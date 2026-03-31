/**
 * Feature extraction for the subscription confidence model.
 *
 * All features are normalised to [0, 1] so the logistic regression weights
 * are directly comparable. Recency decay is NOT included here — it is applied
 * as a post-sigmoid multiplier in subscriptionModel.js so that stale detections
 * can still be stored with their raw model score and decayed at query time.
 *
 * Feature vector (5 dimensions):
 *   [0] occ_norm       — clamp((occurrences - 1) / 5, 0, 1)
 *   [1] interval_score — clamp(1 - intervalVariance / 30, 0, 1)
 *   [2] amount_score   — clamp(1 - amountCV / 0.5, 0, 1)
 *   [3] intent_score   — clamp(intentCount / 2, 0, 1)
 *   [4] known_brand    — 1 if a known brand with confirmSingle, else 0
 */

export function extractFeatures({ occurrences, intervalVariance, amountCV, intentCount, knownBrand }) {
  const occ_norm       = Math.min(Math.max((occurrences - 1) / 5, 0), 1);
  const interval_score = Math.min(Math.max(1 - intervalVariance / 30, 0), 1);
  const amount_score   = Math.min(Math.max(1 - amountCV / 0.5, 0), 1);
  const intent_score   = Math.min(Math.max(intentCount / 2, 0), 1);
  const known_brand    = knownBrand ? 1 : 0;

  return [occ_norm, interval_score, amount_score, intent_score, known_brand];
}
