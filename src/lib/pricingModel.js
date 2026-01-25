export function computePriceState(candidate) {
  // Explicit price state so UI doesn't guess.
  const amount = candidate?.amount;
  const currency = candidate?.currency || null;
  const cadence = candidate?.cadenceGuess || null;

  if (candidate?.excludeFromSpend) {
    return { kind: "status", amount: amount ?? null, currency, cadence, isEstimate: true, notes: ["excluded_from_spend"] };
  }

  if (amount == null || !cadence) {
    return { kind: "unknown", amount: amount ?? null, currency, cadence, isEstimate: true };
  }

  const monthlyEq = cadence === "annual" ? amount / 12 : cadence === "weekly" ? amount * 4.345 : amount;
  const annualEq = cadence === "annual" ? amount : cadence === "weekly" ? amount * 52 : amount * 12;

  return {
    kind: "recurring",
    amount,
    currency,
    cadence,
    monthlyEquivalent: monthlyEq,
    annualEquivalent: annualEq,
    isEstimate: false,
  };
}
