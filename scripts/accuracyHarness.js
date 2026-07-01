/**
 * Detection accuracy harness — generalization test.
 *
 * Runs realistic billing emails (known AND unknown brands, single & multi charge,
 * pretty & taxed amounts) through the SAME extraction + detection path that
 * gmailScanService.js uses in production, then reports detected vs missed.
 *
 * Usage: node scripts/accuracyHarness.js
 *
 * The `BUILD_CHARGE` function mirrors gmailScanService.js's charge construction
 * exactly (including whether `subject` is attached) so results reflect production.
 */
import {
  extractAmount, extractMerchant, extractRenewalDate,
  extractCurrencyCode, extractBillingInterval,
} from "../src/services/emailParser.js";
import { detectRecurringSubscriptions } from "../src/services/subscriptionEngine.js";

// Toggle: does the charge object carry `subject`? Production currently = false.
const ATTACH_SUBJECT = process.env.ATTACH_SUBJECT === "1";

// Mirror gmailScanService.js intent scoring.
function intentScoreFor(text, isKnownDomain) {
  let s = 0;
  if (text.includes("subscription")) s += 2;
  if (text.includes("membership")) s += 2;
  if (text.includes("automatically renew")) s += 3;
  if (text.includes("renews on")) s += 3;
  if (text.includes("next billing")) s += 3;
  if (text.includes("/month") || text.includes("per month")) s += 2;
  if (text.includes("/year") || text.includes("per year")) s += 2;
  if (text.includes("valid until")) s += 2;
  if (text.includes("cancel anytime")) s += 3;
  if (text.includes("free trial")) s += 2;
  if (text.includes("your plan")) s += 2;
  if (text.includes("plan")) s += 1;
  if (isKnownDomain) s += 3;
  return s;
}

// Build a charge exactly like gmailScanService does (subject optionally attached).
function buildCharge(email) {
  const text = email.body.toLowerCase();
  const amount = extractAmount(text);
  const merchant = extractMerchant(email.from, text, email.subject);
  const charge = {
    merchant,
    amount,
    currency: extractCurrencyCode(text),
    date: email.date,
    subscriptionIntent: intentScoreFor(text, false) >= 2,
    renewalDate: extractRenewalDate(text),
    billingInterval: extractBillingInterval(text),
  };
  if (ATTACH_SUBJECT) charge.subject = email.subject;
  return charge;
}

const d = (s) => new Date(s);

// ── Test inventory: each entry is one merchant with 1+ billing emails ─────────
const CASES = [
  {
    label: "Netflix (known, single)", expectDetect: true,
    emails: [{ from: "Netflix <info@netflix.com>", subject: "Your receipt from Netflix",
      body: "Your Netflix membership. We charged $15.49 to your card. Your plan renews monthly.", date: d("2026-06-10") }],
  },
  {
    label: "Anthropic (known, single)", expectDetect: true,
    emails: [{ from: "Anthropic <receipts@anthropic.com>", subject: "Your receipt",
      body: "Receipt. Total $20.00. Claude Pro subscription. Renews on July 5, 2026.", date: d("2026-06-05") }],
  },
  // ── UNKNOWN brands — the cases a new user (mom) actually has ──────────────
  {
    label: "Linear SaaS (unknown, single, TAXED $13.47)", expectDetect: true,
    emails: [{ from: "Linear <invoice@linear.app>", subject: "Receipt from Linear",
      body: "Thanks. Amount charged $13.47. Your subscription renews on January 5, 2026. Cancel anytime.", date: d("2026-06-01") }],
  },
  {
    label: "Lemonade insurance (unknown, single, $34.20/mo)", expectDetect: true,
    emails: [{ from: "Lemonade <billing@lemonade.com>", subject: "Payment received",
      body: "Your renters membership. We charged $34.20 per month. Next billing date is July 2, 2026.", date: d("2026-06-02") }],
  },
  {
    label: "Crunch gym (unknown, 2 charges, $43.50/mo)", expectDetect: true,
    emails: [
      { from: "Crunch <noreply@crunch.com>", subject: "Payment received",
        body: "Membership dues $43.50. Auto-renew monthly.", date: d("2026-05-04") },
      { from: "Crunch <noreply@crunch.com>", subject: "Payment received",
        body: "Membership dues $43.50. Auto-renew monthly.", date: d("2026-06-04") },
    ],
  },
  {
    label: "The Athletic (unknown, single, pretty $11.99)", expectDetect: true,
    emails: [{ from: "The Athletic <subs@theathletic.com>", subject: "Your subscription",
      body: "Your subscription. $11.99 charged. Renews monthly. Cancel anytime.", date: d("2026-06-08") }],
  },
  // ── Negative control — a one-time purchase should NOT be detected ─────────
  {
    label: "Etsy one-time order (should NOT detect)", expectDetect: false,
    emails: [{ from: "Etsy <transaction@etsy.com>", subject: "Receipt",
      body: "Order total $24.30. Thank you for your purchase.", date: d("2026-06-09") }],
  },
];

const allCharges = [];
for (const c of CASES) for (const e of c.emails) allCharges.push({ ...buildCharge(e), _case: c.label });

const detected = detectRecurringSubscriptions(allCharges, {});
const detectedByCase = new Map();
for (const r of detected) {
  // Match detection back to a case by merchant containment (best-effort for display).
  detectedByCase.set(r.merchant, r);
}

console.log(`\n=== ACCURACY HARNESS  (ATTACH_SUBJECT=${ATTACH_SUBJECT ? "1" : "0"}) ===\n`);
let hits = 0, falsePos = 0, misses = 0;
for (const c of CASES) {
  // A case counts as detected if any detection's merchant matches its charges' merchant.
  const merchants = new Set(c.emails.map((e) => {
    const t = e.body.toLowerCase();
    return extractMerchant(e.from, t, e.subject);
  }));
  const found = detected.find((r) => {
    const rl = r.merchant.toLowerCase();
    return [...merchants].some((m) => rl.includes(m.toLowerCase()) || m.toLowerCase().includes(rl));
  });
  const ok = c.expectDetect ? !!found : !found;
  if (c.expectDetect && found) hits++;
  if (c.expectDetect && !found) misses++;
  if (!c.expectDetect && found) falsePos++;
  const status = ok ? "✅" : (c.expectDetect ? "❌ MISSED" : "⚠️ FALSE POSITIVE");
  const conf = found ? ` (conf ${found.confidence}, ${found.merchant} ${found.renewalAmount})` : "";
  console.log(`${status.padEnd(18)} ${c.label}${conf}`);
}
const recall = hits / CASES.filter((c) => c.expectDetect).length;
console.log(`\n  Recall: ${hits}/${CASES.filter((c) => c.expectDetect).length} (${(recall * 100).toFixed(0)}%) | Misses: ${misses} | False positives: ${falsePos}\n`);
