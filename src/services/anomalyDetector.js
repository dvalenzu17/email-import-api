/**
 * Anomaly detection for subscription charge amounts.
 *
 * Flags charges that deviate significantly from a subscription's historical
 * billing amounts. Useful for detecting price changes, unexpected upgrades,
 * or one-off charges misclassified as recurring.
 *
 * Algorithm: if the new amount is more than 2 standard deviations from the
 * historical mean, it is flagged as anomalous. With < 3 samples, a simpler
 * 50% relative change threshold is used.
 */

/**
 * @param {number}   newAmount        — the charge amount being evaluated
 * @param {number[]} historicalAmounts — previous confirmed amounts for this subscription
 * @returns {{ anomalous: boolean, reason: string | null }}
 */
export function detectAmountAnomaly(newAmount, historicalAmounts) {
  if (!historicalAmounts || historicalAmounts.length === 0) {
    return { anomalous: false, reason: null };
  }

  const mean = historicalAmounts.reduce((a, b) => a + b, 0) / historicalAmounts.length;

  // With very few data points, use a simple relative threshold.
  if (historicalAmounts.length < 3) {
    const relChange = Math.abs(newAmount - mean) / mean;
    if (relChange > 0.5) {
      return {
        anomalous: true,
        reason: `amount_change_${relChange > 1 ? "large" : "moderate"}`,
      };
    }
    return { anomalous: false, reason: null };
  }

  // With enough data, use 2-sigma rule.
  const variance = historicalAmounts.reduce((s, x) => s + (x - mean) ** 2, 0) / historicalAmounts.length;
  const stddev = Math.sqrt(variance);

  // If all historical amounts are identical (stddev=0), flag any change.
  if (stddev === 0) {
    if (newAmount !== mean) {
      return { anomalous: true, reason: "amount_changed_from_fixed" };
    }
    return { anomalous: false, reason: null };
  }

  const zScore = Math.abs(newAmount - mean) / stddev;
  if (zScore > 2) {
    return {
      anomalous: true,
      reason: newAmount > mean ? "amount_spike" : "amount_drop",
    };
  }

  return { anomalous: false, reason: null };
}
