"""CountMy extraction regression battery.

Runs the golden set against the live /extract endpoint and prints a per-language
scorecard plus the worker version that answered. Exit code is non-zero if any
English or Pidgin case fails - those are the guarded languages. Twi cases are
reported but do not fail the run yet (known partial support, see memory).

Usage:  python worker/battery.py            # run everything
        python worker/battery.py --lang twi # one language

Why this exists (15 Sep 2026): a longer Twi glossary in the prompt silently
turned "I sold two shirts for 50 cedis" into 50 cedis EACH. It was caught only
because one English sentence happened to be in the ad-hoc test. Every change to
the prompt, the model, the grounding code or the Worker should run this first.

Case format: (language, sentence, expected) where expected is a list of dicts
with the fields that must match exactly. Fields not listed are not checked.
Per-unit price for a sale is what the Worker stores, so "2 shirts for 50" is
price 25.
"""
import json
import sys
import urllib.request

API = "https://countmy-api.boatengbobby.workers.dev/extract"

CASES = [
    # ---- English: guarded ----
    ("en", "I sold two shirts for 50 cedis", [{"type": "sale", "item": "shirts", "qty": 2, "price": 25}]),
    ("en", "sold five bags of rice for ten cedis each", [{"type": "sale", "item": "rice", "qty": 5, "price": 10}]),
    ("en", "I sold one bag of rice for 30 cedis", [{"type": "sale", "qty": 1, "price": 30}]),
    ("en", "Ama owes me 120 cedis", [{"type": "debt_in", "customer": "Ama", "price": 120}]),
    ("en", "Kofi owes me fifty cedis", [{"type": "debt_in", "customer": "Kofi", "price": 50}]),
    ("en", "customer owes me 80 cedis", [{"type": "debt_in", "price": 80}]),
    ("en", "I spent 35 cedis on transport", [{"type": "expense", "item": "transport", "price": 35}]),
    ("en", "I bought stock for 200 cedis", [{"type": "expense", "item": "stock", "price": 200}]),
    ("en", "I owe Mensah 400 cedis", [{"type": "debt_out", "supplier": "Mensah", "price": 400}]),
    ("en", "I owe Kofi 50 cedis for rice", [{"type": "debt_out", "supplier": "Kofi", "price": 50}]),
    ("en", "I still owe the supplier 400", [{"type": "debt_out", "price": 400}]),
    # ---- Pidgin: guarded ----
    ("pidgin", "I sell five shirts today, 300 cedis", [{"type": "sale", "item": "shirts", "qty": 5, "price": 60}]),
    ("pidgin", "I buy stock today, 200 cedis", [{"type": "expense", "item": "stock", "price": 200}]),
    # ---- Twi: reported, not yet guarded ----
    ("twi", "Ama de me ka cedis aduonum", [{"type": "debt_in", "customer": "Ama", "price": 50}]),
    ("twi", "Ama de me ka cedis ɔha aduonu", [{"type": "debt_in", "customer": "Ama", "price": 120}]),
    ("twi", "Kofi de me ka cedis aduasa", [{"type": "debt_in", "customer": "Kofi", "price": 30}]),
    ("twi", "Metɔn rice bags mmienu, cedis aduasa", [{"type": "sale", "qty": 2}]),
    ("twi", "Ennɛ metɔn ntoma anum, cedis ɔha", [{"type": "sale", "qty": 5}]),
    ("twi", "Me tɔn nsuo bag baako 15 cedis", [{"type": "sale", "qty": 1, "price": 15}]),
    # ---- Pidgin two-event: reported, known gap ----
    ("pidgin-2ev", "Ama buy two dresses, she still owe me 50", [{"type": "sale", "qty": 2}, {"type": "debt_in", "customer": "Ama", "price": 50}]),
]

GUARDED = {"en", "pidgin"}


def call(text):
    body = json.dumps({"text": text}).encode("utf-8")
    req = urllib.request.Request(API, data=body, headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0 CountMy-battery/1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def matches(expected, events):
    if len(events) < len(expected):
        return False
    used = set()
    for exp in expected:
        hit = None
        for i, ev in enumerate(events):
            if i in used:
                continue
            if all(ev.get(k) == v for k, v in exp.items()):
                hit = i
                break
        if hit is None:
            return False
        used.add(hit)
    return True


def main():
    only = None
    if "--lang" in sys.argv:
        only = sys.argv[sys.argv.index("--lang") + 1]
    totals, passes = {}, {}
    version = None
    failed_guarded = []
    for lang, text, expected in CASES:
        if only and lang != only:
            continue
        try:
            resp = call(text)
        except Exception as e:  # network or 5xx
            resp = {"events": [], "error": str(e)}
        version = resp.get("wv", version)
        ok = matches(expected, resp.get("events", []))
        totals[lang] = totals.get(lang, 0) + 1
        passes[lang] = passes.get(lang, 0) + (1 if ok else 0)
        mark = "OK  " if ok else "FAIL"
        print(f"{mark} [{lang:10}] {text:48} -> {json.dumps(resp.get('events'), ensure_ascii=False)}")
        if not ok and lang in GUARDED:
            failed_guarded.append(text)
    print()
    print(f"worker version: {version}")
    for lang in totals:
        print(f"{lang:10} {passes[lang]}/{totals[lang]}")
    if failed_guarded:
        print("\nGUARDED FAILURES (English/Pidgin regressed):")
        for t in failed_guarded:
            print("  -", t)
        sys.exit(1)


if __name__ == "__main__":
    main()
