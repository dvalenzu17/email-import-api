import jwt from "jsonwebtoken";
import { z } from "zod";
import { scanImapInbox, verifyImapCredentials, getImapConfig } from "../services/imapClient.js";
import { detectRecurringSubscriptions } from "../services/subscriptionEngine.js";
import { batchUpsertSubscriptions, saveScanMetadata, saveImapCredentials, getImapCredentials } from "../db/index.js";
import { decryptCredential } from "../services/crypto.js";

const PROVIDERS = ["yahoo", "outlook", "icloud"];

const verifyBodySchema = z.object({
  provider: z.enum(PROVIDERS),
  user: z.string().email(),
  pass: z.string().min(1),
});

const scanBodySchema = z.object({
  provider: z.enum(PROVIDERS),
  user: z.string().email().optional(),
  pass: z.string().min(1).optional(),
  daysBack: z.number().int().min(1).max(730).optional(),
});

const IMAP_RATE_LIMIT = {
  max: 3,
  timeWindow: "15 minutes",
  keyGenerator: (req) => {
    try {
      const token = req.headers.authorization?.split(" ")[1];
      const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
      return decoded?.sub ?? req.ip;
    } catch { return req.ip; }
  },
  errorResponseBuilder: () => ({ error: "rate_limited", message: "Too many scans. Please wait 15 minutes." }),
};

export function registerImapScanRoutes(server) {

  server.post("/scan/imap/verify", async (req, reply) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(" ")[1];
    if (!token) return reply.code(401).send({ error: "unauthorized" });

    try {
      jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const parsed = verifyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    const { provider, user, pass } = parsed.data;

    try {
      await verifyImapCredentials({ provider, user, pass });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  server.post("/scan/imap", { config: { rateLimit: IMAP_RATE_LIMIT } }, async (req, reply) => {
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

    const scanParsed = scanBodySchema.safeParse(req.body);
    if (!scanParsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    let { provider, user, pass, daysBack = 365 } = scanParsed.data;

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
      const { charges, scannedCount } = await scanImapInbox({
        provider, user, pass, daysBack,
      });

      await saveImapCredentials(userId, { provider, user, pass });

      const subscriptions = detectRecurringSubscriptions(charges).map((s) => ({
        ...s,
        source: provider,
      }));

      await batchUpsertSubscriptions(userId, subscriptions.filter((s) => s.confidence >= 0.7));

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
      req.log.error({ err }, "imap_scan_error");
      return reply.code(500).send({ error: "scan_failed" });
    }
  });
}