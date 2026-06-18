import { describe, it, expect } from "vitest";
import {
  extractAmount,
  extractAmountWithLog,
  extractBillingInterval,
  extractBillingIntervalWithLog,
  extractRenewalDate,
  extractRenewalDateWithLog,
  extractMerchant,
  extractMerchantWithLog,
  extractCurrencyCode,
  cleanEmailHtml,
  validateMerchantName,
  parseEmailWithLog,
} from "../src/services/emailParser.js";

// ── extractAmount ────────────────────────────────────────────────────────────

describe("extractAmount", () => {
  it("extracts USD amounts with dollar sign", () => {
    expect(extractAmount("Your total is $9.99 this month")).toBe(9.99);
  });

  it("extracts first matched amount from text", () => {
    expect(extractAmount("Subtotal $5.00 Total: $14.99")).toBe(5);
  });

  it("extracts amounts with 'charged' keyword", () => {
    expect(extractAmount("You were charged $19.99 on your card")).toBe(19.99);
  });

  it("extracts per-month plan amounts", () => {
    expect(extractAmount("Your plan is $12.99/month")).toBe(12.99);
  });

  it("extracts per-year plan amounts", () => {
    expect(extractAmount("Premium plan $99.99 per year")).toBe(99.99);
  });

  it("handles comma-formatted thousands", () => {
    expect(extractAmount("Total: $1,299.00")).toBe(1299.0);
  });

  it("extracts European decimal format (comma as decimal)", () => {
    expect(extractAmount("Votre total: €9,99")).toBe(9.99);
  });

  it("extracts GBP amounts", () => {
    expect(extractAmount("You paid £14.99 for your plan")).toBe(14.99);
  });

  it("extracts EUR amounts with symbol", () => {
    expect(extractAmount("Total: €29.99")).toBe(29.99);
  });

  it("handles US$ prefix (Apple receipts)", () => {
    expect(extractAmount("Order total: US$79.99")).toBe(79.99);
  });

  it("handles US$ with space", () => {
    expect(extractAmount("Price: US$ 4.99")).toBe(4.99);
  });

  it("returns null when no amount found", () => {
    expect(extractAmount("Thank you for your subscription")).toBe(null);
  });

  it("extracts large amounts in fallback path", () => {
    expect(extractAmount("$5000.00")).toBe(500);
  });

  it("extracts small amounts", () => {
    expect(extractAmount("charged $0.99")).toBe(0.99);
  });
});

describe("extractAmountWithLog", () => {
  it("returns value and strategy for total keyword", () => {
    const result = extractAmountWithLog("Total: $14.99");
    expect(result.value).toBe(14.99);
    expect(result.strategy).toBe("total_keyword");
  });

  it("returns value and strategy for charged keyword", () => {
    const result = extractAmountWithLog("charged $9.99 on your card");
    expect(result.value).toBe(9.99);
    expect(result.strategy).toBe("charged_keyword");
  });

  it("returns value and strategy for month pattern", () => {
    const result = extractAmountWithLog("$12.99/month plan");
    expect(result.value).toBe(12.99);
    expect(result.strategy).toBe("month_pattern");
  });

  it("returns value and strategy for euro decimal", () => {
    const result = extractAmountWithLog("€9,99 mensuel");
    expect(result.value).toBe(9.99);
    expect(result.strategy).toBe("euro_decimal");
  });

  it("returns null strategy when no amount found", () => {
    const result = extractAmountWithLog("Hello world");
    expect(result.value).toBe(null);
    expect(result.strategy).toBe(null);
  });
});

// ── extractBillingInterval ───────────────────────────────────────────────────

