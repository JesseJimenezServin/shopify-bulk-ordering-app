import { redirect } from "@vercel/remix";

// Deliberately does not call authenticate.admin here — that call rejects
// requests whose User-Agent looks like a bot (see @shopify/shopify-app-remix's
// reject-bot-request), which fires for things like Vercel's own deployment
// preview screenshotter or uptime checks hitting the bare root path, not just
// real crawlers. /app already authenticates on its own loader, so this route
// only needs to forward the query string (shop, host, embedded, etc.) into it.
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return null;
};

export default function Index() {
  return null;
}
