import { supabaseAdmin } from "./supabaseAdmin.js";

let cache = { at: 0, data: null };
const TTL_MS = 15 * 60 * 1000;

export async function getMerchantDirectoryCached() {
  const now = Date.now();
  if (cache.data && now - cache.at < TTL_MS) return cache.data;

  // Keep this conservative so we don’t explode if columns aren’t there.
  const { data, error } = await supabaseAdmin
    .from("merchant_directory")
    .select("canonical_name, sender_emails, sender_domains, keywords");

  if (error) throw error;
  cache = { at: now, data: data ?? [] };
  return cache.data;
}

export async function getUserOverrides(userId) {
  const { data, error } = await supabaseAdmin
    .from("user_merchant_overrides")
    .select("sender_email, sender_domain, canonical_name")
    .eq("user_id", userId)
    .limit(500);

  if (error) throw error;
  return data ?? [];
}

// Used ONLY for confidence signals (does not auto-create anything)
export async function getUserSubscriptionSignals(userId) {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("merchant, amount, cadence")
    .eq("user_id", userId)
    .limit(1000);

  if (error) return []; // don’t kill scans if this fails
  return (data ?? []).map((r) => ({
    merchant: String(r.merchant ?? "").trim(),
    amount: Number(r.amount ?? 0),
    cadence: String(r.cadence ?? "").trim().toLowerCase(),
  }));
}
