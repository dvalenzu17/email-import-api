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

function buildQuery(daysBack) {
  // open-world: DON'T over-filter with keywords (that’s why your mom got 0 results)
  // we screen aggressively client-side using headers/snippets.
  return `in:anywhere newer_than:${daysBack}d`;
}

async function pMap(items, concurrency, fn) {
  const ret = new Array(items.length);
  let idx = 0;

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        ret[i] = await fn(items[i], i);
      } catch (e) {
        ret[i] = null;
      }
    }
  });

  await Promise.all(workers);
  return ret;
}

export async function scanGmail({ accessToken, options, context }) {
  const daysBack = options.daysBack;
  const maxMessages = options.maxMessages;
  const maxCandidates = options.maxCandidates;

  const q = buildQuery(daysBack);
  let pageToken = options.cursor;
  const ids = [];

  while (ids.length < maxMessages) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("q", q);
    url.searchParams.set("maxResults", String(Math.min(500, maxMessages - ids.length)));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`GMAIL_LIST_FAILED (${res.status}): ${txt}`);
    }

    const json = await res.json();
    const batch = Array.isArray(json.messages) ? json.messages : [];
    for (const m of batch) if (m?.id) ids.push(m.id);

    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }

  // Phase 1: metadata screening (cheap)
  const meta = await pMap(ids, options.concurrency || 10, async (id) => {
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

    return {
      id,
      ok: screen.ok,
      screenReason: screen.reason,
      headers,
      snippet,
      dateMs: msgDate.getTime(),
    };
  });

  const screenedIn = meta.filter((m) => m?.ok);
  const scanned = meta.filter(Boolean).length;

  // Phase 2: fetch FULL only for screened-in messages
  const rawCandidates = [];
  const fullFetched = await pMap(screenedIn, options.concurrency || 10, async (m) => {
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

  const candidates = aggregateCandidates(rawCandidates, maxCandidates);

  return {
    candidates,
    stats: {
      scanned,
      screenedIn: screenedIn.length,
      fullFetched: fullFetched.filter(Boolean).length,
      rawMatched: rawCandidates.length,
      matched: candidates.length,
      daysBack,
      maxMessages,
    },
    nextCursor: pageToken,
  };
}
