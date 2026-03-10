import jwt from "jsonwebtoken";
import { scanImapInbox, verifyImapCredentials, getImapConfig } from "../services/imapClient.js";
import { detectRecurringSubscriptions } from "../services/subscriptionEngine.js";
import { upsertSubscription, saveScanMetadata, saveImapCredentials, getImapCredentials } from "../db/index.js";
import { decryptCredential } from "../services/crypto.js";

export function registerImapScanRoutes(server) {

  server.post("/scan/imap/verify", async (req, reply) => {
    console.log("IMAP VERIFY HIT:", req.body?.provider, req.body?.user);

    const authHeader = req.headers.authorization;
    const token = authHeader?.split(" ")[1];
    if (!token) return reply.code(401).send({ error: "unauthorized" });

    try {
      jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const { provider, user, pass } = req.body;

    if (!provider || !user || !pass) {
      return reply.code(400).send({ error: "missing_fields" });
    }

    try {
      getImapConfig(provider);
    } catch {
      return reply.code(400).send({ error: "unsupported_provider" });
    }

    try {
      await verifyImapCredentials({ provider, user, pass });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  server.post("/scan/imap", async (req, reply) => {
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

    let { provider, user, pass, daysBack = 365 } = req.body;

    if (!provider) {
      return reply.code(400).send({ error: "missing_provider" });
    }

    try {
      getImapConfig(provider);
    } catch {
      return reply.code(400).send({ error: "unsupported_provider" });
    }

    // Fall back to stored credentials if not supplied in request
    if (!user || !pass) {
      const stored = await getImapCredentials(userId, provider);
      if (!stored) {
        return reply.code(400).send({ error: "imap_not_connected" });
      }
      user = stored.imap_user;
      pass = decryptCredential(stored.imap_pass);
    }

    const started = Date.now();

    try {
      await saveImapCredentials(userId, { provider, user, pass });

      const { charges, scannedCount } = await scanImapInbox({
        provider, user, pass, daysBack,
      });

      const subscriptions = detectRecurringSubscriptions(charges).map((s) => ({
        ...s,
        source: provider,
      }));

      for (const sub of subscriptions) {
        if (sub.confidence >= 0.7) {
          await upsertSubscription(userId, sub);
        }
      }

      await saveScanMetadata(userId, {
        scannedMessages: scannedCount,
        detectedCharges: charges.length,
        executionTimeMs: Date.now() - started,
      });

      return {
        success: true,
        detectedSubscriptions: subscriptions.length,
        meta: {
          scannedMessages: scannedCount,
          detectedCharges: charges.length,
          executionTimeMs: Date.now() - started,
        },
      };
    } catch (err) {
      console.error("IMAP SCAN ERROR:", err);
      return reply.code(500).send({ error: "scan_failed", details: err.message });
    }
  });
}