// src/lib/merchantNormalize.js

function norm(s) {
    return String(s || "").trim().toLowerCase();
  }
  
  // crude but 10x better than "first label"
  export function baseDomain(senderDomain) {
    const d = norm(senderDomain);
    if (!d) return null;
    const parts = d.split(".").filter(Boolean);
    if (parts.length <= 2) return d;
    return parts.slice(-2).join(".");
  }
  
  export function inferMerchantName(senderDomain) {
    const bd = baseDomain(senderDomain);
    if (!bd) return "unknown";
    const name = bd.split(".")[0];
    return name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  
  // Directory row shape in your DB: merchant_directory has canonical_name, sender_domain, sender_email, keywords
  export function resolveMerchant({ senderEmail, senderDomain, overrides = [], directory = [] }) {
    const email = norm(senderEmail);
    const domain = norm(senderDomain);
    const bd = baseDomain(domain);
  
    // 1) user overrides (highest priority)
    const o1 = overrides.find((o) => o.sender_email && norm(o.sender_email) === email);
    if (o1?.canonical_name) return o1.canonical_name;
  
    const o2 = overrides.find((o) => o.sender_domain && norm(o.sender_domain) === domain);
    if (o2?.canonical_name) return o2.canonical_name;
  
    // 2) directory exact domain match
    const d1 = directory.find((m) => m.sender_domain && norm(m.sender_domain) === domain);
    if (d1?.canonical_name) return d1.canonical_name;
  
    // 3) directory base-domain match (helps: e.udemymail.com → udemymail.com)
    const d2 = directory.find((m) => m.sender_domain && norm(m.sender_domain) === bd);
    if (d2?.canonical_name) return d2.canonical_name;
  
    // 4) fallback
    return inferMerchantName(domain);
  }
  