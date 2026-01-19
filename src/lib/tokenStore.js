import { encryptString, decryptString } from "./cryptoBox.js";

export async function upsertGoogleTokens({ supabase, userId, accessToken, refreshToken, expiresAt }) {
  const row = {
    user_id: userId,
    provider: "google",
    access_token: encryptString(accessToken),
    refresh_token: refreshToken ? encryptString(refreshToken) : null,
    expires_at: expiresAt ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("oauth_tokens").upsert(row, { onConflict: "user_id" });
  if (error) throw new Error(`upsertGoogleTokens: ${error.message}`);
}

export async function getGoogleTokens({ supabase, userId }) {
  const { data, error } = await supabase
    .from("oauth_tokens")
    .select("access_token,refresh_token,expires_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error(`getGoogleTokens: ${error.message}`);
  if (!data) return null;

  return {
    accessToken: decryptString(data.access_token),
    refreshToken: data.refresh_token ? decryptString(data.refresh_token) : null,
    expiresAt: data.expires_at ? new Date(data.expires_at).getTime() : null,
  };
}
