/**
 * BullMQ-backed Gmail scan queue.
 * Only initialised when QUEUE_ENABLED=true and REDIS_URL is set.
 *
 * Queue name: gmail-scan
 * Job payload: { userId: string, daysBack: number }
 * Job result:  { detectedSubscriptions, scannedMessages, detectedCharges, executionTimeMs }
 */

import { Queue, Worker, QueueEvents } from "bullmq";
import { runGmailScan } from "./gmailScanService.js";

const QUEUE_NAME = "gmail-scan";

let _queue = null;
let _queueEvents = null;
let _worker = null;

function getConnection() {
  if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required for queue mode");
  // BullMQ accepts an ioredis-compatible connection config
  const url = new URL(process.env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
    tls: url.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null, // required by BullMQ
  };
}

export function getQueue() {
  if (!_queue) {
    _queue = new Queue(QUEUE_NAME, {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { age: 60 * 60 * 24 }, // keep completed jobs 24h for polling
        removeOnFail: { age: 60 * 60 * 24 * 7 },
      },
    });
  }
  return _queue;
}

export function getQueueEvents() {
  if (!_queueEvents) {
    _queueEvents = new QueueEvents(QUEUE_NAME, { connection: getConnection() });
  }
  return _queueEvents;
}

/**
 * Starts the BullMQ Worker. Call once at server startup when QUEUE_ENABLED=true.
 */
export function startWorker(logger) {
  if (_worker) return _worker;

  _worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { userId, daysBack } = job.data;

      return runGmailScan({
        userId,
        daysBack,
        onProgress: async (pct, message) => {
          await job.updateProgress({ pct, message });
        },
      });
    },
    {
      connection: getConnection(),
      concurrency: 5, // max parallel scans
    }
  );

  _worker.on("completed", (job) => {
    logger?.info({ jobId: job.id }, "scan_job_completed");
  });

  _worker.on("failed", (job, err) => {
    logger?.error({ jobId: job?.id, err }, "scan_job_failed");
  });

  return _worker;
}

/**
 * Fetches a job and returns a normalised status object safe to send to clients.
 */
export async function getJobStatus(jobId) {
  const job = await getQueue().getJob(jobId);
  if (!job) return null;

  const state = await job.getState();

  return {
    jobId: job.id,
    status: state,                      // queued | active | completed | failed | delayed
    progress: job.progress ?? null,
    result: state === "completed" ? job.returnvalue : null,
    error: state === "failed" ? job.failedReason : null,
    createdAt: new Date(job.timestamp).toISOString(),
  };
}
