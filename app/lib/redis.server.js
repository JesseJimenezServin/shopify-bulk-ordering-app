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
  const cutoff = Date.now() - GRACE_PERIOD_SECONDS;
  return redis.zrange(CLEANUP_QUEUE_KEY, 0, cutoff, { byScore: true });
}

export async function removeCleanupEntry(member) {
  await redis.zrem(CLEANUP_QUEUE_KEY, member);
}
