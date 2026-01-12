import { buildCandidate } from "./detect.js";

function b64urlDecode(s) {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function pickHeaders(headers = []) {
  const map = new Map();
  for (const h of headers) {
    if (h?.name && typeof h?.value === "string") map.set(String(h.name).toLowerCase(), h.value);
  }
  return {
    from: map.get("from") ?? "",
    subject: map.get("subject") ?? "",
    date: map.get("date") ?? "",
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
  return { text: text.trim() || undefined, html: html.trim() || undefined };
}

function buildQuery(daysBack) {
  // broad net: catches Uber receipts + Netflix welcome/plan confirmations, etc.
  return `newer_than:${daysBack}d (receipt OR invoice OR payment OR charged OR renewal OR subscription OR membership OR trial OR billed OR plan OR welcome OR confirmation OR "valid until")`;
}

export async function scanGmail({ accessToken, options, context }) {
  const q = buildQuery(options.daysBack);
  let pageToken = options.cursor;
  const ids = [];

  while (ids.length < options.maxMessages) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("q", q);
    url.searchParams.set("maxResults", String(Math.min(200, options.maxMessages - ids.length)));
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

  const candidates = [];
  let scanned = 0;

  for (const id of ids) {
    if (scanned >= options.maxMessages) break;
    if (candidates.length >= options.maxCandidates) break;

    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      scanned += 1;
      continue;
    }

    const msg = await res.json();
    scanned += 1;

    const headers = pickHeaders(msg.payload?.headers ?? []);
    const bodies = extractBodies(msg.payload);
    const msgDate = headers.date ? new Date(headers.date) : new Date(Number(msg.internalDate || Date.now()));

    const cand = buildCandidate({
      from: headers.from,
      subject: headers.subject,
      date: msgDate,
      text: bodies.text,
      html: bodies.html,
      directory: context?.directory,
      overrides: context?.overrides,
    });

    if (cand) candidates.push(cand);
  }

  return {
    candidates,
    stats: { scanned, matched: candidates.length },
    nextCursor: pageToken,
  };
}
