// src/lib/gmail.js
import { buildCandidate, aggregateCandidates, quickScreenMessage } from "./detect.js";

const ENGINE_VERSION = "gmail-scan-v99-deadline-20s";

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

function extractBodies(payload) {
  let text = "";
  let html = "";

  function walk(node) {
    if (!node) return;
    const mt = node.mimeType;
    const data = node.body?.data;

    if (data && typeof data === "string") {
      const decoded = b64urlDecode(data);
      if (mt === "text/plain") text += `\n${decoded}`;
      if (mt === "text/html") html += `\n${decoded}`;
    }

    const parts = node.parts;
    if (Array.isArray(parts)) parts.forEach(walk);
  }

  walk(payload);
  return { text: text.trim() || "", html: html.trim() || "" };
}

function buildQuery(daysBack) {
  // Focus on transactional language to avoid promos/newsletters.
  const transactional =
    '(receipt OR invoice OR billed OR billing OR charged OR "payment" OR "payment successful" OR renewal OR renews OR "next billing" OR subscription OR "trial ends" OR expiring OR "purchase confirmed" OR "order confirmation")';
  return `in:anywhere newer_than:${daysBack}d (${transactional})`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
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

export async function scanGmail({ accessToken, options, context }) {
  const startedAt = Date.now();

  const daysBack = Number(options?.daysBack ?? 730);
  const pageSize = clamp(Number(options?.pageSize ?? 200), 50, 500);
  const maxCandidates = clamp(Number(options?.maxCandidates ?? 60), 10, 200);

  const deadlineMs = clamp(Number(options?.deadlineMs ?? 20000), 8000, 45000);
  const deadlineAt = startedAt + deadlineMs;

  const concurrency = clamp(Number(options?.concurrency ?? 5), 2, 8);

  const listTimeoutMs = clamp(Number(options?.timeouts?.listMs ?? 8000), 3000, 15000);
  const metaTimeoutMs = clamp(Number(options?.timeouts?.metaMs ?? 7000), 3000, 15000);
  const fullTimeoutMs = clamp(Number(options?.timeouts?.fullMs ?? 9000), 3000, 20000);

  const cursor = options?.cursor || undefined;
  const q = buildQuery(daysBack);

  const shouldStop = () => Date.now() > deadlineAt - 750;

  // ---- Step 1: list one page of IDs ----
  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", q);
  listUrl.searchParams.set("maxResults", String(pageSize));
  if (cursor) listUrl.searchParams.set("pageToken", cursor);

  const listRes = await fetchWithTimeout(
    listUrl.toString(),
    { headers: { Authorization: `Bearer ${accessToken}` } },
    listTimeoutMs
  );

  if (!listRes.ok) {
    const txt = await listRes.text().catch(() => "");
    throw new Error(`GMAIL_LIST_FAILED (${listRes.status}): ${txt}`);
  }

  const listJson = await listRes.json();
  const ids = (Array.isArray(listJson.messages) ? listJson.messages : [])
    .map((m) => m?.id)
    .filter(Boolean);

  const nextCursor = listJson.nextPageToken || null;

  if (!ids.length) {
    return {
      candidates: [],
      nextCursor,
      stats: {
        engineVersion: ENGINE_VERSION,
        daysBack,
        pageSize,
        scanned: 0,
        screenedIn: 0,
        fullFetched: 0,
        matched: 0,
        deadlineMs,
        tookMs: Date.now() - startedAt,
        query: q,
      },
    };
  }

  // ---- Step 2: metadata screening ----
  const meta = await pMap(
    ids,
    concurrency,
    async (id) => {
      if (shouldStop()) return null;

      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
      url.searchParams.set("format", "metadata");
      url.searchParams.set("metadataHeaders", "From");
      url.searchParams.set("metadataHeaders", "Subject");
      url.searchParams.set("metadataHeaders", "Date");
      url.searchParams.set("metadataHeaders", "Reply-To");
      url.searchParams.set("metadataHeaders", "Return-Path");
      url.searchParams.set("metadataHeaders", "List-Unsubscribe");
      url.searchParams.set("metadataHeaders", "List-Id");
      url.searchParams.set("metadataHeaders", "Precedence");
      url.searchParams.set("metadataHeaders", "Auto-Submitted");

      const res = await fetchWithTimeout(
        url.toString(),
        { headers: { Authorization: `Bearer ${accessToken}` } },
        metaTimeoutMs
      );
      if (!res.ok) return null;

      const msg = await res.json();
      const headers = pickHeaders(msg.payload?.headers ?? []);
      const snippet = msg.snippet || "";
      const msgDate = headers.date ? new Date(headers.date) : new Date(Number(msg.internalDate || Date.now()));

      const screen = quickScreenMessage({
        from: headers.from,
        subject: headers.subject,
        snippet,
        headerMap: headers.headerMap,
      });

      const ok = screen.ok || screen.reason === "weak_signal";

      return {
        id,
        ok,
        headers,
        snippet,
        dateMs: msgDate.getTime(),
      };
    },
    shouldStop
  );

  const scanned = meta.filter(Boolean).length;
  const screenedIn = meta.filter((m) => m?.ok);

  // ---- Step 3: full fetch only for a small subset ----
  const fullCap = clamp(Number(options?.fullFetchCap ?? 35), 10, 80);
  const fullTargets = screenedIn.slice(0, fullCap);

  const rawCandidates = [];
  let fullFetched = 0;

  for (let i = 0; i < fullTargets.length; i++) {
    if (shouldStop()) break;

    const m = fullTargets[i];
    try {
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`;
      const res = await fetchWithTimeout(
        url,
        { headers: { Authorization: `Bearer ${accessToken}` } },
        fullTimeoutMs
      );
      if (!res.ok) continue;

      const msg = await res.json();
      fullFetched++;

      const bodies = extractBodies(msg.payload);
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
        { directory: context?.directory, overrides: context?.overrides }
      );

      if (cand) rawCandidates.push(cand);
      if (rawCandidates.length >= maxCandidates) break;

      if (i % 8 === 0) await sleep(10);
    } catch {
      // ignore per-email failures
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
      scanned,
      screenedIn: screenedIn.length,
      fullFetched,
      rawMatched: rawCandidates.length,
      matched: candidates.length,
      deadlineMs,
      fullFetchCap: fullCap,
      tookMs: Date.now() - startedAt,
      query: q,
    },
  };
}
