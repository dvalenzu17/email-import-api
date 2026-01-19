// api/src/worker/scanWorker.js
import { Worker } from "bullmq";
import { redis } from "../queue/redis.js";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { getGoogleTokens } from "../lib/tokenStore.js";
import { scanGmail } from "../lib/gmail.js";
import { writeEvent } from "../lib/eventStore.js";
import { getScanSession, updateSessionProgress, upsertCandidates } from "../lib/scanStore.js";
import { enqueueScanChunk } from "../queue/scanQueue.js";

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

async function failSession(session, code, message) {
  await updateSessionProgress({
    supabase: supabaseAdmin,
    sessionId: session.id,
    patch: { status: "error", error_code: code, error_message: message },
  });
  await writeEvent({
    supabase: supabaseAdmin,
    sessionId: session.id,
    userId: session.user_id,
    type: "scan_failed",
    payload: { code, message },
  });
}

export const scanWorker = new Worker(
  "scan",
  async (job) => {
    const { sessionId } = job.data || {};
    if (!sessionId) return;

    const supabase = supabaseAdmin;

    const session = await getScanSession({ supabase, sessionId });
    if (!session) return;

    if (["done", "failed", "canceled", "error"].includes(session.status)) return;

    // Mark running on first chunk
    if (session.status === "queued") {
      await updateSessionProgress({ supabase, sessionId, patch: { status: "running" } });
      await writeEvent({ supabase, sessionId, userId: session.user_id, type: "progress", payload: { phase: "starting" } });
    }

    // Token: prefer stored access token; refresh token is a bonus, not a requirement for the first hour.
    const tokens = await getGoogleTokens({ supabase, userId: session.user_id }).catch(() => null);
    const accessToken = tokens?.accessToken;
    if (!accessToken) {
      await failSession(session, "MISSING_TOKEN", "Missing Google token. Reconnect Gmail.");
      return;
    }

    const opts = session.options || {};
    const maxPages = clamp(Number(opts.maxPages ?? 120), 1, 400);
    const maxCandidates = clamp(Number(opts.maxCandidates ?? 200), 10, 400);

    const pages = Number(session.pages || 0);
    const scannedTotal = Number(session.scanned_total || 0);
    const foundTotal = Number(session.found_total || 0);

    // One chunk per job (bounded by deadlineMs)
    const result = await scanGmail({
      accessToken,
      options: {
        daysBack: Number(opts.daysBack ?? 90),
        pageSize: Number(opts.pageSize ?? 500),
        deadlineMs: Number(opts.chunkMs ?? 9000),
        fullFetchCap: Number(opts.fullFetchCap ?? 12),
        concurrency: Number(opts.concurrency ?? 6),
        queryMode: opts.queryMode ?? "transactions",
        includePromotions: Boolean(opts.includePromotions ?? false),
        maxListIds: Number(opts.maxListIds ?? 800),
        clusterCap: Number(opts.clusterCap ?? 40),
        cursor: session.cursor || undefined,
        debug: Boolean(opts.debug ?? false),
      },
      context: {
        directory: null,
        overrides: null,
      },
    });

    const scannedDelta = Number(result?.stats?.scanned || 0);
    const up = await upsertCandidates({ supabase, sessionId, userId: session.user_id, candidates: result.candidates || [] });
    const foundDelta = up.inserted;

    const nextPages = pages + 1;
    const nextScanned = scannedTotal + scannedDelta;
    const nextFound = foundTotal + foundDelta;
    const nextCursor = result.nextCursor ?? null;

    const progressPayload = {
      phase: "running",
      pages: nextPages,
      cursor: nextCursor,
      scannedTotal: nextScanned,
      foundTotal: nextFound,
      stats: result.stats,
    };

    await updateSessionProgress({
      supabase,
      sessionId,
      patch: {
        pages: nextPages,
        cursor: nextCursor,
        scanned_total: nextScanned,
        found_total: nextFound,
        last_stats: progressPayload,
      },
    });

    await writeEvent({ supabase, sessionId, userId: session.user_id, type: "progress", payload: progressPayload });
    if (foundDelta > 0) {
      await writeEvent({ supabase, sessionId, userId: session.user_id, type: "candidates", payload: { candidates: result.candidates || [] } });
    }

    const done =
      !nextCursor ||
      nextPages >= maxPages ||
      nextFound >= maxCandidates;

    if (done) {
      await updateSessionProgress({ supabase, sessionId, patch: { status: "done" } });
      await writeEvent({ supabase, sessionId, userId: session.user_id, type: "done", payload: { ok: true, pages: nextPages, scannedTotal: nextScanned, foundTotal: nextFound } });
      return;
    }

    // schedule next chunk
    await enqueueScanChunk({ sessionId });
  },
  { connection: redis }
);

scanWorker.on("failed", (job, err) => {
  console.error("scan job failed", { jobId: job?.id, err: err?.message || String(err) });
});
