import { z } from "zod";
import { requireUser } from "../lib/auth.js";
import {
  getSubscriptions,
  getLatestScanMetadata,
  updateSubscriptionStatus,
  getSubscriptionById,
  saveFeedback,
  saveMerchantConfirmation, // TASK 4: write per-confirmation signal for alias rebuild
} from "../db/index.js";
import { extractFeatures } from "../services/modelFeatures.js";

const patchStatusSchema = z.object({
  status: z.enum(["confirmed", "cancelled", "ignored"]),
});

const feedbackSchema = z.object({
  label: z.enum(["confirmed", "rejected"]),
});

function formatSubscription(s) {
  return {
    id: s.id,
    merchant: s.merchant,
    renewalAmount: Number(s.renewal_amount),
    currency: s.currency,
    renewalDate: s.renewal_date ? new Date(s.renewal_date).toISOString() : null,
    billingInterval: s.billing_interval ?? null,
    confidence: Number(s.confidence),
    isActive: s.is_active,
    isSuggested: s.is_suggested,
    userStatus: s.user_status ?? null,
    lastSeenAt: s.last_seen_at ? new Date(s.last_seen_at).toISOString() : null,
    source: s.source,
  };
}

export function registerSubscriptionRoutes(server) {
  // ── GET /subscriptions ───────────────────────────────────────────────────
  server.get("/subscriptions", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const subs = await getSubscriptions(userId, { limit, offset });
      const latestScan = await getLatestScanMetadata(userId);

      return {
        subscriptions: subs.map(formatSubscription),
        meta: latestScan
          ? {
              scannedMessages: latestScan.scanned_messages,
              detectedCharges: latestScan.detected_charges,
              executionTimeMs: latestScan.execution_time_ms,
            }
          : { scannedMessages: 0, detectedCharges: 0, executionTimeMs: 0 },
      };
    } catch (err) {
      req.log.error({ err }, "fetch_subscriptions_error");
      return reply.code(500).send({ error: "fetch_failed" });
    }
  });

  // ── PATCH /subscriptions/:id ─────────────────────────────────────────────
  // Lets users manually override a subscription's status:
  //   confirmed → locks isActive = true (algorithmic staleness ignored)
  //   cancelled → locks isActive = false (won't flip back on next scan)
  //   ignored   → hidden from view, but staleness logic still applies
  server.patch("/subscriptions/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const { id } = req.params;

    const parsed = patchStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    try {
      // Verify the subscription belongs to this user before updating.
      const existing = await getSubscriptionById(userId, id);
      if (!existing) return reply.code(404).send({ error: "not_found" });

      const updated = await updateSubscriptionStatus(userId, id, parsed.data.status);
      return { subscription: formatSubscription(updated) };
    } catch (err) {
      req.log.error({ err }, "patch_subscription_error");
      return reply.code(500).send({ error: "update_failed" });
    }
  });

  // ── POST /subscriptions/:id/feedback ────────────────────────────────────
  // Records algorithm feedback — whether a detection was a true or false positive.
  // This builds the labeled training dataset used by scripts/trainModel.js.
  // Distinct from PATCH /:id (user_status) which controls UI visibility.
  server.post("/subscriptions/:id/feedback", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const { id } = req.params;

    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    try {
      const sub = await getSubscriptionById(userId, id);
      if (!sub) return reply.code(404).send({ error: "not_found" });

      // Re-derive the feature snapshot from the stored subscription fields.
      // We don't have intervalVariance / amountCV at route level, so we proxy
      // confidence back into interpretable features for storage.
      const features = extractFeatures({
        occurrences:      sub.occurrence_count ?? 2,
        intervalVariance: 0,   // not stored on subscriptions; defaulted
        amountCV:         0,
        intentCount:      sub.is_suggested ? 1 : 2,
        knownBrand:       false,
      });

      await saveFeedback(userId, id, parsed.data.label, {
        occ_norm:       features[0],
        interval_score: features[1],
        amount_score:   features[2],
        intent_score:   features[3],
        known_brand:    features[4],
        confidence:     Number(sub.confidence),
      });

      // TASK 4: Record the confirmation/rejection as a merchant signal.
      // Non-fatal — a failure here must never break the feedback response.
      // This data accumulates and is used by /admin/merchant-aliases/rebuild
      // to auto-promote high-confidence domain→canonical_name mappings.
      try {
        await saveMerchantConfirmation(userId, {
          merchantDomain: sub.sender_domain ?? sub.merchant,
          canonicalName:  sub.merchant,
          confirmed:      parsed.data.label === "confirmed",
          amount:         Number(sub.renewal_amount) || null,
          interval:       sub.billing_interval ?? null,
        });
      } catch (confirmErr) {
        req.log.warn({ err: confirmErr }, "merchant_confirmation_write_failed");
      }

      return { ok: true };
    } catch (err) {
      req.log.error({ err }, "feedback_error");
      return reply.code(500).send({ error: "feedback_failed" });
    }
  });
}