describe("extractBillingInterval", () => {
  it("detects 'annual'", () => {
    expect(extractBillingInterval("Your annual subscription")).toBe("yearly");
  });

  it("detects 'annually'", () => {
    expect(extractBillingInterval("Billed annually")).toBe("yearly");
  });

  it("detects 'per year'", () => {
    expect(extractBillingInterval("$99 per year")).toBe("yearly");
  });

  it("detects '/year'", () => {
    expect(extractBillingInterval("$99/year")).toBe("yearly");
  });

  it("detects '1-year'", () => {
    expect(extractBillingInterval("1-year plan")).toBe("yearly");
  });

  it("detects '12-month'", () => {
    expect(extractBillingInterval("12-month subscription")).toBe("yearly");
  });

  it("detects 'monthly'", () => {
    expect(extractBillingInterval("Your monthly plan")).toBe("monthly");
  });

  it("detects 'per month'", () => {
    expect(extractBillingInterval("$9.99 per month")).toBe("monthly");
  });

  it("detects '/month'", () => {
    expect(extractBillingInterval("$9.99/month")).toBe("monthly");
  });

  it("detects 'every month'", () => {
    expect(extractBillingInterval("Charged every month")).toBe("monthly");
  });

  it("detects 'once a month'", () => {
    expect(extractBillingInterval("Billed once a month")).toBe("monthly");
  });

  it("detects 'quarterly'", () => {
    expect(extractBillingInterval("Billed quarterly")).toBe("quarterly");
  });

  it("detects 'every 3 months'", () => {
    expect(extractBillingInterval("Charged every 3 months")).toBe("quarterly");
  });

  it("detects 'semi-annual' as yearly", () => {
    expect(extractBillingInterval("semi-annual billing")).toBe("yearly");
  });

  it("detects 'every 6 months'", () => {
    expect(extractBillingInterval("Charged every 6 months")).toBe("semiannual");
  });

  it("detects 'weekly'", () => {
    expect(extractBillingInterval("Charged weekly")).toBe("weekly");
  });

  it("detects 'biweekly'", () => {
    expect(extractBillingInterval("Billed biweekly")).toBe("biweekly");
  });

  it("detects 'every 2 weeks'", () => {
    expect(extractBillingInterval("Charged every 2 weeks")).toBe("biweekly");
  });

  it("returns null for no interval keywords", () => {
    expect(extractBillingInterval("Thank you for your purchase")).toBe(null);
  });

  it("handles null/empty input", () => {
    expect(extractBillingInterval(null)).toBe(null);
    expect(extractBillingInterval("")).toBe(null);
  });
});

// ── extractRenewalDate ───────────────────────────────────────────────────────

describe("extractRenewalDate", () => {
  it("extracts 'renews on' date (US format)", () => {
    const d = extractRenewalDate("Your subscription renews on June 15, 2026");
    expect(d).toBeInstanceOf(Date);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5); // June = 5
    expect(d.getDate()).toBe(15);
  });

  it("extracts 'next billing date' date", () => {
    const d = extractRenewalDate("Next billing date: July 1, 2026");
    expect(d).toBeInstanceOf(Date);
    expect(d.getMonth()).toBe(6); // July
  });

  it("extracts 'will renew on' date", () => {
    const d = extractRenewalDate("Your plan will renew on August 20 2026");
    expect(d).toBeInstanceOf(Date);
    expect(d.getMonth()).toBe(7); // August
  });

  it("extracts 'renewal date' with colon", () => {
    const d = extractRenewalDate("Renewal date: September 5, 2026");
    expect(d).toBeInstanceOf(Date);
    expect(d.getMonth()).toBe(8); // September
  });

  it("extracts UK/Apple day-first format", () => {
    const d = extractRenewalDate("Your subscription renews on 11 July 2025");
    expect(d).toBeInstanceOf(Date);
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(6); // July
    expect(d.getDate()).toBe(11);
  });

  it("extracts 'starting' date (Apple pattern)", () => {
    const d = extractRenewalDate("Your subscription starting June 1, 2026");
    expect(d).toBeInstanceOf(Date);
    expect(d.getMonth()).toBe(5);
  });

  it("extracts 'expires on' date", () => {
    const d = extractRenewalDate("Your plan expires on December 31, 2026");
    expect(d).toBeInstanceOf(Date);
    expect(d.getMonth()).toBe(11);
  });

  it("extracts ISO date near renew keyword", () => {
    const d = extractRenewalDate("Next billing on 2026-03-15");
    expect(d).toBeInstanceOf(Date);
    expect(d.getFullYear()).toBe(2026);
  });

  it("returns null when no date found", () => {
    expect(extractRenewalDate("Thank you for subscribing")).toBe(null);
  });
});

