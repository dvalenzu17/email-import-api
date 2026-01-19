import { OAuth2Client } from "google-auth-library";
import { getGoogleTokens, upsertGoogleTokens } from "./tokenStore.js";

export async function getFreshGoogleAccessToken({ supabase, userId }) {
  const tokens = await getGoogleTokens({ supabase, userId });
  if (!tokens?.refreshToken) throw new Error("MISSING_REFRESH_TOKEN");

  const oauth2 = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: tokens.refreshToken });

  const accessToken = await oauth2.getAccessToken();
  if (!accessToken?.token) throw new Error("TOKEN_REFRESH_FAILED");

  // google-auth-library doesn’t always return expiry here; you can keep a short TTL or fetch tokeninfo if needed.
  await upsertGoogleTokens({
    supabase,
    userId,
    accessToken: accessToken.token,
    refreshToken: tokens.refreshToken,
    expiresAt: null,
  });

  return accessToken.token;
}
