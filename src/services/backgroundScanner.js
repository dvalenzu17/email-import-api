/**
 * Background (cron) scanner.
 *
 * Periodically re-scans connected accounts for users who have push tokens and
 * haven't been scanned recently. Reuses the normal incremental scan paths
 * (runGmailScan / runImapScan), so brand-new subscriptions automatically fire
 * the "new subscription detected" push via newSubscriptionNotifier.
 *
 * This closes the gap left by app-triggered-only scans: a user can have the app
 * closed for days and still get alerted shortly after a new subscription email
 * lands (on the next cron cycle).
 *
 * Design notes:
 *   - Incremental: uses the saved checkpoint per provider, so each cycle fetches
 *     only mail since the last scan (cheap).
 *   - Polite: bounded concurrency + per-task jitter, and it shares the
 *     module-level Gmail circuit breaker in gmailScanService.
 *   - Best-effort: a failure for one user/provider never aborts the cycle.
 *   - Not subject to the per-request free-tier scan limit (runs out-of-band,
 *     like the BullMQ worker).
 */

import pLimit from "p-limit";
import {
  getUsersDueForScan,
  getScanCheckpoint,
  saveScanCheckpoint,
  getImapCredentials,
} from "../db/index.js";
import { runGmailScan } from "./gmailScanService.js";
import { runImapScan } from "./imapScanService.js";
import { runTimeBasedAlertCycle } from "./timeBasedAlerts.js";
import { decryptCredential } from "./crypto.js";

