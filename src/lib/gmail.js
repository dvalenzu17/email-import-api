// src/lib/gmail.js
import { buildCandidate, aggregateCandidates, quickScreenMessage } from "./detect.js";

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

/**
 * Merchant-agnostic but transactional-focused Gmail query.
 * This avoids wasting pages on promos/newsletters.
 */
function buildQuery(daysBack) {
  const transactional =
    '(receipt OR invoice OR billed OR billing OR charged OR "payment" OR "payment successful" OR renewal OR renews OR "next billing" OR subscription OR "trial ends" OR expiring OR "purchase confirmed" OR "order confirmation")';
  return `in:anywhere newer_than:${daysBack}d (${transactional})`;
}

async function pMap(items, concurrency, fn) {
  const ret = new Array(items.length);
  let idx = 0;

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (idx < items.length) {
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
  const daysBack = options.daysBack ?? 730;

  // IMPORTANT: "pageSize" is per-request scan size. Keep this bounded for reliability.
  const pageSize = Math.max(50, Math.min(500, Number(options.pageSize ?? 250)));
  const maxCandidates = Math.max(10, Math.min(200, Number(options.maxCandidates ?? 60)));
  const concurrency = Math.max(2, Math.min(10, Number(options.concurrency ?? 6)));

  const cursor = options.cursor || undefined;
  const q = buildQuery(daysBack);

  // ---- Step 1: list ONE page of message IDs ----
  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", q);
  listUrl.searchParams.set("maxResults", String(pageSize));
  if (cursor) listUrl.searchParams.set("pageToken", cursor);

  const listRes = await fetch(listUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!listRes.ok) {
    const txt = await listRes.text();
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
      stats: {
        scanned: 0,
        screenedIn: 0,
        fullFetched: 0,
        rawMatched: 0,
        matched: 0,
        daysBack,
        pageSize,
      },
      nextCursor,
    };
  }

  // ---- Step 2: metadata screening (cheap) ----
  const meta = await pMap(ids, concurrency, async (id) => {
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

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
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

    // allow "weak_signal" to pass so we don't drop everything
    const ok = screen.ok || screen.reason === "weak_signal";

    return {
      id,
      ok,
      headers,
      snippet,
      dateMs: msgDate.getTime(),
    };
  });

  const scanned = meta.filter(Boolean).length;
  const screenedIn = meta.filter((m) => m?.ok);

  // ---- Step 3: full fetch only for screened-in, STOP EARLY once we have enough ----
  const rawCandidates = [];

  // Process in small chunks to avoid long request time
  for (let i = 0; i < screenedIn.length; i += 40) {
    const chunk = screenedIn.slice(i, i + 40);

    await pMap(chunk, concurrency, async (m) => {
      if (!m?.id) return null;
      if (rawCandidates.length >= maxCandidates * 2) return null;

      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) return null;

      const msg = await res.json();
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
      return true;
    });

    // If we already have enough evidence, stop early
    if (rawCandidates.length >= maxCandidates) break;
  }

  const candidates = aggregateCandidates(rawCandidates, maxCandidates);

  return {
    candidates,
    stats: {
      scanned,
      screenedIn: screenedIn.length,
      fullFetched: Math.min(screenedIn.length, scanned),
      rawMatched: rawCandidates.length,
      matched: candidates.length,
      daysBack,
      pageSize,
    },
    nextCursor,
  };
}
