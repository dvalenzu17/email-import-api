/**
 * Shared middleware and config for scan routes (Gmail + IMAP).
 * Eliminates duplication between scanRoutes.js and imapScanRoutes.js.
 */

import jwt from "jsonwebtoken";
import { getUserScanCount } from "../db/index.js";
import { FREE_SCAN_LIMIT } from "../config.js";

/**
 * Rate limit config for scan endpoints.
 * Reused by both POST /scan and POST /scan/imap.
 */
export const SCAN_RATE_LIMIT = {
  max: 3,
  timeWindow: "15 minutes",
  statusCode: 429,
  keyGenerator: (req) => {
    try {
      const token = req.headers.authorization?.split(" ")[1];
      const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
      return decoded?.sub ?? req.ip;
    } catch {
      return req.ip;
    }
  },
  errorResponseBuilder: () => ({
    statusCode: 429,
    error: "rate_limited",
    message: "Too many scans. Please wait 15 minutes.",
  }),
};

// Tracks in-flight scans per user to prevent TOCTOU race in the free-tier
// limit check. Without this, two concurrent requests could both read
// scanCount=4, both pass the <5 check, and the user ends up with 6 scans.
const _inFlightScans = new Map();

/**
 * Checks the free-tier scan limit. Returns a 403 reply if exceeded.
 * Returns true if the scan should proceed, false if the reply was already sent.
 *
 * Callers MUST call releaseScanSlot(userId) when the scan completes or fails.
 */
export async function enforceScanLimit(req, reply) {
  const isPro = req.headers["x-pro-status"] === "true";
  if (isPro) return true;

  const userId = req.userId;
  const inFlight = _inFlightScans.get(userId) ?? 0;

  try {
    const scanCount = await getUserScanCount(userId);
    const effectiveCount = scanCount + inFlight;
    if (effectiveCount >= FREE_SCAN_LIMIT) {
      reply.code(403).send({
        error: "scan_limit_reached",
        message: `Free plan allows ${FREE_SCAN_LIMIT} scans. Upgrade to Pro for unlimited scans.`,
        limit: FREE_SCAN_LIMIT,
        used: effectiveCount,
      });
      return false;
    }
    _inFlightScans.set(userId, inFlight + 1);
    reply.header("X-Scan-Remaining", FREE_SCAN_LIMIT - effectiveCount - 1);
  } catch (err) {
    req.log.error({ err }, "scan_limit_check_error");
    // Non-fatal: allow the scan if the limit check itself fails
  }
  return true;
}

/**
 * Releases an in-flight scan slot for the given user.
 * Must be called in a finally block after enforceScanLimit returns true.
 */
export function releaseScanSlot(userId) {
  const count = _inFlightScans.get(userId) ?? 0;
  if (count <= 1) _inFlightScans.delete(userId);
  else _inFlightScans.set(userId, count - 1);
}
