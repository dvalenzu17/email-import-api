/**
 * Post-detection pipeline shared by Gmail and IMAP scan paths.
 *
 * After subscriptionEngine.detectRecurringSubscriptions() returns, both scan
 * paths need to: enrich results, apply thresholds, handle bypasses, process
 * cancellations, and persist. This module consolidates that logic.
 */

import { validateMerchantName } from "./emailParser.js";
import { selectStaleCancellations } from "./cancellationUtil.js";
import {
  batchUpsertSubscriptions,
  upsertCancelledSubscriptions,
  getActiveSubscriptionConfidences,
  updateRenewalDateByAmountAndInterval,
  cancelSubscriptionByMerchant,
  saveScanMetadata,
  saveScanCheckpoint,
} from "../db/index.js";

/**
 * Builds a lookup of raw charge data keyed by lowercase merchant.
 * When multiple charges exist for the same merchant, prefers yearly over monthly.
 */
export function buildChargeDataMap(charges) {
  const map = {};
  for (const c of charges) {
    const key = c.merchant.toLowerCase();
    const prev = map[key];
    if (!prev || (c.billingInterval === "yearly" && prev.billingInterval !== "yearly")) {
      map[key] = c;
    }
  }
  return map;
}

/**
 * Enriches subscription results with data from the original charges.
 * Fills in billingInterval, senderDomain, iconUrl, extractionLog.
 * Optionally boosts Apple IAP confidence.
 */
export function enrichSubscriptions(subscriptions, chargeDataMap, { source, boostAppleIAP = false }) {
  return subscriptions.map((s) => {
    const raw = chargeDataMap[s.merchant.toLowerCase()];
    const isAppleIAP = !!raw?.isAppleIAP;
    const confidence = boostAppleIAP && isAppleIAP
      ? Math.min(1.0, Math.round((s.confidence + 0.15) * 1000) / 1000)
      : s.confidence;
    return {
      ...s,
      confidence,
      source,
      billingInterval: s.billingInterval && s.billingInterval !== "unknown"
        ? s.billingInterval
        : (raw?.billingInterval ?? s.billingInterval),
      senderDomain: raw?.senderDomain ?? null,
      iconUrl: raw?.iconUrl ?? null,
      // Merge engine's extractionLog (subject_intent, known_price_tier_score) with
      // charge-level data rather than overwriting. Engine sets extractionLog on `s`;
      // charges rarely have one, so raw?.extractionLog is typically null.
      extractionLog: { ...(s.extractionLog ?? {}), ...(raw?.extractionLog ?? {}) },
    };
  });
}

/**
 * Filters subscriptions by confidence threshold.
 * Supports per-charge threshold overrides (e.g., Apple IAP at 0.35).
 *
 * @param {Function} getThreshold - (subscription, chargeDataMap) => number
 */
export function filterByThreshold(subscriptions, chargeDataMap, getThreshold) {
  return subscriptions.filter((s) => s.confidence >= getThreshold(s, chargeDataMap));
}

/**
 * Builds bypass entries for charges that passed extraction but failed ML detection.
 * These appear as suggested candidates for user review.
 *
 * @param {object} opts
 * @param {Array}  opts.charges - all extracted charges
 * @param {Set}    opts.detectedMerchants - merchants already detected by the engine
 * @param {Map}    opts.existingConfidences - Map<merchant, confidence> from DB (optional)
 * @param {string} opts.source - "gmail" | provider name
 * @param {Function} opts.shouldBypass - (charge) => boolean (filter predicate)
 * @param {object}   opts.logger - req.log or pino logger for structured logging
 */
