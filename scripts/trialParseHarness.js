/**
 * Trial-confirmation parse harness.
 *
 * The core BIB loop hinges on parsing the *trial confirmation* email correctly:
 * "you started a trial → you will be billed $X on DATE". This harness runs
 * realistic trial-confirmation bodies (varied phrasings, varied services)
 * through the REAL date extractor and reports whether the exact bill date is
 * recovered — the "never gets a date wrong" guarantee, made measurable.
 *
 * Read-only: imports the shipping parser, changes nothing. Run:
 *   node scripts/trialParseHarness.js
 */
import { extractRenewalDateWithLog } from "../src/services/emailParser.js";
import { classifyEmail, EMAIL_TYPES } from "../src/services/emailClassifier.js";

// Measures the REAL pipeline: classify the email, then extract the bill date
// with the trial hint the scan path would pass. `expect: null` means no future
// bill date should be produced (precision cases — receipts must not leak a date).
const CASES = [
  {
    label: "Netflix — 'trial ends on <date>'", expect: "2026-01-22",
    subject: "Your Netflix free trial",
    body: "Welcome to Netflix. Your free trial ends on January 22, 2026. On that date your membership begins at $15.49/month.",
  },
  {
    label: "Disney+ — 'won't be charged until <date>' (day-first)", expect: "2026-01-22",
    subject: "Your Disney+ trial has started",
    body: "Thanks for starting your Disney+ trial. You won't be charged until 22 January 2026.",
  },
  {
    label: "Spotify — 'charged $X on <date>'", expect: "2026-02-03",
    subject: "Your Premium trial",
    body: "Your Premium trial is active. After your trial, you'll be charged $10.99 on Feb 3, 2026.",
  },
  {
    label: "Apple — 'free trial for 7 days starting <date>' (calc)", expect: "2026-01-22",
    subject: "Your subscription confirmation",
    body: "Your free trial for 7 days starting January 15, 2026, then $9.99/month.",
  },
  {
    label: "Audible — '30-day trial ends <iso>'", expect: "2026-02-10",
    subject: "Your Audible free trial",
    body: "Your 30-day free trial ends 2026-02-10. Cancel anytime before then to avoid charges.",
  },
  {
    label: "NYT — 'billing begins <date>'", expect: "2026-01-30",
    subject: "Welcome to your trial",
    body: "Enjoy your trial. After your trial, billing begins January 30, 2026 at $4.25/week.",
  },
  {
    label: "Generic SaaS — 'first payment ... on <date>'", expect: "2026-01-25",
    subject: "Your trial has started",
    body: "Your trial has started. Your first payment of $20.00 will be on January 25, 2026.",
  },
  {
    label: "Hulu — 'cancel before <date> to avoid being charged'", expect: "2026-01-28",
    subject: "Your free trial",
    body: "You're on a free trial. Cancel before January 28, 2026 to avoid being charged $7.99.",
  },
  {
    label: "Paramount+ — 'renews on <date>' (receipt-style)", expect: "2026-01-20",
    subject: "Your subscription",
    body: "Your subscription renews on January 20, 2026 for $11.99.",
  },
  {
    label: "YouTube Premium — 'billed starting <date>'", expect: "2026-01-18",
    subject: "Your free trial is active",
    body: "Your free trial is active. You'll be billed starting January 18, 2026 at $13.99/month.",
  },
  // ── Precision (receipts): must NOT yield a future bill date ────────────────
  {
    label: "PRECISION receipt — 'was charged on <past date>'", expect: null,
    subject: "Your receipt from Acme",
    body: "Thanks for your order. You were charged $9.99 on January 3, 2026. No further action needed.",
  },
  {
    label: "PRECISION receipt — order confirmation, no dates", expect: null,
    subject: "Order confirmed",
    body: "Your Etsy order #12345 has shipped. Total $24.00. Thanks for shopping with us.",
  },
];

function iso(d) {
  if (!(d instanceof Date) || isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

console.log("\n=== TRIAL-CONFIRMATION PARSE HARNESS (classify → gated extract) ===\n");
let hit = 0, precisionOk = 0, precisionTotal = 0;
const recallCases = CASES.filter((c) => c.expect !== null);
for (const c of CASES) {
  const type = classifyEmail(c.subject, c.body);
  const isTrial = type === EMAIL_TYPES.TRIAL_START || type === EMAIL_TYPES.TRIAL_ENDING;
  const { value, strategy } = extractRenewalDateWithLog(c.body, { isTrial });
  const got = iso(value);

  if (c.expect === null) {
    precisionTotal++;
    const ok = got === null;
    if (ok) precisionOk++;
    console.log(`${ok ? "✅" : "🔴 LEAK "}  ${c.label}`);
    console.log(`        expect no date  got ${got ?? "—"}  [type=${type}]`);
  } else {
    const ok = got === c.expect;
    if (ok) hit++;
    console.log(`${ok ? "✅" : (got ? "⚠️ WRONG" : "❌ MISS ")}  ${c.label}`);
    console.log(`        expect ${c.expect}  got ${got ?? "—"}  [type=${type} / ${strategy ?? "no match"}]`);
  }
}
console.log(`\n  Bill-date recall:  ${hit}/${recallCases.length} (${Math.round((hit / recallCases.length) * 100)}%)`);
console.log(`  Receipt precision: ${precisionOk}/${precisionTotal} (no false bill dates)\n`);