function num(envVal, fallback) {
  const n = Number(envVal);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const CONFIG = {
  intervalMin: () => num(process.env.BACKGROUND_SCAN_INTERVAL_MIN, 360), // 6h
  minHoursSinceLastScan: () => num(process.env.BACKGROUND_SCAN_MIN_HOURS, 12),
  concurrency: () => num(process.env.BACKGROUND_SCAN_CONCURRENCY, 3),
  maxUsers: () => num(process.env.BACKGROUND_SCAN_MAX_USERS, 200),
  daysBack: () => num(process.env.BACKGROUND_SCAN_DAYS_BACK, 30),
  // Time-based alerts run on their own tighter cadence (default hourly) so the
  // escalating 2day/1day/day_of ladder fires close to each bucket boundary
  // instead of being smeared across the 6h scan interval.
  alertIntervalMin: () => num(process.env.ALERT_CYCLE_INTERVAL_MIN, 60),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(Math.floor(Math.random() * 750));

// Guard against overlapping cycles if a run takes longer than the interval.
let cycleRunning = false;

async function scanGmailForUser(userId, daysBack, logger) {
  let afterDate;
  const checkpoint = await getScanCheckpoint(userId, "google");
  if (checkpoint?.last_message_date) afterDate = new Date(checkpoint.last_message_date);

  const result = await runGmailScan({ userId, daysBack, afterDate, force: false });
  if (result?.checkpoint) {
    await saveScanCheckpoint(userId, "google", result.checkpoint);
  }
  logger?.info?.(
    { userId, provider: "google", detected: result?.detectedSubscriptions ?? 0 },
    "bg_scan_gmail_done"
  );
}

async function scanImapForUser(userId, provider, daysBack, logger) {
  const stored = await getImapCredentials(userId, provider);
  if (!stored) return;

  const user = stored.imap_user;
  const pass = decryptCredential(stored.imap_pass);

  let sinceDate;
  const checkpoint = await getScanCheckpoint(userId, provider);
  if (checkpoint?.last_message_date) sinceDate = new Date(checkpoint.last_message_date);

  // runImapScan persists its own checkpoint + metadata via finalizeScan().
  const result = await runImapScan({ userId, provider, user, pass, daysBack, sinceDate, force: false });
  logger?.info?.(
    { userId, provider, detected: result?.detectedSubscriptions ?? 0 },
    "bg_scan_imap_done"
  );
}

/**
 * Runs a single background scan cycle. Safe to call directly (e.g. from an
 * external cron hitting an admin endpoint) or via the in-process scheduler.
 */
export async function runBackgroundScanCycle(logger = console) {
  if (cycleRunning) {
    logger?.warn?.("bg_scan_cycle_skipped_overlap");
    return { skipped: "overlap" };
  }
  cycleRunning = true;
  const startedAt = Date.now();

  try {
    const daysBack = CONFIG.daysBack();
    const due = await getUsersDueForScan({
      minHoursSinceLastScan: CONFIG.minHoursSinceLastScan(),
      limit: CONFIG.maxUsers(),
    });

    if (!due.length) {
      // No accounts to re-scan. Time-based alerts run on their own scheduler.
      logger?.info?.("bg_scan_cycle_no_scan_users");
      return { users: 0, scanned: 0, failed: 0 };
    }

    logger?.info?.({ users: due.length, daysBack }, "bg_scan_cycle_start");

    const limit = pLimit(CONFIG.concurrency());
    let scanned = 0;
    let failed = 0;

    await Promise.all(
      due.map((u) =>
        limit(async () => {
          await jitter();

          if (u.hasGmail) {
            try {
              await scanGmailForUser(u.userId, daysBack, logger);
              scanned += 1;
            } catch (err) {
              failed += 1;
              logger?.warn?.({ userId: u.userId, provider: "google", err: err?.message }, "bg_scan_gmail_failed");
            }
          }

          for (const provider of u.imapProviders) {
            try {
              await scanImapForUser(u.userId, provider, daysBack, logger);
              scanned += 1;
            } catch (err) {
              failed += 1;
              logger?.warn?.({ userId: u.userId, provider, err: err?.message }, "bg_scan_imap_failed");
            }
          }
        })
      )
    );

    const elapsedMs = Date.now() - startedAt;
    logger?.info?.({ users: due.length, scanned, failed, elapsedMs }, "bg_scan_cycle_done");
    return { users: due.length, scanned, failed, elapsedMs };
  } catch (err) {
    logger?.error?.({ err: err?.message }, "bg_scan_cycle_error");
    return { error: err?.message };
  } finally {
    cycleRunning = false;
  }
}

/**
 * Starts the in-process scheduler. Runs an initial cycle shortly after boot,
 * then repeats every BACKGROUND_SCAN_INTERVAL_MIN minutes.
 * Returns the interval handle (useful for tests / shutdown).
 */
export function startBackgroundScanner(logger = console) {
  const intervalMs = CONFIG.intervalMin() * 60 * 1000;

  // Initial run after a short delay so it doesn't compete with cold-start work.
  setTimeout(() => {
    runBackgroundScanCycle(logger).catch(() => {});
  }, 60_000);

  const handle = setInterval(() => {
    runBackgroundScanCycle(logger).catch(() => {});
  }, intervalMs);

  // Don't keep the process alive solely for this timer.
  if (typeof handle.unref === "function") handle.unref();

  logger?.info?.({ intervalMin: CONFIG.intervalMin() }, "background_scanner_started");
  return handle;
}

// Guard against overlapping alert cycles (a slow cycle vs the next tick).
let alertRunning = false;
async function runAlertsSafely(logger) {
  if (alertRunning) return;
  alertRunning = true;
  try {
    await runTimeBasedAlertCycle(logger);
  } catch (err) {
    logger?.warn?.({ err: err?.message }, "alert_cycle_failed");
  } finally {
    alertRunning = false;
  }
}

/**
 * Starts the time-based alert scheduler on its own tighter cadence (default
 * hourly) so the escalating renewal/trial ladder fires close to each day
 * boundary. Separate from the 6h scan loop. Returns the interval handle.
 */
export function startAlertScheduler(logger = console) {
  const intervalMs = CONFIG.alertIntervalMin() * 60 * 1000;

  setTimeout(() => { runAlertsSafely(logger); }, 90_000);

  const handle = setInterval(() => { runAlertsSafely(logger); }, intervalMs);
  if (typeof handle.unref === "function") handle.unref();

  logger?.info?.({ alertIntervalMin: CONFIG.alertIntervalMin() }, "alert_scheduler_started");
  return handle;
}
