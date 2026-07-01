/**
 * TASK 5 — Shared confidence threshold constant.
 *
 * Single source of truth for all detection thresholds across scan routes and
 * the detection engine. Previously these values were scattered:
 *   - Gmail hardcoded 0.50 (too permissive — too many false positives)
 *   - IMAP hardcoded 0.70 (too strict — missed real single-charge subscriptions)
 * 0.60 is the calibrated balance point between recall and precision.
 *
 * RECENCY_DECAY multipliers are applied as a post-sigmoid factor so stale
 * detections naturally decay without changing the stored model score.
 */

// CONFIDENCE_THRESHOLD: The minimum model confidence score (0–1) for a detected
// subscription to be stored. 0.60 was chosen as the balance point between recall
// (catching real subscriptions) and precision (not flooding users with false positives).
// Gmail used 0.50 (too permissive) and IMAP used 0.70 (too strict) before this constant
// was introduced.
export const DETECTION = {
  CONFIDENCE_THRESHOLD: 0.60,
  CONFIDENCE_BOOST_KNOWN_BRAND: 0.2,
  // Multi-charge recurring-signal override: two or more charges at a *detected*
  // cadence with consistent amounts are the strongest recurring signal there is,
  // yet the logistic model under-scores them for unknown brands (occurrence-count
  // and known-brand features dominate). When the guardrails below are met we floor
  // the confidence so the detection clears both CONFIDENCE_THRESHOLD here and the
  // production re-filter in gmailScanService. Stays isSuggested for user confirm.
  MULTI_CHARGE_OVERRIDE: {
    CONFIDENCE_FLOOR:           0.65,  // ≥ CONFIDENCE_THRESHOLD so it survives the re-filter
    MAX_INTERVAL_VARIANCE_DAYS: 14,    // trimmed spread of gaps must be tight
    MAX_AMOUNT_CV:              0.15,  // amounts consistent (≤15% coefficient of variation)
  },
  RECENCY_DECAY: {
    DAYS_45:  1.0,
    DAYS_90:  0.9,
    DAYS_180: 0.75,
    DAYS_365: 0.55,
    BEYOND:   0.35,
  },
};
