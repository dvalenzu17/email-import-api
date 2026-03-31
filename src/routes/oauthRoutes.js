import crypto from "crypto";
import jwt from "jsonwebtoken";

import {
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
} from "../googleOAuth.js";

import {
  saveOAuthTokens,
} from "../db/index.js";

function signState(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", process.env.SUPABASE_JWT_SECRET)
    .update(data)
    .digest("hex");
  return `${data}.${sig}`;
}

function verifyState(state) {
  const dot = state.lastIndexOf(".");
  if (dot === -1) throw new Error("invalid_state");
  const data = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = crypto
    .createHmac("sha256", process.env.SUPABASE_JWT_SECRET)
    .update(data)
    .digest("hex");
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))
  ) {
    throw new Error("invalid_state");
  }
  return JSON.parse(Buffer.from(data, "base64url").toString());
}

export function registerOAuthRoutes(server) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  server.get("/auth/google", async (req, reply) => {
    try {
      const { token } = req.query;

      if (!token) {
        return reply.code(400).send({ error: "missing_supabase_token" });
      }

      const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
      const supabaseUserId = decoded.sub;

      if (!supabaseUserId) {
        return reply.code(401).send({ error: "invalid_supabase_token" });
      }

      const state = signState({ supabaseUserId, nonce: crypto.randomUUID() });

      const url = buildGoogleAuthUrl({ clientId, redirectUri, state });

      return reply.redirect(url);
    } catch (err) {
      req.log.error({ err }, "oauth_init_error");
      return reply.code(401).send({ error: "invalid_supabase_token" });
    }
  });

  server.get("/auth/google/callback", async (req, reply) => {
    try {
      const { code, state } = req.query;

      if (!code) return reply.code(400).send({ error: "missing_code" });
      if (!state) return reply.code(400).send({ error: "missing_state" });

      let supabaseUserId;
      try {
        const decodedState = verifyState(state);
        supabaseUserId = decodedState.supabaseUserId;
      } catch {
        return reply.code(400).send({ error: "invalid_state" });
      }

      if (!supabaseUserId) {
        return reply.code(400).send({ error: "invalid_state" });
      }

      const tokens = await exchangeCodeForTokens({
        clientId,
        clientSecret,
        redirectUri,
        code,
      });

      const userInfoRes = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        { headers: { Authorization: `Bearer ${tokens.accessToken}` } }
      );

      if (!userInfoRes.ok) throw new Error("failed_to_fetch_userinfo");

      const userInfo = await userInfoRes.json();
      const email = userInfo.email;

      if (!email) return reply.code(400).send({ error: "email_not_found" });
      await saveOAuthTokens(supabaseUserId, tokens);

      return reply.redirect(
        `beforeitbills://oauth-success?email=${encodeURIComponent(email)}`
      );
    } catch (err) {
      req.log.error({ err }, "oauth_callback_error");
      return reply.code(500).send({ error: "oauth_failed" });
    }
  });
  // ── Native app PKCE exchange ──────────────────────────────────────────────
  // Called by the iOS app after expo-auth-session completes the Google OAuth flow.
  // iOS clients use PKCE and do NOT require a client secret.
  server.post("/oauth/google/exchange", async (req, reply) => {
    try {
      // Verify Supabase JWT from Authorization header
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
      if (!userId) return reply.code(401).send({ error: "unauthorized" });

      const { code, codeVerifier, redirectUri, clientId } = req.body || {};

      if (!code || typeof code !== "string") {
        return reply.code(400).send({ error: "missing_code" });
      }
      if (!redirectUri || typeof redirectUri !== "string") {
        return reply.code(400).send({ error: "missing_redirect_uri" });
      }
      if (!clientId || typeof clientId !== "string") {
        return reply.code(400).send({ error: "missing_client_id" });
      }

      // Exchange code for tokens — iOS PKCE flow, no client secret
      const params = new URLSearchParams({
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      });
      if (codeVerifier) params.set("code_verifier", codeVerifier);

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      });

      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        req.log.warn({ status: tokenRes.status }, "google_token_exchange_failed");
        return reply.code(400).send({ error: "token_exchange_failed" });
      }

      const tokenData = await tokenRes.json();

      // Fetch email from userinfo
      const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      const userInfo = userInfoRes.ok ? await userInfoRes.json() : {};
      const email = userInfo.email || null;

      // Sync user record
      // Persist tokens
      await saveOAuthTokens(userId, {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || null,
        expiresIn: tokenData.expires_in || 3600,
      });

      return reply.send({ ok: true, connected: true, provider: "google", email });
    } catch (err) {
      req.log.error({ err }, "oauth_exchange_error");
      return reply.code(500).send({ error: "exchange_failed" });
    }
  });

}