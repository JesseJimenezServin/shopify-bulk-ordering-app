import type { ActionFunctionArgs } from "@vercel/remix";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
    const { payload, topic, shop } = await authenticate.webhook(request);
    console.log(`Received ${topic} webhook for ${shop}`);

    const current = payload.current as string[];

    // Update every stored session for this shop, not just the one tied to
    // whichever request triggered the webhook. Session.isActive()/isScopeChanged()
    // (used internally by authenticate.admin's token-exchange strategy) compares
    // this field against the app's configured scopes to decide whether a stored
    // token is stale and a fresh token exchange is required — if this drifts,
    // requests start failing with 401 instead of silently re-authenticating.
    await db.session.updateMany({
        where: { shop },
        data: { scope: current.toString() },
    });

    return new Response();
};
