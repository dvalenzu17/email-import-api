// lib/detect.js
// Detection engine: conservative + explainable + open-world.

import { resolveMerchant } from "./merchantResolver.js";

// ---------- text helpers ----------
function normalizeTextForParsing(input) {
  return (input || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\t\r]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function safeLower(s) {
  return (s || "").toString().toLowerCase();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function bumpNullReason(context, key) {
  try {
    const map = context?.stats?.nullReasons;
    if (!map) return;
    map[key] = (map[key] || 0) + 1;
  } catch {}
}

function maybePushNearMiss(context, sample) {
  try {
    const arr = context?.stats?.nearMisses;
    if (!arr) return;
    if (arr.length >= 25) return;

    // Keep samples low-PII and small.
    const safe = {
      dropReason: String(sample?.dropReason || "unknown"),
      fromDomain: String(sample?.fromDomain || ""),
      merchantGuess: sample?.merchantGuess ? String(sample.merchantGuess).slice(0, 80) : null,
      resolverConfidence: Number(sample?.resolverConfidence || 0),
      confidence: Number(sample?.confidence || 0),
      floor: Number(sample?.floor || 0),
      evidenceType: String(sample?.evidenceType || ""),
      hasAmount: Boolean(sample?.hasAmount),
      hasNextRenewal: Boolean(sample?.hasNextRenewal),
      hasCadence: Boolean(sample?.hasCadence),
      pos: Number(sample?.pos || 0),
      neg: Number(sample?.neg || 0),
      bulkHeader: Boolean(sample?.bulkHeader),
      subject: sample?.subject ? String(sample.subject).slice(0, 140) : "",
      snippet: sample?.snippet ? String(sample.snippet).slice(0, 160) : "",
    };

    arr.push(safe);
  } catch {}
}

// ---------- link domain extraction ----------
function extractLinkDomains({ text = "", html = "" }) {
  const domains = new Set();
  const scan = `${text}\n${html}`;
  const urls = scan.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  for (const u of urls.slice(0, 200)) {
    try {
      const host = new URL(u).hostname;
      if (host) domains.add(host.toLowerCase());
    } catch {}
  }
  return [...domains];
}

// ---------- marketing vs transactional classifier ----------
const POSITIVE_SIGNAL_PHRASES = [
  "payment successful",
  "payment was successful",
  "we charged",
  "you were charged",
  "has been charged",
  "charged to",
  "invoice",
  "receipt",
  "tax invoice",
  "order confirmation",
  "purchase confirmed",
  "subscription renewed",
  "will renew",
  "renews on",
  "next billing date",
  "billing date",
  "amount due",
  "you paid",
  "total",
  "trial ends",
  "subscription confirmed",
  "expires on",
  "expiring",
];

const NEGATIVE_SIGNAL_PHRASES = [
  "newsletter",
  "promo",
  "promotion",
  "offer",
  "sale",
  "discount",
  "limited time",
  "recommended",
  "suggested",
  "restaurants everyone is loving",
  "new features",
  "update",
];

// ✅ FIX: don’t treat List-Unsubscribe as “bulk” (too many legit receipts have it)
function headerIsBulk(headerMap = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headerMap)) h[safeLower(k)] = String(v || "");
  const precedence = safeLower(h["precedence"] || "");
  const autoSubmitted = safeLower(h["auto-submitted"] || "");
  const listId = safeLower(h["list-id"] || "");

  const bulk = precedence.includes("bulk") || precedence.includes("list") || precedence.includes("junk");
  const auto = autoSubmitted.includes("auto-generated") || autoSubmitted.includes("auto-replied");
  const hasListId = !!listId;

  return bulk || auto || hasListId;
}

