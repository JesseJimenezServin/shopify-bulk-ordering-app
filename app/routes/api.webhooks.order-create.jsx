import { authenticate } from "../shopify.server";
import { redis, keyPrefix } from "../lib/redis.server";
import { setDropStatusMetafield } from "../lib/metafields.server";

export async function action({ request }) {
  const { shop, topic, admin, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];

  for (const item of lineItems) {
    const productId = item?.product_id;
    const variantId = item?.variant_id;
    if (!productId || !variantId) continue;

    const prefix = keyPrefix(productId, variantId);
    const status = await redis.get(`${prefix}:status`);
    if (status !== "open") continue;

    const goal = Number(await redis.get(`${prefix}:goal`));
    const quantity = Number(item?.quantity) || 1;
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
