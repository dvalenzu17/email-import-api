import { describe, it, expect } from "vitest";
import {
  normalizeMerchant,
  isSameMerchant,
} from "../src/services/merchantNormalizer.js";

describe("normalizeMerchant", () => {
  it("lowercases merchant names", () => {
    expect(normalizeMerchant("NETFLIX")).toBe("netflix");
  });

  it("strips .com TLD", () => {
    expect(normalizeMerchant("NETFLIX.COM")).toBe("netflix");
  });

  it("strips .net TLD", () => {
    expect(normalizeMerchant("example.net")).toBe("example");
  });

  it("strips .io TLD", () => {
    expect(normalizeMerchant("sentry.io")).toBe("sentry");
  });

  it("strips 'Inc' suffix", () => {
    expect(normalizeMerchant("Netflix Inc")).toBe("netflix");
  });

  it("strips 'Inc.' suffix", () => {
    expect(normalizeMerchant("Netflix Inc.")).toBe("netflix");
  });

  it("strips comma-separated 'Inc.'", () => {
    expect(normalizeMerchant("Netflix, Inc.")).toBe("netflix");
  });

  it("strips 'LLC' suffix", () => {
    expect(normalizeMerchant("Acme LLC")).toBe("acme");
  });

  it("strips 'Ltd' suffix", () => {
    expect(normalizeMerchant("Company Ltd")).toBe("company");
  });

  it("strips 'AB' suffix (Swedish companies)", () => {
    expect(normalizeMerchant("Spotify AB")).toBe("spotify");
  });

  it("strips 'GmbH' suffix", () => {
    expect(normalizeMerchant("Company GmbH")).toBe("company");
  });

  it("preserves + in brand names", () => {
    expect(normalizeMerchant("Disney+")).toBe("disney+");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeMerchant("Adobe   Systems")).toBe("adobe systems");
  });

  it("handles empty/null input", () => {
    expect(normalizeMerchant("")).toBe("");
    expect(normalizeMerchant(null)).toBe("");
  });

  it("strips punctuation noise but preserves words", () => {
    expect(normalizeMerchant("Hello! World")).toBe("hello world");
  });
});

describe("isSameMerchant", () => {
  it("matches identical names", () => {
    expect(isSameMerchant("Netflix", "Netflix")).toBe(true);
  });

  it("matches case-insensitive", () => {
    expect(isSameMerchant("NETFLIX", "netflix")).toBe(true);
  });

  it("matches after stripping suffixes", () => {
    expect(isSameMerchant("Netflix, Inc.", "NETFLIX.COM")).toBe(true);
  });

  it("does not match different merchants", () => {
    expect(isSameMerchant("Netflix", "Spotify")).toBe(false);
  });
});
