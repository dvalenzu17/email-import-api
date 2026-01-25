import { extractWithLLM } from "./llmExtractor.js";

const PRICE_KWS = [
  "price increase",
  "updating pricing",
  "new price",
  "price is changing",
  "price update",
  "effective",
];

const TRIAL_KWS = [
  "trial ends",
  "your trial ends",
  "free for",
  "won't be charged until",
  "will not be charged until",
];

const CANCEL_KWS = [
  "cancellation confirmed",
  "cancelled",
  "canceled",
  "your membership has been cancelled",
  "subscription canceled",
];

function norm(s) {
  return String(s || "").trim();
}

function lc(s) {
  return norm(s).toLowerCase();
}

function findCurrencyAmount(s) {
  // supports $12.34, USD 12.34, 12.34 USD, EUR 9,99
  const text = norm(s);
  const m1 = text.match(/\b(USD|EUR|GBP)\s*([0-9]+(?:[\.,][0-9]{1,2})?)\b/i);
  if (m1) return { currency: m1[1].toUpperCase(), amount: Number(String(m1[2]).replace(",", ".")) };

  const m2 = text.match(/\b([0-9]+(?:[\.,][0-9]{1,2})?)\s*(USD|EUR|GBP)\b/i);
  if (m2) return { currency: m2[2].toUpperCase(), amount: Number(String(m2[1]).replace(",", ".")) };

  const m3 = text.match(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)\b/);
  if (m3) return { currency: "USD", amount: Number(m3[1]) };

  return null;
}

function findEffectiveDate(s) {
  // Very best-effort: ISO date, or "effective January 5, 2026"
  const text = norm(s);

  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];

  const mdY = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+([0-9]{1,2}),\s*(20\d{2})\b/i
  );
  if (mdY) {
    const months = {
      january: "01",
      february: "02",
      march: "03",
      april: "04",
      may: "05",
      june: "06",
      july: "07",
      august: "08",
      september: "09",
      october: "10",
      november: "11",
      december: "12",
    };
    const mm = months[mdY[1].toLowerCase()];
    const dd = String(mdY[2]).padStart(2, "0");
    const yyyy = mdY[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

function confidenceFromEvidence({ type, hasAmount, hasDate }) {
  let c = 0.5;
  if (type === "price_change") c += 0.15;
  if (type === "trial") c += 0.1;
  if (type === "cancel_confirm") c += 0.1;
  if (hasAmount) c += 0.15;
  if (hasDate) c += 0.1;
  return Math.max(0, Math.min(0.95, c));
}

export async function extractSignals(email) {
  const subject = lc(email?.subject);
  const from = lc(email?.fromName || email?.from || email?.fromDomain);
  const text = lc(email?.text || "");
  const html = lc(email?.html || "");
  const hay = `${subject}\n${from}\n${text}\n${html}`;

  let type = null;

  if (CANCEL_KWS.some((k) => hay.includes(k))) type = "cancel_confirm";
  else if (PRICE_KWS.some((k) => hay.includes(k))) type = "price_change";
  else if (TRIAL_KWS.some((k) => hay.includes(k))) type = "trial";
  else if (hay.includes("renew") || hay.includes("renews") || hay.includes("renewal")) type = "renewal";
  else if (hay.includes("receipt") || hay.includes("invoice") || hay.includes("paid")) type = "receipt";

  if (!type) return [];

  const amt = findCurrencyAmount(hay);
  const effective = type === "price_change" ? findEffectiveDate(hay) : null;
  const trialEnd = type === "trial" ? findEffectiveDate(hay) : null;

  const extracted = {
    merchant: email?.fromName || email?.fromDomain || null,
    amount: amt?.amount ?? null,
    currency: amt?.currency ?? null,
    plan: email?.plan ?? null,
    billing_period: email?.billingPeriod ?? null,
    effective_date: effective,
    new_amount: type === "price_change" ? amt?.amount ?? null : null,
    trial_end_at: trialEnd,
    manage_url: email?.manageUrl ?? null,
    cancel_url: email?.cancelUrl ?? null,
    support_email: email?.supportEmail ?? null,
    invoice_id: email?.invoiceId ?? null,
  };

  const raw_spans = { source: { subject: email?.subject || null } };

  const conf = confidenceFromEvidence({
    type,
    hasAmount: !!amt,
    hasDate: !!effective || !!trialEnd,
  });

  // LLM fallback: if rules are weak, attempt optional extractor
  const llm = conf < 0.6 ? await extractWithLLM({ email }) : null;
  if (llm && llm.type) {
    return [
      {
        type: llm.type,
        extracted: llm.extracted || extracted,
        confidence: llm.confidence ?? Math.max(conf, 0.6),
        raw_spans: llm.raw_spans || llm.rawSpans || raw_spans,
      },
    ];
  }

  return [
    {
      type,
      extracted,
      confidence: conf,
      raw_spans: { source: { subject: email?.subject || null } },
    },
  ];
}

// ✅ Added: compatibility export so older imports won't crash
export async function extractSignalsFromCandidate(candidate) {
  return extractSignals(candidate);
}
