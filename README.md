# Shopify Bulk Ordering App

An embedded Shopify app for **group-buy "drops"**. A merchant puts a product
on a drop with a goal and a deadline, for example "100 units by Friday."
Shoppers check out as normal, but their card is only *authorized*, not
charged. If the pool reaches its goal in time, every order is captured. If
it doesn't, every authorization is released and nobody pays.

Originally built as **NUVUS Group Drop**, which is why the app name, Redis
keys (`nuvus:drop:*`) and widget markup still say NUVUS. Built and deployed
in 12 days (2026-08-09 → 08-20): about 2,200 lines across the admin app, API
routes, and storefront widget.

**Status: concluded.** The core engine (Phase 1 of [`VISION.md`](VISION.md))
was built and deployed to Vercel with a live Shopify app registration.
Development stopped before the later phases: creator commissions,
invite-only drops, and a multi-vendor marketplace.

---

## How it works

```
Shopper checks out ──► Shopify order (payment authorized, not captured)
                              │  orders/create webhook (HMAC-verified)
                              ▼
                    Redis pool count += quantity
                              │
              count ≥ goal? ──┴── deadline passes first?
                   │                       │
             status: reached          status: missed
       capture every order's       cancel every order's
       authorization               authorization (no refund
                                   needed, restock items)
                              │
             product metafields updated ──► storefront widget
```

- **Admin UI** (Remix + Polaris, embedded in Shopify Admin): create a drop,
  see every drop with its product, progress and status, end one early.
- **Live pool state in Upstash Redis.** Count, goal, deadline, status and
  the order IDs per drop. It's cheap enough to read on every storefront
  poll.
- **Storefront widget** as a Theme App Extension. A progress bar, countdown
  and reserve button driven by product metafields, plus a "coming soon /
  vote to launch" state for upcoming drops.
- **Two resolution triggers.** The order webhook resolves a drop the
  instant it reaches its goal. An external cron hits `/api/cleanup-drops`
  every minute (with a bearer secret) to resolve missed drops, retry failed
  payment actions, and purge metafields after a 48-hour grace period.
- **Sessions** in PostgreSQL (Neon) via Prisma. Hosted on Vercel.

Deeper detail, including every Shopify and Vercel gotcha below, is in
[`docs/TECHNICAL_NOTES.md`](docs/TECHNICAL_NOTES.md).

---

## What I learned

**1. On a platform, configuration is code, and it was most of the work.**
The first three days were almost all plumbing, not product. A typical
symptom took several separate causes to fix:
- The embedded app showed a blank iframe and 404s. Vercel needed a Remix
  preset that had never been added.
- Vite silently picked a leftover template route over the real one,
  because both compiled to the same route ID.
- The live Shopify config pointed at a frozen one-off deploy URL, with no
  webhooks registered, so orders never reached the app.
- A local `.env` held credentials for a deleted app registration, which
  caused persistent 401s.
- Shopify's library returns `410 Gone` to anything it thinks is a bot,
  including `curl` and uptime monitors, so the root route had to stop
  authenticating.

The lesson: check what is *actually deployed and linked*, not what the
files in the repo look like.

**2. Anything that moves money must be retryable, one item at a time.** A
drop resolves once. But if capturing or cancelling one of its orders
failed during that single pass, nothing ever retried it. The drop looked
done while an order sat authorized forever. The fix had three parts:
- Track each order until its action succeeds, and retry only the
  leftovers.
- Isolate every order, so one failure can't block the rest.
- Isolate each cleanup phase, so one exception can't skip the others.

**3. Two sources of truth will drift, so design for self-healing.** Redis
holds the count, and Shopify metafields drive the storefront. When a
Redis increment succeeded but the metafield write after it failed, a drop
that had reached its goal would have been marked *missed*. The cleanup job
now re-checks `count ≥ goal` before resolving anything.

**4. When you change what a reader depends on, find every writer.** I
switched the widget to render from a new `status` field, but drop creation
only ever wrote the old `is_active` flag. Every open drop would have
silently disappeared from the storefront.

**5. Units bugs hide in plain sight.** The 48-hour grace period compared a
millisecond timestamp against a value in seconds, so drops were purged
after about **3 minutes**. It's a one-line fix that no type checker
catches.

**6. Free tiers shape architecture.** Vercel's free plan runs cron jobs
only once a day, which is far too coarse to close a drop near its
deadline. Scheduling moved to an external every-minute cron with its own
secret.

**7. Prove the core loop before planning the platform.** `VISION.md` grew
into a social group-buying marketplace with creator commissions and
Stripe Connect payouts. Meanwhile, one important step was never confirmed
against a real completed drop: whether Shopify lets an app-level token
capture payments. The next step should have been to run one drop end to
end with real money, not to plan Phase 4.

---

## Running it

```bash
npm install --legacy-peer-deps
cp .env.example .env      # Shopify API key/secret, DATABASE_URL, Upstash Redis, CLEANUP_CRON_SECRET
npm run setup             # prisma generate + migrate deploy
shopify app dev           # needs a Shopify Partner account and a development store
```

Use a store with **manual payment capture** turned on. The whole design
depends on orders staying authorized until the drop resolves.

Built on Shopify's [Remix app template](https://github.com/Shopify/shopify-app-template-remix).
