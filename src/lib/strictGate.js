// src/lib/strictGate.js
const BILLING_KEYWORDS = [
    "receipt",
    "invoice",
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
    "trial",
    "trial ends",
    "paused",
    "pause",
    "update your card",
    "payment failed",
    "past due",
    "declined",
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
    /(\$|usd|eur|gbp|mxn|cad|aud|brl|cop|pen|ars|clp|b\/\.|₡|₲|₱|¥|₹|₩|₦)\s*\d{1,6}([.,]\d{2})?|\d{1,6}([.,]\d{2})?\s*(usd|eur|gbp|mxn|cad|aud|brl|cop|pen|ars|clp)/i;
  
  // Stuff that looks like spend/top-ups/ads rather than subscriptions
  const NEGATIVE_KEYWORDS = [
    "funds successfully added",
    "funds added",
    "top up",
    "top-up",
    "added funds",
    "ad spend",
    "ads credit",
    "campaign",
    "boost your post",
    "promote",
    "newsletter",
    "announcement",
    "recommended",
    "sale",
    "discount",
    "offer",
    "deal",
    "limited time",
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
  
  export function strictGateCandidate(candidate) {
    const ev = candidate?.evidence || {};
    const text = normEvidence(ev);
  
    // hard negatives first
    if (hitAny(text, NEGATIVE_KEYWORDS)) return { keep: false, reason: "negative_keyword" };
  
    const hasMoney = MONEY_RE.test(text) || candidate?.amount != null;
    const hasCadence = hitAny(text, CADENCE_KEYWORDS) || !!candidate?.cadenceGuess;
    const hasBilling = hitAny(text, BILLING_KEYWORDS) || ["receipt","renewal","trial","paused","payment_failed","billing_signal"].includes(candidate?.eventType);
  
    // keep rule: at least 2 strong signals OR 1 very strong (money)
    const signalCount = (hasMoney ? 1 : 0) + (hasCadence ? 1 : 0) + (hasBilling ? 1 : 0);
  
    if (hasMoney) return { keep: true, reason: "money" };
    if (signalCount >= 2) return { keep: true, reason: "two_signals" };
  
    return { keep: false, reason: "weak_signals" };
  }
  