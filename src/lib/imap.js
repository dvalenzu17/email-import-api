import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { buildCandidate } from "./detect.js";

export async function verifyImapConnection({ imap, auth }) {
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    auth: { user: auth.user, pass: auth.pass },
    logger: false,
  });

  await client.connect();
  try {
    await client.getMailboxLock("INBOX");
    return { ok: true };
  } finally {
    try {
      await client.logout();
    } catch {}
  }
}

function encodeCursor(uid) {
  if (!uid) return null;
  return Buffer.from(String(uid)).toString("base64");
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const s = Buffer.from(String(cursor), "base64").toString("utf8");
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
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
        scanned++;
        lastProcessedUid = uid;

        // Fetch full source only when needed (keeps it fast + cheap)
        const msg = await client.fetchOne(uid, { envelope: true, source: true });
        if (!msg?.source) continue;

        const parsed = await simpleParser(msg.source);
        const from = parsed.from?.text || msg.envelope?.from?.[0]?.address || "";
        const subject = parsed.subject || "";
        const msgDate = parsed.date || new Date();

        const candidate = buildCandidate({
          from: from || parsed.from?.text || "",
          subject: subject || parsed.subject || "",
          date: msgDate,
          text: parsed.text,
          html: typeof parsed.html === "string" ? parsed.html : null,
          directory: context?.directory,
          overrides: context?.overrides,
        });

        if (candidate) candidates.push(candidate);
      }

      const stats = {
        provider,
        scanned,
        candidates: candidates.length,
      };

      return {
        stats,
        candidates,
        nextCursor: lastProcessedUid ? encodeCursor(lastProcessedUid) : null,
      };
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {}
  }
}
