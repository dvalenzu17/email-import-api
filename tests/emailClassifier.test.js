import { describe, it, expect } from "vitest";
import { classifyEmail, EMAIL_TYPES } from "../src/services/emailClassifier.js";

describe("classifyEmail — trial confirmations", () => {
  const trial = (subject, body) => classifyEmail(subject, body);
  const isTrial = (t) => t === EMAIL_TYPES.TRIAL_START || t === EMAIL_TYPES.TRIAL_ENDING;

  it("classifies 'free trial ends on <date>' as a trial", () => {
    expect(isTrial(trial("Your Netflix free trial", "Your free trial ends on January 22, 2026."))).toBe(true);
  });

  it("classifies \"won't be charged until\" as a trial", () => {
    expect(isTrial(trial("Your Disney+ trial", "You won't be charged until 22 January 2026."))).toBe(true);
  });

  it("classifies 'cancel before <date> to avoid being charged' as a trial", () => {
    expect(isTrial(trial("Your free trial", "Cancel before January 28, 2026 to avoid being charged $7.99."))).toBe(true);
  });

  it("classifies 'billing begins <date>' as a trial", () => {
    expect(isTrial(trial("Welcome to your trial", "After your trial, billing begins January 30, 2026."))).toBe(true);
  });

  it("classifies 'your free trial has started' as trial_start", () => {
    expect(trial("Trial started", "Your free trial has started. Enjoy!")).toBe(EMAIL_TYPES.TRIAL_START);
  });
});

describe("classifyEmail — precision (must NOT be trials)", () => {
  it("a past-charge receipt stays a receipt", () => {
    expect(classifyEmail("Your receipt from Acme", "You were charged $9.99 on January 3, 2026. No further action needed."))
      .toBe(EMAIL_TYPES.RECEIPT);
  });

  it("a plain order confirmation stays a receipt", () => {
    expect(classifyEmail("Order confirmed", "Your Etsy order #12345 has shipped. Total $24.00."))
      .toBe(EMAIL_TYPES.RECEIPT);
  });

  it("a renewal notice is not misrouted to trial", () => {
    expect(classifyEmail("Your subscription", "Your subscription renews on January 20, 2026 for $11.99."))
      .toBe(EMAIL_TYPES.RENEWAL_NOTICE);
  });

  it("a cancellation is not misrouted to trial", () => {
    expect(classifyEmail("Subscription cancelled", "Your subscription has been cancelled."))
      .toBe(EMAIL_TYPES.CANCELLATION);
  });
});
