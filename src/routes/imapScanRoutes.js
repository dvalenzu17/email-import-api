import jwt from "jsonwebtoken"; // kept for rate-limit keyGenerator only
import { CONFIDENCE_THRESHOLD } from "../config.js";
import { z } from "zod";
import { requireUser } from "../lib/auth.js";
import { scanImapInbox, verifyImapCredentials, getImapConfig } from "../services/imapClient.js";
import { detectRecurringSubscriptions } from "../services/subscriptionEngine.js";
import { batchUpsertSubscriptions, upsertCancelledSubscriptions, saveScanMetadata, saveImapCredentials, getImapCredentials, getFeedbackMerchantMap, cancelSubscriptionByMerchant, updateRenewalDateByAmountAndInterval } from "../db/index.js";
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
    const userId = requireUser(req, reply);
    if (!userId) return;

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
    const userId = requireUser(req, reply);
    if (!userId) return;

    const scanParsed = scanBodySchema.safeParse(req.body);
    if (!scanParsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    let { provider, user, pass, daysBack = 730 } = scanParsed.data;

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
        // Task 3: Apple IAP emails are official transactional receipts from Apple — boost
        // confidence by +0.15 before threshold filtering. A single Apple confirmation is
        // stronger evidence than multiple charge-pattern inferences from a generic inbox.
        const isAppleIAP = !!raw?.isAppleIAP;
        const boostedConfidence = isAppleIAP
          ? Math.min(1.0, Math.round((s.confidence + 0.15) * 1000) / 1000)
          : s.confidence;
        return {
          ...s,
          confidence: boostedConfidence,
          source: provider,
          // Override billingInterval if the engine returned null/unknown and we extracted one from the email.
          billingInterval: s.billingInterval && s.billingInterval !== "unknown"
            ? s.billingInterval
            : (raw?.billingInterval ?? s.billingInterval),
          senderDomain:  raw?.senderDomain ?? null,
          iconUrl:       raw?.iconUrl ?? null,
          // TASK 7: pass extractionLog from the charge to the DB upsert
          extractionLog: raw?.extractionLog ?? null,
        };
      });
      // Task 1: separate thresholds per source reliability.
      //   Apple IAP (email.apple.com receipts): 0.35 — one official receipt is stronger evidence
      //     than multiple inferred charge patterns; the structural format is highly reliable.
      //   Non-Apple iCloud: 0.55 — reliable IMAP but merchant resolution is less certain.
      //   Gmail / other providers: CONFIDENCE_THRESHOLD (0.50).
      const APPLE_IAP_THRESHOLD = 0.35;
      const nonAppleThreshold   = provider === "icloud" ? 0.55 : CONFIDENCE_THRESHOLD;

      const confident = allSubscriptions.filter((s) => {
        const raw = chargeDataMap[s.merchant.toLowerCase()];
        const thr = raw?.isAppleIAP ? APPLE_IAP_THRESHOLD : nonAppleThreshold;
        if (s.confidence < thr) {
          console.log(`[imap] below_threshold merchant="${s.merchant}" confidence=${s.confidence} threshold=${thr} isAppleIAP=${!!raw?.isAppleIAP}`);
          return false;
        }
        return true;
      });

      // Apple IAP bypass: Apple IAP emails are almost always subscriptions. If the
      // engine didn't detect them (insufficient recurrence data), add them manually
      // with a moderate confidence so they appear in the review candidates page.
      // Use confident (not allSubscriptions) so merchants that scored below the
      // threshold are still eligible for the bypass rather than silently dropped.
      const detectedMerchants = new Set(confident.map((s) => s.merchant.toLowerCase()));
      const appleBypass = [];
      const appleBypassSeen = new Set();
      // Expiry notices where app-name extraction failed and merchant resolved to "Apple".
      // We can't write merchant="Apple" as a new record — collect for renewal_date patching instead.
      const expiryRenewalUpdates = [];

      // Task 2: bypass is open to ALL charges that weren't written via the confident path —
      // not just Apple IAP. The isAppleIAP flag is for merchant name extraction only; it is
      // not a gate on which merchants may be written.
      for (const c of charges) {
        const key = c.merchant.toLowerCase();

        // Apple expiry notice where app-name extraction failed → merchant="Apple".
        // Writing merchant="Apple" would shadow all other subscriptions via the unique
        // index on (user_id, LOWER(merchant)) and burn the dedup slot. Skip INSERT;
        // patch renewal_date onto the matched existing record instead.
        if (c.isExpiryNotice && key === "apple") {
          console.log(`[imap] bypass_skip reason=expiry_apple_fallback amount=${c.amount} interval=${c.billingInterval} renewalDate=${c.renewalDate ?? "null"}`);
          if (c.renewalDate) expiryRenewalUpdates.push({ amount: c.amount, billingInterval: c.billingInterval ?? null, renewalDate: c.renewalDate });
          continue;
        }

        if (detectedMerchants.has(key)) {
          console.log(`[imap] bypass_skip reason=already_confident merchant="${c.merchant}"`);
          continue;
        }
        if (appleBypassSeen.has(key)) {
          console.log(`[imap] bypass_skip reason=duplicate_merchant merchant="${c.merchant}"`);
          continue;
        }
        appleBypassSeen.add(key);
        console.log(`[imap] bypass_add merchant="${c.merchant}" amount=${c.amount} isAppleIAP=${c.isAppleIAP}`);
        appleBypass.push({
          merchant:        c.merchant,
          renewalAmount:   c.amount,
          currency:        c.currency,
          billingInterval: c.billingInterval ?? "monthly",
          renewalDate:     c.renewalDate ?? null,
          // Expiry notices state the renewal price/date explicitly — higher confidence.
          // All other bypass entries use 0.75 (structurally observed charge, unverified recurrence).
          confidence:      c.isExpiryNotice ? 0.80 : 0.75,
          isActive:        true,
          isSuggested:     true,
          source:          provider,
          senderDomain:    c.senderDomain ?? null,
          iconUrl:         c.iconUrl ?? null,
          extractionLog:   c.extractionLog ?? null,
        });
      }

      await batchUpsertSubscriptions(userId, [...confident, ...appleBypass]);

      // Bug 2: for expiry notices where merchant="Apple", try to patch renewal_date onto
      // the existing subscription matched by amount (±$0.50) + billing_interval.
      for (const u of expiryRenewalUpdates) {
        const { updated, merchant } = await updateRenewalDateByAmountAndInterval(userId, u);
        if (updated) {
          console.log(`[imap] expiry_renewal_date_patched merchant="${merchant}" amount=${u.amount} renewalDate=${u.renewalDate}`);
        } else {
          console.log(`[imap] expiry_renewal_date_no_match amount=${u.amount} interval=${u.billingInterval} — no existing subscription matched, skipped`);
        }
      }

      // Upsert + collect cancelled subscriptions from expiry/cancellation emails.
      // These appear in the scan review as candidates (with mayBeCancelled flag)
      // but are NOT auto-added to the home screen — user must confirm.
      let cancelledForReview = [];
      if (cancelledCharges.length) {
        const activeMerchants = new Set(confident.map((s) => s.merchant.toLowerCase()));
        // Deduplicate by merchant — multiple emails for the same merchant (e.g. 3
        // failed-payment emails for disney+) would cause a Postgres ON CONFLICT error
        // if all rows hit the same unique key in a single unnest() INSERT.
        // Keep the entry with the largest amount when there are duplicates.
        const cancelledByMerchant = {};
        for (const c of cancelledCharges) {
          const key = c.merchant.toLowerCase();
          if (activeMerchants.has(key)) continue;
          const prev = cancelledByMerchant[key];
          if (!prev || c.renewalAmount > prev.renewalAmount) {
            cancelledByMerchant[key] = { ...c, source: provider };
          }
        }
        const newlyCancelled = Object.values(cancelledByMerchant);
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
      // Never cancel a merchant that was also detected as an active charge in this
      // same scan — a receipt always wins over an old expiry/cancellation notice.
      // e.g. LinkedIn may have a "Your Subscription is Expiring" notice in the
      // inbox AND a recent "Your Subscription is Confirmed" receipt; without this
      // guard the route would upsert LinkedIn as active then immediately cancel it.
      if (cancellations.length) {
        const activeScanMerchants = new Set([
          ...confident.map((s) => s.merchant.toLowerCase()),
          ...appleBypass.map((s) => s.merchant.toLowerCase()),
        ]);
        const staleCancellations = cancellations.filter(
          (m) => !activeScanMerchants.has(m.toLowerCase())
        );
        await Promise.allSettled(
          staleCancellations.map((merchant) => cancelSubscriptionByMerchant(userId, merchant))
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
          scannedMessages:         scannedCount,       // emails fetched (UIDs matched by server-side search)
          parsedCharges:           charges.length,      // emails with extractable amount + merchant
          passedConfidenceThreshold: confident.length,  // engine detections above threshold (${threshold})
          appleBypassCount:        appleBypass.length,  // Apple IAP added via bypass (engine missed)
          executionTimeMs:         Date.now() - started,
        },
      };
    } catch (err) {
      req.log.error({ err }, "imap_scan_error");
      return reply.code(500).send({ error: "scan_failed" });
    }
  });
}