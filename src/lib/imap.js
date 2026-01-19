import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { buildCandidate, aggregateCandidates } from "./detect.js";
import { getMerchantDirectoryCached, getUserOverrides } from "./merchantData.js";

export async function verifyImapConnection({ provider, imap, auth }) {
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    auth: { user: auth.user, pass: auth.pass },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      await client.mailboxOpen("INBOX", { readOnly: true });
      const caps = Array.from(client.serverCapabilities ?? []);
      return { mailbox: client.mailbox?.path ?? "INBOX", capabilities: caps };
    } finally {
      lock.release();
    }
  } finally {
    await safeLogout(client);
  }
}

export async function scanImap({ provider, imap, auth, options, userId }) {
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    auth: { user: auth.user, pass: auth.pass },
    logger: false,
  });

  const since = new Date(Date.now() - options.daysBack * 24 * 3600 * 1000);
  const startAfterUid = decodeCursor(options.cursor);

  const directory = await getMerchantDirectoryCached();
  const overrides = userId ? await getUserOverrides(userId) : [];

  const statsRef = { nullReasons: Object.create(null) };

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      await client.mailboxOpen("INBOX", { readOnly: true });

      let uids = await client.search({ since });
      uids.sort((a, b) => a - b);
      if (startAfterUid) uids = uids.filter((u) => u > startAfterUid);

      const raw = [];
      let scanned = 0;
      let fullFetched = 0;
      let lastProcessedUid;

      for (const uid of uids) {
        if (scanned >= options.maxMessages) break;

        const header = await client.fetchOne(uid, { envelope: true, internalDate: true, uid: true });
        const subject = header.envelope?.subject ?? "";
        const from = header.envelope?.from?.[0]
          ? formatAddress(header.envelope.from[0].name, header.envelope.from[0].address)
          : "";

        // Quick skip for obvious marketing (cheap pre-filter)
        const looksMarketing = /(promo|newsletter|offer|discount|sale|recommended|update)/i.test(`${subject} ${from}`);
        if (looksMarketing) {
          scanned += 1;
          lastProcessedUid = uid;
          statsRef.nullReasons.marketingPrefilter = (statsRef.nullReasons.marketingPrefilter || 0) + 1;
          continue;
        }

        const full = await client.fetchOne(uid, { envelope: true, internalDate: true, uid: true, source: true });
        fullFetched += 1;

        const msgDate = full.internalDate instanceof Date ? full.internalDate : new Date();
        const parsed = await simpleParser(full.source);

        const headerMap = {};
        for (const [k, v] of parsed.headers || []) headerMap[String(k).toLowerCase()] = String(v || "");

        const candidate = buildCandidate(
          {
            from: from || parsed.from?.text || "",
            replyTo: parsed.replyTo?.text || "",
            returnPath: headerMap["return-path"] || "",
            subject: subject || parsed.subject || "",
            snippet: "",
            text: parsed.text || "",
            html: typeof parsed.html === "string" ? parsed.html : "",
            headerMap,
            dateMs: msgDate.getTime(),
          },
          { directory, overrides, stats: statsRef }
        );

        scanned += 1;
        lastProcessedUid = uid;

        if (candidate) raw.push(candidate);
      }

      const candidates = aggregateCandidates(raw, options.maxCandidates || 60);

      const nextCursor =
        lastProcessedUid && lastProcessedUid < (uids.at(-1) ?? 0) ? encodeCursor(lastProcessedUid) : undefined;

      return {
        candidates,
        stats: {
          scanned,
          fullFetched,
          rawMatched: raw.length,
          matched: candidates.length,
          nullReasons: statsRef.nullReasons,
        },
        nextCursor,
      };
    } finally {
      lock.release();
    }
  } finally {
    await safeLogout(client);
  }
}

function formatAddress(name, address) {
  const n = (name ?? "").trim();
  const a = (address ?? "").trim();
  if (n && a) return `${n} <${a}>`;
  return n || a;
}

function encodeCursor(uid) {
  const raw = JSON.stringify({ uid });
  return Buffer.from(raw).toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) return undefined;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const data = JSON.parse(raw);
    const uid = Number(data.uid);
    return Number.isFinite(uid) ? uid : undefined;
  } catch {
    return undefined;
  }
}

async function safeLogout(client) {
  try {
    await client.logout();
  } catch {
    try {
      await client.close();
    } catch {}
  }
}
