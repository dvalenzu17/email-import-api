/**
 * Internal admin endpoints — protected by ADMIN_SECRET header.
 * NOT user-scoped. Never exposed to end users.
 */

import { pool, getAdminUsersData, aggregateMerchantConfirmations } from "../db/index.js"; // TASK 4: alias rebuild uses confirmation aggregates + pool for alias upserts
import { createClient } from "@supabase/supabase-js";
import { runBackgroundScanCycle } from "../services/backgroundScanner.js";

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

    const limit  = Math.min(Number(req.query.limit)  || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const users = await getAdminUsersData({ limit, offset });
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

  // GET /admin/stats
  // Aggregate, anonymous numbers for marketing/social-proof use: user count,
  // detected subscriptions, averages, and most-detected merchants. No PII.
  server.get("/admin/stats", async (req, reply) => {
    if (!verifyAdminSecret(req, reply)) return;

    const { rows: [agg] } = await pool.query(`
      SELECT
        COUNT(DISTINCT user_id)::int            AS users,
        COUNT(*)::int                           AS subscriptions,
        COUNT(*) FILTER (WHERE is_active)::int  AS active
      FROM subscriptions
    `);

    const { rows: [money] } = await pool.query(`
      SELECT
        COALESCE(ROUND(AVG(per_user), 2), 0) AS avg_monthly,
        COALESCE(ROUND(AVG(cnt), 1), 0)      AS avg_per_user
      FROM (
        SELECT
          user_id,
          SUM(CASE WHEN billing_interval ILIKE 'year%'
                   THEN renewal_amount / 12.0
                   ELSE renewal_amount END) AS per_user,
          COUNT(*) AS cnt
        FROM subscriptions
        WHERE is_active
        GROUP BY user_id
      ) t
    `);

    const { rows: top } = await pool.query(`
      SELECT merchant, COUNT(*)::int AS n
      FROM subscriptions
      GROUP BY merchant
      ORDER BY n DESC
      LIMIT 10
    `);

    return {
      users: agg.users,
      subscriptions: agg.subscriptions,
      active: agg.active,
      avgPerUser: Number(money.avg_per_user),
      avgMonthly: Number(money.avg_monthly),
      topServices: top.map((r) => r.merchant),
      generatedAt: new Date().toISOString(),
    };
  });

  // ── POST /admin/run-background-scan ──────────────────────────────────────
  // Drives one background scan + time-based alert cycle. Lets an external
  // scheduler (Render Cron Job, GitHub Actions, cron-job.org, etc.) run the
  // cron on hosts where the in-process timer can't (e.g. free tiers that sleep
  // when idle). Requires x-admin-secret.
  //
  // Fire-and-forget by default (responds 202 so the caller doesn't time out on
  // a long scan). Pass ?wait=true to await and return the cycle result.
  server.post("/admin/run-background-scan", async (req, reply) => {
    if (!verifyAdminSecret(req, reply)) return;

    const wait = req.query.wait === "true" || req.query.wait === "1";

    if (wait) {
      const result = await runBackgroundScanCycle(req.log);
      return { ok: true, ...result };
    }

    // The cycle has its own overlap guard, so a double-trigger is safe.
    runBackgroundScanCycle(req.log).catch((err) =>
      req.log.error({ err }, "admin_background_scan_error")
    );
    return reply.code(202).send({ ok: true, started: true });
  });

  // ── TASK 4: POST /admin/merchant-aliases/rebuild ─────────────────────────
  // Aggregates merchant_confirmations and promotes high-confidence domain→name
  // mappings into merchant_aliases:
  //   - Domains with ≥3 confirmations not already in aliases → INSERT (boost=0.10)
  //   - Existing aliases → UPDATE confirmation_count; boost += 0.05 per 10 new
  //     confirmations, capped at 0.30
  // Requires x-admin-secret header.
  server.post("/admin/merchant-aliases/rebuild", async (req, reply) => {
    if (!verifyAdminSecret(req, reply)) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const rows = await aggregateMerchantConfirmations();

      const inserted = [];
      const updated  = [];

      for (const row of rows) {
        const confirmedCount = Number(row.confirmed_count);
        if (confirmedCount < 3) continue;

        const domain    = row.merchant_domain;
        const name      = row.canonical_name;

        const existing = await client.query(
          `SELECT id, confidence_boost, confirmation_count FROM merchant_aliases WHERE raw_sender_domain = $1`,
          [domain]
        );

        if (existing.rows.length === 0) {
          await client.query(
            `INSERT INTO merchant_aliases (raw_sender_domain, canonical_name, category, confidence_boost, confirmation_count)
             VALUES ($1, $2, 'other', 0.10, $3)
             ON CONFLICT (raw_sender_domain) DO NOTHING`,
            [domain, name, confirmedCount]
          );
          inserted.push({ domain, canonical_name: name, confirmed_count: confirmedCount });
        } else {
          const ex = existing.rows[0];
          const prevCount   = Number(ex.confirmation_count ?? 0);
          const newCount    = confirmedCount;
          const newConfirms = newCount - prevCount;
          const boostDelta  = Math.floor(newConfirms / 10) * 0.05;
          const newBoost    = Math.min(Number(ex.confidence_boost ?? 0) + boostDelta, 0.30);

          await client.query(
            `UPDATE merchant_aliases
             SET confirmation_count = $1, confidence_boost = $2, updated_at = NOW()
             WHERE raw_sender_domain = $3`,
            [newCount, newBoost, domain]
          );
          updated.push({ domain, canonical_name: name, confirmation_count: newCount, confidence_boost: newBoost });
        }
      }

      await client.query("COMMIT");
      return { ok: true, inserted, updated };
    } catch (err) {
      await client.query("ROLLBACK");
      req.log.error({ err }, "merchant_aliases_rebuild_error");
      return reply.code(500).send({ error: "rebuild_failed" });
    } finally {
      client.release();
    }
  });
}
