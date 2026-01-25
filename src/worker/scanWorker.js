// src/worker/scanWorker.js
import { Worker } from "bullmq";
import { redis } from "../queue/redis.js";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";

import { getGoogleTokens } from "../lib/tokenStore.js";
import { getFreshGoogleAccessToken } from "../lib/googleAuth.js";
import { scanGmail } from "../lib/gmail.js";

import { writeEvent } from "../lib/eventStore.js";
import { getScanSession, updateSessionProgress, upsertCandidates } from "../lib/scanStore.js";
import { enqueueScanChunk } from "../queue/scanQueue.js";

import { enforceBudgets } from "../lib/slo.js";
import { upsertChunkLog } from "../lib/scanDebugStore.js";
import { getMerchantDirectoryCached, getUserOverrides } from "../lib/merchantData.js";

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
    dedupeKey: `fail:${code}`,
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

    if (["done", "canceled", "error"].includes(session.status)) return;

    // Start state
    if (session.status === "queued") {
      await updateSessionProgress({ supabase, sessionId, patch: { status: "running" } });
      await writeEvent({
        supabase,
        sessionId,
        userId: session.user_id,
        type: "progress",
        payload: { phase: "starting" },
        dedupeKey: `progress:starting`,
      });
    }

    // ✅ Token persistence on reopen:
    // Use stored refresh token to mint a fresh access token when available.
    const tokens = await getGoogleTokens({ supabase, userId: session.user_id }).catch(() => null);

    let accessToken = tokens?.accessToken || null;
    if (tokens?.refreshToken) {
      try {
        accessToken = await getFreshGoogleAccessToken({ supabase, userId: session.user_id });
      } catch {
        accessToken = tokens?.accessToken || null;
      }
    }

    if (!accessToken) {
      await failSession(session, "MISSING_TOKEN", "Missing Google token. Reconnect Gmail.");
      return;
    }

    // ✅ Enforce budgets again (worker-side)
    const opts = enforceBudgets(session.options || {});
    const cursorIn = session.cursor || null;

    // ✅ Load directory/overrides for better merchant mapping
    const [directory, overrides] = await Promise.all([
      getMerchantDirectoryCached().catch(() => null),
      getUserOverrides(session.user_id).catch(() => null),
    ]);

    const chunkKey = `${session.id}:${cursorIn || "start"}`;
    const t0 = Date.now();

    let result;
    try {
      result = await scanGmail({
        accessToken,
        options: {
          ...opts,
          cursor: cursorIn || undefined,

          // ✅ API alignment: frontend sends chunkMs; engine expects deadlineMs
          deadlineMs: Number(opts.chunkMs ?? 9000),
        },
        context: {
          directory: directory || [],
          overrides: overrides || [],
        },
      });

      await upsertChunkLog({
        supabase,
        sessionId: session.id,
        chunkKey,
        cursorIn,
        cursorOut: result.nextCursor ?? null,
        listed: result.stats?.listed ?? 0,
        screened: result.stats?.screenedIn ?? 0,
        fullFetched: result.stats?.fullFetched ?? 0,
        matched: result.stats?.matched ?? 0,
        tookMs: Date.now() - t0,
      });
    } catch (e) {
      await upsertChunkLog({
        supabase,
        sessionId: session.id,
        chunkKey,
        cursorIn,
        cursorOut: null,
        listed: 0,
        screened: 0,
        fullFetched: 0,
        matched: 0,
        tookMs: Date.now() - t0,
        error: String(e?.message || e),
      });
      await failSession(session, "CHUNK_ERROR", String(e?.message || e));
      return;
    }

    const scannedDelta = Number(result?.stats?.scanned || 0);

    const up = await upsertCandidates({
      supabase,
      sessionId,
      userId: session.user_id,
      candidates: result.candidates || [],
    });

    const foundDelta = up.inserted;

    const nextPages = Number(session.pages || 0) + 1;
    const nextScanned = Number(session.scanned_total || 0) + scannedDelta;
    const nextFound = Number(session.found_total || 0) + foundDelta;
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

    await writeEvent({
      supabase,
      sessionId,
      userId: session.user_id,
      type: "progress",
      payload: progressPayload,
      dedupeKey: `progress:${nextPages}:${nextCursor || "end"}`,
    });

    if (foundDelta > 0) {
      await writeEvent({
        supabase,
        sessionId,
        userId: session.user_id,
        type: "candidates",
        payload: { candidates: result.candidates || [] },
        dedupeKey: `candidates:${nextPages}:${nextCursor || "end"}`,
      });
    }

    const done =
      !nextCursor ||
      nextPages >= Number(opts.maxPages ?? 6) ||
      nextFound >= Number(opts.maxCandidates ?? 60);

    if (done) {
      await updateSessionProgress({ supabase, sessionId, patch: { status: "done" } });
      await writeEvent({
        supabase,
        sessionId,
        userId: session.user_id,
        type: "done",
        payload: { ok: true, pages: nextPages, scannedTotal: nextScanned, foundTotal: nextFound },
        dedupeKey: `done`,
      });
      return;
    }

    // schedule next chunk (jobId is idempotent in scanQueue.js)
    await enqueueScanChunk({ sessionId });
  },
  { connection: redis }
);

scanWorker.on("failed", (job, err) => {
  console.error("scan job failed", { jobId: job?.id, err: err?.message || String(err) });
});
