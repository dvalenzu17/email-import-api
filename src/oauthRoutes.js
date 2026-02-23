import crypto from "crypto";
import {
  listRecentMessages,
  fetchMessage,
  extractText,
  extractAmount,
  extractMerchant
} from "./gmailClient.js";


import {
    buildGoogleAuthUrl,
    exchangeCodeForTokens,
  } from "./googleOAuth.js";

  import jwt from "jsonwebtoken";
import { findOrCreateUser, saveOAuthTokens } from "./db/index.js";
  
  export function registerOAuthRoutes(server) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  
    // Step 1: Redirect user to Google
    server.get("/auth/google", async (req, reply) => {
      const state = crypto.randomUUID();
    
      const url = buildGoogleAuthUrl({
        clientId,
        redirectUri,
        state,
      });
    
      console.log("CLIENT ID:", clientId);
      console.log("REDIRECT URI:", redirectUri);
      console.log("OAUTH URL:", url);
    
      return reply.redirect(url);
    });
    
    // Step 2: Google redirects back here
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
          code,
        });
        
        // 🔹 Decode email from Google idToken
        // Fetch user info directly from Google
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
        
        if (!email) {
          return reply.code(400).send({ error: "email_not_found" });
        }
        
        // 🔹 Create or fetch user
        const user = await findOrCreateUser(email);
        
        // 🔹 Save tokens to DB
        await saveOAuthTokens(user.id, tokens);
        
        // 🔹 Return user ID (frontend stores this)
        return {
          success: true,
          userId: user.id
        };
      } catch (err) {
        console.error("OAUTH CALLBACK ERROR:", err);
        return reply.code(500).send({ error: err.message });
      }
    });


  }

  