describe("extractRenewalDateWithLog", () => {
  it("returns value and strategy name", () => {
    const result = extractRenewalDateWithLog("Renews on June 15, 2026");
    expect(result.value).toBeInstanceOf(Date);
    expect(result.strategy).toBe("renews_on");
  });

  it("calculates Apple trial renewal date", () => {
    const result = extractRenewalDateWithLog(
      "Free trial for 1 month starting June 1, 2026"
    );
    expect(result.value).toBeInstanceOf(Date);
    expect(result.strategy).toBe("apple_trial_calculation");
    // June 1 + 1 month = July 1
    expect(result.value.getMonth()).toBe(6);
  });

  it("calculates Apple trial renewal with weeks", () => {
    const result = extractRenewalDateWithLog(
      "Free for 2 weeks starting January 1, 2026"
    );
    expect(result.value).toBeInstanceOf(Date);
    expect(result.strategy).toBe("apple_trial_calculation");
    // Jan 1 + 14 days = Jan 15
    expect(result.value.getDate()).toBe(15);
  });
});

// ── extractMerchant ──────────────────────────────────────────────────────────

describe("extractMerchant", () => {
  it("extracts known brand from email address", () => {
    expect(extractMerchant("billing@netflix.com")).toBe("netflix");
  });

  it("extracts known brand from full From header", () => {
    expect(extractMerchant("Spotify <no-reply@spotify.com>")).toBe("spotify");
  });

  it("normalizes uber domain to 'uber one'", () => {
    expect(extractMerchant("receipts@uber.com")).toBe("uber one");
  });

  it("falls back to root domain for unknown senders", () => {
    expect(extractMerchant("billing@somerandombrand.com")).toBe("somerandombrand");
  });

  it("returns 'unknown' for blocked ESPs", () => {
    expect(extractMerchant("campaign@sendgrid.net")).toBe("unknown");
  });

  it("returns 'unknown' for missing From header", () => {
    expect(extractMerchant("")).toBe("unknown");
    expect(extractMerchant(null)).toBe("unknown");
  });

  it("handles known brands via domain parts", () => {
    expect(extractMerchant("no-reply@mail.anthropic.com")).toBe("anthropic");
  });
});

describe("extractMerchantWithLog", () => {
  it("returns strategy 'known_brands_map' for known brands", () => {
    const result = extractMerchantWithLog("billing@netflix.com");
    expect(result.merchant).toBe("netflix");
    expect(result.strategy).toBe("known_brands_map");
    expect(result.confidenceBoost).toBe(0);
  });

  it("returns strategy 'domain_fallback' for unknown domains", () => {
    const result = extractMerchantWithLog("hello@acmecorp.io");
    expect(result.merchant).toBe("acmecorp");
    expect(result.strategy).toBe("domain_fallback");
  });

  it("returns strategy 'blocked_esp' for ESPs", () => {
    const result = extractMerchantWithLog("from@mailchimp.com");
    expect(result.strategy).toBe("blocked_esp");
    expect(result.merchant).toBe("unknown");
  });

  it("returns strategy 'uber_hardcode' for uber domains", () => {
    const result = extractMerchantWithLog("notifications@uber.com");
    expect(result.strategy).toBe("uber_hardcode");
    expect(result.merchant).toBe("uber one");
  });
});

// ── extractCurrencyCode ──────────────────────────────────────────────────────

describe("extractCurrencyCode", () => {
  it("detects GBP from ISO code", () => {
    expect(extractCurrencyCode("Amount: GBP 14.99")).toBe("GBP");
  });

  it("detects EUR from ISO code", () => {
    expect(extractCurrencyCode("Total EUR 29.99")).toBe("EUR");
  });

  it("detects GBP from pound sign", () => {
    expect(extractCurrencyCode("Total: £14.99")).toBe("GBP");
  });

  it("detects EUR from euro sign", () => {
    expect(extractCurrencyCode("Total: €29.99")).toBe("EUR");
  });

  it("detects CAD", () => {
    expect(extractCurrencyCode("CAD 19.99")).toBe("CAD");
  });

  it("detects AUD", () => {
    expect(extractCurrencyCode("AUD 14.99")).toBe("AUD");
  });

  it("detects NZD", () => {
    expect(extractCurrencyCode("NZD 12.00")).toBe("NZD");
  });

  it("detects CHF", () => {
    expect(extractCurrencyCode("CHF 15.00")).toBe("CHF");
  });

  it("detects JPY", () => {
    expect(extractCurrencyCode("JPY 1500")).toBe("JPY");
  });

  it("detects BRL", () => {
    expect(extractCurrencyCode("BRL 29.90")).toBe("BRL");
  });

  it("detects MXN", () => {
    expect(extractCurrencyCode("MXN 199.00")).toBe("MXN");
  });

  it("detects SEK", () => {
    expect(extractCurrencyCode("SEK 99.00")).toBe("SEK");
  });

  it("detects AUD from A$ prefix", () => {
    expect(extractCurrencyCode("A$14.99")).toBe("AUD");
  });

  it("detects CAD from C$ prefix", () => {
    expect(extractCurrencyCode("C$19.99")).toBe("CAD");
  });

  it("defaults to USD when no currency found", () => {
    expect(extractCurrencyCode("Your total is 9.99")).toBe("USD");
  });

  it("defaults to USD for empty/null input", () => {
    expect(extractCurrencyCode("")).toBe("USD");
    expect(extractCurrencyCode(null)).toBe("USD");
  });
});

