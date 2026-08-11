import { json } from "@remix-run/node";
import { unauthenticated } from "../shopify.server";
import { getStaleCleanupEntries, removeCleanupEntry } from "../lib/redis.server";
import { deleteDropMetafields } from "../lib/metafields.server";

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

async function runCleanup() {
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

  return { processed: results.length, results };
}

export async function loader({ request }) {
  authorizeCleanup(request);
  return json(await runCleanup());
}

export async function action({ request }) {
  authorizeCleanup(request);
  return json(await runCleanup());
}
