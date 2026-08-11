import { useState, useCallback } from "react";
import { useSubmit, useNavigation, useActionData } from "@remix-run/react";
import { json } from "@remix-run/node";
import {
  Page, Card, FormLayout, TextField, Button, Thumbnail, BlockStack, Text, Banner,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { setDropMetafields } from "../lib/metafields.server";
import { redis, keyPrefix } from "../lib/redis.server";

function validateDropInputs({ goal, price, durationHours }) {
  const errors = {};
  const goalNum = Number(goal);
  const priceNum = Number(price);
  const durationNum = Number(durationHours);

  if (!Number.isInteger(goalNum) || goalNum <= 0) {
    errors.goal = "Enter a whole number greater than 0";
  }
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    errors.price = "Enter a price greater than $0";
  }
  if (!Number.isFinite(durationNum) || durationNum <= 0) {
    errors.durationHours = "Enter a duration greater than 0 hours";
  }

  return errors;
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const productId = formData.get("productId");
  const variantId = formData.get("variantId");
  const goal = formData.get("goal");
  const price = formData.get("price");
  const durationHours = formData.get("durationHours");

  const errors = validateDropInputs({ goal, price, durationHours });
  if (!productId || !variantId) {
    errors.product = "Select a product before launching a drop";
  }
  if (Object.keys(errors).length > 0) {
    return json({ ok: false, errors }, { status: 400 });
  }

  const goalNum = Number(goal);
  const priceNum = Number(price);
  const durationNum = Number(durationHours);
  const deadlineIso = new Date(Date.now() + durationNum * 3600 * 1000).toISOString();
  const dropId = crypto.randomUUID();

  const numericProductId = productId.split("/").pop();
  const numericVariantId = variantId.split("/").pop();

  await setDropMetafields(admin, { productId, goal: goalNum, price: priceNum, deadlineIso, dropId, isActive: true });

  const prefix = keyPrefix(numericProductId, numericVariantId);
  await redis.hset(`${prefix}:config`, {
    dropId, goal: goalNum, price: priceNum, deadline: deadlineIso, createdAt: Date.now(),
  });
  await redis.mset({
    [`${prefix}:goal`]: goalNum,
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
  const actionData = useActionData();
  const isSaving = nav.state === "submitting";

  const [product, setProduct] = useState(null);
  const [goal, setGoal] = useState("20");
  const [price, setPrice] = useState("");
  const [durationHours, setDurationHours] = useState("2");
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);

  const clientErrors = validateDropInputs({ goal, price, durationHours });
  const errors = { ...clientErrors, ...(attemptedSubmit ? actionData?.errors : undefined) };

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
    setAttemptedSubmit(true);
    if (!product || Object.keys(clientErrors).length > 0) return;

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
          {actionData?.ok && (
            <Banner tone="success">Drop launched successfully.</Banner>
          )}

          {product ? (
            <BlockStack gap="200">
              <Thumbnail source={product.image || ""} alt={product.title} />
              <Text as="span" fontWeight="semibold">{product.title}</Text>
              <Button onClick={openPicker} variant="plain">Change product</Button>
            </BlockStack>
          ) : (
            <BlockStack gap="100">
              <Button onClick={openPicker}>Select product</Button>
              {attemptedSubmit && (
                <Text as="span" tone="critical">Select a product before launching a drop</Text>
              )}
            </BlockStack>
          )}

          <FormLayout>
            <TextField
              label="Target goal (buyers)"
              type="number"
              value={goal}
              onChange={setGoal}
              autoComplete="off"
              error={attemptedSubmit ? errors.goal : undefined}
            />
            <TextField
              label="Group drop price"
              type="number"
              prefix="$"
              value={price}
              onChange={setPrice}
              autoComplete="off"
              error={attemptedSubmit ? errors.price : undefined}
            />
            <TextField
              label="Duration (hours)"
              type="number"
              value={durationHours}
              onChange={setDurationHours}
              autoComplete="off"
              error={attemptedSubmit ? errors.durationHours : undefined}
            />
          </FormLayout>

          <Button variant="primary" onClick={handleSubmit} loading={isSaving}>
            Launch drop
          </Button>
        </BlockStack>
      </Card>
    </Page>
  );
}
