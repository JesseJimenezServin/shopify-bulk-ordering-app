import { json } from "@remix-run/node";
import { redis, keyPrefix } from "../lib/redis.server";

// Called from the storefront widget (theme/group-drop-widget.liquid), which runs
// on the shop's storefront domain, so the response needs CORS headers.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
};

export async function loader({ request }) {
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");
  const variantId = url.searchParams.get("variantId");

  if (!productId || !variantId) {
    return json(
      { error: "productId and variantId query parameters are required" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const prefix = keyPrefix(productId, variantId);
  const [status, count, goal] = await Promise.all([
    redis.get(`${prefix}:status`),
    redis.get(`${prefix}:count`),
    redis.get(`${prefix}:goal`),
  ]);

  if (!status) {
    return json({ error: "Drop not found" }, { status: 404, headers: CORS_HEADERS });
  }

  return json(
    {
      current: Number(count) || 0,
      goal: goal ? Number(goal) : null,
      status,
    },
    { headers: CORS_HEADERS },
  );
}
