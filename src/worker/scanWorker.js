// src/worker/scanWorker.js
import { nanoid } from "nanoid";
import {
  leaseNextQueuedSession,
  renewLease,
  updateSessionProgress,
  writeEvent,
  upsertCandidates,
  getScanSession,
} from "../lib/scanStore.js";
import { scanGmail } from "../lib/gmail.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Background loop worker: continuously leases queued sessions and processes them.
 * Useful if you run a dedicated worker instance.
 */
export function startScanWorker({ server, supabase, getDirectory, getOverrides }) {
  const instanceId = `api-${nanoid(8)}`;
  server.log.info({ instanceId }, "scanWorker starting");

  let stopping = false;
  server.addHook("onClose", async () => {
    stopping = true;
  });

  const loop = async () => {
    while (!stopping) {
      try {
        const session = await leaseNextQueuedSession({ supabase, instanceId, leaseSeconds: 30 });
        if (!session) {
          await sleep(600);
          continue;
        }

        if (session.provider !== "gmail") {
          await updateSessionProgress({
            supabase,
            sessionId: session.id,
            patch: {
              status: "error",
              error_code: "UNSUPPORTED_PROVIDER",
              error_message: "Only gmail sessions are supported by this worker.",
            },
          });
          await writeEvent({
            supabase,
            sessionId: session.id,
            userId: session.user_id,
            type: "error",
            payload: { ok: false, message: "Unsupported provider" },
          });
          continue;
        }

        await runGmailSession({ server, supabase, instanceId, session, getDirectory, getOverrides });
      } catch (e) {
        server.log.error({ err: e }, "scanWorker loop error");
        await sleep(800);
      }
    }
  };

  loop();
}

/**
 * One-shot worker runner: process exactly one sessionId.
 * This is what your /v1/gmail/scan/run endpoint should call.
 */
export async function runScanWorker({ server, sessionId, logger }) {
  const supabase = server?.supabaseAdmin;
  if (!supabase) throw new Error("server.supabaseAdmin missing (attach supabaseAdmin to server)");

  const getDirectory = server?.getMerchantDirectory;
  const getOverrides = server?.getUserOverrides;

  if (typeof getDirectory !== "function" || typeof getOverrides !== "function") {
    throw new Error("server.getMerchantDirectory / server.getUserOverrides missing");
  }

  // Fetch session (no userId required here, scanStore should validate ownership at stream layer)
  const session = await getScanSession({ supabase, sessionId });
  if (!session) throw new Error("Session not found");

  const instanceId = `api-${nanoid(8)}`;
  logger?.info?.({ instanceId, sessionId }, "runScanWorker start");

  if (session.provider !== "gmail") {
    await updateSessionProgress({
      supabase,
      sessionId: session.id,
      patch: {
        status: "error",
        error_code: "UNSUPPORTED_PROVIDER",
        error_message: "Only gmail sessions are supported by this worker.",
      },
    });
    await writeEvent({
      supabase,
      sessionId: session.id,
      userId: session.user_id,
      type: "error",
      payload: { ok: false, message: "Unsupported provider" },
    });
    return;
  }

  await runGmailSession({
    server,
    supabase,
    instanceId,
    session,
    getDirectory,
    getOverrides,
  });

  logger?.info?.({ sessionId }, "runScanWorker done");
}

async function runGmailSession({ server, supabase, instanceId, session, getDirectory, getOverrides }) {
  const sessionId = session.id;
  const userId = session.user_id;

  // access token cache (no tokens in DB)
  const accessToken = server.scanTokenCache?.get(sessionId);
  if (!accessToken) {
    await updateSessionProgress({
      supabase,
      sessionId,
      patch: {
        status: "error",
        error_code: "MISSING_TOKEN",
        error_message: "Access token missing (process restart). Client must restart scan.",
      },
    });
    await writeEvent({
      supabase,
      sessionId,
      userId,
      type: "error",
      payload: { ok: false, message: "Missing access token. Please restart scan." },
    });
    return;
  }

  const directory = await getDirectory();
  const overrides = await getOverrides(userId);

  const opts = session.options || {};
  const maxPages = Number(opts.maxPages || 120);
  const maxCandidates = Number(opts.maxCandidates || 200);

  let cursor = session.cursor || null;
  let pages = Number(session.pages || 0);
  let scannedTotal = Number(session.scanned_total || 0);
  let foundTotal = Number(session.found_total || 0);

  await writeEvent({
    supabase,
    sessionId,
    userId,
    type: "progress",
    payload: { phase: "starting", pages, cursor, scannedTotal, foundTotal },
  });

  while (pages < maxPages) {
    const current = await getScanSession({ supabase, sessionId, userId });
    if (!current || current.status === "canceled") {
      await writeEvent({ supabase, sessionId, userId, type: "done", payload: { ok: true, canceled: true } });
      await updateSessionProgress({ supabase, sessionId, patch: { status: "canceled" } });
      return;
    }

    pages += 1;

    await renewLease({ supabase, sessionId, instanceId, leaseSeconds: 30 });

    const chunkOptions = {
      daysBack: Number(opts.daysBack ?? 365),
      pageSize: Number(opts.pageSize ?? 500),
      deadlineMs: Number(opts.chunkMs ?? 9000),
      fullFetchCap: Number(opts.fullFetchCap ?? 25),
      concurrency: Number(opts.concurrency ?? 6),
      maxCandidates: Math.min(200, maxCandidates),
      cursor: cursor || undefined,
      queryMode: opts.queryMode ?? "transactions",
      includePromotions: Boolean(opts.includePromotions ?? false),
      maxListIds: opts.maxListIds ? Number(opts.maxListIds) : undefined,
      clusterCap: opts.clusterCap ? Number(opts.clusterCap) : undefined,
      debug: Boolean(opts.debug ?? false),
    };

    const startedAt = Date.now();

    const result = await scanGmail({
      accessToken,
      options: chunkOptions,
      context: { directory, overrides },
    });

    const tookMs = Date.now() - startedAt;

    cursor = result.nextCursor ?? null;
    scannedTotal += Number(result.stats?.scanned || 0);

    const up = await upsertCandidates({ supabase, sessionId, userId, candidates: result.candidates || [] });
    foundTotal += up.inserted;

    const progressPayload = {
      phase: "running",
      pages,
      cursor,
      scannedTotal,
      foundTotal,
      tookMs,
      stats: result.stats,
    };

    await updateSessionProgress({
      supabase,
      sessionId,
      patch: {
        cursor,
        pages,
        scanned_total: scannedTotal,
        found_total: foundTotal,
        last_stats: progressPayload,
      },
    });

    await writeEvent({ supabase, sessionId, userId, type: "progress", payload: progressPayload });

    if (up.inserted > 0) {
      await writeEvent({
        supabase,
        sessionId,
        userId,
        type: "candidates",
        payload: { candidates: result.candidates || [] },
      });
    }

    if (!cursor) break;
    if (foundTotal >= maxCandidates) break;

    await sleep(120);
  }

  await updateSessionProgress({ supabase, sessionId, patch: { status: "done" } });
  await writeEvent({ supabase, sessionId, userId, type: "done", payload: { ok: true, pages, scannedTotal, foundTotal } });
}
