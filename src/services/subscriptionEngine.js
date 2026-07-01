// ─── Scoring model ───────────────────────────────────────────────────────────
//
// Confidence is computed by a logistic regression model loaded from
// model/weights.json. Default weights are bootstrapped to match the previous
// hand-tuned heuristic thresholds. Retrain with: node scripts/trainModel.js
//
// Feature vector (all normalised to [0, 1]):
//   [0] occ_norm                — clamp((occurrences - 1) / 5, 0, 1)
//   [1] interval_score          — clamp(1 - intervalVariance / 30, 0, 1)
//   [2] amount_score            — clamp(1 - amountCV / 0.5, 0, 1)
//   [3] intent_score            — clamp(intentCount / 2, 0, 1)
//   [4] known_brand             — 1 if known brand with confirmSingle, else 0
//   [5] subject_intent_score    — TASK 6: 0.0/0.5/0.9 from subject line keyword scoring
//   [6] known_price_tier_score  — TASK 7: 1.0/0.5/0.0 from KNOWN_PRICE_TIERS proximity
//
// Recency decay is applied as a post-sigmoid multiplier so stale detections
// naturally decay without changing the stored model score.
//
// TASK 5: All threshold constants imported from src/config/detectionConstants.js
// (single source of truth — previously scattered as 0.50 in Gmail, 0.70 in IMAP).
// ─────────────────────────────────────────────────────────────────────────────

import { DETECTION } from "../config/detectionConstants.js";
import { predictConfidence } from "./subscriptionModel.js";
import { extractFeatures } from "./modelFeatures.js";

const { CONFIDENCE_THRESHOLD, RECENCY_DECAY, MULTI_CHARGE_OVERRIDE } = DETECTION;

// ─── TASK 6: Subject line intent scoring ─────────────────────────────────────
//
// Scores the email subject line for subscription-intent signals before the
// main detection loop. High-intent subjects (e.g. "your receipt", "invoice")
// get a 0.9 score that flows into the feature vector with weight 0.4.
// Cancellation subjects return 0.0 AND trigger the early-exit guard (Task 8).

// HIGH intent keywords → score 0.9
const HIGH_INTENT = [
  "your receipt", "invoice", "payment confirmation", "thank you for subscribing",
  "subscription confirmation", "your subscription", "billing confirmation",
  "payment received", "order confirmation", "purchase confirmation",
  "payment successful",
];

// MEDIUM intent keywords → score 0.5
const MEDIUM_INTENT = [
  "your plan", "membership", "renewal", "your account", "billing update",
  "subscription renewal", "plan renewal", "auto-renewal",
];

// CANCELLATION signals — score 0.0 and also used by Task 8 early-exit guard.
// Exported so emailParser.js and other modules can reuse the same list.
export const CANCELLATION_SIGNALS = [
  "cancellation confirmed", "subscription cancelled", "subscription canceled",
  "you have been unsubscribed", "your cancellation",
  "we've cancelled", "we've canceled", "cancel confirmation",
  "unsubscribe confirmed",
];

/**
 * TASK 6 — Scores an email subject line for subscription purchase intent.
 * Returns { score, matched, isCancellation } where:
 *   score          — 0.0 (cancellation/low), 0.5 (medium), 0.9 (high)
 *   matched        — the keyword that fired, or null
 *   isCancellation — true if a cancellation signal matched (triggers Task 8 skip)
 */
function scoreSubjectIntent(subject) {
  if (!subject) return { score: 0.0, matched: null, isCancellation: false };
  const lower = subject.toLowerCase();
  for (const kw of CANCELLATION_SIGNALS) {
    if (lower.includes(kw)) return { score: 0.0, matched: kw, isCancellation: true };
  }
  for (const kw of HIGH_INTENT) {
    if (lower.includes(kw)) return { score: 0.9, matched: kw, isCancellation: false };
  }
  for (const kw of MEDIUM_INTENT) {
    if (lower.includes(kw)) return { score: 0.5, matched: kw, isCancellation: false };
  }
  return { score: 0.1, matched: null, isCancellation: false };
}

