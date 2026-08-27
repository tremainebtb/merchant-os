# Merchant OS — Product Requirements (source of truth)

Last updated: 2026-08-27. This file, not chat history, is the record of what's decided.

## What this is

A ledger a Ghanaian shop owner opens once a day. Not "inventory management." Not "AI bookkeeping."
**"Know your money."**

## Core loop (v1 — build this week)

- `+ Sale` — item, quantity, price. Total auto-calculated.
- `+ Expense` — what, amount.
- `Customer owes me` — name, amount, what for.
- `I owe supplier` — name, amount, what for.
- `Today` screen — Sales / Expenses / Customers owe me / Estimated balance, front and center on open.
- Full history, filterable by day.

## Explicitly NOT in v1 — do not build until evidence says so

- Voice input (Track B — comes after real usage exists to test against, not synthetic samples)
- WhatsApp Business API integration
- Payment processing / holding merchant money
- Staff accounts / multi-user
- Loans, credit scoring, financial products of any kind
- Native app store builds

Reason for each: no merchant evidence yet that these are needed to get someone using the core loop daily. Add only when a specific merchant, in the pilot, blocks on its absence.

## Non-negotiables

1. **Offline-first.** Every action above works with zero signal. Sync when connectivity returns. No "no internet" error blocking a sale from being recorded.
2. **No silent financial mutations.** Nothing gets written to a total without the owner seeing the number first.
3. **Data-light.** No autoplay, no heavy images, no unnecessary background refresh — most Ghanaian mobile data is prepaid and metered.
4. **Zero learning curve.** If it needs a tutorial, it's wrong. Owner opens app, sees today's number, taps one of four buttons.
5. **Local language for money, not software jargon.** "Customer owes me," not "Accounts Receivable."

## Tech decision (and why)

**Progressive Web App (PWA)**, not native. Installable from a browser link, no app store friction, works on any Android phone (dominant in Ghana), one codebase.

**Storage: IndexedDB locally, always** — every entry writes to the device first, instantly, regardless of network. This is v1 and is fully offline-capable on its own with zero external dependency.

**Sync layer: deferred, not blocking.** Hand-rolling CRDT conflict resolution (multi-device sync) was flagged across every round of the earlier research as the highest-risk custom engineering work — the place AI-generated code "looks beautiful while containing catastrophic edge cases." v1 ships single-device, local-first, no sync, and is fully useful on its own (one phone, one owner, matches how the merchant already works). A managed sync backend (Firebase Firestore has offline persistence and conflict handling built in — this is deliberately NOT hand-rolled) gets added only once a real pilot merchant needs a second device, not before.

## Pricing — not fixed, to be tested

Free tier (today screen + last 7 days) vs. paid tier (full history + export). Price cohorts to test once there's a live pilot: GHS 49 / 79 / 99. Anchor context: YebSales (Ghana-based, live competitor) charges GHS 99.99–299.99 for a comparable product; Catlog's Ghana entry price has moved between GHS 42–85 across its own repricings.

## Kill / scale gates (first 90 days of real pilot use, not launch hype)

| Metric | Red | Green |
|---|---|---|
| 7-day activation (used it daily) | <20% | ≥40% |
| 30-day retention | <20% | ≥35% |
| Free → paid conversion | <2% | ≥5% |
| Month-2 paid retention | <70% | ≥85% |
| Data loss on device | any | zero |

These are internal decision thresholds for this build, not published Ghanaian market benchmarks — no such benchmark exists publicly for this exact product.

## Known open risk, named honestly

Kippa (Nigeria) — funded, competent team — could not make standalone bookkeeping-for-informal-traders pay on its own, and pivoted into other lines. That is the closest real regional precedent to this exact product category. It's a reason to gate hard on real paid retention before investing further, not a reason not to try.
