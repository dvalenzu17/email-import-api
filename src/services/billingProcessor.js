/**
 * Billing processor passthrough.
 *
 * Many SaaS products bill through third-party processors (Stripe, Paddle, etc.)
 * whose From domain is the processor, not the merchant. Without this layer,
 * "Receipt from Anthropic" sent by stripe.com would resolve to merchant "stripe"
 * instead of "anthropic".
 *
 * Each extractor receives (subject, body) and returns the real merchant name or null.
 * Returning null means we couldn't extract the merchant — the caller should
 * return "unknown" rather than falling through to the processor domain name.
 */

// ── Per-processor extraction functions ───────────────────────────────────────

function extractStripe(subject, body) {
  // "Your $20.00 receipt from Anthropic"
  // "Receipt from Anthropic, Inc. ($20.00)"
  // "Invoice from Anthropic"
  let m =
    subject.match(/receipt from ([^,(]+)/i) ||
    subject.match(/invoice from ([^,(]+)/i) ||
    subject.match(/payment to ([^,(]+)/i);
  if (m) return m[1].trim();

  // Body: Stripe's PDF-style "RECEIPT FROM\nANTHROPIC PBC"
  m = body.match(/receipt from[\s\n]+([A-Z][A-Z\s]{1,40})/);
  if (m) return titleCase(m[1].trim());

  return null;
}

function extractPaddle(subject, body) {
  // "Your Notion Subscription" → "Notion"
  // "Your Notion AI Monthly subscription receipt"
  let m = subject.match(/^your (.+?) (?:subscription|plan|billing)/i);
  if (m) return m[1].trim();

  // Body phrases
  m =
    body.match(/thank you for (?:purchasing|subscribing to) ([^\n.!,]+)/i) ||
    body.match(/you(?:'re| are) (?:now )?subscribed to ([^\n.!,]+)/i) ||
    body.match(/subscription to ([^\n.!,]+) has been/i);
  if (m) return m[1].trim();

  return null;
}

function extractLemonSqueezy(subject, body) {
  // "[Merchant] - Payment Successful"
  // "Your [Merchant] Subscription"
  let m =
    subject.match(/^([^-–|]+?) [-–|] (?:payment|receipt|invoice|order)/i) ||
    subject.match(/^your (.+?) (?:subscription|receipt)/i);
  if (m) return m[1].trim();
  return null;
}

function extractFastSpring(subject, body) {
  // "Your [Merchant] Order Confirmation"
  // "[Merchant] Receipt"
  let m =
    subject.match(/^your (.+?) order/i) ||
    subject.match(/^(.+?) (?:receipt|invoice)$/i);
  if (m) return m[1].trim();
  return null;
}

function extractPayPal(subject, body) {
  // Only extract from PayPal SUBSCRIPTION/RECURRING emails, not P2P money-sent emails.
  // "You sent $X to Person" emails are person-to-person transfers, not subscriptions.
  // "You sent a recurring payment to Netflix"
  // "Your subscription payment to Spotify has been processed"
  if (
    subject.toLowerCase().includes("money sent") ||
    subject.toLowerCase().includes("you sent") ||
    subject.toLowerCase().includes("you paid") ||
    body.toLowerCase().includes("money sent")
  ) return null; // P2P transfer — not a subscription

  let m =
    subject.match(/(?:recurring|subscription|automatic) payment to ([^.$]+)/i) ||
    body.match(/(?:recurring|subscription) payment (?:to|for) ([A-Z][^\n.,]+)/i);
  if (m) return m[1].trim();
  return null;
}

function extractChargebee(subject, body) {
  // "Invoice from [Merchant]"
  // "[Merchant] - Invoice #INV-001"
  let m =
    subject.match(/invoice from ([^-–]+)/i) ||
    subject.match(/^([^-–]+?) [-–] invoice/i);
  if (m) return m[1].trim();
  return null;
}

function extractRecurly(subject, body) {
  // "[Merchant] - Transaction Receipt"
  // "[Merchant] Subscription Confirmed"
  let m =
    subject.match(/^([^-–]+?) [-–] (?:transaction|receipt|subscription)/i) ||
    subject.match(/^(.+?) subscription confirmed/i);
  if (m) return m[1].trim();
  return null;
}

function extract2Checkout(subject, body) {
  // "Your [Merchant] order"
  // "[Merchant] Order Confirmation"
  let m =
    subject.match(/^your (.+?) order/i) ||
    subject.match(/^(.+?) order confirmation/i);
  if (m) return m[1].trim();
  return null;
}

function extractZuora(subject, body) {
  // "Invoice from [Merchant]"
  let m = subject.match(/invoice from ([^-–,]+)/i);
  if (m) return m[1].trim();
  return null;
}

// ── Processor registry ────────────────────────────────────────────────────────

const PROCESSOR_EXTRACTORS = [
  { domains: ["stripe.com", "mail.stripe.com"],         fn: extractStripe        },
  { domains: ["paddle.com", "team.paddle.com", "paddle.net"], fn: extractPaddle  },
  { domains: ["lemonsqueezy.com"],                       fn: extractLemonSqueezy  },
  { domains: ["fastspring.com", "onfastspring.com"],     fn: extractFastSpring    },
  { domains: ["paypal.com", "paypal-mail.com", "e.paypal.com"], fn: extractPayPal },
  { domains: ["chargebee.com", "cb-billing.com"],        fn: extractChargebee     },
  { domains: ["recurly.com"],                            fn: extractRecurly       },
  { domains: ["2checkout.com", "avangate.com"],          fn: extract2Checkout     },
  { domains: ["zuora.com"],                              fn: extractZuora         },
];

// Flat set of all processor domains for fast membership checks
export const PROCESSOR_DOMAIN_SET = new Set(
  PROCESSOR_EXTRACTORS.flatMap((p) => p.domains)
);

/**
 * Returns true if the from-domain belongs to a known billing processor.
 * @param {string} domain — e.g. "mail.stripe.com"
 */
export function isProcessor(domain) {
  const d = domain.toLowerCase();
  for (const dom of PROCESSOR_DOMAIN_SET) {
    if (d.includes(dom)) return true;
  }
  return false;
}

/**
 * Extracts the actual merchant from a billing processor email.
 * Returns null if the processor is recognised but the merchant can't be parsed.
 *
 * @param {string} fromDomain
 * @param {string} subject
 * @param {string} body       — plain text
 * @returns {string|null}
 */
export function extractProcessorMerchant(fromDomain, subject, body) {
  const d = fromDomain.toLowerCase();
  for (const { domains, fn } of PROCESSOR_EXTRACTORS) {
    if (domains.some((dom) => d.includes(dom))) {
      const result = fn(subject, body);
      if (result) return result.replace(/\s+/g, " ").trim();
    }
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function titleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
