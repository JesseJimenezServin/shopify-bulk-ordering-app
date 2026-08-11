import { json } from "@remix-run/node";
import { unauthenticated } from "../shopify.server";
import { getStaleCleanupEntries, removeCleanupEntry, resolveExpiredDrops } from "../lib/redis.server";
import { deleteDropMetafields, setDropStatusMetafield } from "../lib/metafields.server";

function authorizeCleanup(request) {
  // Vercel Cron automatically sends `Authorization: Bearer $CRON_SECRET` when an
  // env var named CRON_SECRET is set, so we accept that alongside our own name.
  const secret = process.env.CLEANUP_CRON_SECRET || process.env.CRON_SECRET;
  if (!secret) {
    throw new Response("CLEANUP_CRON_SECRET is not configured", { status: 500 });
  }

  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${secret}`) {
    throw new Response("Unauthorized", { status: 401 });
  }
}

// Drops whose deadline has passed without hitting their goal never get an
// order webhook to flip them, so this scan is what actually resolves them
// to "missed" and starts their 48h grace period.
async function resolveMissed() {
  const expired = await resolveExpiredDrops();
  const results = [];

  for (const { prefix, shop, productGid } of expired) {
    if (!shop) {
      results.push({ prefix, productGid, status: "missed", metafieldUpdated: false });
      continue;
    }

    try {
      const { admin } = await unauthenticated.admin(shop);
      await setDropStatusMetafield(admin, productGid, "missed");
      results.push({ prefix, productGid, status: "missed", metafieldUpdated: true });
    } catch (error) {
      results.push({
        prefix,
        productGid,
        status: "missed",
        metafieldUpdated: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

// Purges metafields for drops (soft-deleted or auto-resolved as missed) whose
// 48h grace period has fully elapsed.
async function purgeStale() {
  const members = await getStaleCleanupEntries();
  const results = [];

  for (const member of members) {
    const { shop, productGid } = JSON.parse(member);

    try {
      const { admin } = await unauthenticated.admin(shop);
      const deleted = await deleteDropMetafields(admin, productGid);
      await removeCleanupEntry(member);
      results.push({ productGid, status: "deleted", deletedCount: deleted.length });
    } catch (error) {
      results.push({
        productGid,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

async function runCleanup() {
  const missed = await resolveMissed();
  const purged = await purgeStale();

  return {
    missedResolved: missed.length,
    missed,
    processed: purged.length,
    results: purged,
  };
}

export async function loader({ request }) {
  authorizeCleanup(request);
  return json(await runCleanup());
}

export async function action({ request }) {
  authorizeCleanup(request);
  return json(await runCleanup());
}
