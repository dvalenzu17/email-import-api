/**
 * Pure helper for trial pre-emption. No DB/env imports so it's unit-testable.
 *
 * A scan may see several trial-confirmation emails for the same merchant; we
 * keep the earliest *future* first-bill date (the most imminent charge to warn
 * about) and drop anything already in the past.
 */

/**
 * @param {Array<{merchant:string, trialEnd:Date|string}>} signals
 * @param {number} now  epoch ms (injectable for tests)
 * @returns {Array<{merchant:string, trialEnd:Date}>} one per merchant, earliest future date
 */
export function selectTrialEnds(signals, now = Date.now()) {
  const byMerchant = new Map();
  for (const s of signals) {
    if (!s?.merchant) continue;
    const d = s.trialEnd instanceof Date ? s.trialEnd : new Date(s.trialEnd);
    if (Number.isNaN(d.getTime()) || d.getTime() <= now) continue; // must be a future date
    const key = s.merchant.toLowerCase();
    const prev = byMerchant.get(key);
    // Keep the first-seen merchant casing; adopt the earlier date if this is sooner.
    if (!prev) byMerchant.set(key, { merchant: s.merchant, trialEnd: d });
    else if (d < prev.trialEnd) byMerchant.set(key, { merchant: prev.merchant, trialEnd: d });
  }
  return [...byMerchant.values()];
}
