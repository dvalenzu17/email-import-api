import { Queue } from "bullmq";
import { redis } from "./redis.js";

export const scanQueue = new Queue("scan", { connection: redis });


export async function enqueueScanChunk({ sessionId }) {
  return scanQueue.add(
    "gmail-scan-chunk",
    { sessionId },
    {
      attempts: 8,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 500,
      removeOnFail: 2000,
    }
  );
}
