// src/lib/candidateClassifier.js
// Event-type classification + negative filters.
// Fixes: "TOTAL:" (Udemy course brand) false positives by requiring *money-like* patterns for receipts.

const EVENT_RULES = [
    {
      type: "payment_failed",
      hits: [
        "payment was unsuccessful",
        "payment failed",
        "problem with your payment",
        "card declined",
        "update your card",
        "unable to process",
        "past due",
        "action required to keep",
      ],
    },
    {
      type: "paused",
      hits: ["membership is paused", "subscription is paused", "your membership is paused", "pause end date", "pause start date"],
    },
    {
      type: "cancellation",
      hits: ["canceled", "cancelled", "subscription ended", "membership ended", "has been cancelled", "sorry to see you go"],
    },
    { type: "trial", hits: ["free trial", "trial ends", "trial will end", "trial ending", "start your trial", "your trial"] },
    {
      type: "renewal",
      hits: ["renewal", "will renew", "renews on", "auto-renew", "auto renew", "next billing", "billing date", "your plan renews"],
    },
  ];
  
  const NEG_MARKETING = [
    "announcement",
    "newsletter",
    "recommended",
    "digest",
    "top picks",
    "watch now",
    "new episode",
    "new course",
    "instructor",
    "enroll",
    "enrollments",
    "course",
    "certification",
    "promotion",
    "sale",
    "discount",
    "offer",
    "deal",
    "limited time",
    "last chance",
    "introducing",
  ];
  
  const POS_BILLING = [
    "receipt",
    "invoice",
    "charged",
    "charge",
    "payment",
    "paid",
    "billing",
    "subscription",
    "membership",
    "renew",
    "auto-renew",
    "order confirmation",
    "transaction id",
    "payment received",
    "thank you for your purchase",
  ];
  
  function normText({ subject, snippet, from }) {
    return `${subject || ""}\n${snippet || ""}\n${from || ""}`.toLowerCase();
  }
  
  // Broad currency/amount detector
  function hasMoney(text) {
    const re =
      /(\$|usd|eur|gbp|mxn|cad|aud|brl|cop|pen|ars|clp|b\/\.|₡|₲|₱|¥|₹|₩|₦)\s*\d{1,6}([.,]\d{2})?|\d{1,6}([.,]\d{2})?\s*(usd|eur|gbp|mxn|cad|aud|brl|cop|pen|ars|clp)/i;
    return re.test(text);
  }
  
  export function classifyEventType({ subject, snippet, from }) {
    const text = normText({ subject, snippet, from });
  
    // Marketing override: multiple marketing terms + no money + no invoice/receipt => marketing
    const marketingScore = NEG_MARKETING.reduce((acc, k) => acc + (text.includes(k) ? 1 : 0), 0);
    if (marketingScore >= 2 && !hasMoney(text) && !text.includes("invoice") && !text.includes("receipt")) {
      return "marketing";
    }
  
    // Hard rules first
    for (const r of EVENT_RULES) {
      if (r.hits.some((h) => text.includes(h))) return r.type;
    }
  
    // Receipt requires money OR explicit invoice/receipt phrasing (avoids Udemy TOTAL:)
    const looksReceipt =
      text.includes("receipt") ||
      text.includes("invoice") ||
      text.includes("order confirmation") ||
      text.includes("payment received") ||
      text.includes("thank you for your purchase");
  
    if (looksReceipt && (hasMoney(text) || text.includes("invoice"))) return "receipt";
  
    // Fallback scoring
    const billingScore = POS_BILLING.reduce((acc, k) => acc + (text.includes(k) ? 1 : 0), 0);
    if (billingScore >= 2) return hasMoney(text) ? "billing_signal" : "billing_signal_no_amount";
    if (marketingScore >= 2) return "marketing";
  
    return "unknown";
  }
  
  export function shouldDropCandidate(eventType, evidence) {
    if (eventType === "marketing") return true;
  
    // Hard-drop education/newsletters with no money/receipt
    const t = normText(evidence || {});
    const eduNoMoney =
      (t.includes("course") || t.includes("instructor") || t.includes("certification")) &&
      !hasMoney(t) &&
      !t.includes("invoice") &&
      !t.includes("receipt");
    if (eduNoMoney) return true;
  
    return false;
  }
  