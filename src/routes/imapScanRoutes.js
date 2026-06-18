import { z } from "zod";
import { requireUser } from "../lib/auth.js";
import { SCAN_RATE_LIMIT, enforceScanLimit, releaseScanSlot } from "../lib/scanMiddleware.js";
import { runImapScan } from "../services/imapScanService.js";
import { saveImapCredentials, getImapCredentials, getScanCheckpoint } from "../db/index.js";
import { verifyImapCredentials } from "../services/imapClient.js";
import { decryptCredential } from "../services/crypto.js";

const PROVIDERS = ["gmail", "yahoo", "outlook", "icloud"];

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
  force: z.boolean().optional(),
});

export function registerImapScanRoutes(server) {

  server.post("/scan/imap/verify", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const parsed = verifyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    const { provider, user, pass } = parsed.data;

    try {
      await verifyImapCredentials({ provider, user, pass });
      await saveImapCredentials(userId, { provider, user, pass });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  server.post("/scan/imap", { config: { rateLimit: SCAN_RATE_LIMIT } }, async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    req.userId = userId;

    const allowed = await enforceScanLimit(req, reply);
    if (!allowed) return;

    const scanParsed = scanBodySchema.safeParse(req.body);
    if (!scanParsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    let { provider, user, pass, daysBack = 730, force = false } = scanParsed.data;

    // Fall back to stored credentials if not supplied in request
    if (!user || !pass) {
      const stored = await getImapCredentials(userId, provider);
      if (!stored) {
        return reply.code(400).send({ error: "imap_not_connected" });
      }
      user = stored.imap_user;
      pass = decryptCredential(stored.imap_pass);
    }

    try {
      // Incremental scan checkpoint
      let sinceDate;
      if (!force) {
        const checkpoint = await getScanCheckpoint(userId, provider);
        if (checkpoint?.last_message_date) {
          sinceDate = new Date(checkpoint.last_message_date);
          req.log.info({ sinceDate, provider }, "incremental_scan_checkpoint");
        }
      }

      // Save credentials (refresh the stored copy)
      await saveImapCredentials(userId, { provider, user, pass });

      const result = await runImapScan({ userId, provider, user, pass, daysBack, sinceDate, force });

      return { success: true, ...result };
    } catch (err) {
      req.log.error({ err }, "imap_scan_error");
      return reply.code(500).send({ error: "scan_failed" });
    } finally {
      releaseScanSlot(userId);
    }
  });
}
