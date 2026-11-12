# Technical notes

The detailed engineering reference for this app: how it is put together, and
the Shopify and Vercel gotchas that cost real debugging time. See the
[README](../README.md) for the project overview and retrospective.

## Architecture

This repo is NUVUS Group Drop, a Shopify embedded app for running group-buy "drops" on products (shoppers reserve a spot; if a goal is hit before a deadline, the pool is captured, otherwise no one is charged). It's built on Shopify's Remix app template with the following app-specific pieces layered on top:

- **Admin UI** (`app/routes/app.*`) — merchant-facing Polaris pages to create and manage drops.
- **Live pool state** — Upstash Redis (`app/lib/redis.server.js`), keyed by `nuvus:drop:<productId>:<variantId>:*`. Holds count/goal/deadline/status (`open` → `reached`/`missed` → soft-deleted/purged) — this is the source of truth for anything time-sensitive, since it's cheap to read/write on every storefront poll.
- **Storefront-visible config** — Shopify product metafields under the `group_drop` namespace (`app/lib/metafields.server.js`), read directly by the storefront widget via Liquid, independent of the app being reachable.
- **Storefront widget** — `extensions/group-drop-widget` is a Theme App Extension; its `blocks/drop_progress.liquid` app block is what merchants add under Apps in the Theme Editor. `theme/group-drop-widget.liquid` is the same widget as a manual copy-paste snippet, kept only as a fallback — the two aren't synced automatically, so port changes to both. Rendering is driven entirely by the `group_drop.status` metafield: `active` shows the live progress bar (set at creation in `app/lib/metafields.server.js`, alongside `reached`/`missed` written by the order webhook and cleanup cron respectively), `dormant`/`upcoming` shows a "coming soon" + interest-button state instead, and any other value renders nothing.
- **Drop resolution, two triggers**:
  - Instant: `app/routes/api.webhooks.order-create.jsx` handles the `orders/create` webhook and flips a drop to `reached` synchronously the moment an order pushes its count to the goal.
  - Scheduled: `app/routes/api.cleanup-drops.jsx` marks drops `missed` once their deadline passes unmet, and purges metafields for closed drops after a 48h grace period. See "Background jobs and drop resolution" below for why this runs on an external cron instead of Vercel's.
- **Session storage** — Prisma + PostgreSQL (Neon), not the template's default SQLite; see `prisma/schema.prisma`.
- **Auth** — embedded app using `shopify-app-remix`'s token-exchange strategy (`unstable_newEmbeddedAuthStrategy` in `app/shopify.server.ts`), hosted on Vercel via the `@vercel/remix` preset (see "Hosting on Vercel").

## Session storage

