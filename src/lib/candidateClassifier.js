// src/lib/candidateClassifier.js

const POS_BILLING = [
    "receipt", "invoice", "payment", "paid", "charged", "order", "renewal",
    "subscription", "membership", "billing", "statement", "your plan",
    "total:", "amount", "tax", "subtotal", "transaction id",
  ];
  
  const NEG_MARKETING = [
    "announcement", "newsletter", "new course", "recommended", "thinking about",
    "enroll", "enrollments", "instructor", "course", "certificate path",
    "promotion", "sale", "discount", "offer", "last chance", "watch now",
  ];
  
  const EVENT_KEYWORDS = [
    { type: "payment_failed", hits: ["payment was unsuccessful", "payment failed", "problem with your payment", "card declined", "update your card"] },
    { type: "paused", hits: ["membership is paused", "paused", "pause end date", "pause start date"] },
    { type: "cancellation", hits: ["canceled", "cancelled", "has been cancelled", "subscription ended"] },
    { type: "trial", hits: ["trial", "free trial", "trial ends", "trial will end"] },
    { type: "renewal", hits: ["renewal", "will renew", "renews on", "next billing", "billing date", "auto-renew"] },
    { type: "receipt", hits: ["receipt", "invoice", "thank you for your purchase", "order confirmation", "payment received"] },
  ];
  
  function norm(s) {
    return String(s || "").toLowerCase();
  }
  
  export function classifyEventType({ subject, snippet, from }) {
    const text = `${subject || ""}\n${snippet || ""}\n${from || ""}`.toLowerCase();
  
    for (const rule of EVENT_KEYWORDS) {
      if (rule.hits.some((h) => text.includes(h))) return rule.type;
    }
  
    const billingScore = POS_BILLING.reduce((acc, k) => acc + (text.includes(k) ? 1 : 0), 0);
    const marketingScore = NEG_MARKETING.reduce((acc, k) => acc + (text.includes(k) ? 1 : 0), 0);
  
    if (marketingScore >= 2 && billingScore === 0) return "marketing";
    if (billingScore >= 2) return "billing_signal";
  
    return "unknown";
  }
  
  export function shouldDropCandidate(eventType) {
    // For YC demo: drop pure marketing/noise. Keep paused/payment_failed but classify them.
    return eventType === "marketing";
  }
  