/**
 * Internal admin endpoints — protected by ADMIN_SECRET header.
 * NOT user-scoped. Never exposed to end users.
 */

import { getAdminUsersData } from "../db/index.js";
import { createClient } from "@supabase/supabase-js";

function verifyAdminSecret(req, reply) {
  const secret = req.headers["x-admin-secret"];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  return true;
}

// Fetch emails from Supabase auth.users for a list of UUIDs.
// Returns a map of { userId -> email }. Falls back to empty map if
// SUPABASE_SERVICE_ROLE_KEY is not set or the query fails.
async function lookupUserEmails(userIds) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_URL) return {};
  try {
    const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
    if (error || !data?.users) return {};
    const idSet = new Set(userIds);
    return Object.fromEntries(
      data.users.filter((u) => idSet.has(u.id)).map((u) => [u.id, u.email])
    );
  } catch {
    return {};
  }
}

export function registerAdminRoutes(server) {
  // GET /admin/users
  // Returns all users with their subscriptions and last scan metadata.
  server.get("/admin/users", async (req, reply) => {
    if (!verifyAdminSecret(req, reply)) return;

    const users = await getAdminUsersData();
    const emailMap = await lookupUserEmails(users.map((u) => u.userId));

    const result = users.map((u) => ({
      userId: u.userId,
      email: emailMap[u.userId] ?? null,
      subscriptionCount: u.subscriptions.length,
      activeCount: u.subscriptions.filter((s) => s.is_active).length,
      lastScan: u.lastScan
        ? {
            scannedMessages: u.lastScan.scanned_messages,
            detectedCharges: u.lastScan.detected_charges,
            at: u.lastScan.last_scan_at,
          }
        : null,
      subscriptions: u.subscriptions.map((s) => ({
        id: s.id,
        merchant: s.merchant,
        amount: Number(s.renewal_amount),
        currency: s.currency,
        interval: s.billing_interval,
        confidence: Number(s.confidence),
        isActive: s.is_active,
        isSuggested: s.is_suggested,
        userStatus: s.user_status ?? null,
        source: s.source,
        lastSeenAt: s.last_seen_at,
        detectedAt: s.created_at,
      })),
    }));

    return { users: result, total: result.length };
  });
}
