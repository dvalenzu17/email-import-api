import { describe, it, expect } from "vitest";
import {
  isProcessor,
  extractProcessorMerchant,
} from "../src/services/billingProcessor.js";

describe("isProcessor", () => {
  it("recognizes Stripe domains", () => {
    expect(isProcessor("stripe.com")).toBe(true);
    expect(isProcessor("mail.stripe.com")).toBe(true);
  });

  it("recognizes Paddle domains", () => {
    expect(isProcessor("paddle.com")).toBe(true);
    expect(isProcessor("team.paddle.com")).toBe(true);
  });

  it("recognizes PayPal domains", () => {
    expect(isProcessor("paypal.com")).toBe(true);
    expect(isProcessor("e.paypal.com")).toBe(true);
  });

  it("recognizes LemonSqueezy", () => {
    expect(isProcessor("lemonsqueezy.com")).toBe(true);
  });

  it("does not recognize non-processor domains", () => {
    expect(isProcessor("netflix.com")).toBe(false);
    expect(isProcessor("gmail.com")).toBe(false);
    expect(isProcessor("example.com")).toBe(false);
  });
});

describe("extractProcessorMerchant", () => {
  // Stripe
  it("extracts merchant from Stripe receipt subject", () => {
    expect(
      extractProcessorMerchant("stripe.com", "Your $20.00 receipt from Anthropic", "")
    ).toBe("Anthropic");
  });

  it("extracts merchant from Stripe invoice subject", () => {
    expect(
      extractProcessorMerchant("stripe.com", "Invoice from Notion Labs", "")
    ).toBe("Notion Labs");
  });

  it("extracts merchant from Stripe body fallback", () => {
    expect(
      extractProcessorMerchant("stripe.com", "Payment processed", "receipt from\nANTHROPIC PBC")
    ).toBe("Anthropic Pbc");
  });

  // Paddle
  it("extracts merchant from Paddle subscription subject", () => {
    expect(
      extractProcessorMerchant("paddle.com", "Your Notion Subscription receipt", "")
    ).toBe("Notion");
  });

  // LemonSqueezy
  it("extracts merchant from LemonSqueezy subject", () => {
    expect(
      extractProcessorMerchant("lemonsqueezy.com", "Acme Corp - Payment Successful", "")
    ).toBe("Acme Corp");
  });

  // PayPal
  it("extracts merchant from PayPal recurring payment subject", () => {
    expect(
      extractProcessorMerchant("paypal.com", "Your recurring payment to Netflix", "")
    ).toBe("Netflix");
  });

  it("returns null for PayPal P2P money-sent emails", () => {
    expect(
      extractProcessorMerchant("paypal.com", "You sent $50 to John", "")
    ).toBe(null);
  });

  // Unknown processor
  it("returns null for unrecognized domain", () => {
    expect(
      extractProcessorMerchant("netflix.com", "Some subject", "some body")
    ).toBe(null);
  });

  // Chargebee
  it("extracts merchant from Chargebee invoice", () => {
    expect(
      extractProcessorMerchant("chargebee.com", "Invoice from DataDog", "")
    ).toBe("DataDog");
  });

  // Recurly
  it("extracts merchant from Recurly transaction receipt", () => {
    expect(
      extractProcessorMerchant("recurly.com", "Acme - Transaction Receipt", "")
    ).toBe("Acme");
  });
});
