// services/subscriptionEngine.js

function calculateConfidence({ occurrences, intervalVariance, amountVariance }) {
    let score = 0;
  
    // Recurrence strength
    if (occurrences >= 3) score += 0.4;
    else if (occurrences === 2) score += 0.25;
  
    // Interval stability
    if (intervalVariance < 3) score += 0.3;
    else if (intervalVariance < 7) score += 0.15;
  
    // Amount stability
    if (amountVariance < 0.05) score += 0.3;
    else if (amountVariance < 0.15) score += 0.15;
  
    return Math.min(score, 0.99);
  }

  function scoreSubscription(charges, subscriptionIntent) {
    let score = 0;
  
    if (charges.length >= 2) score += 0.4;
    if (subscriptionIntent) score += 0.3;
  
    const intervalVariance = calculateIntervalVariance(charges);
    if (intervalVariance < 5) score += 0.2;
  
    const amountVariance = calculateAmountVariance(charges);
    if (amountVariance < 0.1) score += 0.1;
  
    return Math.min(score, 1);
  }
  
  function detectBillingInterval(avgDays) {
    if (avgDays > 25 && avgDays < 35) return "monthly";
    if (avgDays > 350 && avgDays < 380) return "yearly";
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
      
        // Only allow single if strong subscription intent exists
        if (!single.subscriptionIntent) continue;
      
        results.push({
          merchant,
          renewalAmount: single.amount,
          currency: "USD",
          renewalDate: null,
          billingInterval: "unknown",
          confidence: 0.65, // strong intent single
          isActive: true,
          isSuggested: true,
          source: "gmail"
        });
      
        continue;
      }
  
      list.sort((a, b) => a.date - b.date);
  
      const intervals = [];
      for (let i = 1; i < list.length; i++) {
        const diff =
          (list[i].date - list[i - 1].date) / (1000 * 60 * 60 * 24);
        intervals.push(diff);
      }
  
      const avgInterval =
        intervals.reduce((a, b) => a + b, 0) / intervals.length;
  
      const intervalVariance =
        Math.max(...intervals) - Math.min(...intervals);
  
      const amounts = list.map(x => x.amount);
      const avgAmount =
        amounts.reduce((a, b) => a + b, 0) / amounts.length;
  
      const amountVariance =
        Math.max(...amounts) - Math.min(...amounts);
  
      const normalizedAmountVariance =
        amountVariance / avgAmount;
  
      const billingInterval = detectBillingInterval(avgInterval);
  
      const last = list[list.length - 1];
  
      const nextDate = new Date(
        last.date.getTime() + avgInterval * 24 * 60 * 60 * 1000
      );
  
      const confidence = calculateConfidence({
        occurrences: list.length,
        intervalVariance,
        amountVariance: normalizedAmountVariance
      });
  
      results.push({
        merchant,
        renewalAmount: last.amount,
        currency: "USD",
        renewalDate: nextDate,
        billingInterval,
        confidence,
        isActive: true,
        isSuggested: confidence < 0.85,
        source: "gmail"
      });
    }
  
    return results;
  }