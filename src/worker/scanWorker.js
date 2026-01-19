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

        // Only Gmail implemented in this “100/100 drop”
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

  // server-side foundTotal should be DB-unique count, not “added lengths”
  // We'll track via upsert count and set-based dedupe is enforced by DB unique index.
  await writeEvent({
    supabase,
    sessionId,
    userId,
    type: "progress",
    payload: {
      phase: "starting",
      pages,
      cursor,
      scannedTotal,
      foundTotal,
    },
  });

  while (pages < maxPages) {
    // cancel check
    const current = await getScanSession({ supabase, sessionId, userId });
    if (!current || current.status === "canceled") {
      await writeEvent({ supabase, sessionId, userId, type: "done", payload: { ok: true, canceled: true } });
      await updateSessionProgress({ supabase, sessionId, patch: { status: "canceled" } });
      return;
    }

    pages += 1;

    // renew lease
    await renewLease({ supabase, sessionId, instanceId, leaseSeconds: 30 });

    const chunkOptions = {
      daysBack: Number(opts.daysBack ?? 365),
      pageSize: Number(opts.pageSize ?? 500),

      // Bigger budget per chunk -> more list pages + meta fetches -> higher throughput.
      // Keep it under typical reverse-proxy limits (we still stream progress via events).
      deadlineMs: Number(opts.chunkMs ?? 15000),

      fullFetchCap: Number(opts.fullFetchCap ?? 25),
      concurrency: Number(opts.concurrency ?? 6),
      maxCandidates: Math.min(200, maxCandidates),
      cursor: cursor || undefined,

      // NEW: scan scope + listing throughput
      queryMode: opts.queryMode ?? "transactions", // "transactions" | "broad"
      includePromotions: Boolean(opts.includePromotions ?? false),
      maxListIds: Number(opts.maxListIds ?? (Number(opts.pageSize ?? 500) * 10)),
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

    // write candidates (deduped)
    const up = await upsertCandidates({ supabase, sessionId, userId, candidates: result.candidates || [] });

    // update foundTotal via count query? keep it cheap: increment by attempted inserts, and occasionally correct.
    foundTotal += up.inserted;

    const progressPayload = {
      phase: "running",
      pages,
      cursor,
      scannedTotal,
      foundTotal,
      estimatedTotal: result?.stats?.estimatedTotal ?? null,
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
      // stream only the candidates we just processed (client can merge/dedupe by fingerprint)
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

    // tiny delay to avoid bursty quota behavior
    await sleep(120);
  }

  await updateSessionProgress({ supabase, sessionId, patch: { status: "done" } });
  await writeEvent({ supabase, sessionId, userId, type: "done", payload: { ok: true, pages, scannedTotal, foundTotal } });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