export async function buildBypassEntries({
  charges, detectedMerchants, existingConfidences, source, shouldBypass, logger,
}) {
  const bypass = [];
  const seen = new Set();
  const expiryUpdates = [];

  for (const c of charges) {
    const key = c.merchant.toLowerCase();

    // Apple expiry notice where app-name extraction failed → merchant="Apple".
    // Skip INSERT; collect for renewal_date patching instead.
    if (c.isExpiryNotice && key === "apple") {
      logger.info({ reason: "expiry_apple_fallback", amount: c.amount }, "bypass_skip");
      if (c.renewalDate) {
        expiryUpdates.push({ amount: c.amount, billingInterval: c.billingInterval ?? null, renewalDate: c.renewalDate });
      }
      continue;
    }

    if (detectedMerchants.has(key)) continue;

    // Check existing DB confidence (if provided)
    if (existingConfidences) {
      const existing = existingConfidences.get(key);
      if (existing !== undefined && existing >= 0.70) continue;
    }

    if (seen.has(key)) continue;
    if (!shouldBypass(c)) continue;
    if (!validateMerchantName(c.merchant)) continue;

    seen.add(key);
    bypass.push({
      merchant: c.merchant,
      renewalAmount: c.amount,
      currency: c.currency,
      billingInterval: c.billingInterval ?? "monthly",
      renewalDate: c.renewalDate ?? null,
      confidence: c.isExpiryNotice ? 0.80 : 0.75,
      isActive: true,
      isSuggested: true,
      source,
      senderDomain: c.senderDomain ?? null,
      iconUrl: c.iconUrl ?? null,
      extractionLog: c.extractionLog ?? null,
    });
  }

  return { bypass, expiryUpdates };
}

/**
 * Deduplicates cancelled charges by merchant, filters out active merchants,
 * and upserts as inactive subscriptions.
 *
 * @returns {Array} cancelledForReview — formatted for scan response
 */
export async function processCancellations(userId, { cancelledCharges, activeMerchants, source }) {
  if (!cancelledCharges.length) return [];

  const cancelledByMerchant = {};
  for (const c of cancelledCharges) {
    const key = c.merchant.toLowerCase();
    if (activeMerchants.has(key)) continue;
    const prev = cancelledByMerchant[key];
    if (!prev || c.renewalAmount > prev.renewalAmount) {
      cancelledByMerchant[key] = { ...c, source };
    }
  }

  const newlyCancelled = Object.values(cancelledByMerchant);
  if (!newlyCancelled.length) return [];

  await upsertCancelledSubscriptions(userId, newlyCancelled);

  return newlyCancelled.map((c) => ({
    merchant: c.merchant,
    renewalAmount: c.renewalAmount,
    currency: c.currency,
    renewalDate: c.renewalDate ?? null,
    billingInterval: c.billingInterval ?? null,
    senderDomain: c.senderDomain ?? null,
    iconUrl: c.iconUrl ?? null,
    confidence: 0.6,
    isActive: false,
    isSuggested: true,
    source,
  }));
}

/**
 * Applies lifecycle cancellations: marks subscriptions inactive when a
 * cancellation email was detected, but never cancels a merchant that was
 * also detected as active in the same scan.
 */
export async function applyLifecycleCancellations(userId, cancellations, activeMerchants) {
  if (!cancellations.length) return 0;
  const stale = selectStaleCancellations(cancellations, activeMerchants);
  const results = await Promise.allSettled(
    stale.map((c) => cancelSubscriptionByMerchant(userId, c.merchant, c.date))
  );
  return results.reduce((n, r) => n + (r.status === "fulfilled" ? (r.value ?? 0) : 0), 0);
}

/**
 * Patches renewal_date onto existing subscriptions matched by amount + interval.
 * Uses Promise.allSettled instead of sequential awaits.
 */
export async function applyExpiryRenewalUpdates(userId, updates, logger) {
  if (!updates.length) return;
  const results = await Promise.allSettled(
    updates.map((u) => updateRenewalDateByAmountAndInterval(userId, u))
  );
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "fulfilled") {
      const { updated, merchant } = results[i].value;
      if (updated) {
        logger.info({ merchant, amount: updates[i].amount, renewalDate: updates[i].renewalDate }, "expiry_renewal_patched");
      }
    }
  }
}

/**
 * Saves scan metadata and checkpoint. Called at the end of both scan paths.
 */
export async function finalizeScan(userId, { provider, scannedMessages, detectedCharges, executionTimeMs, checkpoint }) {
  await saveScanMetadata(userId, { scannedMessages, detectedCharges, executionTimeMs });
  if (checkpoint) {
    await saveScanCheckpoint(userId, provider, checkpoint);
  }
}
