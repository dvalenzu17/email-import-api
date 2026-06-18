/**
 * Semantic merchant normalization.
 *
 * Strips legal suffixes, punctuation, and common noise from merchant names so
 * that near-identical merchants are deduplicated before upsert.
 *
 * Examples:
 *   "NETFLIX.COM"   → "netflix"
 *   "NETFLIX INC"   → "netflix"
 *   "Netflix, Inc." → "netflix"
 *   "ADOBE SYSTEMS" → "adobe systems"
 *   "Spotify AB"    → "spotify"
 */

// Legal / corporate suffixes to strip (order matters — longer first).
// Pre-compiled to avoid creating 20 RegExp objects per normalizeMerchant() call.
const SUFFIX_PATTERNS = [
  "incorporated", "corporation", "limited liability company",
  "inc.", "corp.", "ltd.", "llc.", "llp.", "plc.",
  "inc", "corp", "ltd", "llc", "llp", "plc", "ab", "gmbh", "sas", "bv",
].map((s) => new RegExp(`\\s+${s.replace(".", "\\.")}\\s*$`));

// TLDs that sometimes appear in merchant names extracted from email headers.
const TLDS = [".com", ".net", ".org", ".io", ".co", ".app", ".tv"];

/**
 * Normalise a raw merchant string into a canonical lowercase key.
 *
 * @param {string} raw
 * @returns {string} normalised merchant key
 */
export function normalizeMerchant(raw) {
  if (!raw) return "";

  let name = raw.toLowerCase().trim();

  // Strip TLDs.
  for (const tld of TLDS) {
    if (name.endsWith(tld)) {
      name = name.slice(0, -tld.length);
    }
  }

  // Strip trailing legal suffixes (may be comma-separated: "Netflix, Inc.").
  name = name.replace(/[,;]+$/, "").trim();

  for (const pattern of SUFFIX_PATTERNS) {
    name = name.replace(pattern, "").trim();
  }

  // Collapse multiple spaces and strip remaining punctuation noise.
  // Preserve + so brand names like "disney+" and "apple tv+" round-trip correctly.
  name = name.replace(/\s{2,}/g, " ").replace(/[^\w\s+]/g, "").trim();

  return name;
}

/**
 * Returns true if two merchant strings are likely the same entity.
 * Uses normalised equality — not a fuzzy edit-distance check.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isSameMerchant(a, b) {
  return normalizeMerchant(a) === normalizeMerchant(b);
}
