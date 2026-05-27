/**
 * Normalises a merchant name for canonical storage.
 * Trims, collapses internal whitespace, and applies title case.
 *
 * Examples:
 *   "netflix"   → "Netflix"
 *   "uber one"  → "Uber One"
 *   "disney+"   → "Disney+"
 *   "dr. kegel" → "Dr. Kegel"
 *   "nyt games" → "Nyt Games"
 *
 * @param {string} name
 * @returns {string}
 */
export function normaliseMerchant(name) {
  if (!name) return name;
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}
