/**
 * Escalating reminder ladder for renewals and trial-endings.
 *
 * A single heads-up is easy to miss; the product promise is escalating nudges
 * as the charge nears. Each rung fires at most once (deduped via the
 * subscription_alerts ledger with period_key = "<date>#<rung>").
 *
 * Rung selection is driven by a *calendar-day* delta (days_until) computed in
 * SQL against CURRENT_DATE — not JS Date math — so it can't drift across
 * timezones. Precise local time-of-day ("9am morning-of") is intentionally left
 * to the client scheduler; the server has no per-user timezone.
 *
 * Pure module (no DB/env imports) so it is unit-testable in isolation.
 */

// Ordered most-distant → most-urgent. `days` is the calendar-day delta that
// triggers the rung; `lead` is human copy for the notification body.
export const LADDER_RUNGS = [
  { key: "2day",   days: 2, lead: "in 2 days" },
  { key: "1day",   days: 1, lead: "tomorrow" },
  { key: "day_of", days: 0, lead: "today" },
];

const BY_DAYS = new Map(LADDER_RUNGS.map((r) => [r.days, r]));

/**
 * Maps a calendar-day delta to the rung that should fire, or null if the date
 * is outside the ladder window (>2 days out, or already in the past).
 *
 * @param {number} daysUntil  whole days between the charge date and today
 * @returns {{key:string, days:number, lead:string} | null}
 */
export function rungFromDays(daysUntil) {
  if (!Number.isInteger(daysUntil)) return null;
  return BY_DAYS.get(daysUntil) ?? null;
}

// The widest window the ladder needs the query to return (days).
export const LADDER_MAX_DAYS = Math.max(...LADDER_RUNGS.map((r) => r.days));
