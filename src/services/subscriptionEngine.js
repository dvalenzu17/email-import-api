// ─── Scoring model ───────────────────────────────────────────────────────────
//
// Confidence is computed by a logistic regression model loaded from
// model/weights.json. Default weights are bootstrapped to match the previous
// hand-tuned heuristic thresholds. Retrain with: node scripts/trainModel.js
//
// Feature vector (all normalised to [0, 1]):
//   [0] occ_norm       — clamp((occurrences - 1) / 5, 0, 1)
//   [1] interval_score — clamp(1 - intervalVariance / 30, 0, 1)
//   [2] amount_score   — clamp(1 - amountCV / 0.5, 0, 1)
//   [3] intent_score   — clamp(intentCount / 2, 0, 1)
//   [4] known_brand    — 1 if known brand with confirmSingle, else 0
//
// Recency decay is applied as a post-sigmoid multiplier so stale detections
// naturally decay without changing the stored model score.
//
// Thresholds downstream:
//   Gmail:  ≥ 0.50 → confirmed,  < 0.85 → isSuggested = true
//   IMAP:   ≥ 0.70 → confirmed,  < 0.85 → isSuggested = true
// ─────────────────────────────────────────────────────────────────────────────

import { predictConfidence } from "./subscriptionModel.js";
import { extractFeatures } from "./modelFeatures.js";

function calculateConfidence({ occurrences, intervalVariance, amountCV, intentCount, recencyDecay, knownBrand }) {
  const features = extractFeatures({ occurrences, intervalVariance, amountCV, intentCount, knownBrand });
  const raw = predictConfidence(features);
  return Math.min(raw * recencyDecay, 1.0);
}

// Billing interval bands — widened vs original to handle real-world billing
// drift (e.g. a 28-day or 31-day "monthly" cycle, holiday delays).
function detectBillingInterval(avgDays) {
  if (avgDays >= 5 && avgDays <= 10)   return "weekly";
  if (avgDays >= 22 && avgDays <= 38)  return "monthly";
  if (avgDays >= 75 && avgDays <= 105) return "quarterly";
  if (avgDays >= 165 && avgDays <= 200) return "semi-annual";
  if (avgDays >= 345 && avgDays <= 385) return "yearly";
  return "unknown";
}

// Returns the spread of intervals after trimming the single worst outlier
// (e.g. a skipped month or a billing retry). Falls back to full range when
// there aren't enough data points to trim.
function calcIntervalVariance(intervals) {
  if (intervals.length === 0) return 0;
  if (intervals.length < 3) return Math.max(...intervals) - Math.min(...intervals);
  const sorted = [...intervals].sort((a, b) => a - b);
  return sorted[sorted.length - 2] - sorted[0];
}

// Coefficient of variation: stddev / mean.
// More robust than range/mean — a $1 spread on a $5 plan (CV=0.20) is
// correctly penalised more than a $1 spread on a $200 plan (CV=0.005).
function calcAmountCV(amounts) {
  if (amounts.length < 2) return 0;
  const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  if (mean === 0) return 0;
  const variance = amounts.reduce((sum, x) => sum + (x - mean) ** 2, 0) / amounts.length;
  return Math.sqrt(variance) / mean;
}

// Multiplier applied to raw confidence based on how recently the subscription
// was last seen. Ensures stale subscriptions naturally decay rather than staying
// "confirmed" forever after a cancellation.
function calcRecencyDecay(daysSinceLastCharge) {
  if (daysSinceLastCharge < 45)  return 1.00;
  if (daysSinceLastCharge < 90)  return 0.90;
  if (daysSinceLastCharge < 180) return 0.75;
  if (daysSinceLastCharge < 365) return 0.55;
  return 0.35;
}

import { getBrandInfo } from "./knownBrands.js";
import { normalizeMerchant } from "./merchantNormalizer.js";

