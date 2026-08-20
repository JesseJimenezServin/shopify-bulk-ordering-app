import { json } from "@vercel/remix";
import { unauthenticated } from "../shopify.server";
import {
  getStaleCleanupEntries,
  removeCleanupEntry,
  resolveExpiredDrops,
  findDropsWithPendingOrderActions,
} from "../lib/redis.server";
import { deleteDropMetafields, setDropStatusMetafield } from "../lib/metafields.server";
import { cancelOrdersForDropWithAdmin, captureOrdersForDropWithAdmin } from "../lib/orders.server";

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

// Runs a cleanup phase in isolation — one phase throwing (a Redis hiccup, an
// unexpected error on a single drop) must never prevent the other phases
// from running. This is exactly what let missing-shop entries in purgeStale
// grind everything to a halt before this fix.
async function safely(name, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error(`NUVUS: cleanup phase "${name}" failed:`, error);
    return [];
  }
}

// Drops that are no longer live (deadline passed, or manually ended) never
// get an order webhook to flip them, so this scan is what actually resolves
// them — to "missed", or self-heals to "reached" if the pool actually hit
// its goal — and starts the 48h grace period for the ones that missed.
//
// Checkout uses manual/deferred payment capture, so every order placed
// against a drop sits authorized-but-uncaptured until the drop resolves.
// When a drop resolves "missed", every associated order's authorization is
// released via orderCancel (refund: false — there's nothing to capture yet,
// so there's nothing to refund). When the count>=goal self-heal instead
// resolves a drop to "reached" (the order webhook's metafield/capture step
// never ran because its Redis increment succeeded but something after it
// failed), this captures payment the same way the webhook normally would.
async function resolveDropOutcomes() {
  const resolved = await resolveExpiredDrops();
  const results = [];

  for (const { prefix, shop, productGid, status, orderIds } of resolved) {
    if (!shop) {
      results.push({ prefix, productGid, status, orderIds, metafieldUpdated: false });
      continue;
    }

    let admin;
    try {
      ({ admin } = await unauthenticated.admin(shop));
    } catch (error) {
      results.push({
        prefix,
        productGid,
        status,
        orderIds,
        metafieldUpdated: false,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    let metafieldUpdated = false;
    let metafieldError;
    try {
      await setDropStatusMetafield(admin, productGid, status);
      metafieldUpdated = true;
    } catch (error) {
      metafieldError = error instanceof Error ? error.message : String(error);
    }

    let canceledOrders = [];
    let capturedOrders = [];
    try {
      if (status === "missed" && orderIds.length) {
        canceledOrders = await cancelOrdersForDropWithAdmin(admin, prefix);
      } else if (status === "reached" && orderIds.length) {
        capturedOrders = await captureOrdersForDropWithAdmin(admin, prefix);
      }
    } catch (error) {
      console.error(`NUVUS: order actions failed for drop ${prefix}:`, error);
    }

    results.push({
      prefix,
      productGid,
      status,
      orderIds,
      metafieldUpdated,
      ...(metafieldError ? { metafieldError } : {}),
      ...(status === "missed" ? { canceledOrders } : {}),
      ...(status === "reached" ? { capturedOrders } : {}),
    });
  }

  return results;
}

// Drops that already resolved to "missed"/"reached" but still have entries
// left in order_ids are ones where a previous cancel/capture attempt failed
// for at least one order — this retries just those remaining orders, without
// touching status or metafields (already correct, no need to redo them).
async function retryPendingOrderActions() {
  const pending = await findDropsWithPendingOrderActions();
  const results = [];

  for (const { prefix, status, shop, productGid, orderIds } of pending) {
    if (!shop) {
      results.push({ prefix, productGid, status, orderIds, message: "missing shop, cannot retry" });
      continue;
    }

    let admin;
    try {
      ({ admin } = await unauthenticated.admin(shop));
    } catch (error) {
      results.push({
        prefix,
        productGid,
        status,
        orderIds,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (status === "missed") {
      const canceledOrders = await cancelOrdersForDropWithAdmin(admin, prefix);
      results.push({ prefix, productGid, status, canceledOrders });
    } else {
      const capturedOrders = await captureOrdersForDropWithAdmin(admin, prefix);
      results.push({ prefix, productGid, status, capturedOrders });
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

    if (!shop) {
      // Can only happen for drops created before `shop` started being stored
      // in Redis config. There's no admin API call we can make without a shop
      // domain, and retrying forever just wastes every future cron run for
      // no progress — drop the entry. The Redis keys expire independently of
      // this queue, so the drop itself still disappears from the dashboard;
      // only its now-orphaned product metafields won't get cleaned up.
      await removeCleanupEntry(member);
      results.push({ productGid, status: "skipped", message: "missing shop, cannot purge metafields" });
      continue;
    }

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
  const resolved = await safely("resolveDropOutcomes", resolveDropOutcomes);
  const retried = await safely("retryPendingOrderActions", retryPendingOrderActions);
  const purged = await safely("purgeStale", purgeStale);

  return {
    resolved: resolved.length,
    resolvedDrops: resolved,
    retried: retried.length,
    retriedDrops: retried,
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
