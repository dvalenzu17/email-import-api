import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";

// Use the same env var as the main backend (TOKEN_ENCRYPTION_KEY)
// Accept hex or base64, matching parseEncryptionKey in backend/index.js
function loadKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY || process.env.APP_SECRET || "";
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  try {
    const b64 = Buffer.from(raw, "base64");
    if (b64.length === 32) return b64;
  } catch {}
  try {
    const hex = Buffer.from(raw, "hex");
    if (hex.length === 32) return hex;
  } catch {}
  throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes (base64 or hex)");
}

const KEY = loadKey();

export function encryptCredential(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return [
    iv.toString("hex"),
    tag.toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}

export function decryptCredential(stored) {
  const parts = String(stored).split(":");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("invalid_encrypted_format");
  }
  const [ivHex, tagHex, encryptedHex] = parts;

  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}