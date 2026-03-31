import jwt from "jsonwebtoken";
import { runGmailScan } from "../services/gmailScanService.js";
import { getQueue, getJobStatus, getQueueEvents } from "../services/scanQueue.js";

const QUEUE_ENABLED = process.env.QUEUE_ENABLED === "true";

const SCAN_RATE_LIMIT = {
  max: 3,
  timeWindow: "15 minutes",
  keyGenerator: (req) => {
    try {
      const token = req.headers.authorization?.split(" ")[1];
      const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
      return decoded?.sub ?? req.ip;
    } catch {
      return req.ip;
    }
  },
  errorResponseBuilder: () => ({
    error: "rate_limited",
    message: "Too many scans. Please wait 15 minutes before scanning again.",
  }),
};

function verifyUserId(req, reply) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) { reply.code(401).send({ error: "unauthorized" }); return null; }
  try {
    const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
    const userId = decoded.sub;
    if (!userId) { reply.code(401).send({ error: "unauthorized" }); return null; }
    return userId;
  } catch {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
}

export function registerScanRoutes(server) {
  // ── POST /scan ────────────────────────────────────────────────────────────
  // QUEUE_ENABLED=true  → enqueues job, returns { jobId } immediately
  // QUEUE_ENABLED=false → runs synchronously, returns result directly
  server.post("/scan", { config: { rateLimit: SCAN_RATE_LIMIT } }, async (req, reply) => {
    const userId = verifyUserId(req, reply);
    if (!userId) return;

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
        const job = await getQueue().add("scan", { userId, daysBack });
        return reply.code(202).send({ jobId: job.id, status: "queued" });
      } catch (err) {
        req.log.error({ err }, "scan_enqueue_error");
        return reply.code(500).send({ error: "scan_failed" });
      }
    }

    // Synchronous path (default, no Redis required)
    try {
      const result = await runGmailScan({ userId, daysBack });
      return { success: true, ...result };
    } catch (err) {
      if (err.message === "gmail_not_connected") {
        return reply.code(400).send({ error: "gmail_not_connected" });
      }
      if (err.message === "circuit_open") {
        return reply.code(503).send({ error: "scan_paused", message: "Gmail API is rate limited. Try again shortly." });
      }
      req.log.error({ err }, "scan_error");
      return reply.code(500).send({ error: "scan_failed" });
    }
  });

  // ── GET /scan/:jobId/status ───────────────────────────────────────────────
  // Polls a queued scan job. Returns status + result when complete.
  server.get("/scan/:jobId/status", async (req, reply) => {
    const userId = verifyUserId(req, reply);
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
  // SSE stream of real-time scan progress for a queued job.
  // Client receives { pct, message } progress updates and a final { done } event.
  server.get("/scan/:jobId/events", async (req, reply) => {
    const userId = verifyUserId(req, reply);
    if (!userId) return;

    if (!QUEUE_ENABLED) {
      return reply.code(400).send({ error: "queue_not_enabled" });
    }

    const { jobId } = req.params;

    reply.sse(
      (async function* () {
        // First, check if the job is already done.
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

        // Job is still running — subscribe to QueueEvents for live updates.
        const queueEvents = getQueueEvents();

        const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes
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

          await new Promise((res) => setTimeout(res, 2000)); // poll every 2s
        }

        yield { event: "error", data: JSON.stringify({ error: "timeout" }) };
      })()
    );
  });
}
