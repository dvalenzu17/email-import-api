// src/lib/candidateScoring.js
import { classifyEventType, shouldDropCandidate } from "./candidateClassifier.js";
import { resolveMerchant } from "./merchantNormalize.js";

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function textAll(evidence) {
  return `${evidence?.subject || ""}\n${evidence?.snippet || ""}\n${evidence?.from || ""}`.toLowerCase();
}

export function scoreCandidate({ evidence, clusterSize, amount, cadenceGuess, merchant }) {
  const text = textAll(evidence);

  let score = 20;

  // merchant quality
  if (merchant && merchant !== "unknown") score += 10;

  // billing signals
  if (/(receipt|invoice|charged|payment received|order confirmation)/i.test(text)) score += 35;
  if (/(renew|next billing|auto-?renew)/i.test(text)) score += 20;

  // amount extraction boosts a lot
  if (amount != null) score += 25;

  // cluster helps only a bit unless billing signals exist
  if (clusterSize >= 3) score += 6;

  // penalty if cadence guessed but no amount/billing proof
  if (cadenceGuess && amount == null && !/(receipt|invoice|charged|renew)/i.test(text)) score -= 25;

  // marketing penalties
  if (/(announcement|newsletter|instructor|course|enroll|certification)/i.test(text)) score -= 40;

  return clamp(score, 0, 100);
}

export function buildImprovedCandidate({ rawCandidate, directory, overrides }) {
  const ev = rawCandidate?.evidence || {};
  const eventType = classifyEventType(ev);

  if (shouldDropCandidate(eventType)) {
    return { drop: true, reason: ["Dropped marketing/non-billing email"] };
  }

  const merchant = resolveMerchant({
    senderEmail: ev.senderEmail,
    senderDomain: ev.senderDomain,
    overrides: Array.isArray(overrides) ? overrides : [],
    directory: Array.isArray(directory) ? directory : [],
  });

  const clusterSize = rawCandidate?.reason?.find((r) => r.includes("Clustered"))?.match(/\d+/)?.[0];
  const clusterN = clusterSize ? Number(clusterSize) : 1;

  const score = scoreCandidate({
    evidence: ev,
    clusterSize: clusterN,
    amount: rawCandidate.amount,
    cadenceGuess: rawCandidate.cadenceGuess,
    merchant,
  });

  let label = "Low";
  if (score >= 80) label = "High";
  else if (score >= 55) label = "Medium";

  const improved = {
    ...rawCandidate,
    merchant,
    eventType,                 // ✅ new
    confidence: score,         // ✅ rescored
    confidenceLabel: label,
    needsConfirm: score < 85 || rawCandidate.amount == null,
    reason: [
      ...(rawCandidate.reason || []),
      `EventType: ${eventType}`,
      rawCandidate.amount == null ? "Amount missing" : "Amount found",
    ],
  };

  // Don’t pretend paused/payment_failed are “recurring spend”
  if (eventType === "paused" || eventType === "payment_failed") {
    improved.cadenceGuess = null;
    improved.nextDateGuess = null;
    improved.reason.push("Not a charge event (status/billing issue)");
  }

  return { drop: false, candidate: improved };
}
