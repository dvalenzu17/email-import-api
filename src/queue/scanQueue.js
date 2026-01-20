// src/queue/scanQueue.js
import { Queue } from "bullmq";
import { redis } from "./redis.js";

export const scanQueue = new Queue("scan", { connection: redis });

export async function enqueueScanChunk({ sessionId, cursor = null }) {
  const jobId = `${sessionId}:${cursor || "start"}`; // ✅ idempotent

  try {
    return await scanQueue.add(
      "gmail-scan-chunk",
      { sessionId },
      {
        jobId,
        attempts: 8,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 500,
        removeOnFail: 2000,
      }
    );
  } catch (e) {
    const err = new Error(`QUEUE_ENQUEUE_FAILED: ${e?.message || e}`);
    err.code = "QUEUE_ENQUEUE_FAILED";
    err.statusCode = 503; // service unavailable
    throw err;
  }
}
