import crypto from "node:crypto";

const KEY = Buffer.from(process.env.TOKEN_ENC_KEY_BASE64 ?? "", "base64");
if (KEY.length !== 32) throw new Error("TOKEN_ENC_KEY_BASE64 must be 32 bytes (base64) for AES-256-GCM");

export function encryptString(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // versioned blob: v1.<iv>.<tag>.<ciphertext>
  return `v1.${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
}

export function decryptString(blob) {
  const [v, ivB64, tagB64, ctB64] = String(blob).split(".");
  if (v !== "v1") throw new Error("Unknown token blob version");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