function classifyEmail({ subject = "", text = "", snippet = "", headerMap = {}, fromDomain = "" }) {
  const s = safeLower(`${subject}\n${snippet}\n${text}`);

  const pos = POSITIVE_SIGNAL_PHRASES.reduce((n, p) => (s.includes(p) ? n + 1 : n), 0);
  const neg = NEGATIVE_SIGNAL_PHRASES.reduce((n, p) => (s.includes(p) ? n + 1 : n), 0);

  const isApple = /(^|\.)apple\.com$/.test(fromDomain) || fromDomain.includes("apple.com");
  const appleReceiptHint = isApple && /(subscription|purchase confirmed|your receipt|app store|itunes)/i.test(s);

  const bulkHeader = headerIsBulk(headerMap);

  // marketing heavy when: bulk + negative + weak/no receipt language
  const marketingHeavy = bulkHeader && neg >= 1 && pos === 0 && !appleReceiptHint;

  // transactional when we have enough positives or explicit Apple receipt hint
  const likelyTransactional = appleReceiptHint || pos >= 2 || /(invoice|receipt|charged|payment|subscription renewed)/i.test(s);

  return {
    appleReceiptHint,
    bulkHeader,
    marketingHeavy,
    likelyTransactional,
    pos,
    neg,
  };
}

// ---------- money parsing ----------
const CURRENCY_SYMBOLS = {
  "$": "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₩": "KRW",
  "₹": "INR",
  "R$": "BRL",
  "C$": "CAD",
  "A$": "AUD",
};

function parseMoney(raw) {
  const str = normalizeTextForParsing(raw);
  const m = str.match(
    /(US\$|C\$|A\$|R\$|\$|€|£|¥|₩|₹)?\s*(USD|EUR|GBP|JPY|KRW|INR|BRL|CAD|AUD)?\s*([0-9]{1,3}(?:[.,\s][0-9]{3})*(?:[.,][0-9]{2})|[0-9]+(?:[.,][0-9]{2}))\s*(USD|EUR|GBP|JPY|KRW|INR|BRL|CAD|AUD)?\s*(US\$|C\$|A\$|R\$|\$|€|£|¥|₩|₹)?/i
  );
  if (!m) return null;

  const sym1 = m[1];
  const code1 = m[2];
  const number = m[3];
  const code2 = m[4];
  const sym2 = m[5];

  const currency = (code1 || code2 || (sym1 && CURRENCY_SYMBOLS[sym1]) || (sym2 && CURRENCY_SYMBOLS[sym2]) || "USD").toUpperCase();

  let n = number.replace(/\s/g, "");
  const lastComma = n.lastIndexOf(",");
  const lastDot = n.lastIndexOf(".");
  const decimalSep = lastComma > lastDot ? "," : ".";
  if (decimalSep === ",") n = n.replace(/\./g, "").replace(/,/g, ".");
  else n = n.replace(/,/g, "");

  const amount = Number.parseFloat(n);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return { amount, currency };
}

function extractAmount({ subject = "", text = "", html = "" }) {
  const haystack = `${subject}\n${text}\n${html}`;

  // prioritize total/charged lines
  const totalLine = haystack.match(/\b(total|amount due|you paid|charged)\b[^\n]{0,80}/i);
  if (totalLine) {
    const parsed = parseMoney(totalLine[0]);
    if (parsed) return parsed;
  }

  const moneyMatches = haystack.match(
    /(US\$|C\$|A\$|R\$|\$|€|£|¥|₩|₹)?\s*(USD|EUR|GBP|JPY|KRW|INR|BRL|CAD|AUD)?\s*[0-9]{1,3}(?:[.,\s][0-9]{3})*(?:[.,][0-9]{2})\s*(USD|EUR|GBP|JPY|KRW|INR|BRL|CAD|AUD)?/gi
  );
  if (!moneyMatches) return null;

  // keep it conservative: only accept amounts near billing-ish keywords
  const keywords = /(total|charged|you paid|amount due|payment|invoice|receipt|renewal|subscription)/i;
  for (const raw of moneyMatches.slice(0, 20)) {
    const idx = haystack.toLowerCase().indexOf(raw.toLowerCase());
    const window = haystack.slice(Math.max(0, idx - 60), idx + raw.length + 60);
    if (!keywords.test(window)) continue;

    const parsed = parseMoney(raw);
    if (parsed) return parsed;
  }

  return null;
}

// ---------- cadence + dates ----------
function extractCadence({ subject = "", text = "", html = "" }, inferredCadence = null) {
  const s = safeLower(`${subject}\n${text}\n${html}`);

  if (/\bweekly\b|\bper week\b|\/week|\bwk\b/.test(s)) return "weekly";
  if (/\bmonthly\b|\bper month\b|\/mo\b|\/month\b/.test(s)) return "monthly";
  if (/\bquarterly\b|\bper quarter\b/.test(s)) return "quarterly";
  if (/\byearly\b|\bannual\b|\bannually\b|\bper year\b|\/year\b/.test(s)) return "yearly";

  return inferredCadence;
}

