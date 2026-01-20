// src/lib/extractBilling.js
function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }
  
  function normalizeText(s) {
    return String(s || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
  }
  
  function parseAmount(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
  
    // "9,99" -> "9.99"
    if (/^\d{1,6},\d{2}$/.test(s)) s = s.replace(",", ".");
    // Remove thousand separators: 1,234.56 -> 1234.56
    s = s.replace(/(?<=\d),(?=\d{3}\b)/g, "");
  
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    if (n <= 0 || n > 1000000) return null;
    return n;
  }
  
  function symbolToCurrency(sym) {
    const x = String(sym || "").toUpperCase();
    if (x === "$") return "USD"; // ambiguous but fine default
    if (x === "€") return "EUR";
    if (x === "£") return "GBP";
    if (x === "¥") return "JPY";
    if (x === "₹") return "INR";
    if (x === "₩") return "KRW";
    if (x === "₱") return "PHP";
    if (x === "B/.") return "PAB";
    return null;
  }
  
  export function extractAmountCurrency(text) {
    const t = normalizeText(text);
  
    // Symbol: $9.99, €9,99, B/. 9.99
    const symbolRe = /(?:(B\/\.)|(\$)|(€)|(£)|(¥)|(₹)|(₩)|(₱))\s*([0-9]{1,6}(?:[.,][0-9]{2})?)/i;
    const m1 = t.match(symbolRe);
    if (m1) {
      const sym = (m1[1] || m1[2] || m1[3] || m1[4] || m1[5] || m1[6] || m1[7] || m1[8] || "").toUpperCase();
      const raw = m1[9];
      const amount = parseAmount(raw);
      const currency = symbolToCurrency(sym);
      return amount != null ? { amount, currency } : { amount: null, currency: null };
    }
  
    // Code before: USD 9.99
    const codeBefore = /\b(USD|EUR|GBP|CAD|AUD|MXN|BRL|PEN|COP|ARS|CLP|JPY|INR|KRW|PHP)\b\s*([0-9]{1,6}(?:[.,][0-9]{2})?)/i;
    const m2 = t.match(codeBefore);
    if (m2) {
      const currency = m2[1].toUpperCase();
      const amount = parseAmount(m2[2]);
      return amount != null ? { amount, currency } : { amount: null, currency: null };
    }
  
    // Code after: 9.99 USD
    const codeAfter = /([0-9]{1,6}(?:[.,][0-9]{2})?)\s*\b(USD|EUR|GBP|CAD|AUD|MXN|BRL|PEN|COP|ARS|CLP|JPY|INR|KRW|PHP)\b/i;
    const m3 = t.match(codeAfter);
    if (m3) {
      const amount = parseAmount(m3[1]);
      const currency = m3[2].toUpperCase();
      return amount != null ? { amount, currency } : { amount: null, currency: null };
    }
  
    return { amount: null, currency: null };
  }
  
  export function extractCadence(text) {
    const t = normalizeText(text).toLowerCase();
  
    if (/\b(per month|monthly|every month|\/mo|a month)\b/.test(t)) return "monthly";
    if (/\b(per year|yearly|annually|every year|\/yr|a year)\b/.test(t)) return "yearly";
    if (/\bweekly|every week\b/.test(t)) return "weekly";
  
    if (/\b(auto-?renew|renews on|next billing|billing date)\b/.test(t)) return "recurring_unknown";
    return null;
  }
  
  // Enrich top N candidates by full-fetching body text (best-effort).
  // Requires candidate.evidence.messageId (we add this in gmail.js below).
  export async function enrichTopCandidates({ candidates, topN = 25, fetchMessageText, shouldStop }) {
    if (!Array.isArray(candidates) || candidates.length === 0) return candidates;
  
    const sortedIdx = candidates
      .map((c, i) => ({ i, score: Number(c?.confidence || 0) }))
      .sort((a, b) => b.score - a.score);
  
    const picked = sortedIdx.slice(0, clamp(topN, 1, 100));
    const out = candidates.map((c) => ({ ...c }));
  
    // Keep it lightweight: sequential is fine for top 25
    for (const { i } of picked) {
      if (shouldStop?.()) break;
  
      const c = out[i];
      const msgId = c?.evidence?.messageId;
      if (!msgId) continue;
  
      // Only enrich if amount missing
      if (c.amount != null && c.currency) continue;
  
      try {
        const text = await fetchMessageText(msgId);
        if (!text) continue;
  
        const { amount, currency } = extractAmountCurrency(text);
        const cadence = extractCadence(text);
  
        if (amount != null) {
          c.amount = amount;
          c.currency = currency || c.currency || null;
          c.reason = [...(c.reason || []), "Amount extracted from full body"];
        }
  
        if (cadence) {
          c.cadenceGuess = cadence;
          c.reason = [...(c.reason || []), `Cadence extracted: ${cadence}`];
        }
  
        // No more “High” without amount
        if (c.amount == null && Number(c.confidence) > 70) {
          c.confidence = 70;
          c.confidenceLabel = "Medium";
          c.reason = [...(c.reason || []), "Confidence capped (no amount found)"];
        }
      } catch (e) {
        c.reason = [...(c.reason || []), `Enrichment failed: ${String(e?.message || e)}`];
      }
    }
  
    return out;
  }
  