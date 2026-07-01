/**
 * Core IMAP scan logic, decoupled from the HTTP request/response cycle.
 * Mirrors gmailScanService.js pattern — can be called from routes or a BullMQ worker.
 */

import { scanImapInbox } from "./imapClient.js";
import { detectRecurringSubscriptions } from "./subscriptionEngine.js";
import { CONFIDENCE_THRESHOLD } from "../config.js";
import { getFeedbackMerchantMap } from "../db/index.js";
import { getActiveSubscriptionConfidences, batchUpsertSubscriptions, applyTrialEnds } from "../db/index.js";
import { selectTrialEnds } from "./trialUtil.js";
import {
  buildChargeDataMap,
  enrichSubscriptions,
  buildBypassEntries,
  processCancellations,
  applyLifecycleCancellations,
  applyExpiryRenewalUpdates,
  finalizeScan,
} from "./postDetection.js";
import { notifyNewSubscriptions, notifyZombieCharges, notifyPriceIncreases } from "./newSubscriptionNotifier.js";
import logger from "../lib/logger.js";

const APPLE_IAP_THRESHOLD = 0.35;

function getThresholdForProvider(provider) {
  return provider === "icloud" ? 0.55 : CONFIDENCE_THRESHOLD;
}

/**
 * @param {{
 *   userId: string,
 *   provider: string,
 *   user: string,
 *   pass: string,
 *   daysBack?: number,
 *   sinceDate?: Date,
 *   force?: boolean,
 * }} opts
 */
export async function runImapScan({ userId, provider, user, pass, daysBack = 730, sinceDate, force = false }) {
  const started = Date.now();

  // ── Step 1: Scan inbox ──────────────────────────────────────────────────────
  const { charges, cancellations, cancelledCharges, trialSignals = [], scannedCount, checkpoint } = await scanImapInbox({
    provider, user, pass, daysBack, sinceDate: force ? undefined : sinceDate,
  });

  // ── Step 2: Detect subscriptions ────────────────────────────────────────────
  const feedbackMap = await getFeedbackMerchantMap(userId);
  const chargeDataMap = buildChargeDataMap(charges);

  const allSubscriptions = enrichSubscriptions(
    detectRecurringSubscriptions(charges, { feedbackMap }),
    chargeDataMap,
    { source: provider, boostAppleIAP: true }
  );

  // ── Step 3: Threshold filtering ─────────────────────────────────────────────
  const nonAppleThreshold = getThresholdForProvider(provider);
  const confident = allSubscriptions.filter((s) => {
    const raw = chargeDataMap[s.merchant.toLowerCase()];
    const thr = raw?.isAppleIAP ? APPLE_IAP_THRESHOLD : nonAppleThreshold;
    if (s.confidence < thr) {
      logger.info({ merchant: s.merchant, confidence: s.confidence, threshold: thr }, "imap_below_threshold");
      return false;
    }
    return true;
  });

  const upsertConfident = await batchUpsertSubscriptions(userId, confident);

  // ── Step 4: Bypass loop ─────────────────────────────────────────────────────
  const existingConfidences = await getActiveSubscriptionConfidences(userId);
  const detectedMerchants = new Set(allSubscriptions.map((s) => s.merchant.toLowerCase()));

  const { bypass: appleBypass, expiryUpdates } = await buildBypassEntries({
    charges,
    detectedMerchants,
    existingConfidences,
    source: provider,
    shouldBypass: () => true, // open to all charges
    logger,
  });

  let upsertBypass = { inserted: [], zombieCharges: [], priceIncreases: [] };
  if (appleBypass.length) {
    upsertBypass = await batchUpsertSubscriptions(userId, appleBypass);
  }

  // Fire scan-driven pushes (best-effort, non-blocking). All respect the user's
  // new-subscription-alerts preference.
  const newlyInserted = [...(upsertConfident.inserted || []), ...(upsertBypass.inserted || [])];
  const zombieCharges = [...(upsertConfident.zombieCharges || []), ...(upsertBypass.zombieCharges || [])];
  const priceIncreases = [...(upsertConfident.priceIncreases || []), ...(upsertBypass.priceIncreases || [])];

  // Trial pre-emption: stamp trial_end and flag newly-inserted trials so the push
  // becomes the pre-emptive "trial → bills $X on <date>" hook.
  const appliedTrials = await applyTrialEnds(userId, selectTrialEnds(trialSignals));
  if (appliedTrials.length) {
    const trialByMerchant = new Map(appliedTrials.map((t) => [t.merchant.toLowerCase(), t.trialEnd]));
    for (const s of newlyInserted) {
      const te = trialByMerchant.get(String(s.merchant).toLowerCase());
      if (te) { s.isTrial = true; s.trialEnd = te; }
    }
  }

  if (newlyInserted.length) notifyNewSubscriptions(userId, newlyInserted, logger).catch(() => {});
  if (zombieCharges.length) notifyZombieCharges(userId, zombieCharges, logger).catch(() => {});
  if (priceIncreases.length) notifyPriceIncreases(userId, priceIncreases, logger).catch(() => {});

  // Patch renewal_date for expiry notices where merchant="Apple"
  await applyExpiryRenewalUpdates(userId, expiryUpdates, logger);

  // ── Step 5: Cancellations ───────────────────────────────────────────────────
  const activeMerchants = new Set([
    ...confident.map((s) => s.merchant.toLowerCase()),
    ...appleBypass.map((s) => s.merchant.toLowerCase()),
  ]);

  const cancelledForReview = await processCancellations(userId, {
    cancelledCharges,
    activeMerchants,
    source: provider,
  });

  await applyLifecycleCancellations(userId, cancellations, activeMerchants);

  // ── Step 6: Finalize ────────────────────────────────────────────────────────
  const executionTimeMs = Date.now() - started;
  await finalizeScan(userId, {
    provider,
    scannedMessages: scannedCount,
    detectedCharges: charges.length,
    executionTimeMs,
    checkpoint,
  });

  return {
    subscriptions: [...confident, ...cancelledForReview, ...appleBypass],
    detectedSubscriptions: confident.length + appleBypass.length,
    meta: {
      scannedMessages: scannedCount,
      parsedCharges: charges.length,
      passedConfidenceThreshold: confident.length,
      appleBypassCount: appleBypass.length,
      executionTimeMs,
    },
  };
}
