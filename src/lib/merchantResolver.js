// lib/merchantResolver.js
// Merchant resolution with layered evidence + explainable scoring.
// Upgrades:
// - uses List-Unsubscribe + Reply-To + Return-Path + link domains as signals
// - penalizes consumer domains (gmail/yahoo/etc) as merchant identity
// - returns structured `signals` for deterministic confidence scoring

const CONSUMER_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
]);

const INFRA_DOMAINS = [
  "mailchimp.com",
  "sendgrid.net",
  "amazonses.com",
  "mailgun.org",
  "sparkpostmail.com",
  "list-manage.com",
  "cmail19.com",
  "rsgsv.net",
];

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeLower(s) {
  return (s || "").toString().toLowerCase();
}

export function extractEmail(value) {
  if (!value) return null;
  const match = String(value).match(/<([^>]+)>/);
  const raw = match ? match[1] : String(value);
  const email = raw.trim().toLowerCase();
  if (!email.includes("@")) return null;
  return email;
}

export function domainOf(emailish) {
  const e = extractEmail(emailish) || String(emailish || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return null;
  return e.split("@")[1]?.toLowerCase() || null;
}

function normalizeDomain(domain) {
  if (!domain) return null;
  const d = domain.toLowerCase().trim();
  // strip common mail subdomains
  return d.replace(/^(mail|email|em|m|news|notify|noreply)\./, "");
}

function extractDomainsFromListUnsubscribe(val) {
  if (!val) return [];
  const raw = Array.isArray(val) ? val.join(" ") : String(val);
  const domains = new Set();

  const urlMatches = raw.match(/https?:\/\/[^\s>,]+/gi) || [];
  for (const u of urlMatches) {
    try {
      const host = new URL(u.replace(/[>,]$/, "")).hostname;
      if (host) domains.add(normalizeDomain(host));
    } catch {}
  }

  const mailtoMatches = raw.match(/mailto:([^\s>,]+)/gi) || [];
  for (const m of mailtoMatches) {
    const email = m.replace(/^mailto:/i, "").replace(/[>,]$/, "");
    const d = domainOf(email);
    if (d) domains.add(normalizeDomain(d));
  }

  return [...domains].filter(Boolean);
}

function extractDomainsFromLinks(linkDomains) {
  const out = new Set();
  for (const d of linkDomains || []) {
    const nd = normalizeDomain(d);
    if (nd) out.add(nd);
  }
  return [...out];
}

function bestMatchByEmail(directory, email) {
  if (!email) return null;
  const e = extractEmail(email);
  if (!e) return null;
  return directory.find((m) => (m.sender_emails || []).map(safeLower).includes(e)) || null;
}

function bestMatchByDomain(directory, domain) {
  if (!domain) return null;
  const d = normalizeDomain(domain);
  if (!d) return null;

  return (
    directory.find((m) => (m.sender_domains || []).some((x) => normalizeDomain(x) === d)) ||
    directory.find((m) => (m.sender_domains || []).some((x) => d.endsWith(normalizeDomain(x)))) ||
    null
  );
}

function keywordHitScore({ keywords, haystack }) {
  if (!keywords?.length || !haystack) return 0;
  const t = safeLower(haystack);
  let hits = 0;
  for (const kw of keywords) {
    const k = safeLower(kw).trim();
    if (!k) continue;
    if (t.includes(k)) hits += 1;
  }
  return hits;
}

/**
 * resolveMerchant
 * @param {object} args
 * @param {object} args.email - normalized email object (from, replyTo, returnPath, headerMap, linkDomains)
 * @param {Array} args.directory - merchant_directory rows
 * @param {Array} [args.overrides] - user overrides rows
 * @param {string} [args.haystack] - subject+body text for keyword scoring
 */
export function resolveMerchant({ email, directory, overrides = [], haystack = "" }) {
  const explain = [];
  const signals = {
    senderEmailMatch: false,
    domainMatch: false,
    keywordMatch: false,
    personalSenderDomain: false,
    fallbackUsed: false,
    consumerDomainUsed: false,
    unsubscribeDomainUsed: false,
    linkDomainUsed: false,
  };

  const fromEmail = extractEmail(email.from);
  const replyToEmail = extractEmail(email.replyTo);
  const returnPathEmail = extractEmail(email.returnPath);

  const fromDomain = normalizeDomain(domainOf(fromEmail));
  const replyToDomain = normalizeDomain(domainOf(replyToEmail));
  const returnPathDomain = normalizeDomain(domainOf(returnPathEmail));

  const headerMap = email?.headerMap || {};
  const listUnsubDomains = extractDomainsFromListUnsubscribe(
    headerMap["list-unsubscribe"] || headerMap["List-Unsubscribe"]
  );

  const linkDomains = extractDomainsFromLinks(email?.linkDomains || []);

  const candidateDomains = [
    fromDomain,
    replyToDomain,
    returnPathDomain,
    ...listUnsubDomains,
    ...linkDomains,
  ]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);

  const fromIsConsumer = !!(fromDomain && CONSUMER_DOMAINS.has(fromDomain));
  if (fromIsConsumer) {
    signals.personalSenderDomain = true;
    signals.consumerDomainUsed = true;
  }

  // 1) User override wins
  if (fromEmail) {
    const ov = overrides.find((o) => safeLower(o.sender_email) === fromEmail);
    if (ov?.canonical_name) {
      signals.senderEmailMatch = true;
      explain.push({ type: "override_email", value: fromEmail, merchant: ov.canonical_name, score: 95 });
      return { canonical: ov.canonical_name, confidence: 95, reason: "override-email", explain, signals, fromDomain };
    }
  }
  for (const d of candidateDomains) {
    const ov = overrides.find((o) => normalizeDomain(o.sender_domain) === d);
    if (ov?.canonical_name) {
      signals.domainMatch = true;
      explain.push({ type: "override_domain", value: d, merchant: ov.canonical_name, score: 90 });
      return { canonical: ov.canonical_name, confidence: 90, reason: "override-domain", explain, signals, fromDomain };
    }
  }

  // 2) Exact sender email match
  const exact = bestMatchByEmail(directory, fromEmail);
  if (exact) {
    signals.senderEmailMatch = true;
    let score = 40;
    if (replyToEmail && bestMatchByEmail([exact], replyToEmail)) score += 10;
    if (returnPathEmail && bestMatchByEmail([exact], returnPathEmail)) score += 5;
    explain.push({ type: "sender_email", value: fromEmail, merchant: exact.canonical_name, score });
    return {
      canonical: exact.canonical_name,
      confidence: clamp(50 + score, 0, 100),
      reason: "sender-email",
      explain,
      signals,
      fromDomain,
    };
  }

  // 3) Domain match (from/reply-to/return-path/unsubscribe/link)
  for (const d of candidateDomains) {
    const match = bestMatchByDomain(directory, d);
    if (!match) continue;

    signals.domainMatch = true;
    let score = 25;

    if (d === fromDomain) score += 10;
    if (d === replyToDomain) score += 5;
    if (d === returnPathDomain) score += 5;

    if (listUnsubDomains.includes(d)) {
      score += 6;
      signals.unsubscribeDomainUsed = true;
    }
    if (linkDomains.includes(d)) {
      score += 4;
      signals.linkDomainUsed = true;
    }

    if (CONSUMER_DOMAINS.has(d)) score -= 30;

    explain.push({ type: "domain", value: d, merchant: match.canonical_name, score });
    return {
      canonical: match.canonical_name,
      confidence: clamp(45 + score, 0, 100),
      reason: "domain",
      explain,
      signals,
      fromDomain,
    };
  }

  // 4) Keyword match
  const textForMatch = safeLower(haystack);
  let best = null;
  for (const m of directory) {
    const hits = keywordHitScore({ keywords: m.keywords || [], haystack: textForMatch });
    if (hits <= 0) continue;
    const score = clamp(10 + hits * 7, 10, 38);
    if (!best || score > best.score) best = { m, score, hits };
  }
  if (best) {
    signals.keywordMatch = true;
    let score = best.score;
    if (fromIsConsumer) score -= 10;
    explain.push({ type: "keywords", value: `${best.hits} hits`, merchant: best.m.canonical_name, score });
    return {
      canonical: best.m.canonical_name,
      confidence: clamp(35 + score, 0, 100),
      reason: "keywords",
      explain,
      signals,
      fromDomain,
    };
  }

  // 5) Fallback domain label (ONLY if not consumer + not infra)
  if (fromDomain && !fromIsConsumer) {
    if (!INFRA_DOMAINS.some((x) => fromDomain.endsWith(x))) {
      signals.fallbackUsed = true;
      const pretty = fromDomain.split(".")[0];
      explain.push({ type: "fallback_domain", value: fromDomain, merchant: pretty, score: 18 });
      return {
        canonical: pretty,
        confidence: 35,
        reason: "fallback-domain",
        explain,
        signals,
        fromDomain,
      };
    }
  }

  explain.push({ type: "none", value: null, merchant: null, score: 0 });
  return { canonical: null, confidence: 0, reason: "no-match", explain, signals, fromDomain };
}
