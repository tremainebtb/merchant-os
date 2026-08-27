# CountMy — Product Requirements (source of truth)

Last updated: 2026-08-27. This file, not chat history, is the record of what's decided.

## What this is

A ledger a Ghanaian shop owner opens once a day. Not "inventory management." Not "AI bookkeeping."
**"Know your money."**

## Naming — locked, with the real trail that got here (27 Aug)

**Brand name: CountMy** (countmy.app confirmed available via direct RDAP registry lookup, not inference). **"Know your money" survives as the tagline**, not the site name — it's still good, tested UX copy, just can't be the dominant title/domain.

Why it changed: the original plan named the product "Know Your Money" outright. Checked only *after* being asked directly whether that had been verified — it hadn't, and shouldn't have been called "locked" before it was. Real findings from that check:
- **knowyourmoney.co.uk** is a 20-year-old, NerdWallet-owned UK financial comparison site (~400K visits/month) — a small Ghanaian bookkeeping app would never be findable under a colliding name.
- **knowyourmoney.app** is a separate live personal-finance product, in the same category.
- A live US trademark on the exact phrase exists (cancelled/dead, but shows the phrase has real trademark history in financial services); UK/Ghana trademark registers weren't directly queryable and were flagged as a genuine gap, not assumed clear.

Backup candidates generated afterward (Owey, Balanzo, Zamu, Countio, Sumzy) were each checked and each failed — either a direct product conflict (Countio vs. Counto, Sumzy vs. Sumly) or, more usefully, a lesson caught by directly querying domain registries (RDAP) rather than trusting "no search hits = available": **owey.com and owey.app were both already registered**, despite an earlier pass reporting no conflict found — absence of search hits is not the same as confirmed availability, and every domain claim after this point was checked by direct registry query, not inferred.

Also tried and rejected: **"Sika"** (the real Twi word for money) as a brand root — domain-available, but a targeted check found it's already the single most reused word in Ghanaian fintech branding (SikaPay, SikaCash, Sika Credit, Sikaflow, the award-winning Naa Sika, and others going back a decade). Also rejected on a second, self-caught error: candidates using "kobo" (Nigerian currency) and "duka" (Swahili for shop) were geographically wrong for a Ghana-specific product — the same borrowed-region mistake flagged earlier in this project, caught before shipping this time.

**The general lesson, not just this one decision:** local-language/local-currency words feel authentic but are exactly where founders already reach first — they're the most contested naming space, not the safest. A plain, functional, geography-neutral name (matching how Bumpa/Catlog/Pocketi/Kippa are actually built — short invented-or-plain words, not local-language claims) is both lower-conflict and scales past Ghana into other African markets and beyond without needing a rename later.

## Scope-creep rule — permanent, not optional

**No infrastructure gets built solely because an advisor (human or AI) recommends it.** Each architectural expansion needs one of: observed user demand (a real pilot merchant hit the limit), a demonstrated reliability/security failure (reproduced, not hypothetical), or a clear regulatory requirement. This project now runs advice through three AI systems (Claude, ChatGPT, Gemini) — the risk isn't bad code, it's three confident AIs agreeing on something nobody asked for. Cloud sync, a full backend, and an automated Playwright/Cypress harness were all proposed and declined on 27 Aug on exactly this basis: zero real users had hit the limits they'd solve.

## Known pre-scale gate, not urgent for a private pilot

Ghana's Data Protection Commission requires organisations processing personal data to register (low fee, ~GHS120 for small operators) and meet basic technical/organisational safeguards. A 5-person private pilot with people Bobby knows directly is a materially different risk than public commercial launch. **This must happen before any public marketing or launch beyond known pilot contacts — flagged now so it doesn't get forgotten, not blocking the pilot itself.**

## Engineering rule — permanent, not optional

**Never mark a fix or deploy complete based on source inspection, commit status, or build success alone. Verify the deployed behaviour live, by actually exercising it, before calling it done.** Confirmed necessary in practice, not theoretical: on 27 Aug, two real deploys landed cleanly on GitHub (commit history clean, file content correct) but silently never reached an already-visited browser — a service worker "network-first" fetch was still quietly satisfied by the browser's own HTTP cache underneath. Caught only because the fix was re-tested against a browser that had already loaded the old version, not a fresh one. A fresh-browser-only test would have produced a false green result. Same logic on every subsequent check: even after fixing that, a plain page navigation once still silently served a stale document until a hard/forced reload was used — the lesson generalizes past this one bug: assume caching (service worker, browser HTTP cache, or the navigation itself) can lie about whether a fix actually shipped, and verify with a forced fresh load against a previously-visited client, not just a clean one.

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