// ─── TASK 7: Amount (price tier) stability scoring ────────────────────────────
//
// Subscription services almost always charge at standard "nice" price tiers
// (e.g. $9.99, $14.99, $19.99). An extracted amount that exactly matches (or is
// within $1.00 of) a known tier is a strong signal it's a real subscription
// rather than a one-time or irregular charge.

const KNOWN_PRICE_TIERS = [
  0.99, 1.99, 2.99, 3.99, 4.99, 5.99, 6.99, 7.99, 8.99, 9.99,
  10.99, 11.99, 12.99, 13.99, 14.99, 15.99, 17.99, 19.99, 24.99, 29.99,
  34.99, 39.99, 49.99, 59.99, 69.99, 79.99, 99.99, 119.99, 129.99, 149.99,
  199.99, 299.99,
];

/**
 * TASK 7 — Returns a score (0–1) based on how close an amount is to a known
 * subscription price tier:
 *   1.0 — exact match (±$0.01)
 *   0.5 — close match (within $1.00)
 *   0.0 — not near any known tier
 */
function scorePriceTier(amount) {
  if (!amount || amount <= 0) return 0.0;
  const n = Number(amount);
  for (const tier of KNOWN_PRICE_TIERS) {
    if (Math.abs(n - tier) <= 0.01) return 1.0;
    if (Math.abs(n - tier) <= 1.00) return 0.5;
  }
  return 0.0;
}

function calculateConfidence({
  occurrences, intervalVariance, amountCV, intentCount, recencyDecay, knownBrand,
  subjectIntentScore = 0,   // TASK 6
  knownPriceTierScore = 0,  // TASK 7
}) {
  const features = extractFeatures({
    occurrences, intervalVariance, amountCV, intentCount, knownBrand,
    subjectIntentScore,
    knownPriceTierScore,
  });
  const raw = predictConfidence(features);
  return Math.min(raw * recencyDecay, 1.0);
}

// Billing interval bands — widened vs original to handle real-world billing
// drift (e.g. a 28-day or 31-day "monthly" cycle, holiday delays).
function detectBillingInterval(avgDays) {
  if (avgDays >= 5 && avgDays <= 10)    return "weekly";
  if (avgDays >= 22 && avgDays <= 38)   return "monthly";
  if (avgDays >= 75 && avgDays <= 105)  return "quarterly";
  if (avgDays >= 165 && avgDays <= 200) return "semi-annual";
  if (avgDays >= 345 && avgDays <= 385) return "yearly";
  return "unknown";
}

// Returns the spread of intervals after trimming the single worst outlier.
function calcIntervalVariance(intervals) {
  if (intervals.length === 0) return 0;
  if (intervals.length < 3) return Math.max(...intervals) - Math.min(...intervals);
  const sorted = [...intervals].sort((a, b) => a - b);
  return sorted[sorted.length - 2] - sorted[0];
}

// Coefficient of variation: stddev / mean.
function calcAmountCV(amounts) {
  if (amounts.length < 2) return 0;
  const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  if (mean === 0) return 0;
  const variance = amounts.reduce((sum, x) => sum + (x - mean) ** 2, 0) / amounts.length;
  return Math.sqrt(variance) / mean;
}

/**
 * TASK 5 — Recency decay multiplier using DETECTION.RECENCY_DECAY constants
 * instead of hardcoded literals. Previously these were scattered inline.
 */
function calcRecencyDecay(daysSinceLastCharge) {
  if (daysSinceLastCharge < 45)  return RECENCY_DECAY.DAYS_45;   // 1.00
  if (daysSinceLastCharge < 90)  return RECENCY_DECAY.DAYS_90;   // 0.90
  if (daysSinceLastCharge < 180) return RECENCY_DECAY.DAYS_180;  // 0.75
  if (daysSinceLastCharge < 365) return RECENCY_DECAY.DAYS_365;  // 0.55
  return RECENCY_DECAY.BEYOND;                                     // 0.35
}

import { getBrandInfo, getBrandDisplayName } from "./knownBrands.js";
import { normalizeMerchant } from "./merchantNormalizer.js";

