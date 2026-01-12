import crypto from "node:crypto";
import { htmlToText } from "html-to-text";
import * as chrono from "chrono-node";
import { resolveMerchantFromSender } from "./merchantResolver.js";

const MERCHANT_HINTS = [
  { name: "Netflix", domains: ["netflix.com"], keywords: ["netflix"] },
  { name: "Uber One", domains: ["uber.com"], keywords: ["uber one", "uberone", "uber"] },
  { name: "Spotify", domains: ["spotify.com"], keywords: ["spotify"] },
  { name: "Apple", domains: ["apple.com", "icloud.com"], keywords: ["apple", "icloud"] },
  { name: "Google", domains: ["google.com"], keywords: ["google", "youtube"] },
  { name: "Amazon", domains: ["amazon.com"], keywords: ["amazon", "prime"] },
  { name: "Microsoft", domains: ["microsoft.com"], keywords: ["microsoft", "xbox", "office 365"] },
  { name: "Adobe", domains: ["adobe.com"], keywords: ["adobe", "creative cloud"] },
  { name: "Dropbox", domains: ["dropbox.com"], keywords: ["dropbox"] },
  { name: "Disney+", domains: ["disneyplus.com", "disney.com"], keywords: ["disney+"] },
];

const SUBJECT_KEYWORDS = [
  "receipt",
  "invoice",
  "payment",
  "charged",
  "subscription",
  "renewal",
  "trial",
  "membership",
  "plan",
  "billing",
];

const BODY_KEYWORDS = [
  "your subscription",
  "next billing date",
  "will renew",
  "renewal date",
  "thanks for your payment",
  "you have been charged",
  "charged your",
  "payment method",
  "billing period",
];

const WELCOME_KEYWORDS = [
  "welcome",
  "thanks for joining",
  "your account information",
];

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findDirectoryKeywordHit(text, directory) {
  const t = String(text || "").toLowerCase();
  if (!t || !Array.isArray(directory) || directory.length === 0) return null;

  let best = null; // { canonicalName, keyword, weight }

  for (const m of directory) {
    const name = m?.canonical_name;
    const kws = Array.isArray(m?.keywords) ? m.keywords : [];
    for (const raw of kws) {
      const kw = String(raw || "").trim().toLowerCase();
      if (!kw) continue;

      // Avoid super-common noise keywords (too short)
      if (kw.length < 4) continue;

      let hit = false;
      if (kw.includes(" ") || kw.includes("+") || kw.includes(".") || kw.includes("-")) {
        hit = t.includes(kw);
      } else {
        const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, "i");
        hit = re.test(t);
      }

      if (!hit) continue;

      const weight = Math.min(20, 8 + Math.floor(kw.length / 2)); // longer phrase == more convincing
      if (!best || weight > best.weight) {
        best = { canonicalName: name, keyword: kw, weight };
      }
    }
  }

  return best;
}

