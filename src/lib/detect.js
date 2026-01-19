// src/lib/detect.js
// Detection engine: conservative on per-email parsing, but *never* returns 0 by default.
// Strategy:
//   1) Build high-confidence candidates from full bodies (buildCandidate)
//   2) Build cluster-level "suspected subscriptions" from metadata only (buildClusterCandidates)
//
// Output shape is designed for the app:
//   - fingerprint: required for DB + client dedupe
//   - evidence: { from, subject, senderDomain, senderEmail, dateMs }
//   - cadenceGuess / nextDateGuess: used by UI

import crypto from "crypto";
import { resolveMerchant } from "./merchantResolver.js";

// ---------- small utils ----------
function safeLower(s) {
  return (s || "").toString().toLowerCase();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function stableHash(input) {
  return crypto.createHash("sha1").update(String(input)).digest("hex");
}

function bumpNullReason(context, key) {
  try {
    const map = context?.stats?.nullReasons;
    if (!map) return;
    map[key] = (map[key] || 0) + 1;
  } catch {}
}

function normalizeTextForParsing(input) {
  return (input || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\t\r]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractSenderEmail(fromHeader = "") {
  const m = String(fromHeader).match(/<([^>]+)>/);
  const email = (m?.[1] || fromHeader).trim();
  if (!email.includes("@")) return null;
  return email.replace(/^mailto:/i, "").trim();
}

function extractSenderDomain(fromHeader = "") {
  const email = extractSenderEmail(fromHeader);
  if (!email) return null;
  return email.split("@").pop()?.toLowerCase() || null;
}

function isInfraDomain(host = "") {
  const h = safeLower(host);
  return (
    h.includes("sendgrid") ||
    h.includes("mailchimp") ||
    h.includes("klaviyo") ||
    h.includes("braze") ||
    h.includes("customer.io") ||
    h.includes("mailgun") ||
    h.includes("sparkpost") ||
    h.includes("marketo") ||
    h.includes("salesforce") ||
    h.includes("campaign")
  );
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
  // “non-amount” subscription proof
  "manage subscription",
  "manage your subscription",
  "cancel subscription",
  "cancel anytime",
  "membership",
  "your plan",
];

const NEGATIVE_SIGNAL_PHRASES = [
  "newsletter",
  "subscribe to our newsletter",
  "new product",
  "sale",
  "discount",
  "offer",
  "limited time",
  "promotion",
  "marketing",
  "in-store",
  "collection",
];

export function quickScreenMessage({ headers, snippet }) {
  // Fast, cheap, metadata-only filter to avoid full fetch spam.
  const from = safeLower(headers?.from || "");
  const subject = safeLower(headers?.subject || "");
  const s = safeLower(snippet || "");
  const hay = `${subject}\n${s}\n${from}`;

  // Skip obvious conversations / irrelevant
  if (hay.includes("re:") && hay.includes("fwd:")) return { ok: false, reason: "thread" };

  // Strong positives
  if (POSITIVE_SIGNAL_PHRASES.some((p) => hay.includes(p))) return { ok: true, reason: "positive_signal" };

  // Avoid pure promo unless it still smells like billing
  const neg = NEGATIVE_SIGNAL_PHRASES.some((p) => hay.includes(p));
  if (neg && !(hay.includes("invoice") || hay.includes("receipt") || hay.includes("billed") || hay.includes("charged"))) {
    return { ok: false, reason: "promo" };
  }

  // Mild signal: keep it for cluster model
  if (hay.includes("subscription") || hay.includes("renew") || hay.includes("billing") || hay.includes("charged")) {
    return { ok: true, reason: "weak_signal" };
  }

  return { ok: false, reason: "no_signal" };
}

function hasBulkHeaders(headerMap = {}) {
  const hm = headerMap || {};
  return Boolean(hm["list-unsubscribe"] || hm["precedence"] || hm["x-campaign"] || hm["x-mailer"]);
}

function classifyEmail({ subject = "", snippet = "", text = "", headerMap = {}, fromDomain = "" }) {
  const hay = safeLower(`${subject}\n${snippet}\n${text}`.slice(0, 12000));
  const bulk = hasBulkHeaders(headerMap) || isInfraDomain(fromDomain);

  const posHits = POSITIVE_SIGNAL_PHRASES.filter((p) => hay.includes(p)).length;
  const negHits = NEGATIVE_SIGNAL_PHRASES.filter((p) => hay.includes(p)).length;

  // Transactional if it contains billing/receipt language, even if bulk headers exist.
  const likelyTransactional =
    posHits >= 1 ||
    /(invoice|receipt|billed|billing|charged|payment|subscription|renew|trial ends|manage subscription|cancel subscription)/i.test(hay);

  // Marketing if bulk headers + no transactional cues
  const likelyMarketing = bulk && !likelyTransactional && negHits >= 1;

  return { bulkHeader: bulk, posHits, negHits, likelyTransactional, likelyMarketing };
}

function extractAmountAndCurrency(haystack) {
  const s = haystack || "";

  // Common patterns: $12.99, USD 12.99, 12.99 USD, €9,99
  const m1 = s.match(/(?:USD|US\\$|\\$)\\s?([0-9]{1,5}(?:[\\.,][0-9]{2})?)/i);
  if (m1) return { amount: Number(m1[1].replace(",", ".")), currency: "USD" };

  const m2 = s.match(/(?:EUR|€)\\s?([0-9]{1,5}(?:[\\.,][0-9]{2})?)/i);
  if (m2) return { amount: Number(m2[1].replace(",", ".")), currency: "EUR" };

  const m3 = s.match(/([0-9]{1,5}(?:[\\.,][0-9]{2})?)\\s?(USD|EUR|GBP|CAD|AUD)/i);
  if (m3) return { amount: Number(m3[1].replace(",", ".")), currency: m3[2].toUpperCase() };

  return { amount: null, currency: null };
}

function inferCadenceFromDates(dates) {
  if (!dates || dates.length < 3) return null;

  const ds = [...dates].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ds.length; i++) gaps.push((ds[i] - ds[i - 1]) / (24 * 3600 * 1000));

  // remove outliers (simple trim)
  gaps.sort((a, b) => a - b);
  const trimmed = gaps.slice(Math.floor(gaps.length * 0.15), Math.ceil(gaps.length * 0.85));
  const median = trimmed[Math.floor(trimmed.length / 2)] || null;
  if (!median) return null;

  const near = (x, target, tol) => Math.abs(x - target) <= tol;
  if (near(median, 7, 2)) return "weekly";
  if (near(median, 14, 3)) return "biweekly";
  if (near(median, 30, 6)) return "monthly";
  if (near(median, 90, 15)) return "quarterly";
  if (near(median, 365, 45)) return "yearly";
  return null;
}

function nextDateGuessFromCadence(lastDateMs, cadence) {
  if (!lastDateMs || !cadence) return null;
  const d = new Date(lastDateMs);
  const addDays = (n) => new Date(d.getTime() + n * 24 * 3600 * 1000);

  let nd;
  switch (cadence) {
    case "weekly":
      nd = addDays(7);
      break;
    case "biweekly":
      nd = addDays(14);
      break;
    case "monthly":
      nd = addDays(30);
      break;
    case "quarterly":
      nd = addDays(90);
      break;
    case "yearly":
      nd = addDays(365);
      break;
    default:
      return null;
  }
  return nd.toISOString().slice(0, 10);
}

export function buildCandidate(email, context) {
  const directory = context?.directory || [];
  const overrides = context?.overrides || [];

  const from = String(email?.from || "");
  const subject = String(email?.subject || "");
  const snippet = String(email?.snippet || "");
  const text = String(email?.text || "");
  const html = String(email?.html || "");
  const headerMap = email?.headerMap || {};
  const dateMs = Number(email?.dateMs || 0) || null;

  const normText = normalizeTextForParsing(text);
  const normSnippet = normalizeTextForParsing(snippet);
  const normSubject = normalizeTextForParsing(subject);

  const linkDomains = extractLinkDomains({ text: normText, html });

  const cls = classifyEmail({
    subject: normSubject,
    snippet: normSnippet,
    text: normText,
    headerMap,
    fromDomain: extractSenderDomain(from) || "",
  });

  // quick reject pure marketing
  if (cls.likelyMarketing) {
    bumpNullReason(context, "marketing");
    return null;
  }

  // Merchant resolution
  const resolved = resolveMerchant({
    email: {
      from,
      replyTo: email?.replyTo || "",
      returnPath: email?.returnPath || "",
      headerMap,
      linkDomains,
    },
    directory,
    overrides,
    haystack: `${normSubject}\n${normSnippet}\n${normText}`.slice(0, 16000),
  });

  const senderEmail = extractSenderEmail(from);
  const senderDomain = resolved.fromDomain || extractSenderDomain(from);

  // Amount/currency extraction (optional)
  const { amount, currency } = extractAmountAndCurrency(`${normSubject}\n${normSnippet}\n${normText}`.slice(0, 20000));

  // Confidence
  let confidence = 0;
  let evidenceType = "email";
  const reason = [];

  if (resolved.canonical) {
    confidence += 55;
    reason.push("Matched known merchant");
  } else if (resolved.pretty || senderDomain) {
    confidence += 28;
    reason.push("Identified sender");
  } else {
    bumpNullReason(context, "no_sender");
    return null;
  }

  if (cls.likelyTransactional) {
    confidence += 18;
    reason.push("Transactional language");
  } else {
    confidence += 6;
    reason.push("Weak transactional signal");
  }

  if (amount) {
    confidence += 12;
    reason.push("Detected amount");
  } else {
    reason.push("Amount not found");
  }

  // Cadence inference from internal date windows (optional, if caller provides history)
  // This function is per-email; cadence is computed by aggregator/cluster model.
  confidence = clamp(confidence, 0, 100);

  const merchant = resolved.canonical || resolved.pretty || senderDomain || "Unknown";

  const fpBasis = {
    v: 2,
    type: "email",
    merchant: safeLower(merchant),
    senderDomain: safeLower(senderDomain || ""),
    amount: amount ? Math.round(amount * 100) / 100 : null,
    currency: currency || null,
  };
  const fingerprint = stableHash(JSON.stringify(fpBasis));

  return {
    fingerprint,
    merchant,
    amount,
    currency,
    cadenceGuess: null,
    nextDateGuess: null,
    confidence,
    confidenceLabel: confidence >= 80 ? "High" : confidence >= 55 ? "Medium" : "Low",
    evidenceType,
    reason,
    evidence: {
      from,
      subject,
      snippet,
      senderEmail,
      senderDomain,
      dateMs,
    },
  };
}

// Basic aggregation: keep top candidates by confidence and dedupe on fingerprint.
export function aggregateCandidates(candidates, maxCandidates = 200) {
  const map = new Map();
  for (const c of candidates || []) {
    if (!c?.fingerprint) continue;
    const prev = map.get(c.fingerprint);
    if (!prev || (c.confidence || 0) > (prev.confidence || 0)) map.set(c.fingerprint, c);
  }
  return Array.from(map.values())
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, maxCandidates);
}

