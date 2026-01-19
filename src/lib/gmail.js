// src/lib/gmail.js
import { buildCandidate, aggregateCandidates, quickScreenMessage } from "./detect.js";

const ENGINE_VERSION = "gmail-scan-v105-multipage-attachments-retry";

function b64urlDecode(s) {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function headersToMap(headers = []) {
  const map = {};
  for (const h of headers || []) {
    if (!h?.name) continue;
    map[String(h.name).toLowerCase()] = String(h.value || "");
  }
  return map;
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

function buildQuery(daysBack) {
  const transactional =
    '(receipt OR invoice OR billed OR billing OR charged OR "payment" OR "payment successful" OR renewal OR renews OR "next billing" OR subscription OR "trial ends" OR expiring OR "purchase confirmed" OR "order confirmation")';
  // reduce garbage
  return `in:anywhere newer_than:${daysBack}d -category:promotions -category:social (${transactional})`;
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

    if ((res.status === 429 || res.status === 403) && attempt < tries - 1) {
      attempt++;
      await sleep(jitter(250 * Math.pow(2, attempt)));
      continue;
    }
    return res;
  }
}

async function pMap(items, concurrency, fn, shouldStop) {
  const ret = new Array(items.length);
  let idx = 0;

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (idx < items.length) {
      if (shouldStop?.()) break;
      const i = idx++;
      try {
        ret[i] = await fn(items[i], i);
      } catch {
        ret[i] = null;
      }
    }
  });

  await Promise.all(workers);
  return ret;
}

async function getAttachment({ accessToken, messageId, attachmentId, timeoutMs, shouldStop }) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`;
  const res = await fetchRetry(url, { headers: { Authorization: `Bearer ${accessToken}` } }, timeoutMs, shouldStop);
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  if (!json || typeof json.data !== "string") return null;
  return b64urlDecode(json.data);
}

async function extractBodiesFull({ accessToken, messageId, payload, timeoutMs, attachTimeoutMs, shouldStop, capBytes = 250_000 }) {
  let text = "";
  let html = "";

  async function walk(node) {
    if (!node) return;
    const mt = node.mimeType;
    const body = node.body || {};

    if (mt === "text/plain" || mt === "text/html") {
      if (typeof body.data === "string") {
        const decoded = b64urlDecode(body.data);
        if (mt === "text/plain") text += `\n${decoded}`;
        else html += `\n${decoded}`;
      } else if (body.attachmentId) {
        const size = Number(body.size ?? 0);
        if (Number.isFinite(size) && size > 0 && size <= capBytes) {
          const decoded = await getAttachment({
            accessToken,
            messageId,
            attachmentId: body.attachmentId,
            timeoutMs: attachTimeoutMs ?? timeoutMs,
            shouldStop,
          });
          if (decoded) {
            if (mt === "text/plain") text += `\n${decoded}`;
            else html += `\n${decoded}`;
          }
        }
      }
    }

    if (Array.isArray(node.parts)) {
      for (const p of node.parts) await walk(p);
    }
  }

  await walk(payload);
  return { text: text.trim() || "", html: html.trim() || "" };
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
  const q = buildQuery(daysBack);
  const shouldStop = () => Date.now() > deadlineAt - 900;

  const statsRef = { nullReasons: Object.create(null) };

  // Step 1: list multiple pages quickly
  const ids = [];
  let estimatedTotal = null;
  let pageToken = cursor || undefined;

  while (!shouldStop() && ids.length < pageSize * 3) {
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("q", q);
    listUrl.searchParams.set("maxResults", String(pageSize));
    listUrl.searchParams.set("fields", "messages/id,nextPageToken,resultSizeEstimate");
    if (pageToken) listUrl.searchParams.set("pageToken", pageToken);

    const listRes = await fetchRetry(listUrl.toString(), { headers: { Authorization: `Bearer ${accessToken}` } }, listTimeoutMs, shouldStop);

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

  // Step 2: metadata screening
  const meta = await pMap(
    ids,
    concurrency,
    async (id) => {
      if (shouldStop()) return null;

      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
      url.searchParams.set("format", "metadata");
      url.searchParams.set("fields", "id,snippet,internalDate,payload/headers");
      url.searchParams.set("metadataHeaders", "From");
      url.searchParams.set("metadataHeaders", "Subject");
      url.searchParams.set("metadataHeaders", "Date");
      url.searchParams.set("metadataHeaders", "Reply-To");
      url.searchParams.set("metadataHeaders", "Return-Path");
      url.searchParams.set("metadataHeaders", "List-Unsubscribe");
      url.searchParams.set("metadataHeaders", "List-Id");
      url.searchParams.set("metadataHeaders", "Precedence");
      url.searchParams.set("metadataHeaders", "Auto-Submitted");

      const res = await fetchRetry(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } }, metaTimeoutMs, shouldStop);
      if (!res.ok) return null;

      const msg = await res.json();
      const headers = pickHeaders(msg.payload?.headers ?? []);
      const snippet = msg.snippet || "";
      const msgDate = headers.date ? new Date(headers.date) : new Date(Number(msg.internalDate || Date.now()));

      const screen = quickScreenMessage({ from: headers.from, subject: headers.subject, snippet, headerMap: headers.headerMap });
      const ok = screen.ok || screen.reason === "weak_signal";

      return { id, ok, headers, snippet, dateMs: msgDate.getTime() };
    },
    shouldStop
  );

  const scanned = meta.filter(Boolean).length;
  const screenedIn = meta.filter((m) => m?.ok);

  // Step 3: bounded full fetch
  const fullCap = clamp(Number(options?.fullFetchCap ?? 25), 10, 120);
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
          replyTo: m.headers.replyTo,
          returnPath: m.headers.returnPath,
          subject: m.headers.subject,
          snippet: m.snippet,
          text: bodies.text,
          html: bodies.html,
          headerMap: m.headers.headerMap,
          dateMs: m.dateMs,
        },
        { directory: context?.directory, overrides: context?.overrides, stats: statsRef }
      );

      if (cand) rawCandidates.push(cand);
      if (rawCandidates.length >= maxCandidates) break;
      if (i % 8 === 0) await sleep(10);
    } catch {
      // ignore
    }
  }

  const candidates = aggregateCandidates(rawCandidates, maxCandidates);

  return {
    candidates,
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
      matched: candidates.length,
      nullReasons: statsRef.nullReasons,
      deadlineMs,
      fullFetchCap: fullCap,
      tookMs: Date.now() - startedAt,
      query: q,
    },
  };
}
