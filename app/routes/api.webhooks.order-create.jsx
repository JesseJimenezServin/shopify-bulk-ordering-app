import { authenticate } from "../shopify.server";
import { redis, keyPrefix } from "../lib/redis.server";
import { setDropStatusMetafield } from "../lib/metafields.server";

export async function action({ request }) {
  const { shop, topic, admin, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];

  // Group by drop first and sum quantity across every matching line item, so
  // an order with N units toward one drop — whether that's one line item with
  // quantity N or several line items for the same product/variant — credits
  // the pool exactly N, with a single goal check against the combined total.
  const unitsByDrop = new Map();
  for (const item of lineItems) {
    const productId = item?.product_id;
    const variantId = item?.variant_id;
    const quantity = Number(item?.quantity) || 0;
    if (!productId || !variantId || quantity <= 0) continue;

    const prefix = keyPrefix(productId, variantId);
    const existing = unitsByDrop.get(prefix);
    unitsByDrop.set(prefix, {
      productId,
      quantity: (existing?.quantity || 0) + quantity,
    });
  }

  for (const [prefix, { productId, quantity }] of unitsByDrop) {
    const [status, deadline] = await Promise.all([
      redis.get(`${prefix}:status`),
      redis.get(`${prefix}:deadline`),
    ]);
    if (status !== "open") continue;
    if (deadline && Date.now() > new Date(deadline).getTime()) continue;

    const goal = Number(await redis.get(`${prefix}:goal`));
    const newCount = await redis.incrby(`${prefix}:count`, quantity);

    if (goal && newCount >= goal) {
      await redis.set(`${prefix}:status`, "reached");

      if (admin) {
        await setDropStatusMetafield(admin, `gid://shopify/Product/${productId}`, "reached");
      }
    }
  }

  return new Response();
}
