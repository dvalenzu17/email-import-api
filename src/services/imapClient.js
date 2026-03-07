import { ImapFlow } from "imapflow";
import { cleanEmailHtml, extractAmount } from "../gmailClient.js";

const IMAP_CONFIGS = {
  yahoo:   { host: "imap.mail.yahoo.com",      port: 993, secure: true },
  outlook: { host: "outlook.office365.com",    port: 993, secure: true },
  icloud:  { host: "imap.mail.me.com",         port: 993, secure: true },
};

const SEARCH_KEYWORDS = [
  "subscription", "renewal", "receipt", "invoice",
  "billing", "payment", "charged", "membership",
];

export function getImapConfig(provider) {
  const config = IMAP_CONFIGS[provider];
  if (!config) throw new Error(`unsupported_provider: ${provider}`);
  return config;
}

export async function verifyImapCredentials({ provider, user, pass }) {
  const { host, port, secure } = getImapConfig(provider);

  const client = new ImapFlow({
    host, port, secure,
    auth: { user, pass },
    logger: false,
    connectionTimeout: 10000,
  });

  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (err) {
    throw new Error(normaliseImapError(err));
  }
}

export async function scanImapInbox({ provider, user, pass, daysBack = 365 }) {
  const { host, port, secure } = getImapConfig(provider);

  const client = new ImapFlow({
    host, port, secure,
    auth: { user, pass },
    logger: false,
    connectionTimeout: 15000,
  });

  await client.connect();

  const charges = [];
  let scannedCount = 0;

  try {
    const mailbox = await client.mailboxOpen("INBOX");

    const since = new Date();
    since.setDate(since.getDate() - daysBack);

    // Use UID search explicitly
    const allUids = await client.search({ since }, { uid: true });
    if (!allUids.length) return { charges, scannedCount };

    const uids = allUids.slice(-500);

    // Pass 1 — envelopes only, UID mode
    const relevant = [];

    for await (const msg of client.fetch(
      uids,
      { envelope: true, uid: true },
      { uid: true }
    )) {
      scannedCount++;
      const subject = msg.envelope?.subject?.toLowerCase() ?? "";

      const looksRelevant =
        subject.includes("receipt") ||
        subject.includes("invoice") ||
        subject.includes("subscription") ||
        subject.includes("renewal") ||
        subject.includes("payment") ||
        subject.includes("billing") ||
        subject.includes("charged") ||
        subject.includes("membership") ||
        subject.includes("your plan") ||
        subject.includes("order confirmation");

      if (looksRelevant) {
        relevant.push({ uid: msg.uid, envelope: msg.envelope });
      }
    }

    if (!relevant.length) return { charges, scannedCount };

    const relevantUids = relevant.map((r) => r.uid);
    const envelopeMap = Object.fromEntries(
      relevant.map((r) => [r.uid, r.envelope])
    );

    // Pass 2 — full source, UID mode
    for await (const msg of client.fetch(
      relevantUids,
      { source: true, uid: true },
      { uid: true }
    )) {
      try {
        const raw = msg.source?.toString("utf8") ?? "";
        if (!raw) continue;

        const text = cleanEmailHtml(raw);
        if (!text || text.length < 30) continue;

        if (
          text.includes("trip with uber") ||
          text.includes("thanks for riding") ||
          text.includes("order with uber eats")
        ) continue;

        const amount = extractAmount(text);
        if (!amount) continue;

        const envelope = envelopeMap[msg.uid] ?? msg.envelope;
        const from = envelope?.from?.[0];
        const merchant = normaliseMerchant(from);
        const date = envelope?.date ? new Date(envelope.date) : new Date();

        let intentScore = 0;
        if (text.includes("subscription")) intentScore += 1;
        if (text.includes("membership")) intentScore += 1;
        if (text.includes("automatically renew")) intentScore += 2;
        if (text.includes("renews on")) intentScore += 2;
        if (text.includes("/month") || text.includes("per month")) intentScore += 2;
        if (text.includes("/year") || text.includes("per year")) intentScore += 2;
        if (text.includes("valid until")) intentScore += 2;
        if (text.includes("plan")) intentScore += 1;

        charges.push({
          merchant,
          amount,
          date,
          subscriptionIntent: intentScore >= 3,
        });
      } catch {
        continue;
      }
    }
  } finally {
    await client.logout();
  }

  return { charges, scannedCount };
}
function normaliseMerchant(from) {
  if (!from) return "unknown";

  const address = from.address ?? "";
  const name = from.name ?? "";

  const domain = address.split("@")[1]?.toLowerCase() ?? "";
  const root = domain.split(".").slice(-2, -1)[0] ?? domain;

  if (root.includes("uber")) {
    return name.toLowerCase().includes("uber one") ? "uber one" : "uber";
  }

  const knownMap = {
    netflix: "netflix",
    openai: "openai",
    spotify: "spotify",
    apple: "apple",
    amazon: "amazon",
    google: "google",
    microsoft: "microsoft",
    adobe: "adobe",
    dropbox: "dropbox",
    slack: "slack",
  };

  return knownMap[root] ?? root;
}

function normaliseImapError(err) {
  const msg = err.message?.toLowerCase() ?? "";

  if (msg.includes("invalid credentials") || msg.includes("authentication failed")) {
    return "invalid_credentials";
  }
  if (msg.includes("application-specific password")) {
    return "app_password_required";
  }
  if (msg.includes("too many")) {
    return "rate_limited";
  }
  if (msg.includes("connect") || msg.includes("timeout")) {
    return "connection_failed";
  }

  return err.message ?? "imap_error";
}