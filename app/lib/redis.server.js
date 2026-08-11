import { Redis } from "@upstash/redis";

export const GRACE_PERIOD_SECONDS = 172800;
export const CLEANUP_QUEUE_KEY = "nuvus:drop:cleanup:queue";

export const DROP_KEY_SUFFIXES = [
  "status",
  "count",
  "goal",
  "deadline",
  "config",
  "order_ids",
  "recent",
];

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export function keyPrefix(productId, variantId) {
  return `nuvus:drop:${productId}:${variantId}`;
}

export async function scanDropStatusKeys() {
  let cursor = "0";
  const statusKeys = [];
  do {
    const [next, batch] = await redis.scan(cursor, { match: "nuvus:drop:*:status", count: 100 });
    cursor = next;
    statusKeys.push(...batch);
  } while (cursor !== "0");
  return statusKeys;
}

// Scans all open drops and flips any whose deadline has passed without hitting
// their goal to "missed", queuing them for the same 48h grace + purge flow as
// a manual end/delete.
export async function resolveExpiredDrops() {
  const statusKeys = await scanDropStatusKeys();
  const resolved = [];

  for (const statusKey of statusKeys) {
    const prefix = statusKey.replace(/:status$/, "");
    const [status, deadline, config] = await Promise.all([
      redis.get(`${prefix}:status`),
      redis.get(`${prefix}:deadline`),
      redis.hgetall(`${prefix}:config`),
    ]);

    if (status !== "open" || !deadline) continue;
    if (Date.now() < new Date(deadline).getTime()) continue;

    const [, , productId] = prefix.split(":");
    const productGid = `gid://shopify/Product/${productId}`;
    const shop = config?.shop;

    await redis.set(`${prefix}:status`, "missed");
    await softDeleteDrop(prefix, { shop, productGid });

    resolved.push({ prefix, shop, productGid });
  }

  return resolved;
}

export async function softDeleteDrop(prefix, { shop, productGid }) {
  const softDeletedAt = Date.now();

  await redis.hset(`${prefix}:config`, {
    softDeletedAt,
    isActive: false,
  });

  await Promise.all(
    DROP_KEY_SUFFIXES.map((suffix) =>
      redis.expire(`${prefix}:${suffix}`, GRACE_PERIOD_SECONDS),
    ),
  );

  await redis.zadd(CLEANUP_QUEUE_KEY, {
    score: softDeletedAt,
    member: JSON.stringify({ shop, productGid }),
  });
}

export async function getStaleCleanupEntries() {
  // Scores are stored as Date.now() (ms), so the grace period must be converted
  // from seconds to ms too — otherwise this cutoff is off by a factor of 1000.
  const cutoff = Date.now() - GRACE_PERIOD_SECONDS * 1000;
  return redis.zrange(CLEANUP_QUEUE_KEY, 0, cutoff, { byScore: true });
}

export async function removeCleanupEntry(member) {
  await redis.zrem(CLEANUP_QUEUE_KEY, member);
}
