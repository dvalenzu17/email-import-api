// src/queue/scanQueue.js
import { Queue } from "bullmq";
import { redis } from "./redis.js";

export const scanQueue = new Queue("scan", { connection: redis });

export async function enqueueScanChunk({ sessionId, cursor = null, phase = "run" }) {
  // ✅ BullMQ custom IDs cannot contain ":"
  const jobId = `${sessionId}__${phase}__${cursor || "start"}`;

  try {
    await scanQueue.add(
      "scan-chunk",
      { sessionId },
      {
        jobId,
        removeOnComplete: 1000,
        removeOnFail: 5000,
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
      }
    );
  } catch (e) {
    const err = new Error(`QUEUE_ENQUEUE_FAILED: ${e?.message || e}`);
    err.code = "QUEUE_ENQUEUE_FAILED";
    err.statusCode = 503;
    throw err;
  }
}
