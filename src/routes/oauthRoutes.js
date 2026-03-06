import crypto from "crypto";
import {
  buildGoogleAuthUrl,
  exchangeCodeForTokens
} from "../googleOAuth.js";

import { findOrCreateUser, saveOAuthTokens } from "../db/index.js";

export function registerOAuthRoutes(server) {

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  /* STEP 1 — redirect user to Google */

  server.get("/auth/google", async (req, reply) => {

    const state = crypto.randomUUID();

    const url = buildGoogleAuthUrl({
      clientId,
      redirectUri,
      state
    });

    return reply.redirect(url);
  });


  /* STEP 2 — Google redirects back here */

  server.get("/auth/google/callback", async (req, reply) => {

    try {

      const { code } = req.query;

      if (!code) {
        return reply.code(400).send({ error: "missing_code" });
      }

      const tokens = await exchangeCodeForTokens({
        clientId,
        clientSecret,
        redirectUri,
        code
      });

      const userInfoRes = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        {
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`
          }
        }
      );

      const userInfo = await userInfoRes.json();

      const email = userInfo.email;

      if (!email) {
        return reply.code(400).send({ error: "email_not_found" });
      }

      const user = await findOrCreateUser(email);

      await saveOAuthTokens(user.id, tokens);

      return reply.send({
        success: true,
        userId: user.id
      });

    } catch (err) {

      console.error("OAUTH ERROR:", err);

      return reply.code(500).send({
        error: "oauth_failed"
      });

    }

  });

}