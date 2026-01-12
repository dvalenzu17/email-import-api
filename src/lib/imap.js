import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { buildCandidate } from "./detect.js";

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

export async function scanImap({ provider, imap, auth, options, context }) {
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    auth: { user: auth.user, pass: auth.pass },
    logger: false,
  });

  const since = new Date(Date.now() - options.daysBack * 24 * 3600 * 1000);
  const startAfterUid = decodeCursor(options.cursor);

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      await client.mailboxOpen("INBOX", { readOnly: true });

      let uids = await client.search({ since });
      uids.sort((a, b) => a - b);
      if (startAfterUid) uids = uids.filter((u) => u > startAfterUid);

      const candidates = [];
      let scanned = 0;
      let lastProcessedUid;

      for (const uid of uids) {
        if (scanned >= options.maxMessages) break;
        if (candidates.length >= options.maxCandidates) break;

        const header = await client.fetchOne(uid, { envelope: true, internalDate: true, uid: true });
        const subject = header.envelope?.subject ?? "";
        const from = header.envelope?.from?.[0]
          ? formatAddress(header.envelope.from[0].name, header.envelope.from[0].address)
          : "";

        if (!looksPromising(subject, from)) {
          scanned += 1;
          lastProcessedUid = uid;
          continue;
        }

        const full = await client.fetchOne(uid, { envelope: true, internalDate: true, uid: true, source: true });
        const msgDate = full.internalDate instanceof Date ? full.internalDate : new Date();

        const parsed = await simpleParser(full.source);

        const candidate = buildCandidate({
          from: from || parsed.from?.text || "",
          subject: subject || parsed.subject || "",
          date: msgDate,
          text: parsed.text,
          html: typeof parsed.html === "string" ? parsed.html : null,
          directory: context?.directory,
          overrides: context?.overrides,
          knownSubs: context?.knownSubs,
        });

        scanned += 1;
        lastProcessedUid = uid;

        if (candidate) candidates.push(candidate);
      }

      const nextCursor =
        lastProcessedUid && lastProcessedUid < (uids.at(-1) ?? 0) ? encodeCursor(lastProcessedUid) : undefined;

      return {
        candidates,
        stats: { scanned, matched: candidates.length },
        nextCursor,
      };
    } finally {
      lock.release();
    }
  } finally {
    await safeLogout(client);
  }
}

function looksPromising(subject, from) {
  const s = `${subject} ${from}`.toLowerCase();
  return /receipt|invoice|payment|charged|subscription|renewal|trial|membership|billing|plan|welcome|confirmation|valid until/.test(s);
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
    } catch {
      // ignore
    }
  }
}
