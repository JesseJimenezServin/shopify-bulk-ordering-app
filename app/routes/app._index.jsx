import { json } from "@vercel/remix";
import { useLoaderData, useSubmit } from "@remix-run/react";
import { IndexTable, Page, Badge, Button, Text, Thumbnail, InlineStack } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { redis, scanDropStatusKeys, softDeleteDrop } from "../lib/redis.server";
import { deactivateDropMetafields } from "../lib/metafields.server";

const PRODUCT_TITLES_QUERY = `#graphql
  query DropProductTitles($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        featuredImage { url }
      }
    }
  }
`;

async function fetchProductInfoByProductId(admin, productIds) {
  const uniqueIds = [...new Set(productIds)];
  const productInfoById = new Map();
  if (!uniqueIds.length) return productInfoById;

  const gids = uniqueIds.map((id) => `gid://shopify/Product/${id}`);
  const response = await admin.graphql(PRODUCT_TITLES_QUERY, { variables: { ids: gids } });
  const { data } = await response.json();

  for (const node of data?.nodes ?? []) {
    if (!node) continue;
    const numericId = node.id.split("/").pop();
    productInfoById.set(numericId, { title: node.title, image: node.featuredImage?.url ?? null });
  }

  return productInfoById;
}

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const statusKeys = await scanDropStatusKeys();

  const drops = await Promise.all(statusKeys.map(async (statusKey) => {
    const prefix = statusKey.replace(/:status$/, "");
    const [status, count, goal, deadline, config] = await Promise.all([
      redis.get(`${prefix}:status`),
      redis.get(`${prefix}:count`),
      redis.get(`${prefix}:goal`),
      redis.get(`${prefix}:deadline`),
      redis.hgetall(`${prefix}:config`),
    ]);
    const [, , productId, variantId] = prefix.split(":");
    return {
      prefix,
      productId,
      variantId,
      status,
      count: count || 0,
      goal,
      deadline,
      softDeleted: Boolean(config?.softDeletedAt),
    };
  }));

  const productInfoById = await fetchProductInfoByProductId(admin, drops.map((d) => d.productId));

  const dropsWithProductInfo = drops.map((d) => ({
    ...d,
    productTitle: productInfoById.get(d.productId)?.title ?? null,
    productImage: productInfoById.get(d.productId)?.image ?? null,
  }));

  return json({ drops: dropsWithProductInfo });
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const prefix = formData.get("prefix");
  const intent = formData.get("intent");
  const productGid = formData.get("productGid");

  if (intent === "end") {
    await redis.set(`${prefix}:deadline`, new Date(0).toISOString());
  }

  if (intent === "end" || intent === "delete") {
    await deactivateDropMetafields(admin, productGid);
    await softDeleteDrop(prefix, { shop: session.shop, productGid });
  }

  return json({ ok: true });
}

const badgeTone = { open: "info", reached: "success", missed: "critical", captured: "success", voided: "critical" };

export default function Dashboard() {
  const { drops } = useLoaderData();
  const submit = useSubmit();

  const act = (prefix, intent, productId) => {
    submit(
      { prefix, intent, productGid: `gid://shopify/Product/${productId}` },
      { method: "post" },
    );
  };

  return (
    <Page title="Group Drops" primaryAction={{ content: "Create drop", url: "/app/create-drop" }}>
      <IndexTable
        resourceName={{ singular: "drop", plural: "drops" }}
        itemCount={drops.length}
        headings={[
          { title: "Product" },
          { title: "Progress" },
          { title: "Status" },
          { title: "Deadline" },
          { title: "Actions" },
        ]}
        selectable={false}
      >
        {drops.map((d, i) => (
          <IndexTable.Row id={d.prefix} key={d.prefix} position={i}>
            <IndexTable.Cell>
              <InlineStack gap="200" blockAlign="center" wrap={false}>
                {d.productImage && (
                  <Thumbnail source={d.productImage} alt={d.productTitle || d.productId} size="small" />
                )}
                <Text as="span">{d.productTitle || d.productId}</Text>
              </InlineStack>
            </IndexTable.Cell>
            <IndexTable.Cell>{d.count} / {d.goal}</IndexTable.Cell>
            <IndexTable.Cell>
              <Badge tone={badgeTone[d.status] || "info"}>
                {d.softDeleted ? `${d.status} (ending)` : d.status}
              </Badge>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <Text as="span" tone="subdued">{new Date(d.deadline).toLocaleString()}</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
              {!d.softDeleted && (
                <>
                  <Button size="slim" onClick={() => act(d.prefix, "end", d.productId)}>End</Button>{" "}
                  <Button size="slim" tone="critical" onClick={() => act(d.prefix, "delete", d.productId)}>Delete</Button>
                </>
              )}
            </IndexTable.Cell>
          </IndexTable.Row>
        ))}
      </IndexTable>
    </Page>
  );
}
