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
const SUFFIXES = [
  "incorporated", "corporation", "limited liability company",
  "inc.", "corp.", "ltd.", "llc.", "llp.", "plc.",
  "inc", "corp", "ltd", "llc", "llp", "plc", "ab", "gmbh", "sas", "bv",
];

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

  for (const suffix of SUFFIXES) {
    // Match suffix at word boundary at the end of the string.
    const pattern = new RegExp(`\\s+${suffix.replace(".", "\\.")}\\s*$`);
    name = name.replace(pattern, "").trim();
  }

  // Collapse multiple spaces and strip remaining punctuation noise.
  name = name.replace(/\s{2,}/g, " ").replace(/[^\w\s]/g, "").trim();

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