// ---------- cluster-first candidates (metadata only) ----------
// metaItems shape expected:
//   { headers: { from, subject, replyTo, returnPath, headerMap }, snippet, dateMs }
export function buildClusterCandidates(metaItems, context, maxCandidates = 50) {
  const directory = context?.directory || [];
  const overrides = context?.overrides || [];

  const clusters = new Map();

  for (const m of metaItems || []) {
    const from = m?.headers?.from || "";
    const subject = m?.headers?.subject || "";
    const snippet = m?.snippet || "";
    const headerMap = m?.headers?.headerMap || {};
    const dateMs = Number(m?.dateMs || 0) || null;

    // Use resolver even with empty directory to get best-domain heuristics.
    const resolved = resolveMerchant({
      email: {
        from,
        replyTo: m?.headers?.replyTo || "",
        returnPath: m?.headers?.returnPath || "",
        headerMap,
        linkDomains: [],
      },
      directory,
      overrides,
      haystack: `${subject}\n${snippet}`.slice(0, 4000),
    });

    // Cluster key: prefer non-infra domain; otherwise fallback to sender email/domain.
    const bestDomain = resolved.fromDomain || extractSenderDomain(from) || "";
    const key = isInfraDomain(bestDomain) ? `infra:${bestDomain}:${extractSenderDomain(from) || ""}` : `dom:${bestDomain}`;
    if (!key || key === "dom:") continue;

    const c = clusters.get(key) || {
      key,
      bestDomain,
      merchant: resolved.canonical || resolved.pretty || null,
      confidenceFromResolver: Number(resolved.confidence || 0),
      subjects: [],
      fromSamples: [],
      snippets: [],
      dates: [],
      bulkCount: 0,
      transactionalCount: 0,
    };

    const cls = classifyEmail({ subject, snippet, text: "", headerMap, fromDomain: bestDomain });
    if (cls.bulkHeader) c.bulkCount += 1;
    if (cls.likelyTransactional) c.transactionalCount += 1;

    if (subject) c.subjects.push(subject);
    if (from) c.fromSamples.push(from);
    if (snippet) c.snippets.push(snippet);
    if (dateMs) c.dates.push(dateMs);

    // If we ever resolve a canonical merchant via overrides/directory, keep it.
    if (resolved.canonical) c.merchant = resolved.canonical;
    c.confidenceFromResolver = Math.max(c.confidenceFromResolver, Number(resolved.confidence || 0));

    clusters.set(key, c);
  }

  const out = [];
  for (const c of clusters.values()) {
    const n = c.dates.length;
    if (n < 3) continue; // cluster must have volume

    const cadenceGuess = inferCadenceFromDates(c.dates);
    const lastDate = Math.max(...c.dates);
    const nextDateGuess = cadenceGuess ? nextDateGuessFromCadence(lastDate, cadenceGuess) : null;

    const joined = safeLower(`${c.subjects.slice(0, 12).join("\n")}\n${c.snippets.slice(0, 6).join("\n")}`);
    const billingKeywordHits =
      /(invoice|receipt|billed|billing|charged|payment|subscription|renew|trial ends|manage subscription|cancel subscription)/i.test(joined) ? 1 : 0;

    // Cadence scoring (simple + explainable)
    let confidence = 0;
    confidence += Math.min(35, Math.log2(n + 1) * 12); // volume
    if (cadenceGuess) confidence += 22;
    if (billingKeywordHits) confidence += 18;
    confidence += Math.min(15, (c.transactionalCount / Math.max(1, n)) * 20);
    confidence += Math.min(20, c.confidenceFromResolver * 0.35);

    // Too many bulk headers means possible promo; don't kill it, just damp.
    const bulkRatio = c.bulkCount / Math.max(1, n);
    if (bulkRatio > 0.8 && !billingKeywordHits) confidence -= 10;

    confidence = clamp(confidence, 0, 100);
    if (confidence < 55) continue;

    const merchant = c.merchant || c.bestDomain || "Unknown";
    const fromSample = c.fromSamples[0] || "";
    const subjectSample = c.subjects[0] || "";

    const senderEmail = extractSenderEmail(fromSample);
    const senderDomain = c.bestDomain || extractSenderDomain(fromSample);

    const fpBasis = {
      v: 2,
      type: "cluster",
      senderDomain: safeLower(senderDomain || ""),
      merchant: safeLower(merchant),
      cadence: cadenceGuess || null,
    };
    const fingerprint = stableHash(JSON.stringify(fpBasis));

    const reason = [
      `Clustered ${n} emails`,
      cadenceGuess ? `Cadence looks ${cadenceGuess}` : "No clear cadence",
      billingKeywordHits ? "Billing keywords present" : "Weak billing keywords",
      c.confidenceFromResolver >= 60 ? "Matched known merchant" : "Needs confirmation",
    ];

    out.push({
      fingerprint,
      merchant,
      amount: null,
      currency: null,
      cadenceGuess,
      nextDateGuess,
      confidence,
      confidenceLabel: confidence >= 80 ? "High" : confidence >= 55 ? "Medium" : "Low",
      evidenceType: "cluster",
      needsConfirm: c.confidenceFromResolver < 60,
      reason,
      evidence: {
        from: fromSample,
        subject: subjectSample,
        snippet: c.snippets[0] || "",
        senderEmail,
        senderDomain,
        dateMs: lastDate,
      },
    });
  }

  out.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  return out.slice(0, maxCandidates);
}
