function calculateConfidence({ occurrences, intervalVariance, amountVariance, subscriptionIntent }) {
  let score = 0;

  // Recurrence strength — requires at least 2 occurrences for meaningful confidence
  if (occurrences >= 4) score += 0.45;
  else if (occurrences === 3) score += 0.35;
  else if (occurrences === 2) score += 0.2;

  // Interval stability
  if (intervalVariance < 3) score += 0.3;
  else if (intervalVariance < 7) score += 0.2;
  else if (intervalVariance < 14) score += 0.1;

  // Amount stability
  if (amountVariance < 0.02) score += 0.25;
  else if (amountVariance < 0.08) score += 0.15;
  else if (amountVariance < 0.15) score += 0.05;

  // Subscription intent boost
  if (subscriptionIntent) score += 0.1;

  return Math.min(score, 0.99);
}

function detectBillingInterval(avgDays) {
  if (avgDays > 25 && avgDays < 35) return "monthly";
  if (avgDays > 350 && avgDays < 380) return "yearly";
  if (avgDays > 80 && avgDays < 100) return "quarterly";
  if (avgDays > 6 && avgDays < 9) return "weekly";
  return "unknown";
}

export function detectRecurringSubscriptions(charges) {
  const grouped = {};

  for (const c of charges) {
    if (!grouped[c.merchant]) grouped[c.merchant] = [];
    grouped[c.merchant].push(c);
  }

  const results = [];

  for (const merchant in grouped) {
    const list = grouped[merchant];

    if (list.length < 2) {
      const single = list[0];
      if (!single.subscriptionIntent) continue;

      const amount = single.amount;
      const looksLikeSubscription =
        amount === Math.round(amount) ||
        [4.99, 5.99, 6.99, 7.99, 9.99, 10.99, 12.99, 14.99, 15.99,
         19.99, 24.99, 29.99, 39.99, 49.99, 59.99, 79.99, 99.99].includes(amount);

      if (!looksLikeSubscription) continue;

      results.push({
        merchant,
        renewalAmount: amount,
        currency: "USD",
        renewalDate: null,
        billingInterval: "unknown",
        confidence: 0.7,
        isActive: true,
        isSuggested: true,
        source: "gmail",
      });

      continue;
    }

    list.sort((a, b) => a.date - b.date);

    const intervals = [];
    for (let i = 1; i < list.length; i++) {
      const diff = (list[i].date - list[i - 1].date) / (1000 * 60 * 60 * 24);
      intervals.push(diff);
    }

    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const intervalVariance = Math.max(...intervals) - Math.min(...intervals);
    const billingInterval = detectBillingInterval(avgInterval);

    const amounts = list.map((x) => x.amount);
    const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const amountVariance = (Math.max(...amounts) - Math.min(...amounts)) / avgAmount;

    const last = list[list.length - 1];
    const nextDate = new Date(
      last.date.getTime() + avgInterval * 24 * 60 * 60 * 1000
    );

    const anyIntent = list.some((c) => c.subscriptionIntent);

    const confidence = calculateConfidence({
      occurrences: list.length,
      intervalVariance,
      amountVariance,
      subscriptionIntent: anyIntent,
    });

    // Only drop unknown interval if confidence is also low
    // A stable amount + recurring merchant overrides unknown interval
    if (billingInterval === "unknown" && confidence < 0.4) continue;

    if (confidence < 0.5) continue;

    results.push({
      merchant,
      renewalAmount: last.amount,
      currency: "USD",
      renewalDate: nextDate,
      billingInterval,
      confidence,
      isActive: true,
      isSuggested: confidence < 0.85,
      source: "gmail",
    });
  }

  return results;
}