import crypto from "crypto";
import jwt from "jsonwebtoken";

import {
  buildGoogleAuthUrl,
  exchangeCodeForTokens
} from "../googleOAuth.js";

import {
  findOrCreateUser,
  saveOAuthTokens
} from "../db/index.js";

export function registerOAuthRoutes(server) {

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  /*
  STEP 1
  Redirect the user to Google OAuth
  */

  server.get("/auth/google", async (req, reply) => {

    try {

      const { token } = req.query;

      if (!token) {
        return reply.code(400).send({ error: "missing_supabase_token" });
      }

      const decoded = jwt.verify(
        token,
        process.env.SUPABASE_JWT_SECRET
      );

      const supabaseUserId = decoded.sub;

      if (!supabaseUserId) {
        return reply.code(401).send({ error: "invalid_supabase_token" });
      }

      const state = Buffer.from(
        JSON.stringify({
          supabaseUserId,
          nonce: crypto.randomUUID()
        })
      ).toString("base64");

      const url = buildGoogleAuthUrl({
        clientId,
        redirectUri,
        state
      });

      return reply.redirect(url);

    } catch (err) {

      console.error("OAUTH INIT ERROR:", err);

      return reply.code(401).send({
        error: "invalid_supabase_token"
      });

    }

  });


  /*
  STEP 2
  Google redirects back here with authorization code
  */

  server.get("/auth/google/callback", async (req, reply) => {
    console.log("CALLBACK HIT — code:", !!req.query.code, "state:", !!req.query.state);
    try {

      const { code, state } = req.query;

      if (!code) {
        return reply.code(400).send({ error: "missing_code" });
      }

      if (!state) {
        return reply.code(400).send({ error: "missing_state" });
      }

      const decodedState = JSON.parse(
        Buffer.from(state, "base64").toString()
      );
      
      const userId = decodedState.supabaseUserId;
      
      /* ensure user exists locally */
      await findOrCreateUser(email);
      
      /* save tokens */
      await saveOAuthTokens(userId, tokens);

      const supabaseUserId = decodedState.supabaseUserId;

      if (!supabaseUserId) {
        return reply.code(400).send({ error: "invalid_state" });
      }

      /*
      Exchange authorization code for tokens
      */

      const tokens = await exchangeCodeForTokens({
        clientId,
        clientSecret,
        redirectUri,
        code
      });

      /*
      Fetch Google account email
      */

      const userInfoRes = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        {
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`
          }
        }
      );

      if (!userInfoRes.ok) {
        throw new Error("failed_to_fetch_userinfo");
      }

      const userInfo = await userInfoRes.json();
      const email = userInfo.email;

      if (!email) {
        return reply.code(400).send({ error: "email_not_found" });
      }

      /*
      Optional helper preserved (not used for identity anymore)
      This keeps existing logic intact in case other parts depend on it.
      */

      try {
        await findOrCreateUser(email);
      } catch (err) {
        console.warn("USER SYNC WARNING:", err.message);
      }

      /*
      Store OAuth tokens using Supabase user id
      */

      await saveOAuthTokens(supabaseUserId, tokens);

      /*
      Redirect back to mobile app
      */

      return reply.redirect(
        "beforeitbills://oauth-success"
      );

    } catch (err) {

      console.error("OAUTH CALLBACK ERROR:", err);

      return reply.code(500).send({
        error: "oauth_failed",
        details: err.message
      });

    }

  });

}