export function detectRecurringSubscriptions(charges) {
  const grouped = {};

  for (const c of charges) {
    // Normalize merchant key so "Netflix Inc." and "NETFLIX.COM" map to the
    // same group. The original merchant name is preserved on the charge itself.
    const key = normalizeMerchant(c.merchant) || c.merchant;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(c);
  }

  const now = Date.now();
  const results = [];

  for (const merchant in grouped) {
    const list = grouped[merchant];
    const brand = getBrandInfo(merchant);

    // ── Single-charge path ──────────────────────────────────────────────────
    if (list.length < 2) {
      const single = list[0];
      const daysSince = (now - single.date.getTime()) / (1000 * 60 * 60 * 24);

      // Known brands with confirmSingle skip the generic intent/amount checks —
      // a charge from netflix.com is a subscription by definition.
      if (brand?.confirmSingle) {
        // Amount sanity check: skip if the amount is implausible for this brand
        // (likely a parsing error from a non-billing email).
        if (single.amount < brand.minAmount * 0.5 || single.amount > brand.maxAmount * 2) continue;

        const confidence = Math.round(0.8 * calcRecencyDecay(daysSince) * 1000) / 1000;

        results.push({
          merchant,
          renewalAmount: single.amount,
          currency: single.currency ?? "USD",
          renewalDate: single.renewalDate ?? null,
          billingInterval: brand.interval,
          confidence,
          isActive: true,
          isSuggested: confidence < 0.85,
          source: "gmail",
        });
        continue;
      }

      // Generic single-charge path: require explicit intent + subscription-like amount.
      if (!single.subscriptionIntent) continue;

      const amount = single.amount;
      const looksLikeSubscription =
        amount === Math.round(amount) ||
        [4.99, 5.99, 6.99, 7.99, 9.99, 10.99, 12.99, 14.99, 15.99,
         19.99, 24.99, 29.99, 39.99, 49.99, 59.99, 79.99, 99.99].includes(amount);

      if (!looksLikeSubscription) continue;

      const confidence = Math.round(0.7 * calcRecencyDecay(daysSince) * 1000) / 1000;

      results.push({
        merchant,
        renewalAmount: amount,
        currency: single.currency ?? "USD",
        renewalDate: single.renewalDate ?? null,
        billingInterval: brand?.interval ?? "unknown",
        confidence,
        isActive: true,
        isSuggested: true,
        source: "gmail",
      });

      continue;
    }

    // ── Multi-charge path ───────────────────────────────────────────────────
    list.sort((a, b) => a.date - b.date);

    const last = list[list.length - 1];

    // Amount sanity check for known brands — skip if amounts are implausible.
    if (brand && (last.amount < brand.minAmount * 0.5 || last.amount > brand.maxAmount * 2)) continue;

    const intervals = [];
    for (let i = 1; i < list.length; i++) {
      const diff = (list[i].date - list[i - 1].date) / (1000 * 60 * 60 * 24);
      intervals.push(diff);
    }

    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const intervalVariance = calcIntervalVariance(intervals);

    // Use detected interval; fall back to brand knowledge if detection returns "unknown".
    const detectedInterval = detectBillingInterval(avgInterval);
    const billingInterval = detectedInterval !== "unknown"
      ? detectedInterval
      : (brand?.interval ?? "unknown");

    const amounts = list.map((x) => x.amount);
    const amountCV = calcAmountCV(amounts);

    const daysSinceLastCharge = (now - last.date.getTime()) / (1000 * 60 * 60 * 24);
    const recencyDecay = calcRecencyDecay(daysSinceLastCharge);

    const explicitRenewalDate = list.find((c) => c.renewalDate)?.renewalDate ?? null;
    const nextDate = explicitRenewalDate ?? new Date(
      last.date.getTime() + avgInterval * 24 * 60 * 60 * 1000
    );

    const intentCount = list.filter((c) => c.subscriptionIntent).length;

    const confidence = calculateConfidence({
      occurrences: list.length,
      intervalVariance,
      amountCV,
      intentCount,
      recencyDecay,
      knownBrand: !!brand?.confirmSingle,
    });

    if (confidence < 0.5) continue;

    results.push({
      merchant,
      renewalAmount: last.amount,
      currency: last.currency ?? "USD",
      renewalDate: nextDate,
      billingInterval,
      confidence: Math.round(confidence * 1000) / 1000,
      isActive: true,
      isSuggested: confidence < 0.85,
      source: "gmail",
    });
  }

  return results;
}
