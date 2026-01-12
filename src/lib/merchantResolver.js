const CONSUMER_EMAIL_DOMAINS = new Set([
  "gmail.com", // your explicit requirement
]);

function normalizeEmail(s) {
  return String(s || "").trim().toLowerCase();
}

function parseFromHeader(from) {
  const raw = String(from || "").trim();
  const m = raw.match(/<([^>]+)>/);
  const email = normalizeEmail(m?.[1] ?? raw);
  const at = email.lastIndexOf("@");
  const domain = at === -1 ? null : email.slice(at + 1);
  return { senderEmail: email || null, senderDomain: domain || null };
}

function domainMatches(candidateDomain, ruleDomain) {
  if (!candidateDomain || !ruleDomain) return false;
  const d = candidateDomain.toLowerCase();
  const r = ruleDomain.toLowerCase();
  return d === r || d.endsWith(`.${r}`);
}

/**
 * Resolve merchant from sender identity + user overrides.
 * @returns {{
 *  canonicalName: string|null,
 *  matchType: "override_email"|"override_domain"|"directory_email"|"directory_domain"|"consumer_domain_filtered"|"no_sender"|"no_match",
 *  senderEmail: string|null,
 *  senderDomain: string|null
 * }}
 */
export function resolveMerchantFromSender({ from, directory, overrides }) {
  const { senderEmail, senderDomain } = parseFromHeader(from);

  if (!senderEmail || !senderDomain) {
    return { canonicalName: null, matchType: "no_sender", senderEmail, senderDomain };
  }

  // Hard filter: consumer domains are not a company signal
  if (CONSUMER_EMAIL_DOMAINS.has(senderDomain)) {
    return { canonicalName: null, matchType: "consumer_domain_filtered", senderEmail, senderDomain };
  }

  // 0) User overrides win (trust)
  for (const o of overrides || []) {
    if (o?.sender_email && normalizeEmail(o.sender_email) === senderEmail) {
      return { canonicalName: o.canonical_name, matchType: "override_email", senderEmail, senderDomain };
    }
  }
  for (const o of overrides || []) {
    if (o?.sender_domain && domainMatches(senderDomain, String(o.sender_domain).toLowerCase())) {
      return { canonicalName: o.canonical_name, matchType: "override_domain", senderEmail, senderDomain };
    }
  }

  // 1) Exact sender match
  for (const m of directory || []) {
    const list = (m.sender_emails || []).map(normalizeEmail);
    if (list.includes(senderEmail)) {
      return { canonicalName: m.canonical_name, matchType: "directory_email", senderEmail, senderDomain };
    }
  }

  // 2) Domain match (subdomain-aware)
  for (const m of directory || []) {
    for (const d of m.sender_domains || []) {
      if (domainMatches(senderDomain, String(d).toLowerCase())) {
        return { canonicalName: m.canonical_name, matchType: "directory_domain", senderEmail, senderDomain };
      }
    }
  }

  return { canonicalName: null, matchType: "no_match", senderEmail, senderDomain };
}
