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
    # ---- Must return nothing: guarded. No amount was said, so no record may exist. ----
    ("silence", "hello how are you", []),
    ("silence", "the market was very busy today", []),
    ("silence", "Ama came to the shop this morning", []),
]

GUARDED = {"en", "pidgin", "silence"}


def call(text):
    body = json.dumps({"text": text}).encode("utf-8")
    req = urllib.request.Request(API, data=body, headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0 CountMy-battery/1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


ONES = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
        "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
        "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19}
TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
TWI = {"baako": 1, "mmienu": 2, "mmiensa": 3, "enan": 4, "anum": 5, "nsia": 6, "nson": 7, "nwotwe": 8,
       "nkron": 9, "du": 10, "edu": 10, "dunum": 15, "aduonu": 20, "aduasa": 30, "aduanan": 40, "aduonum": 50,
       "aduosia": 60, "aduoson": 70, "oha": 100, "ha": 100, "ahanu": 200, "ahasa": 300, "apem": 1000}


def norm(text):
    return "".join(ch if ch.isalnum() or ch == " " else " " for ch in text.lower().replace("\u0254", "o").replace("\u025b", "e"))


def spoken_numbers(text):
    """Every amount a listener could have heard: digits, English words (incl.
    'one hundred and twenty', 'fifty'), Twi words and their additive runs."""
    toks = norm(text).split()
    found = set()
    for t in toks:
        if t.isdigit():
            found.add(int(t))
    # English word runs
    i = 0
    while i < len(toks):
        total, cur, seen, j = 0, 0, False, i
        while j < len(toks):
            t = toks[j]
            if t in ONES:
                cur += ONES[t]; seen = True
            elif t in TENS:
                cur += TENS[t]; seen = True
            elif t == "hundred" and seen:
                cur = (cur or 1) * 100
            elif t == "thousand" and seen:
                total += (cur or 1) * 1000; cur = 0
            elif t == "and" and seen:
                pass
            else:
                break
            j += 1
        if seen:
            found.add(total + cur)
            # also each single word on its own
            for k in range(i, j):
                if toks[k] in ONES: found.add(ONES[toks[k]])
                if toks[k] in TENS: found.add(TENS[toks[k]])
            i = j
        else:
            i += 1
    # Twi runs
    run = 0
    for t in toks:
        if t in TWI:
            found.add(TWI[t]); run += TWI[t]; found.add(run)
        else:
            run = 0
    return found


def invariant_failures(text, events):
    """Rules every record must obey. Returns a list of human-readable breaches."""
    out = []
    spoken = spoken_numbers(text)
    n = norm(text)
    says_i_owe = any(w in f" {n} " for w in (" i owe ", " we owe ", " i still owe ", " i dey owe "))
    says_owes_me = any(w in f" {n} " for w in (" owes me ", " owe me ", " de me ka ", " dey owe me "))
    if not spoken and events:
        out.append("hallucinated: no amount was said but a record was produced")
    for ev in events:
        t = ev.get("type")
        # direction
        if says_i_owe and not says_owes_me and t == "debt_in":
            out.append("direction: transcript says I owe, record says they owe me")
        if says_owes_me and not says_i_owe and t == "debt_out":
            out.append("direction: transcript says they owe me, record says I owe")
        # amounts must trace to something spoken
        price, qty = ev.get("price"), ev.get("qty")
        if isinstance(price, (int, float)):
            ok = price in spoken or (isinstance(qty, (int, float)) and qty and round(price * qty) in spoken)
            if not ok:
                out.append(f"amount: price {price} (qty {qty}) traces to nothing spoken {sorted(spoken)}")
        if isinstance(qty, (int, float)) and qty not in spoken and qty != 1:
            out.append(f"quantity: qty {qty} was never said")
        # entities must have been said
        for key in ("customer", "supplier"):
            name = ev.get(key)
            if isinstance(name, str) and name.strip() and norm(name).strip() not in n:
                out.append(f"entity: {key} '{name}' was never said")
    return out


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
    invariant_breaches = []
    for lang, text, expected in CASES:
        if only and lang != only:
            continue
        try:
            resp = call(text)
        except Exception as e:  # network or 5xx
            resp = {"events": [], "error": str(e)}
        version = resp.get("wv", version)
        events = resp.get("events", [])
        ok = matches(expected, events)
        breaches = invariant_failures(text, events)
        totals[lang] = totals.get(lang, 0) + 1
        passes[lang] = passes.get(lang, 0) + (1 if ok else 0)
        mark = "OK  " if ok else "FAIL"
        print(f"{mark} [{lang:10}] {text:48} -> {json.dumps(events, ensure_ascii=False)}")
        for b in breaches:
            print(f"     INVARIANT BREACH: {b}")
            invariant_breaches.append((text, b))
        if not ok and lang in GUARDED:
            failed_guarded.append(text)
    print()
    print(f"worker version: {version}")
    for lang in totals:
        print(f"{lang:10} {passes[lang]}/{totals[lang]}")
    if invariant_breaches:
        print("\nINVARIANT BREACHES (any language - a record said something that was not spoken):")
        for t, b in invariant_breaches:
            print(f"  - {t}: {b}")
    if failed_guarded:
        print("\nGUARDED FAILURES (English/Pidgin/silence regressed):")
        for t in failed_guarded:
            print("  -", t)
    if failed_guarded or invariant_breaches:
        sys.exit(1)


if __name__ == "__main__":
    main()
