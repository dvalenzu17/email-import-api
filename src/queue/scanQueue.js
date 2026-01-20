// src/queue/scanQueue.js
import { Queue } from "bullmq";
import { redis } from "./redis.js";

export const scanQueue = new Queue("scan", { connection: redis });

export async function enqueueScanChunk({ sessionId, cursor = null, phase = "run" }) {
  const jobId = `${sessionId}:${phase}:${cursor || "start"}`; // ✅ dedupe
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
}
