import { describe, it, expect } from "vitest";
import { predictConfidence } from "../src/services/subscriptionModel.js";

describe("predictConfidence", () => {
  it("returns a number between 0 and 1", () => {
    const score = predictConfidence([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("returns higher confidence for strong features", () => {
    const strong = predictConfidence([1, 1, 1, 1, 1, 1, 1]);
    const weak = predictConfidence([0, 0, 0, 0, 0, 0, 0]);
    expect(strong).toBeGreaterThan(weak);
  });

  it("returns low confidence for all-zero features", () => {
    const score = predictConfidence([0, 0, 0, 0, 0, 0, 0]);
    // With bias = -2.5, sigmoid(-2.5) ~ 0.076
    expect(score).toBeLessThan(0.15);
  });

  it("returns high confidence for all-one features", () => {
    const score = predictConfidence([1, 1, 1, 1, 1, 1, 1]);
    // Sum of weights: 1.5+1.2+1.0+0.4+0.8+0.4+0.3 = 5.6, minus bias 2.5 = 3.1
    // sigmoid(3.1) ~ 0.957
    expect(score).toBeGreaterThan(0.9);
  });

  it("is monotonically increasing with more occurrences", () => {
    const base = [0, 0.5, 0.5, 0.5, 0, 0, 0];
    const more = [1, 0.5, 0.5, 0.5, 0, 0, 0];
    expect(predictConfidence(more)).toBeGreaterThan(predictConfidence(base));
  });

  it("known brand feature increases confidence", () => {
    const noBrand = predictConfidence([0.5, 0.5, 0.5, 0.5, 0, 0, 0]);
    const withBrand = predictConfidence([0.5, 0.5, 0.5, 0.5, 1, 0, 0]);
    expect(withBrand).toBeGreaterThan(noBrand);
  });

  it("handles features with more elements than weights gracefully", () => {
    // Extra features beyond the weight vector should contribute 0 (weight[i] ?? 0)
    const score = predictConfidence([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("handles fewer features than weights gracefully", () => {
    // Fewer features -> some weights contribute 0 (feature undefined * weight = NaN,
    // but reduce only iterates over features.length)
    const score = predictConfidence([0.5, 0.5]);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
