# Nuvus Group Drop — Architectural & Product Roadmap

> **Status (2026-11-11): concluded.** Phase 1 was built and deployed; development stopped
> there. This roadmap is kept as written. See the README for the retrospective.

## Core Vision
Nuvus is evolving from a single-merchant Shopify drop tool into a **Social Group Buying Platform**. The platform enables buyers, creators, and friend groups to coordinate group purchases (unlocking wholesale prices or limited-edition runs) with zero counterparty risk. The platform handles authorization holds, threshold aggregation, payment captures, platform take-rates, and split-destination fulfillment.

## Platform Target Features & Milestones

### Phase 1: Core Single-Merchant Engine (In Progress)
- [x] Theme App Extension UI (`nuvus-group-drop-12`) rendering active/dormant drop states.
- [x] Threshold-based payment lifecycle using manual payment capture (`Authorized` -> `Paid` / `Cancelled`).
- [x] GraphQL `nodes` optimization for Admin UI data fetching.
- [x] Automated `/api/cleanup-drops` endpoint to capture reached drops and void missed holds.

### Phase 2: Creator Attribution & Commissions (Immediate Next Step)
- [ ] Database schema for Creators (discount codes, Stripe Connect IDs, commission rates).
- [ ] Webhook attribution (`orders/create`) matching discount codes to log pending commissions.
- [ ] Commission status resolution (`pending` -> `payable`) on drop success.

### Phase 3: Invite-Only & Social Group Drops
- [ ] Gated access via cryptographic URL tokens (`is_private`, `invite_code`).
- [ ] Storefront widget support for entering invite codes or accessing private group pools.
- [ ] Multi-recipient tracking (linking individual checkout shipping addresses to a single drop pool ID).

### Phase 4: Platform Marketplace & Multi-Vendor Payouts
- [ ] Transition engine to Stripe Connect / Marketplace architecture.
- [ ] Automated platform fee deduction ($X\%$ take rate on GMV) upon drop goal capture.
- [ ] Automated supplier order transmission (via vendor webhooks / dropshipping APIs).

## Architectural Guidelines for Claude Code
- Maintain backward compatibility with the core Shopify Theme App Extension engine.
- Store high-level architectural updates in `README.md` to keep context lightweight.
- Prioritize atomic, fail-safe transaction handling for all money-touching mutation endpoints.
