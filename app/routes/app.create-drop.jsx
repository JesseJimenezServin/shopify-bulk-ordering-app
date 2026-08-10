import { useState, useCallback } from "react";
import { useSubmit, useNavigation } from "@remix-run/react";
import { json } from "@remix-run/node";
import {
  Page, Card, FormLayout, TextField, Button, Thumbnail, BlockStack, Text,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { setDropMetafields } from "../lib/metafields.server";
import { redis, keyPrefix } from "../lib/redis.server";

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const productId = formData.get("productId");
  const variantId = formData.get("variantId");
  const goal = Number(formData.get("goal"));
  const price = formData.get("price");
  const durationHours = Number(formData.get("durationHours"));
  const deadlineIso = new Date(Date.now() + durationHours * 3600 * 1000).toISOString();
  const dropId = crypto.randomUUID();

  const numericProductId = productId.split("/").pop();
  const numericVariantId = variantId.split("/").pop();

  await setDropMetafields(admin, { productId, goal, price, deadlineIso, dropId, isActive: true });

  const prefix = keyPrefix(numericProductId, numericVariantId);
  await redis.hset(`${prefix}:config`, {
    dropId, goal, price, deadline: deadlineIso, createdAt: Date.now(),
  });
  await redis.mset({
    [`${prefix}:goal`]: goal,
    [`${prefix}:deadline`]: deadlineIso,
    [`${prefix}:status`]: "open",
  });
  await redis.setnx(`${prefix}:count`, 0);

  return json({ ok: true, dropId });
}

export default function CreateDrop() {
  const shopify = useAppBridge();
  const submit = useSubmit();
  const nav = useNavigation();
  const isSaving = nav.state === "submitting";

  const [product, setProduct] = useState(null);
  const [goal, setGoal] = useState("20");
  const [price, setPrice] = useState("");
  const [durationHours, setDurationHours] = useState("2");

  const openPicker = useCallback(async () => {
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: false,
      action: "select",
    });
    if (selection?.length) {
      const p = selection[0];
      setProduct({
        id: p.id,
        title: p.title,
        image: p.images?.[0]?.originalSrc,
        variantId: p.variants?.[0]?.id,
      });
    }
  }, [shopify]);

  const handleSubmit = () => {
    if (!product) return;
    const formData = new FormData();
    formData.append("productId", product.id);
    formData.append("variantId", product.variantId);
    formData.append("goal", goal);
    formData.append("price", price);
    formData.append("durationHours", durationHours);
    submit(formData, { method: "post" });
  };

  return (
    <Page title="Create Group Drop" backAction={{ url: "/app" }}>
      <Card>
        <BlockStack gap="400">
          {product ? (
            <BlockStack gap="200">
              <Thumbnail source={product.image || ""} alt={product.title} />
              <Text as="span" fontWeight="semibold">{product.title}</Text>
              <Button onClick={openPicker} variant="plain">Change product</Button>
            </BlockStack>
          ) : (
            <Button onClick={openPicker}>Select product</Button>
          )}

          <FormLayout>
            <TextField label="Target goal (buyers)" type="number" value={goal} onChange={setGoal} autoComplete="off" />
            <TextField label="Group drop price" type="number" prefix="$" value={price} onChange={setPrice} autoComplete="off" />
            <TextField label="Duration (hours)" type="number" value={durationHours} onChange={setDurationHours} autoComplete="off" />
          </FormLayout>

          <Button variant="primary" onClick={handleSubmit} loading={isSaving} disabled={!product}>
            Launch drop
          </Button>
        </BlockStack>
      </Card>
    </Page>
  );
}
