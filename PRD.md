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

## Deploy pipeline — permanent, not optional

**`git push`, never browser copy-paste or manual upload.** The local repo at `MerchantOS/` has a real `origin` remote (`https://github.com/tremainebtb/merchant-os.git`, branch `main`, GitHub Pages serves from it) with working credentials already cached - `git add` / `git commit` / `git push` is the entire deploy step. This replaced two failed methods from 27 Aug, in order: (1) pasting file contents into the Cloudflare/GitHub web code editors via the OS clipboard - PowerShell's `Set-Clipboard`, even fed correctly-read UTF-8 text, silently corrupted every emoji and em-dash in transit (confirmed by reading raw character codes in the pasted result); (2) a direct multipart file upload of a byte-verified-clean local file to GitHub's own "Upload files" page - this ALSO corrupted the same non-ASCII characters somewhere in GitHub's own pipeline, confirmed by downloading the live bytes afterward. `git push` moves the exact same bytes with no intermediate transcription step, so this class of bug cannot recur. If `git push` ever fails (auth expired, history diverged), fix that - do not fall back to clipboard/upload as a workaround.

**Cloudflare Worker (`worker/worker.js`) is a separate deploy target, NOT covered by GitHub Pages.** It has to be pasted into the Cloudflare dashboard's own code editor and hit Deploy - there is currently no `wrangler` CLI / git-based deploy for it. `worker.js` is kept pure-ASCII (see below) specifically so this remaining copy-paste step stays safe.

**All deployed source files (`index.html`, `app.js`, `service-worker.js`, `worker/worker.js`) are kept pure-ASCII, permanently**, even now that `git push` is available - non-ASCII characters (emoji, em-dashes, curly quotes) are written as HTML numeric entities (`&#x1F50A;`) in HTML or JS unicode escapes (`—`) in JS string literals, never as literal UTF-8 bytes. This is redundant with the `git push` fix for GitHub-hosted files, but it's what protects the Cloudflare Worker paste step, and it costs nothing to keep doing everywhere for consistency. Before adding a literal emoji/em-dash/curly-quote to any of these files, convert it to its escape form first.

## Engineering rule — permanent, not optional

**Never mark a fix or deploy complete based on source inspection, commit status, or build success alone. Verify the deployed behaviour live, by actually exercising it, before calling it done.** Confirmed necessary in practice, not theoretical: on 27 Aug, two real deploys landed cleanly on GitHub (commit history clean, file content correct) but silently never reached an already-visited browser — a service worker "network-first" fetch was still quietly satisfied by the browser's own HTTP cache underneath. Caught only because the fix was re-tested against a browser that had already loaded the old version, not a fresh one. A fresh-browser-only test would have produced a false green result. Same logic on every subsequent check: even after fixing that, a plain page navigation once still silently served a stale document until a hard/forced reload was used — the lesson generalizes past this one bug: assume caching (service worker, browser HTTP cache, or the navigation itself) can lie about whether a fix actually shipped, and verify with a forced fresh load against a previously-visited client, not just a clean one.

## Core loop (v1 — build this week)

- `+ Sale` — item, quantity, price. Total auto-calculated.
- `+ Expense` — what, amount.
- `Customer owes me` — name, amount, what for.
- `I owe supplier` — name, amount, what for.
- `Today` screen — Sales / Expenses / Customers owe me / Estimated balance, front and center on open.
- Full history, filterable by day.

## Cost — zero, permanently, not just for v1

Bobby will not pay for any part of this stack (27 Aug). Every service used must be free with no card on file, on infrastructure already under his control — not a free trial, not a low usage tier that later requires billing. Transcription runs on **Cloudflare Workers AI** (`@cf/openai/whisper-large-v3-turbo`, `env.AI` binding), not OpenAI's paid Whisper API — same Cloudflare account already used for the domain and KV, free 10,000 Neurons/day, no signup, no card, verified twice independently against Cloudflare's own docs (27 Aug) before building on it. Known real risk, not hypothetical: that quota is shared across the whole account, and Cloudflare Community has multiple 2025-2026 reports of the free quota misreporting as exhausted (error 4006) even at low usage — `worker/worker.js` returns an honest "try again, or type instead" error rather than pretending, and the frontend already has a working typed-input fallback. Re-verify this before any future model swap or before Bobby ever pays for anything in this stack — don't assume a cost decision from one session still holds.

## Voice extraction — evidence-span architecture, 27 Aug, real test results not a benchmark claim

