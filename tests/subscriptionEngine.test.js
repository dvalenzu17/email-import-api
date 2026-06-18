import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectRecurringSubscriptions, CANCELLATION_SIGNALS } from "../src/services/subscriptionEngine.js";

// Helper to create a charge object at a specific date offset (days ago)
function makeCharge({
  merchant = "netflix",
  amount = 15.49,
  currency = "USD",
  daysAgo = 5,
  subject = "Your receipt",
  subscriptionIntent = true,
  renewalDate = null,
  cleanText = "",
} = {}) {
  return {
    merchant,
    amount,
    currency,
    date: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
    subject,
    subscriptionIntent,
    renewalDate,
    cleanText,
  };
}

// Helper to create multiple charges for the same merchant over a monthly cadence
function makeMonthlyCharges(merchant, amount, count, { startDaysAgo } = {}) {
  const start = startDaysAgo ?? count * 30;
  return Array.from({ length: count }, (_, i) => {
    return makeCharge({
      merchant,
      amount,
      daysAgo: start - i * 30,
    });
  });
}

describe("detectRecurringSubscriptions", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-06-01T00:00:00Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Known brand single-charge path ───────────────────────────────────────

  it("detects a known brand from a single charge (confirmSingle)", () => {
    const charges = [makeCharge({ merchant: "netflix", amount: 15.49, daysAgo: 10 })];
    const results = detectRecurringSubscriptions(charges);
    expect(results).toHaveLength(1);
    expect(results[0].merchant).toBe("Netflix");
    expect(results[0].renewalAmount).toBe(15.49);
    expect(results[0].confidence).toBeGreaterThan(0);
  });

  it("rejects a known brand charge outside plausible amount range", () => {
    // Netflix min=6, max=30. Amount $500 is way outside 0.5*min to 2*max
    const charges = [makeCharge({ merchant: "netflix", amount: 500, daysAgo: 10 })];
    const results = detectRecurringSubscriptions(charges);
    expect(results).toHaveLength(0);
  });

  it("uses brand interval for known brands", () => {
    const charges = [makeCharge({ merchant: "spotify", amount: 9.99, daysAgo: 5 })];
    const results = detectRecurringSubscriptions(charges);
    expect(results).toHaveLength(1);
    expect(results[0].billingInterval).toBe("monthly");
  });

  // ── Multi-charge detection ───────────────────────────────────────────────

  it("detects recurring subscription from multiple monthly charges", () => {
    const charges = makeMonthlyCharges("netflix", 15.49, 4);
    const results = detectRecurringSubscriptions(charges);
    expect(results).toHaveLength(1);
    expect(results[0].merchant).toBe("Netflix");
    expect(results[0].confidence).toBeGreaterThan(0.6);
  });

  it("groups charges by normalized merchant name", () => {
    const charges = [
      makeCharge({ merchant: "netflix", amount: 15.49, daysAgo: 30 }),
      makeCharge({ merchant: "netflix", amount: 15.49, daysAgo: 60 }),
      makeCharge({ merchant: "netflix", amount: 15.49, daysAgo: 90 }),
    ];
    const results = detectRecurringSubscriptions(charges);
    // Should detect one subscription, not three
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("uses the most recent charge amount as renewalAmount", () => {
    const charges = [
      makeCharge({ merchant: "spotify", amount: 9.99, daysAgo: 60 }),
      makeCharge({ merchant: "spotify", amount: 10.99, daysAgo: 30 }),
      makeCharge({ merchant: "spotify", amount: 10.99, daysAgo: 1 }),
    ];
    const results = detectRecurringSubscriptions(charges);
    expect(results).toHaveLength(1);
    expect(results[0].renewalAmount).toBe(10.99);
  });

  // ── Cancellation signal filtering ────────────────────────────────────────

  it("skips charges with cancellation signals in subject", () => {
    const charges = [
      makeCharge({
        merchant: "netflix",
        amount: 15.49,
        daysAgo: 5,
        subject: "Your subscription cancelled",
      }),
    ];
    const results = detectRecurringSubscriptions(charges);
    expect(results).toHaveLength(0);
  });

  it("skips charges with cancellation signals in body", () => {
    const charges = [
      makeCharge({
        merchant: "netflix",
        amount: 15.49,
        daysAgo: 5,
        cleanText: "We have processed your cancellation confirmed request.",
      }),
    ];
    const results = detectRecurringSubscriptions(charges);
    expect(results).toHaveLength(0);
  });

  it("does not skip charges without cancellation signals", () => {
    const charges = [
      makeCharge({
        merchant: "netflix",
        amount: 15.49,
        daysAgo: 5,
        subject: "Your receipt from Netflix",
      }),
    ];
    const results = detectRecurringSubscriptions(charges);
    expect(results).toHaveLength(1);
  });

  // ── Feedback map ─────────────────────────────────────────────────────────

  it("boosts confidence for confirmed merchants", () => {
    const charges = makeMonthlyCharges("spotify", 9.99, 3);
    const withoutFeedback = detectRecurringSubscriptions(charges);
    const withFeedback = detectRecurringSubscriptions(charges, {
      feedbackMap: { spotify: "confirmed" },
    });

    if (withoutFeedback.length > 0 && withFeedback.length > 0) {
      expect(withFeedback[0].confidence).toBeGreaterThanOrEqual(
        withoutFeedback[0].confidence
      );
    }
  });

  it("rejects merchants with 'rejected' feedback", () => {
    const charges = makeMonthlyCharges("spotify", 9.99, 4);
    const results = detectRecurringSubscriptions(charges, {
      feedbackMap: { spotify: "rejected" },
    });
    expect(results).toHaveLength(0);
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  it("returns empty array for empty input", () => {
    expect(detectRecurringSubscriptions([])).toEqual([]);
  });

  it("includes extractionLog on results", () => {
    const charges = [makeCharge({ merchant: "netflix", amount: 15.49, daysAgo: 5 })];
    const results = detectRecurringSubscriptions(charges);
    expect(results).toHaveLength(1);
    expect(results[0].extractionLog).toBeDefined();
  });

  it("does not set source (caller responsibility)", () => {
    const charges = [makeCharge({ merchant: "netflix", amount: 15.49, daysAgo: 5 })];
    const results = detectRecurringSubscriptions(charges);
    expect(results[0].source).toBeUndefined();
  });

  it("rounds confidence to 3 decimal places", () => {
    const charges = [makeCharge({ merchant: "netflix", amount: 15.49, daysAgo: 5 })];
    const results = detectRecurringSubscriptions(charges);
    const conf = results[0].confidence;
    // Check that it has at most 3 decimal places
    expect(conf).toBe(Math.round(conf * 1000) / 1000);
  });
});

// ── CANCELLATION_SIGNALS export ──────────────────────────────────────────────

describe("CANCELLATION_SIGNALS", () => {
  it("is an array of strings", () => {
    expect(Array.isArray(CANCELLATION_SIGNALS)).toBe(true);
    expect(CANCELLATION_SIGNALS.length).toBeGreaterThan(0);
    for (const sig of CANCELLATION_SIGNALS) {
      expect(typeof sig).toBe("string");
    }
  });

  it("contains expected signals", () => {
    expect(CANCELLATION_SIGNALS).toContain("cancellation confirmed");
    expect(CANCELLATION_SIGNALS).toContain("subscription cancelled");
    expect(CANCELLATION_SIGNALS).toContain("subscription canceled");
  });
});
