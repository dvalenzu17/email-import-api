// src/lib/negativeFilters.js

const BILLING_KEYWORDS = [
    "invoice",
    "receipt",
    "billing",
    "billed",
    "charged",
    "charge",
    "payment",
    "paid",
    "subscription",
    "membership",
    "renew",
    "renews",
    "auto-renew",
    "auto renew",
    "next billing",
    "trial ends",
    "purchase confirmed",
    "order confirmation",
    "manage subscription",
    "cancel subscription",
  ];
  
  const CADENCE_KEYWORDS = [
    "monthly",
    "per month",
    "/mo",
    "every month",
    "annual",
    "yearly",
    "per year",
    "/yr",
    "annually",
    "weekly",
    "every week",
  ];
  
  const MONEY_RE =
    /(\$|usd|eur|gbp|mxn|cad|aud|brl|cop|pen|ars|clp|b\/\.|₱|¥|₹|₩|₦)\s*\d{1,6}([.,]\d{2})?|\d{1,6}([.,]\d{2})?\s*(usd|eur|gbp|mxn|cad|aud|brl|cop|pen|ars|clp)/i;
  
  // “Not a subscription” signals
  const NEGATIVE_KEYWORDS = [
    // ads/top-ups/credits
    "funds successfully added",
    "funds added",
    "added funds",
    "top up",
    "top-up",
    "ad spend",
    "ads credit",
    "campaign",
    "promote",
    "boost",
    "credit applied",
  
    // marketing noise
    "newsletter",
    "announcement",
    "recommended",
    "sale",
    "discount",
    "offer",
    "deal",
    "limited time",
    "black friday",
    "cyber monday",
  ];
  
  function normEvidence(ev) {
    const from = ev?.from || ev?.senderEmail || "";
    const subject = ev?.subject || "";
    const snippet = ev?.snippet || "";
    return `${subject}\n${snippet}\n${from}`.toLowerCase();
  }
  
  function hitAny(text, list) {
    return list.some((k) => text.includes(k));
  }
  
  export function shouldDropByEventType(candidate) {
    const t = String(candidate?.eventType || "unknown");
    // ✅ your preference: do NOT allow these in the list
    return t === "top_up" || t === "ad_spend" || t === "promo";
  }
  
  export function strictGate(candidate) {
    const ev = candidate?.evidence || {};
    const text = normEvidence(ev);
  
    if (shouldDropByEventType(candidate)) return { keep: false, why: "dropped_event_type" };

    // Status-only cards: keep, but exclude from spend math
    const t = String(candidate?.eventType || "");
    if (t === "paused" || t === "payment_failed") {
      candidate.cardType = "status";
      candidate.excludeFromSpend = true;
    }
    if (hitAny(text, NEGATIVE_KEYWORDS)) return { keep: false, why: "negative_keyword" };
  
    const hasMoney = candidate?.amount != null || MONEY_RE.test(text);
    const hasCadence = !!candidate?.cadenceGuess || hitAny(text, CADENCE_KEYWORDS);
    const hasBilling = hitAny(text, BILLING_KEYWORDS);
  
    // strict rule: must have money OR cadence OR billing
    if (!hasMoney && !hasCadence && !hasBilling) return { keep: false, why: "no_strong_signals" };
  
    // extra strict: if only “billing-ish” with no money/cadence, force needsConfirm + cap confidence
    if (hasBilling && !hasMoney && !hasCadence) {
      candidate.needsConfirm = true;
      if (Number(candidate.confidence || 0) > 70) {
        candidate.confidence = 70;
        candidate.confidenceLabel = "Medium";
      }
    }
  
    return { keep: true, why: "kept" };
  }
  