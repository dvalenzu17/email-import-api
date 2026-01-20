// src/lib/gmail.js
import { buildCandidate, buildClusterCandidates, aggregateCandidates, quickScreenMessage } from "./detect.js";
import { buildImprovedCandidate } from "./candidateScoring.js";
import { enrichTopCandidates } from "./extractBilling.js";
import { dedupeBestPerMerchant } from "./merchantDedupe.js";


const ENGINE_VERSION = "gmail.v7.cluster-first";


function headersToMap(headers = []) {
  const out = {};
  for (const h of headers || []) {
    const name = String(h?.name || "").toLowerCase();
    if (!name) continue;
    out[name] = String(h?.value || "");
  }
  return out;
}

function pickHeaders(headers = []) {
  const m = headersToMap(headers);
  return {
    headerMap: m,
    from: m["from"] ?? "",
    subject: m["subject"] ?? "",
    date: m["date"] ?? "",
    replyTo: m["reply-to"] ?? "",
    returnPath: m["return-path"] ?? "",
  };
}

function buildQuery({ daysBack, queryMode = "transactions", includePromotions = false }) {
  const transactional =
    '(receipt OR invoice OR billed OR billing OR charged OR "payment" OR "payment successful" OR renewal OR renews OR "next billing" OR subscription OR "trial ends" OR expiring OR "purchase confirmed" OR "order confirmation" OR "manage subscription" OR "cancel subscription")';

  const base = `in:anywhere newer_than:${daysBack}d -in:chats`;
  const promoFilter = includePromotions ? "" : " -category:promotions -category:social";

  if (queryMode === "broad") return `${base}${promoFilter}`;
  return `${base}${promoFilter} (${transactional})`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms) {
  return ms + Math.floor(Math.random() * 120);
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchRetry(url, init, timeoutMs, shouldStop, tries = 3) {
  let attempt = 0;
  while (true) {
    if (shouldStop?.()) throw new Error("DEADLINE");
    const res = await fetchWithTimeout(url, init, timeoutMs);
    if (res.ok) return res;

    if ([429, 500, 502, 503, 504].includes(res.status) && attempt < tries - 1) {
      attempt += 1;
      await sleep(jitter(250 * attempt));
      continue;
    }
    return res;
  }
}

async function parallelMap(items, worker, concurrency, shouldStop) {
  const out = new Array(items.length);
  let idx = 0;

  async function run() {
    while (true) {
      if (shouldStop?.()) return;
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i).catch(() => null);
    }
  }

  const runners = [];
  for (let i = 0; i < concurrency; i++) runners.push(run());
  await Promise.all(runners);
  return out;
}

function flattenParts(payload) {
  const out = [];
  const stack = [payload].filter(Boolean);
  while (stack.length) {
    const p = stack.pop();
    if (!p) continue;
    out.push(p);
    const kids = p.parts || [];
    for (const k of kids) stack.push(k);
  }
  return out;
}

function decodeBase64Url(data) {
  if (!data) return "";
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  return Buffer.from(b64 + pad, "base64").toString("utf8");
}

async function fetchAttachment({ accessToken, messageId, attachmentId, timeoutMs, shouldStop }) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`;
  const res = await fetchRetry(url, { headers: { Authorization: `Bearer ${accessToken}` } }, timeoutMs, shouldStop);
  if (!res.ok) return "";
  const j = await res.json().catch(() => null);
  return decodeBase64Url(j?.data || "");
}

async function extractBodiesFull({ accessToken, messageId, payload, timeoutMs, attachTimeoutMs, shouldStop }) {
  let text = "";
  let html = "";
  const parts = flattenParts(payload);

  for (const p of parts) {
    const mime = String(p?.mimeType || "").toLowerCase();
    const body = p?.body || {};
    const data = body?.data || null;
    const attId = body?.attachmentId || null;
    const size = Number(body?.size || 0);

    if (data && size <= 1024 * 1024) {
      const decoded = decodeBase64Url(data);
      if (mime.includes("text/plain")) text += `\n${decoded}`;
      else if (mime.includes("text/html")) html += `\n${decoded}`;
      continue;
    }

    if (attId && size > 0 && size <= 1024 * 512) {
      const decoded = await fetchAttachment({
        accessToken,
        messageId,
        attachmentId: attId,
        timeoutMs: attachTimeoutMs,
        shouldStop,
      });
      if (mime.includes("text/plain")) text += `\n${decoded}`;
      else if (mime.includes("text/html")) html += `\n${decoded}`;
    }
  }

  if (!text && payload?.body?.data) text = decodeBase64Url(payload.body.data);
  return { text: text.trim(), html: html.trim() };
}

// Used by top-25 enrichment to full-fetch bodies quickly.
async function fetchGmailMessageText({ accessToken, messageId, fullTimeoutMs, attachTimeoutMs, shouldStop }) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full&fields=id,internalDate,payload,snippet`;
  const res = await fetchRetry(url, { headers: { Authorization: `Bearer ${accessToken}` } }, fullTimeoutMs, shouldStop);
  if (!res.ok) return "";

  const msg = await res.json().catch(() => null);
  const bodies = await extractBodiesFull({
    accessToken,
    messageId,
    payload: msg?.payload,
    timeoutMs: fullTimeoutMs,
    attachTimeoutMs,
    shouldStop,
  });

  return `${msg?.snippet || ""}\n${bodies.text || ""}\n${bodies.html || ""}`.trim();
}