export function buildCandidate({ from, subject, date, text, html, directory, overrides }) {
  const plain = normalizeText(text ?? "") || normalizeText(htmlToTextSafe(html ?? ""));
  const haystack = `${subject}\n${from}\n${plain}`.toLowerCase();

  const senderHit = resolveMerchantFromSender({ from, directory, overrides });
  const keywordHit = findDirectoryKeywordHit(haystack, directory);
  const guessed = guessMerchant({ from, subject, text: plain });

  const merchant =
    senderHit.canonicalName ??
    keywordHit?.canonicalName ??
    guessed ??
    "Unknown merchant";

  const fingerprint = crypto
    .createHash("sha256")
    .update(`${compact(merchant)}|${compact(from)}|${compact(subject)}|${date.toISOString().slice(0, 10)}`)
    .digest("hex");

  const isWelcomeLike =
    merchant !== "Unknown merchant" &&
    WELCOME_KEYWORDS.some((k) => haystack.includes(k));

  const hasSignal =
    SUBJECT_KEYWORDS.some((k) => subject.toLowerCase().includes(k)) ||
    BODY_KEYWORDS.some((k) => haystack.includes(k)) ||
    isWelcomeLike;

  if (!hasSignal) return null;

  const amountInfo = extractAmount(haystack);
  const cadence = guessCadence(haystack);
  const nextDate = guessNextDate({ haystack, messageDate: date });

  // Deterministic confidence: sender → directory keywords → other signals.
  let confidence = 20;

  // Sender-based signals (matches checklist intent)
  if (senderHit.canonicalName) {
    if (String(senderHit.reason).includes("email")) confidence += 40;
    else if (String(senderHit.reason).includes("domain")) confidence += 25;
    else confidence += 35; // overrides, etc.
  }

  // Directory keyword match (+20)
  if (keywordHit?.canonicalName) confidence += 20;

  // Penalize conflicting strong signals (keeps confidence honest)
  if (
    senderHit.canonicalName &&
    keywordHit?.canonicalName &&
    senderHit.canonicalName !== keywordHit.canonicalName
  ) {
    confidence -= 30;
  }

  // Existing heuristic signals
  confidence += Math.min(25, keywordScore(subject.toLowerCase(), SUBJECT_KEYWORDS));
  confidence += Math.min(20, keywordScore(haystack, BODY_KEYWORDS));

  if (amountInfo?.amount) confidence += 20;
  if (nextDate) confidence += 15;
  if (isWelcomeLike) confidence += 10;

  confidence = clamp(confidence, 0, 100);

  // welcome-like emails are allowed at a slightly lower signal threshold
  if (!amountInfo?.amount && !nextDate && !isWelcomeLike) {
    confidence = Math.min(confidence, 70);
  }

  return {
    fingerprint,
    merchant,
    amount: amountInfo?.amount,
    currency: amountInfo?.currency,
    cadenceGuess: cadence,
    nextDateGuess: nextDate,
    confidence,
    evidence: {
      from: compact(from),
      subject: compact(subject),
      date: date.toISOString(),
      merchantReason: senderHit.reason || null,
      merchantKeyword: keywordHit?.keyword || null,
    },
  };
}

function htmlToTextSafe(html) {
  if (!html) return "";
  try {
    return htmlToText(html, {
      wordwrap: 120,
      selectors: [{ selector: "a", options: { ignoreHref: true } }],
    });
  } catch {
    return "";
  }
}

function normalizeText(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

function compact(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function keywordScore(text, keywords) {
  let score = 0;
  for (const k of keywords) {
    if (text.includes(k)) score += 5;
  }
  return score;
}

function extractAmount(text) {
  // Simple amount parse: "$9.99", "USD 9.99", etc.
  const m =
    text.match(/\$\s?(\d+(?:\.\d{2})?)/) ||
    text.match(/usd\s?(\d+(?:\.\d{2})?)/i) ||
    text.match(/(\d+(?:\.\d{2})?)\s?usd/i);

  if (!m) return null;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount)) return null;
  return { amount, currency: "USD" };
}

function guessCadence(text) {
  const t = text.toLowerCase();
  if (t.includes("every year") || t.includes("annual") || t.includes("yearly")) return "yearly";
  if (t.includes("every month") || t.includes("monthly")) return "monthly";
  if (t.includes("every week") || t.includes("weekly")) return "weekly";
  return "monthly";
}

function guessNextDate({ haystack, messageDate }) {
  const results = chrono.parse(haystack, messageDate);
  if (!results?.length) return null;
  const d = results[0]?.start?.date?.();
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

function guessMerchant({ from, subject, text }) {
  const fromLower = String(from || "").toLowerCase();
  const subjectLower = String(subject || "").toLowerCase();
  const bodyLower = String(text || "").toLowerCase();
  const all = `${fromLower}\n${subjectLower}\n${bodyLower}`;

  for (const hint of MERCHANT_HINTS) {
    for (const d of hint.domains) {
      if (fromLower.includes(d)) return hint.name;
    }
    for (const kw of hint.keywords) {
      if (all.includes(kw)) return hint.name;
    }
  }

  // fallback: try to extract a display name from "From: Name <email>"
  const m = String(from || "").match(/^([^<]+)</);
  if (m?.[1]) {
    const name = m[1].trim();
    if (name.length >= 2 && name.length <= 40) return name;
  }

  return null;
}
