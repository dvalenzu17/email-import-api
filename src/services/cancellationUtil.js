/**
 * Pure helpers for the cancellation ("mark dead") flow. Kept free of DB/crypto
 * imports so the logic is unit-testable without env or a database connection.
 */

/**
 * Normalizes cancellation entries and drops any merchant seen active in the
 * same scan (the re-subscribe guard). Entries may be legacy strings or
 * { merchant, date } objects.
 *
 * @param {Array<string|{merchant:string,date?:Date|null}>} cancellations
 * @param {Set<string>} activeMerchants  lowercased merchant keys
 * @returns {Array<{ merchant: string, date: Date|null }>}
 */
export function selectStaleCancellations(cancellations, activeMerchants) {
  return cancellations
    .map((c) => (typeof c === "string" ? { merchant: c, date: null } : { merchant: c?.merchant, date: c?.date ?? null }))
    .filter((c) => c.merchant && !activeMerchants.has(c.merchant.toLowerCase()));
}
