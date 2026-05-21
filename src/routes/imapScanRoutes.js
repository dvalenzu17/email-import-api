import jwt from "jsonwebtoken";
import { z } from "zod";
import { scanImapInbox, verifyImapCredentials, getImapConfig } from "../services/imapClient.js";
import { detectRecurringSubscriptions } from "../services/subscriptionEngine.js";
import { batchUpsertSubscriptions, upsertCancelledSubscriptions, saveScanMetadata, saveImapCredentials, getImapCredentials, getFeedbackMerchantMap, cancelSubscriptionByMerchant } from "../db/index.js";
import { decryptCredential } from "../services/crypto.js";

const PROVIDERS = ["gmail", "yahoo", "outlook", "icloud"];

const verifyBodySchema = z.object({
  provider: z.enum(PROVIDERS),
  user: z.string().email(),
  pass: z.string().min(1),
});

const scanBodySchema = z.object({
  provider: z.enum(PROVIDERS),
  user: z.string().email().optional(),
  pass: z.string().min(1).optional(),
  daysBack: z.number().int().min(1).max(730).optional(),
});

const IMAP_RATE_LIMIT = {
  max: 3,
  timeWindow: "15 minutes",
  keyGenerator: (req) => {
    try {
      const token = req.headers.authorization?.split(" ")[1];
      const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
      return decoded?.sub ?? req.ip;
    } catch { return req.ip; }
  },
  statusCode: 429,
  errorResponseBuilder: (req, context) => ({ statusCode: 429, error: "rate_limited", message: "Too many scans. Please wait 15 minutes." }),
};

export function registerImapScanRoutes(server) {

  server.post("/scan/imap/verify", async (req, reply) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(" ")[1];
    if (!token) return reply.code(401).send({ error: "unauthorized" });

    let userId;
    try {
      const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
      userId = decoded.sub;
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const parsed = verifyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    const { provider, user, pass } = parsed.data;

    try {
      await verifyImapCredentials({ provider, user, pass });
      // Save credentials now so subsequent scans can use stored creds
      // even if the first scan fails transiently (e.g. Apple UNAVAILABLE).
      await saveImapCredentials(userId, { provider, user, pass });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  server.post("/scan/imap", { config: { rateLimit: IMAP_RATE_LIMIT } }, async (req, reply) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(" ")[1];
    if (!token) return reply.code(401).send({ error: "unauthorized" });

    let userId;
    try {
      const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
      userId = decoded.sub;
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const scanParsed = scanBodySchema.safeParse(req.body);
    if (!scanParsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    let { provider, user, pass, daysBack = 365 } = scanParsed.data;

    // Fall back to stored credentials if not supplied in request
    if (!user || !pass) {
      const stored = await getImapCredentials(userId, provider);
      if (!stored) {
        return reply.code(400).send({ error: "imap_not_connected" });
      }
      user = stored.imap_user;
      pass = decryptCredential(stored.imap_pass);
    }

    const started = Date.now();

    try {
      const { charges, cancellations, cancelledCharges, scannedCount } = await scanImapInbox({
        provider, user, pass, daysBack,
      });

      await saveImapCredentials(userId, { provider, user, pass });

      const feedbackMap = await getFeedbackMerchantMap(userId);

      // Build a lookup of raw charge data keyed by merchant for post-detection enrichment.
      // When multiple charges exist for the same merchant, prefer yearly over monthly (more specific).
      const chargeDataMap = {};
      for (const c of charges) {
        const key = c.merchant.toLowerCase();
        const prev = chargeDataMap[key];
        if (!prev || (c.billingInterval === "yearly" && prev.billingInterval !== "yearly")) {
          chargeDataMap[key] = c;
        }
      }

      const allSubscriptions = detectRecurringSubscriptions(charges, { feedbackMap }).map((s) => {
        const raw = chargeDataMap[s.merchant.toLowerCase()];
        return {
          ...s,
          source: provider,
          // Override billingInterval if the engine returned null/unknown and we extracted one from the email.
          billingInterval: s.billingInterval && s.billingInterval !== "unknown"
            ? s.billingInterval
            : (raw?.billingInterval ?? s.billingInterval),
          senderDomain: raw?.senderDomain ?? null,
          iconUrl:      raw?.iconUrl ?? null,
        };
      });
      const confident = allSubscriptions.filter((s) => s.confidence >= 0.7);

      // Apple IAP bypass: Apple IAP emails are almost always subscriptions. If the
      // engine didn't detect them (insufficient recurrence data), add them manually
      // with a moderate confidence so they appear in the review candidates page.
      const detectedMerchants = new Set(allSubscriptions.map((s) => s.merchant.toLowerCase()));
      const appleBypass = [];
      const appleBypassSeen = new Set();
      for (const c of charges) {
        if (!c.isAppleIAP) continue;
        const key = c.merchant.toLowerCase();
        if (detectedMerchants.has(key)) continue;
        if (appleBypassSeen.has(key)) continue;
        appleBypassSeen.add(key);
        appleBypass.push({
          merchant:        c.merchant,
          amount:          c.amount,
          currency:        c.currency,
          billingInterval: c.billingInterval ?? "monthly",
          renewalDate:     c.renewalDate ?? null,
          confidence:      0.75,
          isActive:        true,
          isSuggested:     true,
          source:          provider,
          senderDomain:    c.senderDomain ?? null,
          iconUrl:         c.iconUrl ?? null,
        });
      }

      await batchUpsertSubscriptions(userId, [...confident, ...appleBypass]);

      // Upsert + collect cancelled subscriptions from expiry/cancellation emails.
      // These appear in the scan review as candidates (with mayBeCancelled flag)
      // but are NOT auto-added to the home screen — user must confirm.
      let cancelledForReview = [];
      if (cancelledCharges.length) {
        const activeMerchants = new Set(confident.map((s) => s.merchant.toLowerCase()));
        const newlyCancelled = cancelledCharges
          .filter((c) => !activeMerchants.has(c.merchant.toLowerCase()))
          .map((c) => ({ ...c, source: provider }));
        if (newlyCancelled.length) {
          await upsertCancelledSubscriptions(userId, newlyCancelled);
          cancelledForReview = newlyCancelled.map((c) => ({
            merchant:        c.merchant,
            renewalAmount:   c.renewalAmount,
            currency:        c.currency,
            renewalDate:     c.renewalDate ?? null,
            billingInterval: c.billingInterval ?? null,
            senderDomain:    c.senderDomain ?? null,
            iconUrl:         c.iconUrl ?? null,
            confidence:      0.6,
            isActive:        false,
            isSuggested:     true,
            source:          provider,
          }));
        }
      }

      // Apply lifecycle cancellations detected in scan (mirrors Gmail scan behaviour).
      if (cancellations.length) {
        await Promise.allSettled(
          cancellations.map((merchant) => cancelSubscriptionByMerchant(userId, merchant))
        );
      }

      await saveScanMetadata(userId, {
        scannedMessages: scannedCount,
        detectedCharges: charges.length,
        executionTimeMs: Date.now() - started,
      });

      return {
        success: true,
        // Return active + cancelled + Apple IAP bypass subscriptions for the review/candidates page.
        // The frontend shows all of these as candidates requiring user confirmation.
        subscriptions: [...confident, ...cancelledForReview, ...appleBypass],
        detectedSubscriptions: confident.length + appleBypass.length,
        meta: {
          scannedMessages: scannedCount,
          detectedCharges: charges.length,
          executionTimeMs: Date.now() - started,
        },
      };
    } catch (err) {
      req.log.error({ err }, "imap_scan_error");
      return reply.code(500).send({ error: "scan_failed" });
    }
  });
}