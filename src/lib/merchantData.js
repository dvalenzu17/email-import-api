// lib/merchantData.js
import { supabaseAdmin } from "./supabaseAdmin.js";

let cache = { at: 0, data: null };
const TTL_MS = 15 * 60 * 1000;

export async function getMerchantDirectoryCached() {
  const now = Date.now();
  if (cache.data && now - cache.at < TTL_MS) return cache.data;

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
