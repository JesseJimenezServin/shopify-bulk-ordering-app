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

// Resolves every drop that's still marked "open" but is no longer actually
// live — either its deadline has passed, or a merchant manually ended it
// (the dashboard's "End" action soft-deletes it but leaves :status as "open").
// Self-heals a count/goal mismatch: if the pool actually hit its goal (e.g. an
// order webhook's Redis increment succeeded but its metafield write failed),
// this resolves to "reached" instead of incorrectly reporting a missed drop.
export async function resolveExpiredDrops() {
  const statusKeys = await scanDropStatusKeys();
  const resolved = [];

  for (const statusKey of statusKeys) {
    const prefix = statusKey.replace(/:status$/, "");
    const [status, deadline, count, goal, config] = await Promise.all([
      redis.get(`${prefix}:status`),
      redis.get(`${prefix}:deadline`),
      redis.get(`${prefix}:count`),
      redis.get(`${prefix}:goal`),
      redis.hgetall(`${prefix}:config`),
    ]);

    if (status !== "open") continue;

    const deadlinePassed = Boolean(deadline) && Date.now() >= new Date(deadline).getTime();
    const manuallyEnded = Boolean(config?.softDeletedAt);
    if (!deadlinePassed && !manuallyEnded) continue;

    const [, , productId, variantId] = prefix.split(":");
    const productGid = `gid://shopify/Product/${productId}`;
    const shop = config?.shop;
    const goalNum = Number(goal);
    const countNum = Number(count) || 0;
    const resolvedStatus = goalNum && countNum >= goalNum ? "reached" : "missed";

    await redis.set(`${prefix}:status`, resolvedStatus);
    if (!manuallyEnded) {
      await softDeleteDrop(prefix, { shop, productGid });
    }

    const orderIds = await getDropOrderIds(prefix);

    resolved.push({
      prefix,
      productId,
      variantId,
      shop,
      productGid,
      status: resolvedStatus,
      count: countNum,
      goal: goalNum,
      orderIds,
    });
  }

  return resolved;
}

export async function trackDropOrder(prefix, orderId) {
  if (!orderId) return;
  await redis.sadd(`${prefix}:order_ids`, orderId);
}

export async function untrackDropOrder(prefix, orderId) {
  if (!orderId) return;
  await redis.srem(`${prefix}:order_ids`, orderId);
}

export async function getDropOrderIds(prefix) {
  return redis.smembers(`${prefix}:order_ids`);
}

// Drops already resolved (missed/reached) can still have orders whose
// cancel/capture attempt failed on a previous run — cancelOrdersForDropWithAdmin
// and captureOrdersForDropWithAdmin untrack each order as soon as it succeeds,
// so whatever's left in order_ids is exactly what still needs retrying. This
// finds those drops without re-running status/metafield resolution, which
// already succeeded.
export async function findDropsWithPendingOrderActions() {
  const statusKeys = await scanDropStatusKeys();
  const pending = [];

  for (const statusKey of statusKeys) {
    const prefix = statusKey.replace(/:status$/, "");
    const status = await redis.get(`${prefix}:status`);
    if (status !== "missed" && status !== "reached") continue;

    const orderIds = await getDropOrderIds(prefix);
    if (!orderIds.length) continue;

    const config = await redis.hgetall(`${prefix}:config`);
    const [, , productId] = prefix.split(":");

    pending.push({
      prefix,
      status,
      shop: config?.shop,
      productGid: `gid://shopify/Product/${productId}`,
      orderIds,
    });
  }

  return pending;
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
