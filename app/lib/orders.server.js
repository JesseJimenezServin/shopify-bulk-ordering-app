import { unauthenticated } from "../shopify.server";
import { getDropOrderIds } from "./redis.server";

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

const ORDER_PENDING_AUTHORIZATION_QUERY = `#graphql
  query OrderPendingAuthorization($id: ID!) {
    order(id: $id) {
      id
      displayFinancialStatus
      transactions(first: 10) {
        id
        kind
        status
        amountSet {
          presentmentMoney { amount currencyCode }
        }
      }
    }
  }
`;

const ORDER_CAPTURE_MUTATION = `#graphql
  mutation CaptureReachedDropOrder($input: OrderCaptureInput!) {
    orderCapture(input: $input) {
      transaction { id status }
      userErrors { field message }
    }
  }
`;

// orderCapture needs the specific authorization transaction to capture, not
// just the order — an order can have several transactions, and Shopify wants
// parentTransactionId + amount, not an implicit "capture whatever's pending".
export async function captureOrderPayment(admin, orderId) {
  const orderGid = `gid://shopify/Order/${orderId}`;

  const orderResponse = await admin.graphql(ORDER_PENDING_AUTHORIZATION_QUERY, { variables: { id: orderGid } });
  const { data: orderData } = await orderResponse.json();
  const order = orderData?.order;
  if (!order) {
    throw new Error(`Order ${orderId} not found`);
  }

  const authorization = order.transactions?.find((t) => t.kind === "AUTHORIZATION" && t.status === "SUCCESS");
  if (!authorization) {
    throw new Error(
      `Order ${orderId} has no capturable authorization (financial status: ${order.displayFinancialStatus})`,
    );
  }

  const response = await admin.graphql(ORDER_CAPTURE_MUTATION, {
    variables: {
      input: {
        id: orderGid,
        parentTransactionId: authorization.id,
        amount: authorization.amountSet.presentmentMoney.amount,
        currency: authorization.amountSet.presentmentMoney.currencyCode,
        finalCapture: true,
      },
    },
  });
  const { data } = await response.json();

  const errors = data?.orderCapture?.userErrors ?? [];
  if (errors.length) {
    throw new Error(`Order capture errors: ${JSON.stringify(errors)}`);
  }

  return data?.orderCapture?.transaction ?? null;
}

// Captures every order tracked against a drop, given an already-resolved
// admin client. Each order is attempted independently so one failure (e.g.
// an order that was already captured, refunded, or canceled) doesn't block
// the rest — failures are logged and returned, never thrown.
export async function captureOrdersForDropWithAdmin(admin, prefix) {
  const orderIds = await getDropOrderIds(prefix);
  if (!orderIds.length) return [];

  return Promise.all(orderIds.map(async (orderId) => {
    try {
      await captureOrderPayment(admin, orderId);
      return { orderId, captured: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`NUVUS: failed to capture payment for order ${orderId} on drop ${prefix}: ${message}`);
      return { orderId, captured: false, message };
    }
  }));
}

// Same as above, but resolves its own admin client from a shop domain — for
// callers that don't already have one on hand.
export async function captureOrdersForDrop(prefix, shop) {
  const { admin } = await unauthenticated.admin(shop);
  return captureOrdersForDropWithAdmin(admin, prefix);
}
