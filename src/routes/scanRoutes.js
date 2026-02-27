// routes/scanRoutes.js
import jwt from "jsonwebtoken";
import {
  listRecentMessages,
  fetchMessage,
  extractText,
  extractAmount,
  extractMerchant,
  cleanEmailHtml
} from "../gmailClient.js";
  
  import { detectRecurringSubscriptions } from "../services/subscriptionEngine.js";
  import { getOAuthToken, upsertSubscription, saveScanMetadata, saveOAuthTokens } from "../db/index.js";

  
  import { refreshAccessToken } from "../googleOAuth.js";
  
  export function registerScanRoutes(server) {
    server.post("/scan", async (req, reply) => {
        console.log("HEADERS:", req.headers);
        const authHeader = req.headers.authorization;
        const token = authHeader?.split(" ")[1];
        
        if (!token) {
          return reply.code(401).send({ error: "unauthorized" });
        }
        
        const decoded = jwt.verify(
          token,
          process.env.SUPABASE_JWT_SECRET
        );
        
        const userId = decoded.sub;
  
      if (!userId) {
        return reply.code(401).send({ error: "unauthorized" });
      }
  
      const started = Date.now();
  
      try {
        // 1️⃣ Get stored OAuth token
        const tokenRecord = await getOAuthToken(userId);
        if (!tokenRecord) {
          return reply.code(400).send({ error: "gmail_not_connected" });
        }
  
        let accessToken = tokenRecord.access_token;
  
        // 2️⃣ Refresh if expired
        if (new Date(tokenRecord.expiry_date) < new Date()) {
            const refreshed = await refreshAccessToken({
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
              refreshToken: tokenRecord.refresh_token
            });
          
            accessToken = refreshed.accessToken;
          
            // 🔹 Persist refreshed token
            await saveOAuthTokens(userId, {
              accessToken: refreshed.accessToken,
              refreshToken: tokenRecord.refresh_token,
              expiresIn: refreshed.expiresIn
            });
          }
  
        // 3️⃣ Fetch message IDs
        const ids = await listRecentMessages(accessToken);
  
        // 4️⃣ Fetch full messages
        const fullMessages = await Promise.all(
          ids.map(m => fetchMessage(accessToken, m.id))
        );
  
        const charges = [];

        
  
        for (const full of fullMessages) {
          if (!full?.payload) continue;
  
          const headers = full.payload.headers;

        const rawHtml = extractText(full.payload);
        if (!rawHtml) continue;

        const text = cleanEmailHtml(rawHtml);
        if (!text || text.length < 30) continue;

        /* ---------- HARD NEGATIVE FILTERS ----------  */
        if (
        text.includes("trip with uber") ||
        text.includes("thanks for riding") ||
        text.includes("order with uber eats")
      ) {
        continue;
      }

        /* ---------- TRANSACTIONAL CONFIRMATION ---------- */
        const transactional =
  text.includes("payment") ||
  text.includes("charged") ||
  text.includes("invoice") ||
  text.includes("successfully subscribed");

      //  if (!transactional) continue;

      const amount = extractAmount(text);
        if (!amount) continue;

        const merchant = extractMerchant(headers);
        const date = new Date(Number(full.internalDate));

        /* ---------- SUBSCRIPTION INTENT ---------- */
        
        let intentScore = 0;

        if (text.includes("subscription")) intentScore += 1;
        if (text.includes("membership")) intentScore += 1;
        if (text.includes("automatically renew")) intentScore += 2;
        if (text.includes("renews on")) intentScore += 2;
        if (text.includes("/month") || text.includes("per month")) intentScore += 2;
        if (text.includes("/year") || text.includes("per year")) intentScore += 2;
        if (text.includes("valid until")) intentScore += 2;
        if (text.includes("plan")) intentScore += 1;

const subscriptionIntent = intentScore >= 3;

        charges.push({
          merchant,
          amount,
          date,
          subscriptionIntent
        });
        
        }
  
        // 5️⃣ Detect recurring subscriptions
        const subscriptions = detectRecurringSubscriptions(charges);
  
        // 6️⃣ Persist subscriptions
        for (const sub of subscriptions) {
          if (sub.confidence >= 0.65) {
            await upsertSubscription(userId, sub);
          }
        }
  
        // 7️⃣ Save scan metadata
        await saveScanMetadata(userId, {
          scannedMessages: ids.length,
          detectedCharges: charges.length,
          executionTimeMs: Date.now() - started
        });
  
        return {
          success: true,
          detectedSubscriptions: subscriptions.length
        };
  
    } catch (err) {
        console.error("SCAN ERROR:", err);
        return reply.code(500).send({
          error: "scan_failed",
          details: err.message
        });
      }
    });


    
  }