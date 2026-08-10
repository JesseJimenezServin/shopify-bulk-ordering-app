import { json } from "@remix-run/node";
import { useLoaderData, useSubmit } from "@remix-run/react";
import { IndexTable, Page, Badge, Button, Text } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { redis, softDeleteDrop } from "../lib/redis.server";
import { deactivateDropMetafields } from "../lib/metafields.server";

export async function loader({ request }) {
  await authenticate.admin(request);

  let cursor = "0";
  const statusKeys = [];
  do {
    const [next, batch] = await redis.scan(cursor, { match: "nuvus:drop:*:status", count: 100 });
    cursor = next;
    statusKeys.push(...batch);
  } while (cursor !== "0");

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

  return json({ drops });
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
            <IndexTable.Cell>{d.productId}</IndexTable.Cell>
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
