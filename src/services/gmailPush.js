/**
 * Gmail real-time push: register a mailbox watch, handle incoming Pub/Sub
 * notifications, and renew watches before they expire.
 *
 * Entirely inert unless GMAIL_PUBSUB_TOPIC is set — registration/renewal no-op
 * and the webhook route isn't reachable without GMAIL_PUSH_VERIFICATION_TOKEN.
 * This replaces (for Gmail) the 6h polling cron with near-instant reaction so a
 * trial-confirmation email is parsed the moment it lands. IMAP stays polled.
 */
import {
  upsertGmailWatch,
  getWatchByEmail,
  updateWatchHistoryId,
  getExpiringWatches,
} from "../db/index.js";
import { getGmailAccessToken } from "./gmailAuth.js";
import { buildWatchRequest } from "./gmailPushUtil.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export function isGmailPushEnabled() {
  return !!process.env.GMAIL_PUBSUB_TOPIC;
}

async function gmailGet(path, accessToken) {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`gmail_get_failed:${res.status}`);
  return res.json();
}

/**
 * Registers (or refreshes) a Gmail watch for a user. Safe to call repeatedly —
 * Gmail treats a re-watch as an extension. No-op if push isn't configured.
 */
export async function registerGmailWatch(userId, logger = console) {
  const topicName = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topicName) return { skipped: "not_configured" };

  try {
    const accessToken = await getGmailAccessToken(userId);
    const res = await fetch(`${GMAIL_API}/watch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildWatchRequest(topicName)),
    });
    if (!res.ok) throw new Error(`gmail_watch_failed:${res.status}`);
    const watch = await res.json(); // { historyId, expiration }

    // The watch response has no email; the profile does.
    const profile = await gmailGet("/profile", accessToken); // { emailAddress, historyId }

    await upsertGmailWatch(userId, {
      email: profile.emailAddress,
      historyId: watch.historyId ?? profile.historyId,
      expiration: watch.expiration ? new Date(Number(watch.expiration)) : null,
    });
    logger?.info?.({ userId, expiration: watch.expiration }, "gmail_watch_registered");
    return { registered: true };
  } catch (err) {
    logger?.warn?.({ userId, err: err?.message }, "gmail_watch_register_failed");
    return { error: err?.message };
  }
}

// Coalesce bursts of notifications for the same mailbox into one scan.
const scanInFlight = new Set();
async function kickIncrementalScan(userId, logger) {
  if (scanInFlight.has(userId)) return;
  scanInFlight.add(userId);
  try {
    const { runGmailScan } = await import("./gmailScanService.js");
    // A push means fresh mail just arrived; a short window + message-cache dedup
    // keeps this cheap while still catching the new email immediately.
    await runGmailScan({ userId, daysBack: 2 });
  } catch (err) {
    logger?.warn?.({ userId, err: err?.message }, "gmail_push_scan_failed");
  } finally {
    scanInFlight.delete(userId);
  }
}

/**
 * Handles a decoded push ({ emailAddress, historyId }): map to the user, record
 * the historyId, and trigger an incremental scan. Returns quickly; the scan
 * runs in the background so the webhook can ack within the Pub/Sub deadline.
 */
export async function handleGmailPush({ emailAddress, historyId }, logger = console) {
  const watch = await getWatchByEmail(emailAddress);
  if (!watch) {
    logger?.warn?.({ emailAddress }, "gmail_push_unknown_mailbox");
    return { matched: false };
  }
  await updateWatchHistoryId(watch.user_id, historyId);
  kickIncrementalScan(watch.user_id, logger); // fire-and-forget
  return { matched: true };
}

/** Renewal cron: re-register watches expiring soon (Gmail watches last ~7 days). */
export async function renewExpiringWatches(logger = console) {
  if (!isGmailPushEnabled()) return { renewed: 0 };
  let renewed = 0;
  try {
    const due = await getExpiringWatches({ withinHours: 24 });
    for (const row of due) {
      const r = await registerGmailWatch(row.user_id, logger);
      if (r.registered) renewed += 1;
    }
    logger?.info?.({ candidates: due.length, renewed }, "gmail_watch_renewal_done");
  } catch (err) {
    logger?.warn?.({ err: err?.message }, "gmail_watch_renewal_failed");
  }
  return { renewed };
}
