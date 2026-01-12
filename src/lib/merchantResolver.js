// lib/merchantResolver.js
const CONSUMER_EMAIL_DOMAINS = new Set(["gmail.com"]); // your rule

function normalize(s) {
  return String(s || "").trim().toLowerCase();
}

function extractEmailFromFromHeader(from) {
  const s = String(from || "");
  const m = s.match(/<([^>]+)>/);
  return normalize(m?.[1] ?? s);
}

function getDomain(email) {
  const at = email.lastIndexOf("@");
  return at === -1 ? null : email.slice(at + 1);
}

function domainMatches(candidateDomain, ruleDomain) {
  const d = normalize(candidateDomain);
  const r = normalize(ruleDomain);
  return d === r || d.endsWith(`.${r}`);
}

export function resolveMerchantFromSender({ from, directory, overrides }) {
  const email = extractEmailFromFromHeader(from);
  const domain = getDomain(email);

  if (!email || !domain) return { canonicalName: null, confidence: 0, reason: "no_sender" };

  // override by exact sender email
  for (const o of overrides || []) {
    if (o.sender_email && normalize(o.sender_email) === email) {
      return { canonicalName: o.canonical_name, confidence: 95, reason: "user_override_email" };
    }
  }

  // override by domain
  for (const o of overrides || []) {
    if (o.sender_domain && domainMatches(domain, o.sender_domain)) {
      return { canonicalName: o.canonical_name, confidence: 85, reason: "user_override_domain" };
    }
  }

  // consumer domain filter: NOT a company signal
  if (CONSUMER_EMAIL_DOMAINS.has(domain)) {
    return { canonicalName: null, confidence: 0, reason: "consumer_domain_filtered" };
  }

  // global directory exact email
  for (const m of directory || []) {
    const list = (m.sender_emails || []).map(normalize);
    if (list.includes(email)) return { canonicalName: m.canonical_name, confidence: 90, reason: "dir_email_exact" };
  }

  // global directory domain/subdomain
  for (const m of directory || []) {
    for (const d of m.sender_domains || []) {
      if (domainMatches(domain, d)) return { canonicalName: m.canonical_name, confidence: 70, reason: "dir_domain_match" };
    }
  }

  return { canonicalName: null, confidence: 0, reason: "no_match" };
}
