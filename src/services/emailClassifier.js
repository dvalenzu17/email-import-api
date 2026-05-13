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

/**
 * @param {string} subject
 * @param {string} body   — plain text (post-HTML stripping)
 * @returns {string}      — one of EMAIL_TYPES values
 */
export function classifyEmail(subject, body) {
  const s = subject.toLowerCase();
  const b = body.toLowerCase();

  // ── Cancellation ─────────────────────────────────────────────────────────
  if (
    s.includes("cancell") || s.includes("canceled") ||
    b.includes("subscription has been cancelled") ||
    b.includes("subscription has been canceled") ||
    b.includes("successfully cancelled your") ||
    b.includes("successfully canceled your") ||
    b.includes("you have cancelled") ||
    b.includes("you've cancelled") ||
    b.includes("you've canceled") ||
    b.includes("we've cancelled your") ||
    b.includes("your account has been cancelled") ||
    b.includes("subscription cancelled") ||
    b.includes("subscription canceled") ||
    b.includes("membership has been cancelled") ||
    b.includes("membership has been canceled") ||
    // Apple App Store — sent when user turns off auto-renew
    b.includes("will not be renewed") ||
    b.includes("will not renew") ||
    b.includes("turned off auto-renew") ||
    b.includes("auto-renewal has been turned off") ||
    b.includes("subscription will expire") ||
    b.includes("access will end on") ||
    b.includes("access ends on")
  ) return EMAIL_TYPES.CANCELLATION;

  // ── Failed payment ────────────────────────────────────────────────────────
  if (
    s.includes("payment failed") || s.includes("payment declined") ||
    s.includes("payment unsuccessful") ||
    (s.includes("action required") && (s.includes("payment") || s.includes("subscription"))) ||
    b.includes("payment was declined") ||
    b.includes("unable to process your payment") ||
    b.includes("couldn't charge your") ||
    b.includes("we were unable to charge") ||
    b.includes("payment method failed") ||
    b.includes("your card was declined") ||
    b.includes("your payment did not go through") ||
    b.includes("renewal failed") ||
    b.includes("billing attempt failed")
  ) return EMAIL_TYPES.FAILED_PAYMENT;

  // ── Trial ending ──────────────────────────────────────────────────────────
  if (
    (s.includes("trial") && (s.includes("end") || s.includes("expir") || s.includes("over") || s.includes("finish"))) ||
    b.includes("trial ends in") ||
    b.includes("trial period ends") ||
    b.includes("trial is ending") ||
    b.includes("trial expires") ||
    b.includes("trial will end") ||
    b.includes("free trial is over")
  ) return EMAIL_TYPES.TRIAL_ENDING;

  // ── Trial started ─────────────────────────────────────────────────────────
  if (
    (s.includes("free trial") && (s.includes("start") || s.includes("begin") || s.includes("activat"))) ||
    b.includes("your free trial has started") ||
    b.includes("your trial has begun") ||
    b.includes("trial has been activated") ||
    b.includes("free trial is now active")
  ) return EMAIL_TYPES.TRIAL_START;

  // ── Upgrade / plan change ─────────────────────────────────────────────────
  if (
    s.includes("plan upgrade") || s.includes("plan change") ||
    (s.includes("upgrade") && !s.includes("receipt")) ||
    b.includes("you've been upgraded") ||
    b.includes("your plan has been upgraded") ||
    b.includes("successfully upgraded to") ||
    b.includes("you've switched to the") ||
    b.includes("your subscription has been upgraded")
  ) return EMAIL_TYPES.UPGRADE;

  // ── Renewal notice (upcoming, not yet charged) ────────────────────────────
  if (
    (s.includes("renewal") && !s.includes("receipt") && !s.includes("invoice") && !s.includes("renew")) ||
    // Apple "Your Subscription is Expiring" — subscription is expiring but price is still actionable
    /subscription.{0,15}expir/i.test(s) ||
    s.includes("subscription is expiring") ||
    b.includes("will be charged") ||
    b.includes("will automatically renew") ||
    b.includes("will renew on") ||
    b.includes("upcoming renewal") ||
    b.includes("your subscription renews on") ||
    b.includes("scheduled to renew")
  ) return EMAIL_TYPES.RENEWAL_NOTICE;

  return EMAIL_TYPES.RECEIPT;
}
