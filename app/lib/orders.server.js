const ORDER_CANCEL_MUTATION = `#graphql
  mutation CancelMissedDropOrder(
    $orderId: ID!
    $notifyCustomer: Boolean
    $reason: OrderCancelReason!
    $refund: Boolean!
    $restock: Boolean!
    $staffNote: String
  ) {
    orderCancel(
      orderId: $orderId
      notifyCustomer: $notifyCustomer
      reason: $reason
      refund: $refund
      restock: $restock
      staffNote: $staffNote
    ) {
      job { id done }
      orderCancelUserErrors { field message code }
    }
  }
`;

// Cancels an order whose payment was authorized but never captured (this
// store uses manual/deferred capture), releasing the hold on the customer's
// card. refund: false is deliberate — there's nothing to refund since the
// order was never captured, and we don't want to risk refunding a real
// transaction if that assumption is ever wrong for a given order.
export async function cancelOrderAuthorization(admin, orderId) {
  const response = await admin.graphql(ORDER_CANCEL_MUTATION, {
    variables: {
      orderId: `gid://shopify/Order/${orderId}`,
      notifyCustomer: true,
      reason: "OTHER",
      refund: false,
      restock: true,
      staffNote: "NUVUS group drop missed — pool goal not reached before deadline. Releasing payment authorization.",
    },
  });
  const { data } = await response.json();

  const errors = data?.orderCancel?.orderCancelUserErrors ?? [];
  if (errors.length) {
    throw new Error(`Order cancel errors: ${JSON.stringify(errors)}`);
  }

  return data?.orderCancel?.job ?? null;
}
