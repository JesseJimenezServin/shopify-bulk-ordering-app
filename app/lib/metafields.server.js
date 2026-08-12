const SET_METAFIELDS_MUTATION = `#graphql
  mutation SetDropMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key namespace }
      userErrors { field message }
    }
  }
`;

const DELETE_METAFIELDS_MUTATION = `#graphql
  mutation DeleteDropMetafields($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { key namespace ownerId }
      userErrors { field message }
    }
  }
`;

export const GROUP_DROP_KEYS = [
  "target_goal",
  "drop_price",
  "deadline",
  "drop_id",
  "is_active",
  "status",
];

export async function setDropMetafields(admin, { productId, goal, price, deadlineIso, dropId, isActive }) {
  const metafields = [
    { ownerId: productId, namespace: "group_drop", key: "target_goal", type: "number_integer", value: String(goal) },
    { ownerId: productId, namespace: "group_drop", key: "drop_price", type: "number_decimal", value: String(price) },
    { ownerId: productId, namespace: "group_drop", key: "deadline", type: "date_time", value: deadlineIso },
    { ownerId: productId, namespace: "group_drop", key: "drop_id", type: "single_line_text_field", value: dropId },
    { ownerId: productId, namespace: "group_drop", key: "is_active", type: "boolean", value: String(isActive) },
    { ownerId: productId, namespace: "group_drop", key: "status", type: "single_line_text_field", value: "active" },
  ];

  const response = await admin.graphql(SET_METAFIELDS_MUTATION, { variables: { metafields } });
  const { data } = await response.json();

  const errors = data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) throw new Error(`Metafield errors: ${JSON.stringify(errors)}`);

  return data.metafieldsSet.metafields;
}

export async function deactivateDropMetafields(admin, productId) {
  const metafields = [
    { ownerId: productId, namespace: "group_drop", key: "is_active", type: "boolean", value: "false" },
  ];
  const response = await admin.graphql(SET_METAFIELDS_MUTATION, { variables: { metafields } });
  const { data } = await response.json();

  const errors = data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) throw new Error(`Metafield errors: ${JSON.stringify(errors)}`);

  return data.metafieldsSet.metafields;
}

export async function setDropStatusMetafield(admin, productId, status) {
  const metafields = [
    { ownerId: productId, namespace: "group_drop", key: "status", type: "single_line_text_field", value: status },
  ];
  const response = await admin.graphql(SET_METAFIELDS_MUTATION, { variables: { metafields } });
  const { data } = await response.json();

  const errors = data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) throw new Error(`Metafield errors: ${JSON.stringify(errors)}`);

  return data.metafieldsSet.metafields;
}

export async function deleteDropMetafields(admin, productId) {
  const metafields = GROUP_DROP_KEYS.map((key) => ({
    ownerId: productId,
    namespace: "group_drop",
    key,
  }));

  const response = await admin.graphql(DELETE_METAFIELDS_MUTATION, { variables: { metafields } });
  const { data } = await response.json();

  const errors = data?.metafieldsDelete?.userErrors ?? [];
  if (errors.length) throw new Error(`Metafield delete errors: ${JSON.stringify(errors)}`);

  return data.metafieldsDelete.deletedMetafields;
}