/**
 * Adjusts a raw confidence score based on the user's explicit feedback.
 */
function applyFeedback(confidence, merchantKey, feedbackMap) {
  const label = feedbackMap[merchantKey.toLowerCase()];
  if (label === "confirmed") return Math.min(confidence + 0.15, 1.0);
  if (label === "rejected")  return 0;
  return confidence;
}

/**
 * @param {Array}  charges     — extracted charge objects from scan
 * @param {object} opts
 * @param {object} opts.feedbackMap — { [merchantKey: string]: 'confirmed'|'rejected' }
 */
export function detectRecurringSubscriptions(charges, { feedbackMap = {} } = {}) {
  const grouped = {};

  for (const c of charges) {
    // ── TASK 8: Cancellation signal early-exit ─────────────────────────────
    // Before any confidence calculation or merchant lookup, check both the subject
    // and body for cancellation signals. If found, skip this charge entirely so
    // it never enters the detection candidates pool.
    // This runs PER CHARGE (not per email) because multiple charges can come from
    // the same email and the charge object carries subject/cleanText context.
    const subjectLower = (c.subject || "").toLowerCase();
    const bodyLower    = (c.cleanText || "").toLowerCase();
    const isCancellation = CANCELLATION_SIGNALS.some(
      (sig) => subjectLower.includes(sig) || bodyLower.includes(sig)
    );
    if (isCancellation) {
      // Record in extractionLog if present on the charge
      if (c.extractionLog) {
        c.extractionLog.cancellation_signal_detected = true;
      }
      continue; // skip — do not add to candidates
    }

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

      // TASK 6: Score the subject for this single charge.
      const subjectIntent = scoreSubjectIntent(single.subject ?? "");
      // TASK 7: Score the price tier for this single charge.
      const priceTierScore = scorePriceTier(single.amount);

      if (brand?.confirmSingle) {
        if (single.amount < brand.minAmount * 0.5 || single.amount > brand.maxAmount * 2) continue;

        let confidence = Math.round(0.8 * calcRecencyDecay(daysSince) * 1000) / 1000;
        confidence = applyFeedback(confidence, merchant, feedbackMap);
        if (confidence <= 0) continue;

        results.push({
          merchant:        getBrandDisplayName(merchant),
          renewalAmount:   single.amount,
          currency:        single.currency ?? "USD",
          renewalDate:     single.renewalDate ?? null,
          billingInterval: brand.interval,
          confidence:      Math.round(confidence * 1000) / 1000,
          isActive:        true,
          isSuggested:     confidence < 0.85,
          extractionLog:   {
            ...(single.extractionLog ?? {}),
            subject_intent: { score: subjectIntent.score, matched: subjectIntent.matched },
            known_price_tier_score: priceTierScore,
          },
        });
        continue;
      }

      if (!single.subscriptionIntent) continue;

      const amount = single.amount;

      // ── Recurring-signal gate (generalizes beyond the known-brand list) ──────
      // A single charge from an UNKNOWN brand is accepted as a *suggested*
      // subscription when it shows at least one explicit recurring signal —
      // regardless of whether the amount is a "pretty" tier. This is what makes
      // detection work for the long tail of services (gyms, insurance, niche SaaS,
      // taxed/localized amounts like $13.47) that aren't in KNOWN_BRANDS.
      // Results stay isSuggested:true so the user confirms them in onboarding —
      // recall over precision is the right tradeoff for a review-and-confirm flow.
      if (!(amount >= 0.99 && amount <= 2000)) continue;   // sanity band
      const hasInterval   = !!single.billingInterval;                  // "monthly", "/year", …
      const hasRenewal    = !!single.renewalDate;                      // explicit next-billing date
      const nearPriceTier = scorePriceTier(amount) > 0;                // complete tier list
      const strongSubject = subjectIntent.score >= 0.9;                // "your receipt"/"invoice"/…
      const roundAmount   = amount === Math.round(amount);
      const recurringSignal =
        hasInterval || hasRenewal || nearPriceTier || strongSubject || roundAmount;
      if (!recurringSignal) continue;

      let confidence = Math.round(0.7 * calcRecencyDecay(daysSince) * 1000) / 1000;
      confidence = applyFeedback(confidence, merchant, feedbackMap);
      if (confidence <= 0) continue;

      results.push({
        merchant:        getBrandDisplayName(merchant),
        renewalAmount:   amount,
        currency:        single.currency ?? "USD",
        renewalDate:     single.renewalDate ?? null,
        billingInterval: brand?.interval ?? "unknown",
        confidence:      Math.round(confidence * 1000) / 1000,
        isActive:        true,
        isSuggested:     true,
        extractionLog:   {
          ...(single.extractionLog ?? {}),
          subject_intent: { score: subjectIntent.score, matched: subjectIntent.matched },
          known_price_tier_score: priceTierScore,
        },
      });

      continue;
    }

    // ── Multi-charge path ───────────────────────────────────────────────────
    list.sort((a, b) => a.date - b.date);

    const last = list[list.length - 1];

    if (brand && (last.amount < brand.minAmount * 0.5 || last.amount > brand.maxAmount * 2)) continue;

    const intervals = [];
    for (let i = 1; i < list.length; i++) {
      const diff = (list[i].date - list[i - 1].date) / (1000 * 60 * 60 * 24);
      intervals.push(diff);
    }

    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const intervalVariance = calcIntervalVariance(intervals);

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

    // TASK 6: Average subject intent score across all charges for this merchant.
    const avgSubjectIntentScore = list.reduce((sum, c) => {
      return sum + scoreSubjectIntent(c.subject ?? "").score;
    }, 0) / list.length;
    const lastSubjectIntent = scoreSubjectIntent(last.subject ?? "");

    // TASK 7: Score based on the most recent charge amount.
    const priceTierScore = scorePriceTier(last.amount);

    let confidence = calculateConfidence({
      occurrences: list.length,
      intervalVariance,
      amountCV,
      intentCount,
      recencyDecay,
      knownBrand:          !!brand?.confirmSingle,
      subjectIntentScore:  avgSubjectIntentScore,   // TASK 6
      knownPriceTierScore: priceTierScore,           // TASK 7
    });

    // ── Multi-charge recurring-signal override ───────────────────────────────
    // Two or more charges at a *detected* cadence with consistent amounts is the
    // strongest recurring signal there is — stronger than any single-charge case
    // that already passes. The model under-scores these for unknown brands, so we
    // floor the confidence when the cadence and amounts are tight. Guardrails keep
    // precision: a real interval band must be detected (not "unknown"), the gap
    // spread must be tight, amounts must be consistent, and the amount must sit in
    // the sanity band. Result stays isSuggested for the user to confirm.
    const consistentCadence = detectedInterval !== "unknown" &&
      intervalVariance <= MULTI_CHARGE_OVERRIDE.MAX_INTERVAL_VARIANCE_DAYS;
    const consistentAmount  = amountCV <= MULTI_CHARGE_OVERRIDE.MAX_AMOUNT_CV;
    const withinSanityBand  = last.amount >= 0.99 && last.amount <= 2000;
    const recurringOverride =
      consistentCadence && consistentAmount && withinSanityBand;

    if (confidence < CONFIDENCE_THRESHOLD) {
      if (!recurringOverride) continue;
      confidence = Math.max(confidence, MULTI_CHARGE_OVERRIDE.CONFIDENCE_FLOOR);
    }

    confidence = applyFeedback(confidence, merchant, feedbackMap);
    if (confidence <= 0) continue;

    results.push({
      merchant:        getBrandDisplayName(merchant),
      renewalAmount:   last.amount,
      currency:        last.currency ?? "USD",
      renewalDate:     nextDate,
      billingInterval,
      confidence:      Math.round(confidence * 1000) / 1000,
      isActive:        true,
      isSuggested:     confidence < 0.85,
      extractionLog:   {
        ...(last.extractionLog ?? {}),
        subject_intent: { score: avgSubjectIntentScore, matched: lastSubjectIntent.matched },
        known_price_tier_score: priceTierScore,
      },
    });
  }

  return results;
}
