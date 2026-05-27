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
  RECENCY_DECAY: {
    DAYS_45:  1.0,
    DAYS_90:  0.9,
    DAYS_180: 0.75,
    DAYS_365: 0.55,
    BEYOND:   0.35,
  },
};