export async function scanGmail({ accessToken, options, context }) {
  const startedAt = Date.now();

  const daysBack = Number(options?.daysBack ?? 365);
  const pageSize = clamp(Number(options?.pageSize ?? 500), 50, 500);
  const maxCandidates = clamp(Number(options?.maxCandidates ?? 200), 10, 400);

  const deadlineMs = clamp(Number(options?.deadlineMs ?? 9000), 8000, 45000);
  const deadlineAt = startedAt + deadlineMs;

  const concurrency = clamp(Number(options?.concurrency ?? 6), 2, 10);

  const listTimeoutMs = clamp(Number(options?.timeouts?.listMs ?? 9000), 3000, 15000);
  const metaTimeoutMs = clamp(Number(options?.timeouts?.metaMs ?? 8000), 3000, 15000);
  const fullTimeoutMs = clamp(Number(options?.timeouts?.fullMs ?? 12000), 3000, 20000);
  const attachTimeoutMs = clamp(Number(options?.timeouts?.attachMs ?? 12000), 3000, 20000);

  const cursor = options?.cursor || undefined;
  const q = buildQuery({
    daysBack,
    queryMode: options?.queryMode || "transactions",
    includePromotions: !!options?.includePromotions,
  });

  // Keep time for enrichment too
  const shouldStop = () => Date.now() > deadlineAt - 900;

  const statsRef = { nullReasons: Object.create(null) };

  const maxListIds = clamp(Number(options?.maxListIds ?? pageSize * 3), pageSize, 25000);

  // Step 1: list multiple pages quickly
  const ids = [];
  let estimatedTotal = null;
  let pageToken = cursor || undefined;

  while (!shouldStop() && ids.length < maxListIds) {
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("q", q);
    listUrl.searchParams.set("maxResults", String(pageSize));
    listUrl.searchParams.set("fields", "messages/id,nextPageToken,resultSizeEstimate");
    if (pageToken) listUrl.searchParams.set("pageToken", pageToken);

    const listRes = await fetchRetry(
      listUrl.toString(),
      { headers: { Authorization: `Bearer ${accessToken}` } },
      listTimeoutMs,
      shouldStop
    );

    if (!listRes.ok) {
      const txt = await listRes.text().catch(() => "");
      throw new Error(`GMAIL_LIST_FAILED (${listRes.status}): ${txt}`);
    }

    const listJson = await listRes.json();
    if (typeof listJson.resultSizeEstimate === "number") estimatedTotal = listJson.resultSizeEstimate;

    const pageIds = (Array.isArray(listJson.messages) ? listJson.messages : []).map((m) => m?.id).filter(Boolean);
    ids.push(...pageIds);

    pageToken = listJson.nextPageToken || null;
    if (!pageToken) break;
  }

  const nextCursor = pageToken || null;

  if (!ids.length) {
    return {
      candidates: [],
      nextCursor,
      stats: {
        engineVersion: ENGINE_VERSION,
        daysBack,
        pageSize,
        estimatedTotal,
        listed: 0,
        scanned: 0,
        screenedIn: 0,
        fullFetched: 0,
        rawMatched: 0,
        matched: 0,
        nullReasons: statsRef.nullReasons,
        deadlineMs,
        tookMs: Date.now() - startedAt,
        query: q,
      },
    };
  }

  // Step 2: fetch metadata with bounded concurrency
  const meta = await parallelMap(
    ids,
    async (id) => {
      if (shouldStop()) return null;

      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Reply-To&metadataHeaders=Return-Path&fields=id,internalDate,snippet,payload/headers`;
      const res = await fetchRetry(url, { headers: { Authorization: `Bearer ${accessToken}` } }, metaTimeoutMs, shouldStop);
      if (!res.ok) return null;

      const msg = await res.json();
      const headers = pickHeaders(msg?.payload?.headers || []);
      const snippet = msg?.snippet || "";
      const dateMs = Number(msg?.internalDate || 0) || null;

      const screen = quickScreenMessage({ headers, snippet });
      const ok = screen.ok || screen.reason === "weak_signal";
      return { id, headers, snippet, dateMs, ok, screenReason: screen.reason };
    },
    concurrency,
    shouldStop
  );

  const scanned = meta.filter(Boolean).length;
  const screenedIn = meta.filter((m) => m?.ok);

  // Step 2.5: cluster suspects (metadata only)
  const clusterCap = clamp(Number(options?.clusterCap ?? 60), 10, 200);
  const clusterCandidates = buildClusterCandidates(screenedIn, context, Math.min(clusterCap, maxCandidates));

  // Step 3: bounded full fetch
  const fullCap = clamp(Number(options?.fullFetchCap ?? 25), 0, 120);
  const fullTargets = screenedIn.slice(0, fullCap);

  const rawCandidates = [];
  let fullFetched = 0;

  for (let i = 0; i < fullTargets.length; i++) {
    if (shouldStop()) break;

    const m = fullTargets[i];
    try {
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full&fields=id,internalDate,payload,snippet`;
      const res = await fetchRetry(url, { headers: { Authorization: `Bearer ${accessToken}` } }, fullTimeoutMs, shouldStop);
      if (!res.ok) continue;

      const msg = await res.json();
      fullFetched++;

      const bodies = await extractBodiesFull({
        accessToken,
        messageId: m.id,
        payload: msg.payload,
        timeoutMs: fullTimeoutMs,
        attachTimeoutMs,
        shouldStop,
      });

      const cand = buildCandidate(
        {
          from: m.headers.from,
          subject: m.headers.subject,
          snippet: msg?.snippet || m.snippet || "",
          text: bodies.text,
          html: bodies.html,
          headerMap: m.headers.headerMap,
          replyTo: m.headers.replyTo,
          returnPath: m.headers.returnPath,
          dateMs: Number(msg?.internalDate || m.dateMs || 0) || null,
        },
        { ...context, stats: statsRef }
      );

      if (cand) rawCandidates.push(cand);
      if (rawCandidates.length >= maxCandidates) break;
      if (i % 8 === 0) await sleep(10);
    } catch {
      // ignore
    }
  }

  const candidates = aggregateCandidates(rawCandidates, maxCandidates);

  // Merge: parsed candidates first, then cluster suspects
  const merged = [];
  const seen = new Set();

  for (const c of candidates) {
    if (!c?.fingerprint || seen.has(c.fingerprint)) continue;
    seen.add(c.fingerprint);
    merged.push(c);
  }
  for (const c of clusterCandidates) {
    if (!c?.fingerprint || seen.has(c.fingerprint)) continue;
    seen.add(c.fingerprint);
    merged.push(c);
    if (merged.length >= maxCandidates) break;
  }

  // Post-process: normalize merchant + classify event type + rescore confidence.
  const directory = Array.isArray(context?.directory) ? context.directory : [];
  const overrides = Array.isArray(context?.overrides) ? context.overrides : [];

  const improved = [];
  let dropped = 0;

  // Ensure evidence includes messageId for later enrichment
  for (const c of merged) {
    const ev = c?.evidence || {};
    // If the candidate was built from a real message, attach messageId when missing.
    // Prefer existing ev.messageId if detect.js already set it.
    if (!ev.messageId && ev.id) ev.messageId = ev.id; // safe fallback
    c.evidence = { ...ev };
  }

  for (const c of merged) {
    const out = buildImprovedCandidate({ rawCandidate: c, directory, overrides });
    if (!out.drop) improved.push(out.candidate);
    else dropped++;
  }

  // Enrich top 25 (best-effort) for amount/cadence
  const enriched = await enrichTopCandidates({
    
    candidates: improved,
    topN: 25,
    shouldStop,
    fetchMessageText: async (messageId) =>
      await fetchGmailMessageText({
        accessToken,
        messageId,
        fullTimeoutMs,
        attachTimeoutMs,
        shouldStop,
      }),
  });

  const finalCandidates = dedupeBestPerMerchant(enriched, { max: options?.maxMerchants ?? 60 });


  return {
    candidates: finalCandidates,
    nextCursor,
    stats: {
      engineVersion: ENGINE_VERSION,
      daysBack,
      pageSize,
      estimatedTotal,
      listed: ids.length,
      scanned,
      screenedIn: screenedIn.length,
      fullFetched,
      rawMatched: rawCandidates.length,
      matched: enriched.length,
      dropped,
      matchedFromBodies: candidates.length,
      matchedFromClusters: clusterCandidates.length,
      nullReasons: statsRef.nullReasons,
      deadlineMs,
      fullFetchCap: fullCap,
      tookMs: Date.now() - startedAt,
      query: q,
    },
    merchants: finalCandidates.length,
  };
}
