/**
 * Keyword-based email type classifier.
 *
 * Classifies a billing-related email into one of several lifecycle types so
 * the scan pipeline can route each email correctly instead of treating every
 * message as a charge receipt.
 *
 * Types:
 *   receipt        — money has already been charged (default)
 *   renewal_notice — upcoming charge, not yet billed
 *   cancellation   — subscription was cancelled
 *   failed_payment — payment declined / action required
 *   trial_start    — free trial has begun
 *   trial_ending   — trial is about to expire and billing will begin
 *   upgrade        — plan changed (price may differ from prior receipts)
 *
 * Accuracy is intentionally conservative: when in doubt, return "receipt"
 * so the detection pipeline can still score the email normally.
 *
 * Performance: All patterns are pre-compiled at module load. classifyEmail()
 * does at most 12 regex tests instead of 60+ string.includes() calls per email.
 */

export const EMAIL_TYPES = {
  RECEIPT:        "receipt",
  RENEWAL_NOTICE: "renewal_notice",
  CANCELLATION:   "cancellation",
  FAILED_PAYMENT: "failed_payment",
  TRIAL_START:    "trial_start",
  TRIAL_ENDING:   "trial_ending",
  UPGRADE:        "upgrade",
};

// ── Pre-compiled combined patterns ──────────────────────────────────────────
// Each type has a subject regex and a body regex. A single .test() per text
// replaces 5-30 individual .includes() calls.

const CANCEL_SUBJECT_RE = /cancell|canceled/;
const CANCEL_BODY_RE = /subscription has been cancell?ed|successfully cancell?ed your|you have cancell?ed|you've cancell?ed|we've cancell?ed your|your account has been cancell?ed|subscription cancell?ed|membership has been cancell?ed|will not be renewed|will not renew|turned off auto-renew|auto-renewal has been turned off|access will end on|access ends on|subscription has ended|subscription ended on|your account is now inactive|account has been terminated|your membership has expired|account is deactivated|your subscription is now cancell?ed/;

const FAILED_SUBJECT_RE = /payment (?:failed|declined|unsuccessful)|failed payment|action required.*(?:payment|subscription)/;
const FAILED_BODY_RE = /payment was declined|unable to process your payment|couldn't charge your|we were unable to charge|payment method failed|your card was declined|your payment did not go through|renewal failed|billing attempt failed/;

const TRIAL_ENDING_SUBJECT_RE = /trial.*(?:end|expir|over|finish)/;
const TRIAL_ENDING_BODY_RE = /trial (?:ends in|period ends|is ending|expires|will end)|free trial is over/;

const TRIAL_START_SUBJECT_RE = /free trial.*(?:start|begin|activat)/;
const TRIAL_START_BODY_RE = /your free trial has started|your trial has begun|trial has been activated|free trial is now active/;

const UPGRADE_SUBJECT_RE = /plan (?:upgrade|change)|upgrade(?!.*receipt)/;
const UPGRADE_BODY_RE = /you've been upgraded|your plan has been upgraded|successfully upgraded to|you've switched to the|your subscription has been upgraded/;

const RENEWAL_SUBJECT_RE = /renewal(?!.*(?:receipt|invoice|renew))|subscription.{0,15}expir|subscription is expiring/;
const RENEWAL_BODY_RE = /subscription will expire|will be charged|will automatically renew|will renew on|upcoming renewal|your subscription renews on|scheduled to renew/;

/**
 * @param {string} subject
 * @param {string} body   — plain text (post-HTML stripping)
 * @returns {string}      — one of EMAIL_TYPES values
 */
export function classifyEmail(subject, body) {
  const s = subject.toLowerCase();
  const b = body.toLowerCase();

  if (CANCEL_SUBJECT_RE.test(s) || CANCEL_BODY_RE.test(b))
    return EMAIL_TYPES.CANCELLATION;

  if (FAILED_SUBJECT_RE.test(s) || FAILED_BODY_RE.test(b))
    return EMAIL_TYPES.FAILED_PAYMENT;

  if (TRIAL_ENDING_SUBJECT_RE.test(s) || TRIAL_ENDING_BODY_RE.test(b))
    return EMAIL_TYPES.TRIAL_ENDING;

  if (TRIAL_START_SUBJECT_RE.test(s) || TRIAL_START_BODY_RE.test(b))
    return EMAIL_TYPES.TRIAL_START;

  if (UPGRADE_SUBJECT_RE.test(s) || UPGRADE_BODY_RE.test(b))
    return EMAIL_TYPES.UPGRADE;

  if (RENEWAL_SUBJECT_RE.test(s) || RENEWAL_BODY_RE.test(b))
    return EMAIL_TYPES.RENEWAL_NOTICE;

  return EMAIL_TYPES.RECEIPT;
}
