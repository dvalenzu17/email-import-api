/**
 * Redis-backed deduplication cache for Gmail message IDs.
 *
 * Prevents re-fetching and re-parsing the same email on subsequent scans.
 * Falls back to a no-op (process everything) when Redis is unavailable.
 *
 * Key schema: processed_msgs:{userId}  →  Redis Set of message IDs
 * TTL: 30 days (aligned with max daysBack window)
 */

import Redis from "ioredis";

const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

let _redis = null;

function getRedis() {
  if (_redis) return _redis;
  if (!process.env.REDIS_URL) return null;
  _redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  _redis.on("error", () => {
    // Silence Redis errors — cache miss is acceptable, not fatal.
    _redis = null;
  });
  return _redis;
}

/**
 * Filters out message IDs that have already been processed for this user.
 * Returns only the IDs that are new and need fetching.
 */
export async function filterUnprocessedIds(userId, messageIds) {
  if (!messageIds.length) return [];
  const r = getRedis();
  if (!r) return messageIds;

  try {
    const key = `processed_msgs:${userId}`;
    const pipeline = r.pipeline();
    for (const id of messageIds) pipeline.sismember(key, id);
    const results = await pipeline.exec();
    return messageIds.filter((_, i) => results[i]?.[1] === 0);
  } catch {
    return messageIds; // Redis failure → process all (safe degradation)
  }
}

/**
 * Marks message IDs as processed for this user.
 * Refreshes the TTL on every write.
 */
export async function markProcessedIds(userId, messageIds) {
  if (!messageIds.length) return;
  const r = getRedis();
  if (!r) return;

  try {
    const key = `processed_msgs:${userId}`;
    await r.sadd(key, ...messageIds);
    await r.expire(key, TTL_SECONDS);
  } catch {
    // Non-fatal — worst case we re-process a message on the next scan.
  }
}