function extractNextRenewal({ subject = "", text = "", html = "" }) {
  const s = `${subject}\n${text}\n${html}`;

  const iso = s.match(/\b(20\d{2})-(0\d|1[0-2])-(0\d|[12]\d|3[01])\b/);
  if (iso) return iso[0];

  const month = s.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+([0-3]?\d),\s*(20\d{2})\b/i);
  if (month) {
    const [_, mon, day, year] = month;
    const mm =
      { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" }[
        mon.toLowerCase().slice(0, 3)
      ];
    const dd = String(day).padStart(2, "0");
    return `${year}-${mm}-${dd}`;
  }

  return null;
}

function inferCadenceFromDates(dates) {
  if (!dates || dates.length < 2) return null;
  const sorted = [...dates].sort((a, b) => a - b);
  const diffs = [];
  for (let i = 1; i < sorted.length; i++) diffs.push(sorted[i] - sorted[i - 1]);
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)];
  const days = median / (1000 * 60 * 60 * 24);

  if (days >= 6 && days <= 8) return "weekly";
  if (days >= 25 && days <= 35) return "monthly";
  if (days >= 80 && days <= 100) return "quarterly";
  if (days >= 330 && days <= 400) return "yearly";
  return null;
}

// ---------- plan/product extraction ----------
function extractPlan({ subject = "", text = "" }) {
  const s = normalizeTextForParsing(`${subject}\n${text}`);

  const p1 = s.match(/\b(Plan|Membership|Subscription)\b\s*[:\-]\s*([^\n]{2,80})/i);
  if (p1?.[2]) return p1[2].trim();

  const p2 = s.match(/\b([A-Z][A-Za-z0-9+&()'’.\- ]{2,60})\s*\((Monthly|Yearly|Annual|Weekly)\)/);
  if (p2?.[0]) return p2[0].trim();

  return null;
}

// ---------- platform receipts ----------
function extractAppleLineItemMerchant({ subject = "", text = "", html = "" }) {
  const s = normalizeTextForParsing(`${subject}\n${text}`);

  const app = s.match(/\bApp\b\s*[:\-]?\s*([^\n]{2,80})/i);
  const sub = s.match(/\bSubscription\b\s*[:\-]?\s*([^\n]{2,80})/i);
  const provider = s.match(/\b(Content Provider|Developer)\b\s*[:\-]?\s*([^\n]{2,80})/i);

  const candidate = (app && app[1]) || (sub && sub[1]) || (provider && provider[2]);
  return candidate ? candidate.trim() : null;
}

function extractPayPalMerchant({ subject = "", text = "" }) {
  const s = normalizeTextForParsing(`${subject}\n${text}`);
  const m = s.match(/\bto\b\s+([A-Z][A-Za-z0-9&'’.\- ]{2,60})\b/);
  return m?.[1] ? m[1].trim() : null;
}

function extractGooglePlayMerchant({ subject = "", text = "" }) {
  const s = normalizeTextForParsing(`${subject}\n${text}`);
  const m = s.match(/\bfor\b\s+([A-Z][A-Za-z0-9&'’.\- ]{2,60})\b/);
  return m?.[1] ? m[1].trim() : null;
}

// ---------- public: quickScreenMessage ----------
export function quickScreenMessage({ from = "", subject = "", snippet = "", headerMap = {} }) {
  const s = safeLower(`${from}\n${subject}\n${snippet}`);

  const hardNo = /(porn|sex|viagra|casino|loan|crypto giveaway|airdrop)/i.test(s);
  if (hardNo) return { ok: false, reason: "hard_no" };

  const weak = /(receipt|invoice|charged|subscription|renew|trial ends|payment)/i.test(s);
  if (!weak) return { ok: false, reason: "weak_signal" };

  const bulk = headerIsBulk(headerMap);
  if (bulk && /(newsletter|promo|offer|discount|sale)/i.test(s)) return { ok: false, reason: "marketing" };

  return { ok: true, reason: "ok" };
}

// ---------- aggregation ----------
export function aggregateCandidates(raw, maxCandidates = 80) {
  const groups = new Map();

  for (const c of raw || []) {
    const key = `${safeLower(c.merchant || "")}::${safeLower(c.plan || "")}`;
    const prev = groups.get(key);

    if (!prev) {
      groups.set(key, { best: c, dates: c.dateMs ? [c.dateMs] : [], evidence: [c] });
      continue;
    }

    prev.evidence.push(c);
    if (c.dateMs) prev.dates.push(c.dateMs);

    if ((c.confidence || 0) > (prev.best.confidence || 0)) prev.best = c;
  }

  const out = [];
  for (const { best, dates, evidence } of groups.values()) {
    const inferredCadence = inferCadenceFromDates(dates);
    const merged = { ...best };

    merged.cadence = merged.cadence || inferredCadence || null;

    if (!merged.nextRenewal) {
      const nr = evidence.map((e) => e.nextRenewal).filter(Boolean).sort()[0];
      if (nr) merged.nextRenewal = nr;
    }

    merged.eventCount = evidence.length;

    if (dates.length >= 2 && inferredCadence) {
      merged.confidence = clamp((merged.confidence || 0) + 10, 0, 100);
      merged.reason = [...(merged.reason || []), `Cadence inferred from ${dates.length} emails`];
    }

    if (dates.length <= 1 && !merged.nextRenewal && !merged.cadence) {
      merged.confidence = Math.min(merged.confidence || 0, 70);
      merged.reason = [...(merged.reason || []), "Single email evidence (capped confidence)"];
    }

    delete merged._evidence;
    out.push(merged);
  }

  out.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  return out.slice(0, maxCandidates);
}

// ---------- public: buildCandidate ----------
export function buildCandidate(message, context) {
  const directory = context?.directory || [];
  const overrides = context?.overrides || [];

  const subject = message.subject || "";
  const text = message.text || "";
  const html = message.html || "";
  const snippet = message.snippet || "";

  const from = message.from || "";
  const replyTo = message.replyTo || "";
  const returnPath = message.returnPath || "";
  const headerMap = message.headerMap || {};
  const dateMs = message.dateMs || null;

  const linkDomains = message.linkDomains || extractLinkDomains({ text, html });
  const haystack = `${subject}\n${text}\n${snippet}`.slice(0, 20000);

  const resolved = resolveMerchant({
    email: { from, replyTo, returnPath, headerMap, linkDomains },
    directory,
    overrides,
    haystack,
  });

  const classifier = classifyEmail({
    subject,
    text: `${snippet}\n${text}`,
    snippet,
    headerMap,
    fromDomain: resolved.fromDomain || "",
  });

  // HARD SKIP: marketing heavy with no transactional evidence
  if (classifier.marketingHeavy && !classifier.likelyTransactional) {
    bumpNullReason(context, "marketingHeavy");
    maybePushNearMiss(context, {
      dropReason: "marketingHeavy",
      fromDomain: resolved.fromDomain || "",
      merchantGuess: resolved.pretty || resolved.canonical || null,
      resolverConfidence: resolved.confidence || 0,
      confidence: 0,
      floor: 0,
      evidenceType: "marketing",
      hasAmount: false,
      hasNextRenewal: false,
      hasCadence: false,
      pos: classifier.pos,
      neg: classifier.neg,
      bulkHeader: classifier.bulkHeader,
      subject,
      snippet,
    });
    return null;
  }

  // platform/aggregator logic
  let merchant = resolved.canonical || null;
  const fromDomain = resolved.fromDomain || "";

  const isAppleSender = /(^|\.)apple\.com$/.test(fromDomain) || fromDomain.includes("apple.com");
  const isPayPalSender = fromDomain.includes("paypal.com");
  const isGooglePlaySender = fromDomain.includes("google.com") || fromDomain.includes("googleplay");

  let platformExtract = null;
  if (isAppleSender || classifier.appleReceiptHint) platformExtract = extractAppleLineItemMerchant({ subject, text, html });
  else if (isPayPalSender) platformExtract = extractPayPalMerchant({ subject, text });
  else if (isGooglePlaySender) platformExtract = extractGooglePlayMerchant({ subject, text });

  if (platformExtract && platformExtract.length >= 2) {
    merchant = platformExtract;
  }

  const isTrial = /\btrial\b/i.test(`${subject}\n${text}`) && !/extend your trial/i.test(`${subject}\n${text}`);

  // require a merchant for non-trials (unless we later upgrade confidence)
  const money = extractAmount({ subject, text, html });
  const amount = money?.amount ?? null;
  const currency = money?.currency ?? "USD";

  const nextRenewal = extractNextRenewal({ subject, text, html });
  const plan = extractPlan({ subject, text });

  let cadence = extractCadence({ subject, text, html });

  const evidenceType =
    isTrial ? "trial" :
    classifier.appleReceiptHint ? "platform_receipt" :
    classifier.likelyTransactional ? "transactional" :
    "unknown";

  let confidence = 0;
  const reason = [];

  confidence += Math.min(60, resolved.confidence || 0);
  if (resolved.reason) reason.push(`Resolver: ${resolved.reason}`);

  if (classifier.likelyTransactional) {
    confidence += 12;
    reason.push("Transactional language");
  }

  if (classifier.bulkHeader) {
    confidence -= 10;
    reason.push("Bulk/list header detected");
  }

  if (resolved.signals?.personalSenderDomain) {
    confidence -= 15;
    reason.push("Sender domain looks consumer");
  }

  if (platformExtract) {
    confidence += 10;
    reason.push("Extracted merchant from platform email");
  }

  if (amount && classifier.likelyTransactional) {
    confidence += 10;
    reason.push("Found amount near billing keywords");
  }

  if (nextRenewal) {
    confidence += 8;
    reason.push("Found renewal/expiry date");
  }

  if (cadence && (nextRenewal || classifier.likelyTransactional)) {
    confidence += 4;
    reason.push("Detected cadence");
  } else {
    cadence = null;
  }

  // ✅ Open-world upgrade: allow fallback-domain merchants if billing proof is strong
  const strongBillingProof = (!!amount && classifier.likelyTransactional) || !!nextRenewal;
  if (resolved.reason === "fallback-domain" && strongBillingProof) {
    confidence += 18;
    reason.push("Fallback merchant accepted due to strong billing proof");
    if (!merchant) merchant = resolved.canonical || resolved.pretty || merchant;
  }

  confidence = clamp(confidence, 0, 100);

  const weak = !amount && !nextRenewal && !cadence && !isTrial;
  if (weak) confidence = Math.min(confidence, 55);

  // If still no merchant and not trial, drop (now that we’ve given it a chance)
  if (!merchant && !isTrial) {
    bumpNullReason(context, "noMerchant");
    maybePushNearMiss(context, {
      dropReason: "noMerchant",
      fromDomain,
      merchantGuess: resolved.pretty || resolved.canonical || null,
      resolverConfidence: resolved.confidence || 0,
      confidence,
      floor: 45,
      evidenceType,
      hasAmount: !!amount,
      hasNextRenewal: !!nextRenewal,
      hasCadence: !!cadence,
      pos: classifier.pos,
      neg: classifier.neg,
      bulkHeader: classifier.bulkHeader,
      subject,
      snippet,
    });
    return null;
  }

  const floor = isTrial ? 35 : 45;
  if (confidence < floor) {
    bumpNullReason(context, "lowConfidence");
    maybePushNearMiss(context, {
      dropReason: "lowConfidence",
      fromDomain,
      merchantGuess: merchant || resolved.pretty || resolved.canonical || null,
      resolverConfidence: resolved.confidence || 0,
      confidence,
      floor,
      evidenceType,
      hasAmount: !!amount,
      hasNextRenewal: !!nextRenewal,
      hasCadence: !!cadence,
      pos: classifier.pos,
      neg: classifier.neg,
      bulkHeader: classifier.bulkHeader,
      subject,
      snippet,
    });
    return null;
  }

  const label = confidence >= 80 ? "High" : confidence >= 55 ? "Medium" : "Low";

  return {
    merchant,
    plan,
    amount,
    currency,
    cadence,
    nextRenewal,
    isTrial,
    evidenceType,
    confidence,
    confidenceLabel: label,
    dateMs,
    reason,
  };
}
