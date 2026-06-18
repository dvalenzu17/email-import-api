/**
 * Sends "new potential subscription detected" push notifications after a scan.
 *
 * Triggered with the rows that batchUpsertSubscriptions reports as brand-new
 * inserts (first time ever for the user). The push payload uses
 * { app: "sublytics", kind: "new_subscription" } so the app's existing
 * notification tap handler routes to the email review screen.
 *
 * Best-effort: never throws into the scan flow.
 */

import { getPushTokensForUser } from "../db/index.js";
import { sendExpoPush } from "./pushService.js";

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

/**
 * @param {string} userId
 * @param {Array<{ merchant: string, renewalAmount?: number, currency?: string, billingInterval?: string, isActive?: boolean }>} insertedSubs
 * @param {object} [logger]
 */
export async function notifyNewSubscriptions(userId, insertedSubs, logger = console) {
  try {
    // Only alert on active subscriptions — cancelled/inactive rows aren't "new charges".
    const fresh = (insertedSubs || []).filter((s) => s && s.isActive !== false && s.merchant);
    if (!fresh.length) return { sent: 0, failed: 0, skipped: "no_new" };

    const tokens = await getPushTokensForUser(userId);
    if (!tokens.length) return { sent: 0, failed: 0, skipped: "no_tokens" };

    const data = { app: "sublytics", kind: "new_subscription", type: "new_subscription" };

    let payload;
    if (fresh.length === 1) {
      const s = fresh[0];
      const amt = formatAmount(s.renewalAmount, s.currency);
      const price = amt ? `${amt}${cadenceSuffix(s.billingInterval)}` : "";
      payload = {
        title: `New subscription detected: ${s.merchant}`,
        body: price
          ? `Looks like ${price}. Tap to confirm or dismiss.`
          : `Tap to confirm or dismiss this potential subscription.`,
        data,
      };
    } else {
      payload = {
        title: `${fresh.length} new potential subscriptions`,
        body: `We spotted ${fresh.length} new charges that look like subscriptions. Tap to review.`,
        data,
      };
    }

    const result = await sendExpoPush(tokens, payload, logger);
    logger?.info?.(
      { userId, newCount: fresh.length, tokenCount: tokens.length, sent: result.sent, failed: result.failed },
      "new_subscription_push_sent"
    );
    return result;
  } catch (err) {
    logger?.warn?.({ userId, err: err?.message }, "new_subscription_push_failed");
    return { sent: 0, failed: 0, error: err?.message };
  }
}

/**
 * Pushes a "price increase" alert for each subscription whose amount jumped.
 * @param {string} userId
 * @param {Array<{ merchant, oldAmount, newAmount, currency, billingInterval }>} increases
 */
export async function notifyPriceIncreases(userId, increases, logger = console) {
  try {
    const items = (increases || []).filter((p) => p && p.merchant);
    if (!items.length) return { sent: 0, failed: 0, skipped: "none" };

    const tokens = await getPushTokensForUser(userId);
    if (!tokens.length) return { sent: 0, failed: 0, skipped: "no_tokens" };

    const data = { app: "sublytics", kind: "price_change", type: "price_change" };
    let total = { sent: 0, failed: 0 };

    for (const p of items) {
      const suffix = cadenceSuffix(p.billingInterval);
      const oldStr = formatAmount(p.oldAmount, p.currency);
      const newStr = formatAmount(p.newAmount, p.currency);
      const r = await sendExpoPush(
        tokens,
        {
          title: `Price increase: ${p.merchant}`,
          body: `${oldStr} → ${newStr}${suffix}. Tap to review.`,
          data: { ...data, merchant: p.merchant },
        },
        logger
      );
      total.sent += r.sent;
      total.failed += r.failed;
    }

    logger?.info?.({ userId, count: items.length, ...total }, "price_increase_push_sent");
    return total;
  } catch (err) {
    logger?.warn?.({ userId, err: err?.message }, "price_increase_push_failed");
    return { sent: 0, failed: 0, error: err?.message };
  }
}

/**
 * Pushes a "charged after cancelling" (zombie) alert for re-detected charges
 * on subscriptions the user marked cancelled.
 * @param {string} userId
 * @param {Array<{ merchant, amount, currency, billingInterval }>} charges
 */
export async function notifyZombieCharges(userId, charges, logger = console) {
  try {
    const items = (charges || []).filter((c) => c && c.merchant);
    if (!items.length) return { sent: 0, failed: 0, skipped: "none" };

    const tokens = await getPushTokensForUser(userId);
    if (!tokens.length) return { sent: 0, failed: 0, skipped: "no_tokens" };

    const data = { app: "sublytics", kind: "zombie_charge", type: "zombie_charge" };
    let total = { sent: 0, failed: 0 };

    for (const c of items) {
      const amtStr = formatAmount(c.amount, c.currency);
      const body = amtStr
        ? `You marked ${c.merchant} cancelled, but a ${amtStr} charge just appeared. Tap to review.`
        : `You marked ${c.merchant} cancelled, but a new charge just appeared. Tap to review.`;
      const r = await sendExpoPush(
        tokens,
        { title: `Charged after cancelling: ${c.merchant}`, body, data: { ...data, merchant: c.merchant } },
        logger
      );
      total.sent += r.sent;
      total.failed += r.failed;
    }

    logger?.info?.({ userId, count: items.length, ...total }, "zombie_charge_push_sent");
    return total;
  } catch (err) {
    logger?.warn?.({ userId, err: err?.message }, "zombie_charge_push_failed");
    return { sent: 0, failed: 0, error: err?.message };
  }
}
