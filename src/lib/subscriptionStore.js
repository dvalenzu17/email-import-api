import { upsertBrand, upsertBrandAliases } from "./brandStore.js";
import { upsertEmailMessage, insertSignal } from "./evidenceStore.js";

function pickBestSample(candidate) {
  const samples = Array.isArray(candidate?.evidenceSamples) ? candidate.evidenceSamples : [];
  return samples[0] || candidate?.evidence || null;
}

function inferSignalType(candidate) {
  const et = String(candidate?.eventType || "").toLowerCase();
  if (et === "price_change") return "price_change";
  if (et === "paused" || et === "payment_failed") return "renewal";
  return "receipt";
}

export async function confirmCandidateAsSubscription({ supabase, userId, candidate, provider = "gmail" }) {
  if (!candidate?.merchant) throw new Error("confirmCandidateAsSubscription: missing merchant");

  // Upsert brand
  const brand = await upsertBrand({ supabase, canonicalName: candidate.merchant });

  // Aliases (domain/sender/unsubscribe)
  const aliases = [];
  const senderDomain = candidate?.evidence?.senderDomain || candidate?.evidenceSamples?.[0]?.senderDomain;
  if (senderDomain) aliases.push({ kind: "domain", alias: senderDomain });
  const senderName = candidate?.evidence?.from || candidate?.evidenceSamples?.[0]?.from;
  if (senderName) aliases.push({ kind: "sender", alias: senderName });

  await upsertBrandAliases({ supabase, brandId: brand.id, aliases });

  // Evidence (store one message as proof)
  const best = pickBestSample(candidate);
  const emailMsg = await upsertEmailMessage({ supabase, userId, provider, sample: best }).catch(() => null);

  // Signal
  const extracted = {
    merchant: candidate.merchant,
    amount: candidate.amount ?? null,
    currency: candidate.currency ?? null,
    cadence: candidate.cadenceGuess ?? null,
    next_charge_at: candidate.nextDateGuess ?? null,
    plan: candidate.plan ?? null,
    fingerprint: candidate.fingerprint ?? null,
  };

  const sig = await insertSignal({
    supabase,
    userId,
    emailMessageId: emailMsg?.id || null,
    type: inferSignalType(candidate),
    extracted,
    confidence: candidate.confidence ?? 0,
    rawSpans: {},
  });

  // Subscription upsert (idempotent via DB constraint)
  const subRow = {
    user_id: userId,
    brand_id: brand.id,
    plan: candidate.plan ?? null,
    amount: candidate.amount ?? null,
    currency: candidate.currency ?? null,
    cadence: candidate.cadenceGuess ?? null,
    next_charge_at: candidate.nextDateGuess ? new Date(candidate.nextDateGuess).toISOString() : null,
    status: candidate?.eventType === "paused" ? "paused" : candidate?.eventType === "payment_failed" ? "payment_failed" : "active",
    last_evidence_id: sig.id,
  };

  const { data, error } = await supabase
    .from("subscriptions")
    .upsert(subRow, { onConflict: "user_id,brand_id,plan,cadence" })
    .select("*")
    .single();

  if (error) throw new Error(`confirmCandidateAsSubscription: ${error.message}`);

  // Trial entity if present
  const trialEnd = candidate?.trialEndAt || candidate?.extracted?.trial_end_at || null;
  if (trialEnd) {
    await supabase.from("trials").upsert(
      { subscription_id: data.id, ends_at: new Date(trialEnd).toISOString(), source_signal_id: sig.id },
      { onConflict: "subscription_id" }
    );
  }

  return { subscription: data, brand, signal: sig };
}

export async function manualAddSubscription({ supabase, userId, payload }) {
  const brand = await upsertBrand({ supabase, canonicalName: payload.brandName || payload.merchant || "Manual" });
  const { data, error } = await supabase
    .from("subscriptions")
    .insert({
      user_id: userId,
      brand_id: brand.id,
      plan: payload.plan ?? null,
      amount: payload.amount ?? null,
      currency: payload.currency ?? null,
      cadence: payload.cadence ?? null,
      next_charge_at: payload.next_charge_at ?? payload.nextChargeAt ?? null,
      status: "active",
    })
    .select("*")
    .single();
  if (error) throw new Error(`manualAddSubscription: ${error.message}`);
  return { subscription: data, brand };
}