Sessions are stored with Prisma in **PostgreSQL** (hosted on [Neon](https://neon.tech)), not the Shopify template's default SQLite. See the `datasource db` block in `prisma/schema.prisma` and the `DATABASE_URL` env var.

## App configuration (`shopify.app.*.toml`)

The Shopify CLI can track multiple `shopify.app.<name>.toml` files in one repo, but only one is "linked" at a time — tracked by `.shopify/project.json` (keyed by `client_id`), and it's the only one `shopify app deploy` / `shopify app env show` actually reads or pushes to the Partner Dashboard. **If more than one `shopify.app.*.toml` exists, don't assume the one with the most complete-looking config is the live one** — check `.shopify/project.json`'s `client_id` against the `client_id` at the top of each toml file. This app currently links to `shopify.app.nuvus-group-drop.toml`.

`application_url`, `redirect_urls`, `access_scopes`, and `[[webhooks.subscriptions]]` in that file only take effect once you run `npx shopify app deploy` (or `npx shopify app config push` on CLI versions that have it) — editing the toml alone does not change anything on Shopify's side until deployed.

## Hosting on Vercel

This app is deployed on Vercel and already uses the Vercel Preset, which is required for a Remix app hosted there — without it, dynamic routes (including the embedded app's own entry point) return a platform-level `404: NOT_FOUND` instead of reaching the Remix server. Learn more about hosting Remix apps on Vercel [here](https://vercel.com/docs/frameworks/remix).

Concretely, this means:

- `vite.config.ts` registers `presets: [vercelPreset()]` (imported from `@vercel/remix/vite`) in the Remix Vite plugin.
- `app/entry.server.tsx` renders through `handleRequest` from `@vercel/remix` instead of a hand-rolled Node stream pipeline.
- Every route that previously imported types or helpers (`json`, `redirect`, `LoaderFunctionArgs`, etc.) from `@remix-run/node` now imports them from `@vercel/remix` instead, which is a drop-in superset of the `@remix-run/node` API tailored for Vercel's runtime.

If you fork this app onto a different host (Heroku, Fly.io, Docker), swap those `@vercel/remix` imports back to `@remix-run/node` and remove the preset — `@vercel/remix` is Vercel-specific.

## Environment variables

See `.env.example` for the full list. For Shopify credentials specifically, the app reads exactly one pair of variable names — `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` (set in `app/shopify.server.ts`) — matching the standard Shopify Remix template convention and what `npx shopify app env show` outputs for this app. There is no `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` naming anywhere in the codebase; don't add a second pair under those names in Vercel's project settings, since the app will silently ignore them and keep using whatever `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` are already set to.

This matters in practice: if the app's registered client ID/secret on Shopify's Partner Dashboard ever changes (e.g. after deleting and recreating an app, or switching which `shopify.app.*.toml` config is linked), `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` must be updated everywhere they're set — locally in `.env`, and in Vercel's project environment variables — or requests will fail auth (typically surfacing as a 401) even though the code and Shopify-side config are otherwise correct. Run `npx shopify app env show` to get the values for the currently-linked app.

## Background jobs and drop resolution

Group drops resolve in two different ways, on two different triggers:

- **Reached, instantly.** `app/routes/api.webhooks.order-create.jsx` handles the `orders/create` webhook. The moment an order for a product with an open drop is processed, it increments the pool count in Redis and, if that pushes the count to the goal, immediately flips the drop's status to `reached` and updates its metafields — synchronously, in the same webhook request. There is no polling or batching involved in this transition.
- **Missed / manually ended, and cleanup, on a schedule.** Two things can't be triggered by an order webhook, since there's no order to react to: a drop that's no longer live (its deadline passed, or a merchant clicked "End" in the dashboard) without reaching its goal, and the eventual removal of a resolved drop's metafields 48 hours after it closes (so the storefront widget has time to show its final state). Both are handled by `app/routes/api.cleanup-drops.jsx`. Note that "End" doesn't change a drop's Redis `status` itself — it soft-deletes it (`config.softDeletedAt`) and leaves `status: "open"`; the dashboard's "(ending)" badge suffix is purely a display string for that combination, not a separate stored status.

Vercel's native Cron Jobs feature is **not used** for this — the Hobby plan limits native crons to once per day, far too infrequent for marking a drop "missed" close to its actual deadline. Instead, `vercel.json` has no `crons` block, and scheduling is handled externally via [cron-job.org](https://cron-job.org), configured to send a `GET` request to `/api/cleanup-drops` every minute. On each invocation it:

1. Scans for drops still marked `open` that are no longer actually live (deadline passed, or manually ended), and resolves each to `missed` — or self-heals to `reached` if the pool's count had actually already hit its goal (e.g. a prior webhook's metafield write failed after its Redis increment succeeded) — then queues missed/ended ones for cleanup.
2. Retries order cancel/capture for any already-resolved (`missed`/`reached`) drop that still has entries left in its Redis `order_ids` set — see below for why an order can be left pending after step 1 already ran once.
3. Purges Shopify metafields for any drop (`reached`, `missed`, or manually ended) whose 48-hour grace period has fully elapsed.

These three phases (`app/routes/api.cleanup-drops.jsx`'s `resolveDropOutcomes`, `retryPendingOrderActions`, `purgeStale`) each run wrapped in their own error boundary — one throwing must never silently skip the others for that cron tick, which is exactly the resilience gap that used to let missing-`shop` entries in the purge queue (see below) block cleanup progress entirely.

Every order matching an open drop is recorded in Redis (`${prefix}:order_ids`, via `trackDropOrder`/`getDropOrderIds` in `app/lib/redis.server.js`) regardless of outcome, and untracked (`untrackDropOrder`) the moment its cancel/capture attempt succeeds. This store uses manual/deferred payment capture, so an order placed against an open drop is authorized but not captured until the drop resolves:

- **Missed** — every associated order's authorization is released via `cancelOrdersForDropWithAdmin` (`app/lib/orders.server.js`, calling the Admin API's `orderCancel` with `refund: false` — there's nothing captured yet to refund).
- **Reached** — every associated order's payment is captured via `captureOrdersForDropWithAdmin` (same file, calling `orderCapture`). This queries each order's transactions first to find its `AUTHORIZATION`/`SUCCESS` transaction, since `orderCapture` needs a specific `parentTransactionId` + `amount`, not just an order ID. Triggered synchronously right after the order webhook flips a drop to `reached`, with the same self-healing fallback in the cleanup cron for the case where that webhook's capture step never ran. Note: Shopify's docs describe `orderCapture` as additionally requiring the calling user to have a `capture_payments_for_orders` permission — this repo's calls run under an offline (app-level) token rather than a specific staff session, and that distinction isn't fully documented, so verify captures actually succeed against a real reached drop rather than assuming this permission requirement is satisfied.

Because a drop's status only ever transitions to `missed`/`reached` once, a cancel/capture failure for an individual order during that one-time resolution would otherwise never be retried — the drop looks resolved while an order stays stuck authorized-and-untouched. `order_ids` staying non-empty after resolution is exactly the signal that some orders still need a retry, which is what step 2 above does. Similarly, `purgeStale` drops (rather than retries) any cleanup-queue entry with no `shop` on it — this can only happen for drops created before `shop` started being stored in Redis config, and retrying an unreachable shop forever wastes every future cron run for zero progress.

Since Vercel isn't invoking this endpoint itself, it won't auto-inject the `CRON_SECRET` bearer token the way it does for native Cron Jobs. When setting up the job in cron-job.org, add a custom request header:

```
Authorization: Bearer <value of CLEANUP_CRON_SECRET>
```

`CLEANUP_CRON_SECRET` must be set in your Vercel project's environment variables and match the value configured in cron-job.org.

## Troubleshooting

### 401 right after a merchant accepts new scopes

A related but different symptom is a **401 right after a merchant accepts new scopes**, instead of a redirect loop. `authenticate.admin`'s token-exchange strategy (`unstable_newEmbeddedAuthStrategy`) already re-authenticates automatically when a stored session's `scope` doesn't match the app's configured scopes — that check lives in `@shopify/shopify-api`'s `Session.isScopeChanged()` and isn't something app code needs to reimplement. It only works if the stored `scope` is actually kept in sync, which is what `app/routes/webhooks.app.scopes_update.tsx` does (via `db.session.updateMany({ where: { shop } })` — every session row for the shop, not just one). If you ever see this 401 recur, first check whether the `app/scopes_update` webhook is actually registered and firing (see "App configuration" above) before suspecting the token-exchange logic itself.

### 410 Gone at the root URL

`authenticate.admin` internally rejects any request whose `User-Agent` is classified as a bot by the `isbot` library, throwing a raw `410 Gone` (see `reject-bot-request.js` in `@shopify/shopify-app-remix`). This is meant to stop crawlers from triggering OAuth, but it also fires for non-browser traffic like `curl`, uptime monitors, or Vercel's own deployment-preview screenshotter — and plausibly for Shopify's own embeddability pre-checks, which can present as a blank embedded iframe.

For this reason, `app/routes/_index.jsx` (the bare `/` route) deliberately does **not** call `authenticate.admin` — it only forwards the query string into `/app`, which authenticates on its own loader. Don't "fix" this by adding authentication back to the root route; that's what caused the regression in the first place. Any *other* route that needs to authenticate real merchant traffic should keep calling `authenticate.admin` as normal — real browsers are never bot-classified, so this only matters for routes hit by automated tooling.
