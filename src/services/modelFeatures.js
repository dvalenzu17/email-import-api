/**
 * Feature extraction for the subscription confidence model.
 *
 * All features are normalised to [0, 1] so the logistic regression weights
 * are directly comparable. Recency decay is NOT included here — it is applied
 * as a post-sigmoid multiplier in subscriptionModel.js so that stale detections
 * can still be stored with their raw model score and decayed at query time.
 *
 * Feature vector (7 dimensions):
 *   [0] occ_norm                — clamp((occurrences - 1) / 5, 0, 1)
 *   [1] interval_score          — clamp(1 - intervalVariance / 30, 0, 1)
 *   [2] amount_score            — clamp(1 - amountCV / 0.5, 0, 1)
 *   [3] intent_score            — clamp(intentCount / 2, 0, 1)
 *   [4] known_brand             — 1 if a known brand with confirmSingle, else 0
 *   [5] subject_intent_score    — TASK 6: 0.0/0.5/0.9 from subject line keyword scoring
 *   [6] known_price_tier_score  — TASK 7: 1.0/0.5/0.0 from KNOWN_PRICE_TIERS proximity
 */

// TASK 6 — Subject line intent scoring weights (see subscriptionEngine.js for full lists).
// Exported so subscriptionEngine.js can import and use them for extraction logging.
export function extractFeatures({
  occurrences,
  intervalVariance,
  amountCV,
  intentCount,
  knownBrand,
  subjectIntentScore = 0,   // TASK 6: 0–1 from scoreSubjectIntent()
  knownPriceTierScore = 0,  // TASK 7: 0–1 from scorePriceTier()
}) {
  const occ_norm              = Math.min(Math.max((occurrences - 1) / 5, 0), 1);
  const interval_score        = Math.min(Math.max(1 - intervalVariance / 30, 0), 1);
  const amount_score          = Math.min(Math.max(1 - amountCV / 0.5, 0), 1);
  const intent_score          = Math.min(Math.max(intentCount / 2, 0), 1);
  const known_brand           = knownBrand ? 1 : 0;
  const subject_intent_score  = Math.min(Math.max(Number(subjectIntentScore) || 0, 0), 1);
  const known_price_tier_score = Math.min(Math.max(Number(knownPriceTierScore) || 0, 0), 1);

  return [
    occ_norm,
    interval_score,
    amount_score,
    intent_score,
    known_brand,
    subject_intent_score,
    known_price_tier_score,
  ];
}
