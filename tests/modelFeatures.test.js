import { describe, it, expect } from "vitest";
import { extractFeatures } from "../src/services/modelFeatures.js";

describe("extractFeatures", () => {
  it("returns a 7-element feature vector", () => {
    const features = extractFeatures({
      occurrences: 3,
      intervalVariance: 5,
      amountCV: 0.1,
      intentCount: 1,
      knownBrand: false,
    });
    expect(features).toHaveLength(7);
  });

  it("clamps occ_norm between 0 and 1", () => {
    // occurrences = 1 -> (1-1)/5 = 0
    const low = extractFeatures({ occurrences: 1, intervalVariance: 0, amountCV: 0, intentCount: 0, knownBrand: false });
    expect(low[0]).toBe(0);

    // occurrences = 6 -> (6-1)/5 = 1
    const high = extractFeatures({ occurrences: 6, intervalVariance: 0, amountCV: 0, intentCount: 0, knownBrand: false });
    expect(high[0]).toBe(1);

    // occurrences = 100 -> clamped at 1
    const clamped = extractFeatures({ occurrences: 100, intervalVariance: 0, amountCV: 0, intentCount: 0, knownBrand: false });
    expect(clamped[0]).toBe(1);
  });

  it("clamps interval_score between 0 and 1", () => {
    // variance = 0 -> 1 - 0/30 = 1
    const perfect = extractFeatures({ occurrences: 1, intervalVariance: 0, amountCV: 0, intentCount: 0, knownBrand: false });
    expect(perfect[1]).toBe(1);

    // variance = 30 -> 1 - 30/30 = 0
    const worst = extractFeatures({ occurrences: 1, intervalVariance: 30, amountCV: 0, intentCount: 0, knownBrand: false });
    expect(worst[1]).toBe(0);

    // variance = 60 -> 1 - 60/30 = -1, clamped to 0
    const clamped = extractFeatures({ occurrences: 1, intervalVariance: 60, amountCV: 0, intentCount: 0, knownBrand: false });
    expect(clamped[1]).toBe(0);
  });

  it("clamps amount_score between 0 and 1", () => {
    // CV = 0 -> 1 - 0/0.5 = 1
    const perfect = extractFeatures({ occurrences: 1, intervalVariance: 0, amountCV: 0, intentCount: 0, knownBrand: false });
    expect(perfect[2]).toBe(1);

    // CV = 0.5 -> 1 - 0.5/0.5 = 0
    const worst = extractFeatures({ occurrences: 1, intervalVariance: 0, amountCV: 0.5, intentCount: 0, knownBrand: false });
    expect(worst[2]).toBe(0);

    // CV = 1.0 -> 1 - 1.0/0.5 = -1, clamped to 0
    const clamped = extractFeatures({ occurrences: 1, intervalVariance: 0, amountCV: 1.0, intentCount: 0, knownBrand: false });
    expect(clamped[2]).toBe(0);
  });

  it("clamps intent_score between 0 and 1", () => {
    // intentCount = 0 -> 0/2 = 0
    const none = extractFeatures({ occurrences: 1, intervalVariance: 0, amountCV: 0, intentCount: 0, knownBrand: false });
    expect(none[3]).toBe(0);

    // intentCount = 2 -> 2/2 = 1
    const full = extractFeatures({ occurrences: 1, intervalVariance: 0, amountCV: 0, intentCount: 2, knownBrand: false });
    expect(full[3]).toBe(1);

    // intentCount = 10 -> clamped at 1
    const clamped = extractFeatures({ occurrences: 1, intervalVariance: 0, amountCV: 0, intentCount: 10, knownBrand: false });
    expect(clamped[3]).toBe(1);
  });

  it("sets known_brand to 1 when true, 0 when false", () => {
    const withBrand = extractFeatures({ occurrences: 1, intervalVariance: 0, amountCV: 0, intentCount: 0, knownBrand: true });
    expect(withBrand[4]).toBe(1);

    const noBrand = extractFeatures({ occurrences: 1, intervalVariance: 0, amountCV: 0, intentCount: 0, knownBrand: false });
    expect(noBrand[4]).toBe(0);
  });

  it("includes subject_intent_score as feature[5]", () => {
    const features = extractFeatures({
      occurrences: 1, intervalVariance: 0, amountCV: 0, intentCount: 0,
      knownBrand: false, subjectIntentScore: 0.9,
    });
    expect(features[5]).toBe(0.9);
  });

  it("includes known_price_tier_score as feature[6]", () => {
    const features = extractFeatures({
      occurrences: 1, intervalVariance: 0, amountCV: 0, intentCount: 0,
      knownBrand: false, knownPriceTierScore: 0.5,
    });
    expect(features[6]).toBe(0.5);
  });

  it("defaults optional scores to 0 when omitted", () => {
    const features = extractFeatures({
      occurrences: 1, intervalVariance: 0, amountCV: 0, intentCount: 0, knownBrand: false,
    });
    expect(features[5]).toBe(0);
    expect(features[6]).toBe(0);
  });

  it("clamps subject_intent_score to [0, 1]", () => {
    const over = extractFeatures({
      occurrences: 1, intervalVariance: 0, amountCV: 0, intentCount: 0,
      knownBrand: false, subjectIntentScore: 5.0,
    });
    expect(over[5]).toBe(1);

    const under = extractFeatures({
      occurrences: 1, intervalVariance: 0, amountCV: 0, intentCount: 0,
      knownBrand: false, subjectIntentScore: -1,
    });
    expect(under[5]).toBe(0);
  });
});
