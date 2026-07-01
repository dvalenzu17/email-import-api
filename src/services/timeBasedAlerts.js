/**
 * Cron-driven time-based alerts: big-renewal heads-up and trial-ending.
 *
 * Unlike the scan-driven pushes (new sub / price hike / zombie), these are not
 * tied to a scan — they fire as a renewal/trial date approaches. Run on the
 * dedicated alert scheduler (default hourly) so the escalating ladder
 * (2 days → tomorrow → today) lands close to each day boundary.
 *
 * Dedup is atomic via reserveAlert() with a per-rung period_key ("<date>#<rung>"):
 * each rung fires exactly once even though the cron runs hourly, and overlapping
 * cycles never double-send. Best-effort throughout: never throws into the cron.
 */

import {
  getDueRenewalAlerts,
  getDueTrialAlerts,
  reserveAlert,
  getPushTokensForUser,
} from "../db/index.js";
import { sendExpoPush } from "./pushService.js";
import { rungFromDays, LADDER_MAX_DAYS } from "./alertLadder.js";

function num(envVal, fallback) {
  const n = Number(envVal);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const CONFIG = {
  bigRenewalMinAmount: () => num(process.env.BIG_RENEWAL_MIN_AMOUNT, 30),
};

function cadenceSuffix(interval) {
  const c = String(interval || "").toLowerCase();
  if (c.includes("year") || c === "annual" || c === "annually") return "/yr";
  if (c.includes("quarter")) return "/qtr";
  if (c.includes("biweek") || c.includes("bi-week") || c.includes("fortnight")) return "/2wk";
  if (c.includes("week")) return "/wk";
  if (c.includes("month")) return "/mo";
  return "";
}

function formatAmount(amount, currency = "USD") {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  const sym =
    currency === "USD" ? "$" :
    currency === "EUR" ? "€" :
    currency === "GBP" ? "£" :
    currency === "CAD" ? "CA$" :
    `${currency || "USD"} `;
  return `${sym}${n.toFixed(2)}`;
}

function buildRenewalPush(row, rung) {
  const amt = formatAmount(row.renewal_amount, row.currency);
  const price = amt ? `${amt}${cadenceSuffix(row.billing_interval)}` : "";
  const parts = [price, `renews ${rung.lead}`].filter(Boolean);
  return {
    title: `Renewing ${rung.lead}: ${row.merchant}`,
    body: `${parts.join(" · ")}. Tap to review.`,
    // kind 'renewal' + id reuses the app's existing /sub/:id tap routing.
    data: { app: "sublytics", kind: "renewal", id: String(row.id), rung: rung.key },
  };
}

function buildTrialPush(row, rung) {
  const amt = formatAmount(row.renewal_amount, row.currency);
  const tail = amt ? ` before you're charged ${amt}${cadenceSuffix(row.billing_interval)}` : " before you're charged";
  return {
    title: `Trial ends ${rung.lead}: ${row.merchant}`,
    body: `Your free trial ends ${rung.lead}. Cancel${tail}.`,
    data: { app: "sublytics", kind: "trial_ending", id: String(row.id), rung: rung.key },
  };
}

/**
 * Runs one full time-based alert pass across all eligible users.
 * @returns {Promise<{ renewalsSent: number, trialsSent: number }>}
 */
export async function runTimeBasedAlertCycle(logger = console) {
  let renewalsSent = 0;
  let trialsSent = 0;

  try {
    const [renewals, trials] = await Promise.all([
      getDueRenewalAlerts({
        withinDays: LADDER_MAX_DAYS,
        minAmount: CONFIG.bigRenewalMinAmount(),
      }),
      getDueTrialAlerts({ withinDays: LADDER_MAX_DAYS }),
    ]);

    // Cache tokens per user so we don't refetch for every row.
    const tokenCache = new Map();
    async function tokensFor(userId) {
      if (!tokenCache.has(userId)) tokenCache.set(userId, await getPushTokensForUser(userId));
      return tokenCache.get(userId);
    }

    // Escalating ladder: days_until maps to exactly one rung (2day/1day/day_of),
    // so a row emits one rung per day. The period_key carries the rung, so each
    // rung fires once even though the cron runs hourly.
    for (const row of renewals) {
      try {
        const rung = rungFromDays(Number(row.days_until));
        if (!rung) continue;
        const reserved = await reserveAlert(row.user_id, row.id, "renewal", `${row.period_key}#${rung.key}`);
        if (!reserved) continue;
        const tokens = await tokensFor(row.user_id);
        if (!tokens.length) continue;
        const r = await sendExpoPush(tokens, buildRenewalPush(row, rung), logger);
        renewalsSent += r.sent;
      } catch (err) {
        logger?.warn?.({ subId: row.id, err: err?.message }, "renewal_alert_failed");
      }
    }

    for (const row of trials) {
      try {
        const rung = rungFromDays(Number(row.days_until));
        if (!rung) continue;
        const reserved = await reserveAlert(row.user_id, row.id, "trial_ending", `${row.period_key}#${rung.key}`);
        if (!reserved) continue;
        const tokens = await tokensFor(row.user_id);
        if (!tokens.length) continue;
        const r = await sendExpoPush(tokens, buildTrialPush(row, rung), logger);
        trialsSent += r.sent;
      } catch (err) {
        logger?.warn?.({ subId: row.id, err: err?.message }, "trial_alert_failed");
      }
    }

    logger?.info?.(
      { renewalCandidates: renewals.length, trialCandidates: trials.length, renewalsSent, trialsSent },
      "time_based_alert_cycle_done"
    );
  } catch (err) {
    logger?.error?.({ err: err?.message }, "time_based_alert_cycle_error");
  }

  return { renewalsSent, trialsSent };
}
