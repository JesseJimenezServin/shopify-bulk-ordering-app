# Shopify App Template - Remix

> [!NOTE]
> **Remix is now React Router.** As of [React Router v7](https://remix.run/blog/merging-remix-and-react-router), Remix and React Router have merged.
> 
> For new projects, use the **[Shopify App Template - React Router](https://github.com/Shopify/shopify-app-template-react-router)** instead.
> 
> To migrate your existing Remix app, follow the **[migration guide](https://github.com/Shopify/shopify-app-template-react-router/wiki/Upgrading-from-Remix)**.

This is a template for building a [Shopify app](https://shopify.dev/docs/apps/getting-started) using the [Remix](https://remix.run) framework.

Rather than cloning this repo, you can use your preferred package manager and the Shopify CLI with [these steps](https://shopify.dev/docs/apps/getting-started/create).

Visit the [`shopify.dev` documentation](https://shopify.dev/docs/api/shopify-app-remix) for more details on the Remix app package.

## Architecture

This repo is NUVUS Group Drop, a Shopify embedded app for running group-buy "drops" on products (shoppers reserve a spot; if a goal is hit before a deadline, the pool is captured, otherwise no one is charged). It's built on this Remix template with the following app-specific pieces layered on top:

- **Admin UI** (`app/routes/app.*`) — merchant-facing Polaris pages to create and manage drops.
- **Live pool state** — Upstash Redis (`app/lib/redis.server.js`), keyed by `nuvus:drop:<productId>:<variantId>:*`. Holds count/goal/deadline/status (`open` → `reached`/`missed` → soft-deleted/purged) — this is the source of truth for anything time-sensitive, since it's cheap to read/write on every storefront poll.
- **Storefront-visible config** — Shopify product metafields under the `group_drop` namespace (`app/lib/metafields.server.js`), read directly by the storefront widget via Liquid, independent of the app being reachable.
- **Storefront widget** — `extensions/group-drop-widget` is a Theme App Extension; its `blocks/drop_progress.liquid` app block is what merchants add under Apps in the Theme Editor. `theme/group-drop-widget.liquid` is the same widget as a manual copy-paste snippet, kept only as a fallback — the two aren't synced automatically, so port changes to both. Rendering is driven entirely by the `group_drop.status` metafield: `active` shows the live progress bar (set at creation in `app/lib/metafields.server.js`, alongside `reached`/`missed` written by the order webhook and cleanup cron respectively), `dormant`/`upcoming` shows a "coming soon" + interest-button state instead, and any other value renders nothing.
- **Drop resolution, two triggers**:
  - Instant: `app/routes/api.webhooks.order-create.jsx` handles the `orders/create` webhook and flips a drop to `reached` synchronously the moment an order pushes its count to the goal.
  - Scheduled: `app/routes/api.cleanup-drops.jsx` marks drops `missed` once their deadline passes unmet, and purges metafields for closed drops after a 48h grace period. See "Background jobs and drop resolution" below for why this runs on an external cron instead of Vercel's.
- **Session storage** — Prisma + PostgreSQL (Neon), not the template's default SQLite; see `prisma/schema.prisma`.
- **Auth** — embedded app using `shopify-app-remix`'s token-exchange strategy (`unstable_newEmbeddedAuthStrategy` in `app/shopify.server.ts`), hosted on Vercel via the `@vercel/remix` preset (see "Hosting on Vercel").

## Quick start

### Prerequisites

Before you begin, you'll need the following:

1. **Node.js**: [Download and install](https://nodejs.org/en/download/) it if you haven't already.
2. **Shopify Partner Account**: [Create an account](https://partners.shopify.com/signup) if you don't have one.
3. **Test Store**: Set up either a [development store](https://help.shopify.com/en/partners/dashboard/development-stores#create-a-development-store) or a [Shopify Plus sandbox store](https://help.shopify.com/en/partners/dashboard/managing-stores/plus-sandbox-store) for testing your app.
4. **Shopify CLI**: [Download and install](https://shopify.dev/docs/apps/tools/cli/getting-started) it if you haven't already.
```shell
npm install -g @shopify/cli@latest
```

### Setup

```shell
shopify app init --template=https://github.com/Shopify/shopify-app-template-remix
```

### Local Development

```shell
shopify app dev
```



Local development is powered by [the Shopify CLI](https://shopify.dev/docs/apps/tools/cli). It logs into your partners account, connects to an app, provides environment variables, updates remote config, creates a tunnel and provides commands to generate extensions.

### Authenticating and querying data

To authenticate and query data you can use the `shopify` const that is exported from `/app/shopify.server.js`:

```js
export async function loader({ request }) {
  const { admin } = await shopify.authenticate.admin(request);

  const response = await admin.graphql(`
    {
      products(first: 25) {
        nodes {
          title
          description
        }
      }
    }`);

  const {
    data: {
      products: { nodes },
    },
  } = await response.json();

  return nodes;
}
```

This template comes preconfigured with examples of:

1. Setting up your Shopify app in [/app/shopify.server.ts](https://github.com/Shopify/shopify-app-template-remix/blob/main/app/shopify.server.ts)
2. Querying data using Graphql. Please see: [/app/routes/app.\_index.tsx](https://github.com/Shopify/shopify-app-template-remix/blob/main/app/routes/app._index.tsx).
3. Responding to webhooks in individual files such as [/app/routes/webhooks.app.uninstalled.tsx](https://github.com/Shopify/shopify-app-template-remix/blob/main/app/routes/webhooks.app.uninstalled.tsx) and [/app/routes/webhooks.app.scopes_update.tsx](https://github.com/Shopify/shopify-app-template-remix/blob/main/app/routes/webhooks.app.scopes_update.tsx)

Please read the [documentation for @shopify/shopify-app-remix](https://www.npmjs.com/package/@shopify/shopify-app-remix#authenticating-admin-requests) to understand what other API's are available.

## Deployment

### Application Storage

This template uses [Prisma](https://www.prisma.io/) to store session data. The template itself defaults to [SQLite](https://www.sqlite.org/index.html), but **this app is configured for PostgreSQL** (hosted on [Neon](https://neon.tech)) — see the `datasource db` block in `prisma/schema.prisma`, and the `DATABASE_URL` env var.

The database that works best for you depends on the data your app needs and how it is queried.
You can run your database of choice on a server yourself or host it with a SaaS company.
Here's a short list of databases providers that provide a free tier to get started:

| Database   | Type             | Hosters                                                                                                                                                                                                                               |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MySQL      | SQL              | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-mysql), [Planet Scale](https://planetscale.com/), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/mysql) |
| PostgreSQL | SQL              | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-postgresql), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/postgres)                                   |
| Redis      | Key-value        | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-redis), [Amazon MemoryDB](https://aws.amazon.com/memorydb/)                                                                                                        |
| MongoDB    | NoSQL / Document | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-mongodb), [MongoDB Atlas](https://www.mongodb.com/atlas/database)                                                                                                  |

To use one of these, you can use a different [datasource provider](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference#datasource) in your `schema.prisma` file, or a different [SessionStorage adapter package](https://github.com/Shopify/shopify-api-js/blob/main/packages/shopify-api/docs/guides/session-storage.md).

### Build

Remix handles building the app for you, by running the command below with the package manager of your choice:

Using yarn:

```shell
yarn build
```

Using npm:

```shell
npm run build
```

Using pnpm:

```shell
pnpm run build
```

## Hosting

When you're ready to set up your app in production, you can follow [our deployment documentation](https://shopify.dev/docs/apps/deployment/web) to host your app on a cloud provider like [Heroku](https://www.heroku.com/) or [Fly.io](https://fly.io/).

When you reach the step for [setting up environment variables](https://shopify.dev/docs/apps/deployment/web#set-env-vars), you also need to set the variable `NODE_ENV=production`.

### App configuration (`shopify.app.*.toml`)

The Shopify CLI can track multiple `shopify.app.<name>.toml` files in one repo, but only one is "linked" at a time — tracked by `.shopify/project.json` (keyed by `client_id`), and it's the only one `shopify app deploy` / `shopify app env show` actually reads or pushes to the Partner Dashboard. **If more than one `shopify.app.*.toml` exists, don't assume the one with the most complete-looking config is the live one** — check `.shopify/project.json`'s `client_id` against the `client_id` at the top of each toml file. This app currently links to `shopify.app.nuvus-group-drop.toml`.

`application_url`, `redirect_urls`, `access_scopes`, and `[[webhooks.subscriptions]]` in that file only take effect once you run `npx shopify app deploy` (or `npx shopify app config push` on CLI versions that have it) — editing the toml alone does not change anything on Shopify's side until deployed.

### Hosting on Vercel

This app is deployed on Vercel and already uses the Vercel Preset, which is required for a Remix app hosted there — without it, dynamic routes (including the embedded app's own entry point) return a platform-level `404: NOT_FOUND` instead of reaching the Remix server. Learn more about hosting Remix apps on Vercel [here](https://vercel.com/docs/frameworks/remix).

Concretely, this means:

- `vite.config.ts` registers `presets: [vercelPreset()]` (imported from `@vercel/remix/vite`) in the Remix Vite plugin.
- `app/entry.server.tsx` renders through `handleRequest` from `@vercel/remix` instead of a hand-rolled Node stream pipeline.
- Every route that previously imported types or helpers (`json`, `redirect`, `LoaderFunctionArgs`, etc.) from `@remix-run/node` now imports them from `@vercel/remix` instead, which is a drop-in superset of the `@remix-run/node` API tailored for Vercel's runtime.

If you fork this app onto a different host (Heroku, Fly.io, Docker), swap those `@vercel/remix` imports back to `@remix-run/node` and remove the preset — `@vercel/remix` is Vercel-specific.

### Environment variables

See `.env.example` for the full list. For Shopify credentials specifically, the app reads exactly one pair of variable names — `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` (set in `app/shopify.server.ts`) — matching the standard Shopify Remix template convention and what `npx shopify app env show` outputs for this app. There is no `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` naming anywhere in the codebase; don't add a second pair under those names in Vercel's project settings, since the app will silently ignore them and keep using whatever `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` are already set to.

This matters in practice: if the app's registered client ID/secret on Shopify's Partner Dashboard ever changes (e.g. after deleting and recreating an app, or switching which `shopify.app.*.toml` config is linked), `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` must be updated everywhere they're set — locally in `.env`, and in Vercel's project environment variables — or requests will fail auth (typically surfacing as a 401) even though the code and Shopify-side config are otherwise correct. Run `npx shopify app env show` to get the values for the currently-linked app.

### Background jobs and drop resolution

Group drops resolve in two different ways, on two different triggers:

- **Reached, instantly.** `app/routes/api.webhooks.order-create.jsx` handles the `orders/create` webhook. The moment an order for a product with an open drop is processed, it increments the pool count in Redis and, if that pushes the count to the goal, immediately flips the drop's status to `reached` and updates its metafields — synchronously, in the same webhook request. There is no polling or batching involved in this transition.
- **Missed and cleanup, on a schedule.** Two things can't be triggered by an order webhook, since there's no order to react to: a drop whose deadline passes without reaching its goal, and the eventual removal of a resolved drop's metafields 48 hours after it closes (so the storefront widget has time to show its final state). Both are handled by `app/routes/api.cleanup-drops.jsx`.

Vercel's native Cron Jobs feature is **not used** for this — the Hobby plan limits native crons to once per day, far too infrequent for marking a drop "missed" close to its actual deadline. Instead, `vercel.json` has no `crons` block, and scheduling is handled externally via [cron-job.org](https://cron-job.org), configured to send a `GET` request to `/api/cleanup-drops` every minute. On each invocation it:

1. Scans for open drops whose deadline has passed without hitting their goal, marks them `missed`, and queues them for cleanup.
2. Purges Shopify metafields for any drop (`reached`, `missed`, or manually ended) whose 48-hour grace period has fully elapsed.

Since Vercel isn't invoking this endpoint itself, it won't auto-inject the `CRON_SECRET` bearer token the way it does for native Cron Jobs. When setting up the job in cron-job.org, add a custom request header:

```
Authorization: Bearer <value of CLEANUP_CRON_SECRET>
```

`CLEANUP_CRON_SECRET` must be set in your Vercel project's environment variables and match the value configured in cron-job.org.

## Troubleshooting

### Database tables don't exist

If you get this error:

```
The table `main.Session` does not exist in the current database.
```

You need to create the database for Prisma. Run the `setup` script in `package.json` using your preferred package manager.

### Navigating/redirecting breaks an embedded app

Embedded Shopify apps must maintain the user session, which can be tricky inside an iFrame. To avoid issues:

1. Use `Link` from `@remix-run/react` or `@shopify/polaris`. Do not use `<a>`.
2. Use the `redirect` helper returned from `authenticate.admin`. Do not use `redirect` from `@remix-run/node`
3. Use `useSubmit` or `<Form/>` from `@remix-run/react`. Do not use a lowercase `<form/>`.

This only applies if your app is embedded, which it will be by default.

### Non Embedded

Shopify apps are best when they are embedded in the Shopify Admin, which is how this template is configured. If you have a reason to not embed your app please make the following changes:

1. Ensure `embedded = false` is set in your linked `shopify.app.*.toml` (see "App configuration" above for which file that is). [Docs here](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration#global).
2. Pass `isEmbeddedApp: false` to `shopifyApp()` in `./app/shopify.server.js|ts`.
3. Change the `isEmbeddedApp` prop to `isEmbeddedApp={false}` for the `AppProvider` in `/app/routes/app.jsx|tsx`.
4. Remove the `@shopify/app-bridge-react` dependency from [package.json](./package.json) and `vite.config.ts|js`.
5. Remove anything imported from `@shopify/app-bridge-react`.  For example: `NavMenu`, `TitleBar` and `useAppBridge`.

### OAuth goes into a loop when I change my app's scopes

If you change your app's scopes and authentication goes into a loop and fails with a message from Shopify that it tried too many times, you might have forgotten to update your scopes with Shopify.
To do that, you can run the `deploy` CLI command.

Using yarn:

```shell
yarn deploy
```

Using npm:

```shell
npm run deploy
```

Using pnpm:

```shell
pnpm run deploy
```

A related but different symptom is a **401 right after a merchant accepts new scopes**, instead of a redirect loop. `authenticate.admin`'s token-exchange strategy (`unstable_newEmbeddedAuthStrategy`) already re-authenticates automatically when a stored session's `scope` doesn't match the app's configured scopes — that check lives in `@shopify/shopify-api`'s `Session.isScopeChanged()` and isn't something app code needs to reimplement. It only works if the stored `scope` is actually kept in sync, which is what `app/routes/webhooks.app.scopes_update.tsx` does (via `db.session.updateMany({ where: { shop } })` — every session row for the shop, not just one). If you ever see this 401 recur, first check whether the `app/scopes_update` webhook is actually registered and firing (see "App configuration" above) before suspecting the token-exchange logic itself.

### My shop-specific webhook subscriptions aren't updated

If you are registering webhooks in the `afterAuth` hook, using `shopify.registerWebhooks`, you may find that your subscriptions aren't being updated.  

Instead of using the `afterAuth` hook, the recommended approach is to declare app-specific webhooks in your linked `shopify.app.*.toml` file (see "App configuration" above).  This approach is easier since Shopify will automatically update changes to webhook subscriptions every time you run `deploy` (e.g: `npm run deploy`).  Please read these guides to understand more:

1. [app-specific vs shop-specific webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe#app-specific-subscriptions)
2. [Create a subscription tutorial](https://shopify.dev/docs/apps/build/webhooks/subscribe/get-started?framework=remix&deliveryMethod=https)

If you do need shop-specific webhooks, please keep in mind that the package calls `afterAuth` in 2 scenarios:

- After installing the app
- When an access token expires

During normal development, the app won't need to re-authenticate most of the time, so shop-specific subscriptions aren't updated. To force your app to update the subscriptions, you can uninstall and reinstall it in your development store. That will force the OAuth process and call the `afterAuth` hook.

### Admin created webhook failing HMAC validation

Webhooks subscriptions created in the [Shopify admin](https://help.shopify.com/en/manual/orders/notifications/webhooks) will fail HMAC validation. This is because the webhook payload is not signed with your app's secret key.  There are 2 solutions:

1. Use [app-specific webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe#app-specific-subscriptions) defined in your toml file instead (recommended)
2. Create [webhook subscriptions](https://shopify.dev/docs/api/shopify-app-remix/v1/guide-webhooks) using the `shopifyApp` object.

Test your webhooks with the [Shopify CLI](https://shopify.dev/docs/apps/tools/cli/commands#webhook-trigger) or by triggering events manually in the Shopify admin(e.g. Updating the product title to trigger a `PRODUCTS_UPDATE`).

### Incorrect GraphQL Hints

By default the [graphql.vscode-graphql](https://marketplace.visualstudio.com/items?itemName=GraphQL.vscode-graphql) extension for VS Code will assume that GraphQL queries or mutations are for the [Shopify Admin API](https://shopify.dev/docs/api/admin). This is a sensible default, but it may not be true if:

1. You use another Shopify API such as the storefront API.
2. You use a third party GraphQL API.

in this situation, please update the [.graphqlrc.ts](https://github.com/Shopify/shopify-app-template-remix/blob/main/.graphqlrc.ts) config.

### First parameter has member 'readable' that is not a ReadableStream.

See [hosting on Vercel](#hosting-on-vercel).

### 410 Gone at the root URL

`authenticate.admin` internally rejects any request whose `User-Agent` is classified as a bot by the `isbot` library, throwing a raw `410 Gone` (see `reject-bot-request.js` in `@shopify/shopify-app-remix`). This is meant to stop crawlers from triggering OAuth, but it also fires for non-browser traffic like `curl`, uptime monitors, or Vercel's own deployment-preview screenshotter — and plausibly for Shopify's own embeddability pre-checks, which can present as a blank embedded iframe.

For this reason, `app/routes/_index.jsx` (the bare `/` route) deliberately does **not** call `authenticate.admin` — it only forwards the query string into `/app`, which authenticates on its own loader. Don't "fix" this by adding authentication back to the root route; that's what caused the regression in the first place. Any *other* route that needs to authenticate real merchant traffic should keep calling `authenticate.admin` as normal — real browsers are never bot-classified, so this only matters for routes hit by automated tooling.

### Admin object undefined on webhook events triggered by the CLI

When you trigger a webhook event using the Shopify CLI, the `admin` object will be `undefined`. This is because the CLI triggers an event with a valid, but non-existent, shop. The `admin` object is only available when the webhook is triggered by a shop that has installed the app.

Webhooks triggered by the CLI are intended for initial experimentation testing of your webhook configuration. For more information on how to test your webhooks, see the [Shopify CLI documentation](https://shopify.dev/docs/apps/tools/cli/commands#webhook-trigger).

### Using Defer & await for streaming responses

To test [streaming using defer/await](https://remix.run/docs/en/main/guides/streaming) during local development you'll need to use the Shopify CLI slightly differently:

1. First setup ngrok: https://ngrok.com/product/secure-tunnels
2. Create an ngrok tunnel on port 8080: `ngrok http 8080`.
3. Copy the forwarding address. This should be something like: `https://f355-2607-fea8-bb5c-8700-7972-d2b5-3f2b-94ab.ngrok-free.app`
4. In a separate terminal run `yarn shopify app dev --tunnel-url=TUNNEL_URL:8080` replacing `TUNNEL_URL` for the address you copied in step 3.

By default the CLI uses a cloudflare tunnel. Unfortunately it cloudflare tunnels wait for the Response stream to finish, then sends one chunk.

This will not affect production, since tunnels are only for local development.

### Using MongoDB and Prisma

By default this template uses SQLlite as the database. It is recommended to move to a persisted database for production. If you choose to use MongoDB, you will need to make some modifications to the schema and prisma configuration. For more information please see the [Prisma MongoDB documentation](https://www.prisma.io/docs/orm/overview/databases/mongodb).

Alternatively you can use a MongDB database directly with the [MongoDB session storage adapter](https://github.com/Shopify/shopify-app-js/tree/main/packages/apps/session-storage/shopify-app-session-storage-mongodb).

#### Mapping the id field

In MongoDB, an ID must be a single field that defines an @id attribute and a @map("\_id") attribute.
The prisma adapter expects the ID field to be the ID of the session, and not the \_id field of the document.

To make this work you can add a new field to the schema that maps the \_id field to the id field. For more information see the [Prisma documentation](https://www.prisma.io/docs/orm/prisma-schema/data-model/models#defining-an-id-field)

```prisma
model Session {
  session_id  String    @id @default(auto()) @map("_id") @db.ObjectId
  id          String    @unique
...
}
```

#### Error: The "mongodb" provider is not supported with this command

MongoDB does not support the [prisma migrate](https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/overview) command. Instead, you can use the [prisma db push](https://www.prisma.io/docs/orm/reference/prisma-cli-reference#db-push) command and update the `shopify.web.toml` file with the following commands. If you are using MongoDB please see the [Prisma documentation](https://www.prisma.io/docs/orm/overview/databases/mongodb) for more information.

```toml
[commands]
predev = "npx prisma generate && npx prisma db push"
dev = "npm exec remix vite:dev"
```

#### Prisma needs to perform transactions, which requires your mongodb server to be run as a replica set

See the [Prisma documentation](https://www.prisma.io/docs/getting-started/setup-prisma/start-from-scratch/mongodb/connect-your-database-node-mongodb) for connecting to a MongoDB database.

### I want to use Polaris v13.0.0 or higher

Currently, this template is set up to work on node v18.20 or higher. However, `@shopify/polaris` is limited to v12 because v13 can only run on node v20+.

You don't have to make any changes to the code in order to be able to upgrade Polaris to v13, but you'll need to do the following:

- Upgrade your node version to v20.10 or higher.
- Update your `Dockerfile` to pull `FROM node:20-alpine` instead of `node:18-alpine`

### "nbf" claim timestamp check failed

This error will occur of the `nbf` claim timestamp check failed. This is because the JWT token is expired.
If you  are consistently getting this error, it could be that the clock on your machine is not in sync with the server.

To fix this ensure you have enabled `Set time and date automatically` in the `Date and Time` settings on your computer.

## Benefits

Shopify apps are built on a variety of Shopify tools to create a great merchant experience.

<!-- TODO: Uncomment this after we've updated the docs -->
<!-- The [create an app](https://shopify.dev/docs/apps/getting-started/create) tutorial in our developer documentation will guide you through creating a Shopify app using this template. -->

The Remix app template comes with the following out-of-the-box functionality:

- [OAuth](https://github.com/Shopify/shopify-app-js/tree/main/packages/shopify-app-remix#authenticating-admin-requests): Installing the app and granting permissions
- [GraphQL Admin API](https://github.com/Shopify/shopify-app-js/tree/main/packages/shopify-app-remix#using-the-shopify-admin-graphql-api): Querying or mutating Shopify admin data
- [Webhooks](https://github.com/Shopify/shopify-app-js/tree/main/packages/shopify-app-remix#authenticating-webhook-requests): Callbacks sent by Shopify when certain events occur
- [AppBridge](https://shopify.dev/docs/api/app-bridge): This template uses the next generation of the Shopify App Bridge library which works in unison with previous versions.
- [Polaris](https://polaris.shopify.com/): Design system that enables apps to create Shopify-like experiences

## Tech Stack

This template uses [Remix](https://remix.run). The following Shopify tools are also included to ease app development:

- [Shopify App Remix](https://shopify.dev/docs/api/shopify-app-remix) provides authentication and methods for interacting with Shopify APIs.
- [Shopify App Bridge](https://shopify.dev/docs/apps/tools/app-bridge) allows your app to seamlessly integrate your app within Shopify's Admin.
- [Polaris React](https://polaris.shopify.com/) is a powerful design system and component library that helps developers build high quality, consistent experiences for Shopify merchants.
- [Webhooks](https://github.com/Shopify/shopify-app-js/tree/main/packages/shopify-app-remix#authenticating-webhook-requests): Callbacks sent by Shopify when certain events occur
- [Polaris](https://polaris.shopify.com/): Design system that enables apps to create Shopify-like experiences

## Resources

- [Remix Docs](https://remix.run/docs/en/v1)
- [Shopify App Remix](https://shopify.dev/docs/api/shopify-app-remix)
- [Introduction to Shopify apps](https://shopify.dev/docs/apps/getting-started)
- [App authentication](https://shopify.dev/docs/apps/auth)
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli)
- [App extensions](https://shopify.dev/docs/apps/app-extensions/list)
- [Shopify Functions](https://shopify.dev/docs/api/functions)
- [Getting started with internationalizing your app](https://shopify.dev/docs/apps/best-practices/internationalization/getting-started)
