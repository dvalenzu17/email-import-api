// src/lib/merchantDedupe.js
// One card per merchant: dedupe + pick "best" candidate with strongest evidence.

const EVENT_PRIORITY = {
    receipt: 100,
    renewal: 90,
    billing_signal: 80,
    billing_signal_no_amount: 70,
    trial: 60,
    payment_failed: 50,
    paused: 40,
    cancellation: 35,
    unknown: 20,
    marketing: 0,
  };
  
  function normMerchant(m) {
    return String(m || "unknown").trim().toLowerCase();
  }
  
  function hasAmount(c) {
    return c?.amount != null && Number.isFinite(Number(c.amount));
  }
  
  function dateMs(c) {
    return Number(c?.evidence?.dateMs || 0) || 0;
  }
  
  function eventScore(c) {
    const t = String(c?.eventType || "unknown");
    return EVENT_PRIORITY[t] ?? EVENT_PRIORITY.unknown;
  }
  
  // Higher is better
  function rankCandidate(c) {
    const conf = Number(c?.confidence || 0);
    const amt = hasAmount(c) ? 1 : 0;
    const evt = eventScore(c);
    const rec = dateMs(c) ? 1 : 0;
  
    // Prefer: real billing events > has amount > higher confidence > newer evidence
    // Small preference for full-body over cluster-only, if you set evidenceType
    const evidenceType = String(c?.evidenceType || "");
    const fullBoost = evidenceType === "full" ? 3 : 0;
  
    return (
      evt * 10_000 +
      amt * 2_000 +
      conf * 100 +
      rec * 10 +
      fullBoost
    );
  }
  
  function bestOf(list) {
    let best = null;
    let bestScore = -Infinity;
    for (const c of list) {
      const s = rankCandidate(c);
      if (s > bestScore) {
        bestScore = s;
        best = c;
      } else if (s === bestScore) {
        // tie-break: newer wins
        if (dateMs(c) > dateMs(best)) best = c;
      }
    }
    return best;
  }
  
  export function dedupeBestPerMerchant(candidates, { max = 60 } = {}) {
    const groups = new Map();
  
    for (const c of candidates || []) {
      const key = normMerchant(c?.merchant);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
  
    const picked = [];
    for (const [, list] of groups) {
      const best = bestOf(list);
      if (!best) continue;
  
      // Attach a compact evidence summary the UI can render without guessing
      const ev = best.evidence || {};
      best.evidenceSummary = {
        subject: ev.subject || "",
        from: ev.from || ev.senderEmail || "",
        senderEmail: ev.senderEmail || "",
        senderDomain: ev.senderDomain || "",
        dateMs: ev.dateMs || null,
      };
  
      // Optional: include 2 more samples for “show more”
      best.evidenceSamples = list
        .slice()
        .sort((a, b) => dateMs(b) - dateMs(a))
        .slice(0, 3)
        .map((x) => ({
          subject: x?.evidence?.subject || "",
          from: x?.evidence?.from || x?.evidence?.senderEmail || "",
          dateMs: x?.evidence?.dateMs || null,
          senderDomain: x?.evidence?.senderDomain || "",
        }));
  
      picked.push(best);
    }
  
    // Global sort: highest value first
    picked.sort((a, b) => rankCandidate(b) - rankCandidate(a));
  
    // Hard cap so UI never gets flooded
    return picked.slice(0, Math.max(1, Math.min(200, Number(max) || 60)));
  }
  