// ── cleanEmailHtml ───────────────────────────────────────────────────────────

describe("cleanEmailHtml", () => {
  it("strips HTML tags and returns lowercase text", () => {
    const html = "<html><body><h1>Hello World</h1><p>Content</p></body></html>";
    const result = cleanEmailHtml(html);
    expect(result).toBe("hello worldcontent");
  });

  it("removes style and script tags", () => {
    const html = "<body><style>.x{color:red}</style><script>alert(1)</script><p>Text</p></body>";
    expect(cleanEmailHtml(html)).toBe("text");
  });

  it("decodes HTML entities", () => {
    const html = "<body>Price: &amp; Total &gt; $10</body>";
    expect(cleanEmailHtml(html)).toContain("price: & total > $10");
  });

  it("normalizes whitespace", () => {
    const html = "<body><p>Hello   \n\n   World</p></body>";
    expect(cleanEmailHtml(html)).toBe("hello world");
  });

  it("returns empty string for null input", () => {
    expect(cleanEmailHtml(null)).toBe("");
    expect(cleanEmailHtml("")).toBe("");
  });
});

// ── validateMerchantName ─────────────────────────────────────────────────────

describe("validateMerchantName", () => {
  it("accepts valid merchant names", () => {
    expect(validateMerchantName("Netflix")).toBe(true);
    expect(validateMerchantName("Spotify")).toBe(true);
    expect(validateMerchantName("Notion AI")).toBe(true);
  });

  it("rejects null/empty/unknown", () => {
    expect(validateMerchantName(null)).toBe(false);
    expect(validateMerchantName("")).toBe(false);
    expect(validateMerchantName("unknown")).toBe(false);
  });

  it("rejects blocklisted names", () => {
    expect(validateMerchantName("subscription")).toBe(false);
    expect(validateMerchantName("plan")).toBe(false);
    expect(validateMerchantName("premium")).toBe(false);
    expect(validateMerchantName("receipt")).toBe(false);
    expect(validateMerchantName("invoice")).toBe(false);
  });
});

// ── parseEmailWithLog (integration) ──────────────────────────────────────────

describe("parseEmailWithLog", () => {
  it("extracts all fields from a typical billing email", () => {
    const result = parseEmailWithLog({
      fromHeader: "Netflix <billing@netflix.com>",
      html: "",
      text: "Your Netflix subscription has been renewed. Total: $15.49 per month. Next billing date: July 1, 2026.",
      subject: "Your receipt from Netflix",
    });

    expect(result.merchant).toBe("netflix");
    expect(result.amount).toBe(15.49);
    expect(result.currency).toBe("USD");
    expect(result.billingInterval).toBe("monthly");
    expect(result.renewalDate).toBeInstanceOf(Date);
    expect(result.extractionLog).toBeDefined();
    expect(result.extractionLog.merchant.failed).toBe(false);
    expect(result.extractionLog.amount.failed).toBe(false);
  });

  it("reports failed fields in extractionLog", () => {
    const result = parseEmailWithLog({
      fromHeader: "no-reply@unknown-sender.com",
      html: "",
      text: "Welcome to our service!",
      subject: "Welcome",
    });

    expect(result.amount).toBe(null);
    expect(result.extractionLog.amount.failed).toBe(true);
    expect(result.extractionLog.amount.failReason).toBe("no_amount_pattern_matched");
    expect(result.extractionLog.renewalDate.failed).toBe(true);
    expect(result.extractionLog.billingInterval.failed).toBe(true);
  });
});
