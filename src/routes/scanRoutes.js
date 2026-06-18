import { requireUser } from "../lib/auth.js";
import { SCAN_RATE_LIMIT, enforceScanLimit, releaseScanSlot } from "../lib/scanMiddleware.js";
import { runGmailScan } from "../services/gmailScanService.js";
import { getQueue, getJobStatus, getQueueEvents } from "../services/scanQueue.js";
import { getScanCheckpoint, saveScanCheckpoint } from "../db/index.js";

const QUEUE_ENABLED = process.env.QUEUE_ENABLED === "true";

export function registerScanRoutes(server) {
  // ── POST /scan ────────────────────────────────────────────────────────────
  server.post("/scan", { config: { rateLimit: SCAN_RATE_LIMIT } }, async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    req.userId = userId;

    const allowed = await enforceScanLimit(req, reply);
    if (!allowed) return;

    const rawDaysBack = req.body?.daysBack;
    if (rawDaysBack !== undefined) {
      const n = Number(rawDaysBack);
      if (!Number.isInteger(n) || n < 1 || n > 730) {
        return reply.code(400).send({
          error: "invalid_days_back",
          message: "daysBack must be an integer between 1 and 730",
        });
      }
    }
    const daysBack = rawDaysBack !== undefined ? Number(rawDaysBack) : 180;

    if (QUEUE_ENABLED) {
      try {
        const force = req.body?.force === true;
        const job = await getQueue().add("scan", { userId, daysBack, force });
        // Release slot immediately — the worker runs out-of-band and
        // is not subject to the per-request free-tier check.
        releaseScanSlot(userId);
        return reply.code(202).send({ jobId: job.id, status: "queued" });
      } catch (err) {
        releaseScanSlot(userId);
        req.log.error({ err }, "scan_enqueue_error");
        return reply.code(500).send({ error: "scan_failed" });
      }
    }

    // Synchronous path
    try {
      const force = req.body?.force === true;

      let afterDate;
      if (!force) {
        const checkpoint = await getScanCheckpoint(userId, "google");
        if (checkpoint?.last_message_date) {
          afterDate = new Date(checkpoint.last_message_date);
          req.log.info({ afterDate, provider: "google" }, "incremental_scan_checkpoint");
        }
      }

      const SCAN_TIMEOUT_MS = 90_000;
      let timeoutId;
      const result = await Promise.race([
        runGmailScan({ userId, daysBack, afterDate, force }),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("scan_timeout")), SCAN_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timeoutId);

      if (result.checkpoint) {
        await saveScanCheckpoint(userId, "google", result.checkpoint);
      }

      return { success: true, ...result };
    } catch (err) {
      if (err.message === "scan_timeout") {
        return reply.code(504).send({ error: "scan_timeout", message: "Scan took too long. Try a shorter date range." });
      }
      if (err.message === "gmail_not_connected") {
        return reply.code(400).send({ error: "gmail_not_connected" });
      }
      if (err.message === "circuit_open") {
        return reply.code(503).send({ error: "scan_paused", message: "Gmail API is rate limited. Try again shortly." });
      }
      if (err.message?.includes("TOKEN_REFRESH_FAILED")) {
        return reply.code(401).send({ error: "gmail_auth_expired" });
      }
      req.log.error({ err }, "scan_error");
      return reply.code(500).send({ error: "scan_failed" });
    } finally {
      releaseScanSlot(userId);
    }
  });

  // ── GET /scan/:jobId/status ───────────────────────────────────────────────
  server.get("/scan/:jobId/status", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    if (!QUEUE_ENABLED) {
      return reply.code(400).send({ error: "queue_not_enabled" });
    }

    try {
      const status = await getJobStatus(req.params.jobId);
      if (!status) return reply.code(404).send({ error: "job_not_found" });
      return status;
    } catch (err) {
      req.log.error({ err }, "scan_status_error");
      return reply.code(500).send({ error: "status_failed" });
    }
  });

  // ── GET /scan/:jobId/events ───────────────────────────────────────────────
  server.get("/scan/:jobId/events", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    if (!QUEUE_ENABLED) {
      return reply.code(400).send({ error: "queue_not_enabled" });
    }

    const { jobId } = req.params;

    reply.sse(
      (async function* () {
        const initial = await getJobStatus(jobId);
        if (!initial) {
          yield { event: "error", data: JSON.stringify({ error: "job_not_found" }) };
          return;
        }

        if (initial.status === "completed") {
          yield { event: "progress", data: JSON.stringify({ pct: 100, message: "Done" }) };
          yield { event: "done", data: JSON.stringify(initial.result) };
          return;
        }

        if (initial.status === "failed") {
          yield { event: "error", data: JSON.stringify({ error: initial.error }) };
          return;
        }

        const MAX_WAIT_MS = 5 * 60 * 1000;
        const startedAt = Date.now();

        while (Date.now() - startedAt < MAX_WAIT_MS) {
          const current = await getJobStatus(jobId);
          if (!current) break;

          if (current.progress) {
            yield { event: "progress", data: JSON.stringify(current.progress) };
          }

          if (current.status === "completed") {
            yield { event: "progress", data: JSON.stringify({ pct: 100, message: "Done" }) };
            yield { event: "done", data: JSON.stringify(current.result) };
            return;
          }

          if (current.status === "failed") {
            yield { event: "error", data: JSON.stringify({ error: current.error }) };
            return;
          }

          await new Promise((res) => setTimeout(res, 2000));
        }

        yield { event: "error", data: JSON.stringify({ error: "timeout" }) };
      })()
    );
  });
}
