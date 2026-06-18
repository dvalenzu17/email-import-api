/**
 * Cron-driven time-based alerts: big-renewal heads-up and trial-ending.
 *
 * Unlike the scan-driven pushes (new sub / price hike / zombie), these are not
 * tied to a scan — they fire when a renewal or trial date approaches, even if
 * nothing new was detected. Run once per background cron cycle.
 *
 * Dedup is atomic via reserveAlert(): we reserve the occurrence first and only
 * push if the reservation was new, so overlapping cycles never double-send.
 * Best-effort throughout: never throws into the cron.
 */

import {
  getDueRenewalAlerts,
  getDueTrialAlerts,
  reserveAlert,
  getPushTokensForUser,
} from "../db/index.js";
import { sendExpoPush } from "./pushService.js";

function num(envVal, fallback) {
  const n = Number(envVal);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const CONFIG = {
  renewalLeadDays: () => num(process.env.RENEWAL_ALERT_LEAD_DAYS, 3),
  bigRenewalMinAmount: () => num(process.env.BIG_RENEWAL_MIN_AMOUNT, 30),
  trialLeadDays: () => num(process.env.TRIAL_ALERT_LEAD_DAYS, 2),
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function friendlyDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

function buildRenewalPush(row) {
  const amt = formatAmount(row.renewal_amount, row.currency);
  const when = friendlyDate(row.renewal_date);
  const price = amt ? `${amt}${cadenceSuffix(row.billing_interval)}` : "";
  const parts = [price, when ? `renews ${when}` : ""].filter(Boolean);
  return {
    title: `Renewing soon: ${row.merchant}`,
    body: parts.length ? `${parts.join(" · ")}. Tap to review.` : `Tap to review.`,
    // kind 'renewal' + id reuses the app's existing /sub/:id tap routing.
    data: { app: "sublytics", kind: "renewal", id: String(row.id) },
  };
}

function buildTrialPush(row) {
  const amt = formatAmount(row.renewal_amount, row.currency);
  const when = friendlyDate(row.trial_end);
  const tail = amt ? ` before you're charged ${amt}${cadenceSuffix(row.billing_interval)}` : " before you're charged";
  return {
    title: `Trial ending: ${row.merchant}`,
    body: `Your trial ends ${when}. Cancel${tail}.`,
    data: { app: "sublytics", kind: "trial_ending", id: String(row.id) },
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
        withinDays: CONFIG.renewalLeadDays(),
        minAmount: CONFIG.bigRenewalMinAmount(),
      }),
      getDueTrialAlerts({ withinDays: CONFIG.trialLeadDays() }),
    ]);

    // Cache tokens per user so we don't refetch for every row.
    const tokenCache = new Map();
    async function tokensFor(userId) {
      if (!tokenCache.has(userId)) tokenCache.set(userId, await getPushTokensForUser(userId));
      return tokenCache.get(userId);
    }

    for (const row of renewals) {
      try {
        const reserved = await reserveAlert(row.user_id, row.id, "renewal", row.period_key);
        if (!reserved) continue;
        const tokens = await tokensFor(row.user_id);
        if (!tokens.length) continue;
        const r = await sendExpoPush(tokens, buildRenewalPush(row), logger);
        renewalsSent += r.sent;
      } catch (err) {
        logger?.warn?.({ subId: row.id, err: err?.message }, "renewal_alert_failed");
      }
    }

    for (const row of trials) {
      try {
        const reserved = await reserveAlert(row.user_id, row.id, "trial_ending", row.period_key);
        if (!reserved) continue;
        const tokens = await tokensFor(row.user_id);
        if (!tokens.length) continue;
        const r = await sendExpoPush(tokens, buildTrialPush(row), logger);
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
