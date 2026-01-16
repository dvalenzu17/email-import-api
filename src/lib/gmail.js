// src/lib/gmail.js
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

// Less fragile: grab recent mail, let detect.js filter
function buildQuery(daysBack) {
  // exclude chats; keep everything else
  return `newer_than:${daysBack}d -in:chats`;
}

function normalizeMerchantKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function groupCandidates(cands = []) {
  const groups = new Map();

  for (const c of cands) {
    const merchantKey = normalizeMerchantKey(c.merchant);
    const cadenceKey = String(c.cadenceGuess || "").trim().toLowerCase();
    const amountKey =
      typeof c.amount === "number" && Number.isFinite(c.amount)
        ? String(Math.round(c.amount * 100))
        : "";

    // Group by merchant primarily; cadence/amount help avoid merging unrelated stuff
    const key = `${merchantKey}|${cadenceKey}|${amountKey}`;

    const prev = groups.get(key);
    if (!prev) {
      groups.set(key, {
        ...c,
        occurrences: 1,
        evidenceSamples: [c.evidence].filter(Boolean),
        confidenceMax: c.confidence ?? 0,
      });
    } else {
      prev.occurrences += 1;
      prev.confidenceMax = Math.max(prev.confidenceMax, c.confidence ?? 0);

      // keep best "representative" candidate (highest confidence)
      if ((c.confidence ?? 0) > (prev.confidence ?? 0)) {
        groups.set(key, {
          ...prev,
          ...c,
          occurrences: prev.occurrences,
          evidenceSamples: prev.evidenceSamples,
          confidenceMax: prev.confidenceMax,
        });
      }

      if (c.evidence && prev.evidenceSamples.length < 4) {
        prev.evidenceSamples.push(c.evidence);
      }
    }
  }

  return Array.from(groups.values()).sort((a, b) => (b.confidenceMax ?? 0) - (a.confidenceMax ?? 0));
}

export async function scanGmail({ accessToken, options, context }) {
  const q = buildQuery(options.daysBack);
  let pageToken = options.cursor;

  const ids = [];
  let pages = 0;

  // list up to maxMessages message IDs (paginated)
  while (ids.length < options.maxMessages) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("q", q);

    // Gmail maxResults max is 500 per request
    url.searchParams.set("maxResults", String(Math.min(500, options.maxMessages - ids.length)));
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
    pages += 1;

    if (!pageToken) break;
  }

  const rawCandidates = [];
  let scanned = 0;

  for (const id of ids) {
    if (scanned >= options.maxMessages) break;
    if (rawCandidates.length >= options.maxCandidates) break;

    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

    scanned += 1;
    if (!res.ok) continue;

    const msg = await res.json();

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
      knownSubs: context?.knownSubs,
    });

    if (cand) rawCandidates.push(cand);
  }

  const candidates = groupCandidates(rawCandidates).slice(0, options.maxCandidates);

  return {
    candidates,
    stats: {
      listed: ids.length,
      pages,
      scanned,
      matchedRaw: rawCandidates.length,
      matchedDeduped: candidates.length,
      daysBack: options.daysBack,
      maxMessages: options.maxMessages,
    },
    nextCursor: pageToken,
  };
}