The voice pipeline is Whisper transcription -> `@cf/meta/llama-3.2-3b-instruct` structured multi-event extraction -> a deterministic, model-independent, EVIDENCE-VERIFYING sanitizer (`sanitizeEvents()` in `worker/worker.js`) -> a review UI where every field is tagged "AI heard this - check it" (has a value) or "Didn't catch this - tap to enter" (amber, missing) -> explicit per-transaction Save, never automatic.

**The catastrophic finding (first pass, 27 Aug):** given one ambiguous sentence about a single amount ("I think maybe it was 500 or 5000 cedis"), the model fabricated 5 entirely fictional unrelated transactions (pencils, a phone, bottled water, cake, a book) that were never mentioned. A type-only sanitizer could not catch this - a fabricated "GHS 5000" is a perfectly valid number, just one attached to an invented item.

**The fix, same day: evidence-span verification.** Every field the model returns must now include the literal transcript substring it's based on (`{"value": 150, "evidence": "one fifty"}`). The sanitizer independently checks that substring actually occurs in the real transcript (case/punctuation-normalized, capped at 40 chars to block "the whole transcript is my evidence" cheating) before trusting the value - unverified fields are dropped, and an event with NO verified identity (item/customer/supplier) is discarded outright, even if it carries a real-sounding price. This is what actually kills the fabrication case, not the prompt wording: **re-run 3 times live after the fix, the fabrication cascade produced zero events all 3 times.**

**A real architecture bug was found and fixed in the same pass:** asking the model for a computed per-unit price (e.g. "2 bags for 300" -> 150 each) forced it to invent evidence text like "one hundred and fifty cedis" for a number that was never actually spoken - only "300" was said. Fix: the schema now lets the model report a spoken `total` (with real evidence) instead of a derived `price`, and `sanitizeEvents()` computes price = total / qty itself, deterministically, never trusting the model's own arithmetic or invented evidence for it.

**Expanded deterministic test suite: 11/11 passing**, including the exact fabrication shape that caused the live failure, evidence-string tampering, whole-transcript-as-evidence cheating, and the original "high"-in-a-price-field bug. These are 100% reproducible unit tests of `sanitizeEvents()` alone - no LLM involved, no claim about real-world accuracy.

**Do not describe voice as "airtight," "production-ready," or give it a specific accuracy percentage anywhere (marketing, in-app copy, or to Bobby) until it has been scored against 100-200 REAL Ghanaian merchant recordings.** Synthetic/invented test transcripts, however adversarial, are not evidence of real-world accuracy. Confirmed remaining limitation, honestly observed via repeated live runs after the fix: the 3B model does not consistently populate every field even when the information is clearly present in the transcript (re-running the identical multi-event test produced complete results in some runs and partial in others) - this is inherent instruction-following variance at this model size, not a sanitizer defect, and it is exactly what the review UI's amber "needs a number" flag exists to catch. It has not been eliminated and should not be claimed as eliminated.

**What actually keeps this safe: the review UI plus the evidence sanitizer together, not the model.** Every extracted field is shown to the merchant, editable, before Save. This is deliberate: the product does not promise accurate transcription, it promises **zero silently-created financial records** (PRD non-negotiable #2, above). Do not weaken the review UI (auto-save, hide fields, or treat "AI heard this" as pre-confirmed) without first fixing any newly-found hallucination pathway with the same live-test-then-fix discipline used here.

**Frozen until real recordings exist:** further prompt tweaking, model swaps, or parser patching aimed at improving accuracy on invented test sentences, beyond fixing a specific reproduced bug (as the evidence-span and total-field fixes above were - those were real bugs in shipped code, not speculative polish). Next real step, once pilot merchants exist: collect 100-200 real recordings (quiet / noisy / accented / code-switched / hesitant), score numeric/event/type/evidence accuracy against them, and only then decide whether the free 3B model is sufficient or whether the architecture needs to change (e.g. a second-pass check on low-confidence transactions) - do not build that escalation path speculatively before the first real recordings exist. A harness function to score real recordings once collected (transcript + expected events -> accuracy report) is a reasonable next build once a first batch of real audio exists - do not build it against invented recordings first.

**Also explicitly deferred, no evidence to act on yet:** locking Whisper's language to English (`language: 'en'` in `worker/worker.js`) was set for a plausible accuracy reason, but ChatGPT correctly flagged that eventual Ghanaian users will code-switch (English/Twi) and hard-coding English-only is a decision that needs its own real-recording evidence, not assumption. Revisit once real Ghanaian recordings show whether English-pinned, auto-detect, or explicit user-selected language performs best - do not change it without that evidence either.

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
