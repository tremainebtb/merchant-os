# -*- coding: utf-8 -*-
"""Generate the cedi exchange-rate pages (rates/*.html) from a daily rate fetch.

Run by .github/workflows/rates.yml every morning; can be run by hand:
    python tools/gen_rates.py            # fetch live rates, write pages
    python tools/gen_rates.py --offline  # reuse rates/rates.json

Why these pages exist (19 Sep 2026): Google autocomplete for Ghana shows
"dollar to cedi" (314 distinct phrasings), "cedi to dollar" (270), "pound to
cedi" (269), "euro to cedi" (218), "cedi to naira" (214), "cfa to cedi" (150),
with amount variants ("1000 dollars to cedis", "how much is 3000 naira in
cedis"). One page per pair and per amount, refreshed daily, is the same shape
that gives ChopRadar its search traffic. Source: open.er-api.com mid-market
rates (free, daily). Banks and forex bureaus sell above the mid rate; every
page says so and links the Bank of Ghana page.
"""
import io, json, os, sys, datetime, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'rates')
os.makedirs(OUT, exist_ok=True)

CUR = [
    # code, singular, plural, adjective for titles, symbol, slug, region note
    ('USD', 'dollar', 'dollars', 'US dollar', '$', 'dollar', 'the United States'),
    ('GBP', 'pound', 'pounds', 'British pound', '£', 'pound', 'the United Kingdom'),
    ('EUR', 'euro', 'euros', 'euro', '€', 'euro', 'the euro area'),
    ('NGN', 'naira', 'naira', 'Nigerian naira', '₦', 'naira', 'Nigeria'),
    ('XOF', 'CFA', 'CFA', 'West African CFA franc', 'CFA', 'cfa', 'Togo, Côte d’Ivoire, Burkina Faso and the rest of the CFA zone'),
    ('CNY', 'yuan', 'yuan', 'Chinese yuan', '¥', 'yuan', 'China'),
    ('ZAR', 'rand', 'rand', 'South African rand', 'R', 'rand', 'South Africa'),
    ('CAD', 'Canadian dollar', 'Canadian dollars', 'Canadian dollar', 'C$', 'canadian-dollar', 'Canada'),
    ('AED', 'dirham', 'dirhams', 'UAE dirham', 'AED', 'dirham', 'Dubai and the UAE'),
]
FOREIGN_AMOUNTS = [1, 5, 10, 20, 50, 100, 200, 300, 500, 1000, 1500, 2000, 3000, 5000, 10000, 100000]
CEDI_AMOUNTS = [100, 500, 1000, 2000, 5000, 10000]
TABLE_AMOUNTS = [1, 5, 10, 20, 50, 100, 200, 500, 1000, 5000, 10000]

def fetch_rates():
    url = 'https://open.er-api.com/v6/latest/USD'
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'countmy-rates/1.0'}), timeout=30) as r:
        d = json.loads(r.read().decode('utf-8'))
    if d.get('result') != 'success' or 'GHS' not in d['rates']:
        raise SystemExit('rate fetch failed')
    ghs = d['rates']['GHS']
    per_cedi = {}
    for code, *_ in CUR:
        if code == 'USD':
            per_cedi[code] = ghs
        else:
            per_cedi[code] = ghs / d['rates'][code]  # cedis per 1 unit of foreign
    return {'date': datetime.date.today().isoformat(), 'source': 'open.er-api.com mid-market, USD base',
            'source_time': d.get('time_last_update_utc', ''), 'ghs_per_unit': per_cedi}

def fmt(n, dp=2):
    if n >= 1000:
        return '{:,.{p}f}'.format(n, p=dp)
    return '{:.{p}f}'.format(n, p=dp)

def cedis(n):
    if n >= 100:
        return 'GH₵ ' + '{:,.0f}'.format(round(n))
    if n < 0.1:
        return 'GH₵ ' + '{:,.4f}'.format(n)
    return 'GH₵ ' + '{:,.2f}'.format(n)

ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
def words(n):
    n = int(round(n))
    if n == 0: return 'zero'
    def small(x):
        s = ''
        if x >= 100:
            s += ONES[x // 100] + ' hundred'
            x %= 100
            if x: s += ' and '
        if x >= 20:
            s += TENS[x // 10]
            if x % 10: s += '-' + ONES[x % 10]
        elif x:
            s += ONES[x]
        return s
    parts = []
    for div, name in ((1000000000, 'billion'), (1000000, 'million'), (1000, 'thousand')):
        if n >= div:
            parts.append(small(n // div) + ' ' + name)
            n %= div
    if n:
        parts.append(small(n))
    return ', '.join(parts)

def human_date(iso):
    d = datetime.date.fromisoformat(iso)
    return d.strftime('%-d %B %Y') if os.name != 'nt' else d.strftime('%d %B %Y').lstrip('0')

HEAD = '''<!doctype html>
<html lang="en-GH">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="https://countmy.app/rates/{file}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="https://countmy.app/og-image.png">
<meta property="og:url" content="https://countmy.app/rates/{file}">
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@700;800&family=Work+Sans:wght@400;600&display=swap">
<link rel="stylesheet" href="/guides/guide.css">
<style>
.rate{{font-family:Manrope,system-ui,sans-serif;font-weight:800;font-size:2rem;line-height:1.15;margin:6px 0 2px;font-variant-numeric:tabular-nums}}
.conv{{background:var(--surface);border:1px solid var(--rule);border-radius:14px;padding:16px;margin:14px 0}}
.conv label{{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0;font-weight:600}}
.conv input{{width:150px;max-width:45%;font:inherit;font-size:18px;padding:8px 10px;border:1px solid var(--rule);border-radius:10px;text-align:right;background:var(--paper);color:var(--ink);font-variant-numeric:tabular-nums}}
.conv .out{{display:flex;justify-content:space-between;align-items:baseline;padding:10px 0 0;font-family:Manrope,system-ui,sans-serif;font-weight:800;font-size:18px;gap:8px;flex-wrap:wrap}}
.conv .out b{{font-size:24px;font-variant-numeric:tabular-nums}}
.pairs a{{display:inline-block;margin:4px 6px 4px 0;padding:6px 12px;border:1px solid var(--rule);border-radius:100px;color:var(--ink);text-decoration:none;font-weight:600;font-size:.9rem;background:var(--surface)}}
</style>
<script type="application/ld+json">
{{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{faq}]}}
</script>
</head>
<body>
<div class="wrap">
  <div class="top"><a href="/">Count<span class="my">My</span></a></div>
'''

FOOT = '''
  <h2>Other rates today</h2>
  <p class="pairs">{pairs}</p>
  <a class="cta" href="/?utm_source=rates&amp;utm_medium=page&amp;utm_campaign={slug}"><svg viewBox="0 0 24 24" fill="none"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" stroke="currentColor" stroke-width="2"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>Bought goods today? Say it, CountMy keeps the record</a>
  <p class="cta-sub">Free money notebook for any business in Ghana. No password, no MoMo PIN, no Ghana Card.</p>
  <p class="foot">Rate: mid-market rate from <a href="https://www.exchangerate-api.com" rel="noopener">ExchangeRate-API</a> (open data), refreshed every morning; this page was generated on {date}. Banks and forex bureaus buy below and sell above the mid rate; the Bank of Ghana publishes the <a href="https://www.bog.gov.gh/treasury-and-the-markets/daily-interbank-fx-rates/" rel="noopener">daily interbank rates</a>. Not financial advice. <a href="/guides/who-owes-me.html">Guides for your business</a> · <a href="/privacy.html">Privacy</a></p>
</div>
<script>
(function(){{var r={rate};var a=document.getElementById('c_amt'),o=document.getElementById('c_out'),rev=document.getElementById('c_rev');if(!a)return;function f(n){{return n>=100?Math.round(n).toLocaleString('en-GH'):n.toFixed(2);}}
a.addEventListener('input',function(){{var v=parseFloat(a.value)||0;o.textContent='GH\\u20b5 '+f(v*r);if(rev)rev.textContent=f(v/r);}});}})();
</script>
</body>
</html>
'''

def faq_json(items):
    return ','.join('{"@type":"Question","name":%s,"acceptedAnswer":{"@type":"Answer","text":%s}}' % (json.dumps(q), json.dumps(a)) for q, a in items)

def write(file, html):
    io.open(os.path.join(OUT, file), 'w', encoding='utf-8', newline='\n').write(html)

def pair_links(exclude=None):
    out = []
    for code, sing, plur, adj, sym, slug, region in CUR:
        if slug != exclude:
            out.append('<a href="/rates/%s-to-cedi.html">%s to cedi</a>' % (slug, sing.capitalize() if code != 'XOF' else 'CFA'))
    out.append('<a href="/rates/cedi-to-naira.html">Cedi to naira</a>')
    out.append('<a href="/rates/cedi-to-dollar.html">Cedi to dollar</a>')
    return ' '.join(out)

def gen(rates):
    date = rates['date']; hd = human_date(date)
    files = []
    for code, sing, plur, adj, sym, slug, region in CUR:
        r = rates['ghs_per_unit'][code]
        name = 'CFA' if code == 'XOF' else sing
        pslug = {'USD': 'dollars', 'GBP': 'pounds', 'EUR': 'euros', 'NGN': 'naira', 'XOF': 'cfa', 'CNY': 'yuan', 'ZAR': 'rand', 'CAD': 'canadian-dollars', 'AED': 'dirhams'}[code]
        base = 1000 if code in ('NGN', 'XOF') else 1
        Name = name.capitalize() if code != 'XOF' else 'CFA'
        # ---- foreign -> cedi pair page
        title = '%s to cedi rate today (%s): %s %s = %s' % (Name, hd, fmt(base, 0), code, cedis(base * r))
        desc = 'How much is the %s to the cedi today, %s: 1 %s is %s at the mid-market rate. Converter, a table from 1 to 10,000, what banks and forex bureaus charge on top, and the reverse rate.' % (name, hd, code, cedis(r))
        higher = r > 1
        faq = [
            ('How much is %s %s to the cedi today?' % (fmt(base, 0), name if base == 1 else plur), '%s %s = %s on %s at the mid-market rate. Banks and forex bureaus sell %s for more than this and buy for less.' % (fmt(base, 0), code, cedis(base * r), hd, plur)),
            ('Is the %s higher than the cedi?' % name, ('Yes. One %s buys %s.' % (name, cedis(r))) if higher else ('No. One cedi buys %s %s; one %s is only %s.' % (fmt(1 / r), plur, name, cedis(r)))),
            ('What is the Bank of Ghana rate?', 'The Bank of Ghana publishes daily interbank buying and selling rates on its website; this page shows the international mid-market rate, which sits between a bank’s buying and selling price.'),
        ]
        rows = ''.join('<tr><td class="num">%s %s</td><td class="num">%s</td></tr>' % (fmt(a, 0), code, cedis(a * r)) for a in TABLE_AMOUNTS)
        rows2 = ''.join('<tr><td class="num">GH₵ %s</td><td class="num">%s %s</td></tr>' % (fmt(a, 0), fmt(a / r), code) for a in TABLE_AMOUNTS)
        amount_links = ' '.join('<a href="/rates/%s-%s-to-cedis.html">%s %s</a>' % (a, pslug, fmt(a, 0), plur if a != 1 else name) for a in FOREIGN_AMOUNTS)
        body = HEAD.format(title=title, desc=desc, file='%s-to-cedi.html' % slug, faq=faq_json(faq)) + '''
  <h1>%s to cedi rate today</h1>
  <p class="stamp">%s · mid-market rate · refreshed every morning</p>
  <div class="big"><div class="n">%s %s = %s</div><p>1 cedi = %s %s. %s</p></div>
  <div class="conv">
    <label><span>%s</span><input type="number" inputmode="decimal" id="c_amt" placeholder="100"></label>
    <div class="out"><span>Cedis</span><b id="c_out">%s</b></div>
  </div>
  <h2>%s to cedis, quick table</h2>
  <div class="tw"><table><tr><th class="num">%s</th><th class="num">Cedis</th></tr>%s</table></div>
  <h2>Cedis to %s</h2>
  <div class="tw"><table><tr><th class="num">Cedis</th><th class="num">%s</th></tr>%s</table></div>
  <h2>What the bank or forex bureau will actually give you</h2>
  <p>The number above is the mid-market rate, the middle point between what banks buy at and sell at. A bank or bureau in Accra sells %s above it and buys below it, often by 3%% to 6%% each way; "black market" rates quoted on the street sit above the bank selling rate. Take the mid rate as the honest reference and expect to pay more when you buy %s and receive less when you sell.</p>
  <h2>Amounts</h2>
  <p class="pairs">%s</p>
  <h2 class="faq">Questions people ask</h2>
  <div class="faq">%s</div>
''' % (Name, hd, fmt(base, 0), code, cedis(base * r), fmt(1 / r), code, ('One %s is worth more than one cedi.' % name) if higher else ('One cedi is worth more than one %s.' % name),
       Name + 's' if code not in ('XOF', 'NGN', 'CNY', 'ZAR') else Name, cedis(100 * r), Name, Name, rows, plur, Name, rows2, plur, plur, amount_links,
       ''.join('<h3>%s</h3><p>%s</p>' % (q, a) for q, a in faq))
        body += FOOT.format(pairs=pair_links(slug), slug=slug, date=hd, rate=repr(r))
        write('%s-to-cedi.html' % slug, body); files.append('%s-to-cedi.html' % slug)

        # ---- cedi -> foreign pair page
        title = 'Cedi to %s rate today (%s): 1 cedi = %s %s' % (name, hd, fmt(1 / r, 4), code)
        desc = 'How much is the cedi to the %s today, %s: 1 GHS is %s %s; %s %s buys one %s. Converter and tables.' % (name, hd, fmt(1 / r, 4), code, cedis(r), '' , name)
        faq = [('How much is 1 cedi to the %s today?' % name, '1 cedi = %s %s on %s at the mid-market rate.' % (fmt(1 / r, 4), code, hd)),
               ('How much is 1 %s in cedis?' % name, cedis(r) + ' on ' + hd + '.')]
        body = HEAD.format(title=title, desc=desc, file='cedi-to-%s.html' % slug, faq=faq_json(faq)) + '''
  <h1>Cedi to %s rate today</h1>
  <p class="stamp">%s · mid-market rate · refreshed every morning</p>
  <div class="big"><div class="n">1 cedi = %s %s</div><p>1 %s = %s.</p></div>
  <div class="conv">
    <label><span>Cedis</span><input type="number" inputmode="decimal" id="c_amt" placeholder="1000"></label>
    <div class="out"><span>%s</span><b id="c_rev">%s</b></div>
  </div>
  <h2>Cedis to %s</h2>
  <div class="tw"><table><tr><th class="num">Cedis</th><th class="num">%s</th></tr>%s</table></div>
  <h2 class="faq">Questions people ask</h2>
  <div class="faq">%s</div>
''' % (name, hd, fmt(1 / r, 4), code, code, cedis(r), Name, fmt(1000 / r), plur, Name, rows2, ''.join('<h3>%s</h3><p>%s</p>' % (q, a) for q, a in faq))
        body += FOOT.format(pairs=pair_links(slug), slug='cedi-to-' + slug, date=hd, rate=repr(r)).replace("o.textContent='GH\\u20b5 '+f(v*r);", "o&&(o.textContent='GH\\u20b5 '+f(v*r));")
        write('cedi-to-%s.html' % slug, body); files.append('cedi-to-%s.html' % slug)

        # ---- amount pages, foreign -> cedi
        for a in FOREIGN_AMOUNTS:
            v = a * r
            unit = name if a == 1 else plur
            aslug = pslug
            title = '%s %s to cedis today (%s): %s' % (fmt(a, 0), unit, hd, cedis(v))
            desc = 'How much is %s %s in cedis today, %s: %s at the mid-market rate, %s cedis in words. Table of nearby amounts and the reverse.' % (fmt(a, 0), unit, hd, cedis(v), words(v))
            faq = [('How much is %s %s in cedis?' % (fmt(a, 0), unit), '%s %s = %s on %s at the mid-market rate (1 %s = %s).' % (fmt(a, 0), unit, cedis(v), hd, code, cedis(r))),
                   ('%s %s to cedis in words' % (fmt(a, 0), unit), (words(v) + ' cedis').capitalize())]
            near = ''.join('<tr><td class="num">%s %s</td><td class="num">%s</td></tr>' % (fmt(x, 0), code, cedis(x * r)) for x in FOREIGN_AMOUNTS if x != 100000)
            body = HEAD.format(title=title, desc=desc, file='%s-%s-to-cedis.html' % (a, aslug), faq=faq_json(faq)) + '''
  <h1>%s %s to cedis today</h1>
  <p class="stamp">%s · mid-market rate · refreshed every morning</p>
  <div class="big"><div class="n">%s %s = %s</div><p>%s. Rate used: 1 %s = %s.</p></div>
  <div class="conv">
    <label><span>%s</span><input type="number" inputmode="decimal" id="c_amt" placeholder="%s"></label>
    <div class="out"><span>Cedis</span><b id="c_out">%s</b></div>
  </div>
  <h2>Nearby amounts</h2>
  <div class="tw"><table><tr><th class="num">%s</th><th class="num">Cedis</th></tr>%s</table></div>
  <p>Reverse: %s = %s %s. A bank or forex bureau sells %s above this rate and buys below it, often by 3%% to 6%%; the number here is the mid-market reference.</p>
  <h2 class="faq">Questions people ask</h2>
  <div class="faq">%s</div>
''' % (fmt(a, 0), unit, hd, fmt(a, 0), code, cedis(v), (words(v) + ' cedis').capitalize(), code, cedis(r), Name, a, cedis(v), Name, near, cedis(a), fmt(a / r), code, plur, ''.join('<h3>%s</h3><p>%s</p>' % (q, x) for q, x in faq))
            body += FOOT.format(pairs=pair_links(slug), slug=slug, date=hd, rate=repr(r))
            write('%s-%s-to-cedis.html' % (a, aslug), body); files.append('%s-%s-to-cedis.html' % (a, aslug))

        # ---- amount pages, cedi -> foreign
        for a in CEDI_AMOUNTS:
            v = a / r
            aslug = pslug
            title = '%s cedis to %s today (%s): %s %s' % (fmt(a, 0), plur, hd, fmt(v), code)
            desc = 'How much is %s cedis in %s today, %s: %s %s at the mid-market rate. Nearby amounts and the reverse.' % (fmt(a, 0), plur, hd, fmt(v), code)
            faq = [('How much is %s cedis in %s?' % (fmt(a, 0), plur), '%s cedis = %s %s on %s (1 %s = %s).' % (fmt(a, 0), fmt(v), code, hd, code, cedis(r)))]
            near = ''.join('<tr><td class="num">GH₵ %s</td><td class="num">%s %s</td></tr>' % (fmt(x, 0), fmt(x / r), code) for x in CEDI_AMOUNTS)
            body = HEAD.format(title=title, desc=desc, file='%s-cedis-to-%s.html' % (a, aslug), faq=faq_json(faq)) + '''
  <h1>%s cedis to %s today</h1>
  <p class="stamp">%s · mid-market rate · refreshed every morning</p>
  <div class="big"><div class="n">GH₵ %s = %s %s</div><p>Rate used: 1 %s = %s.</p></div>
  <div class="conv">
    <label><span>Cedis</span><input type="number" inputmode="decimal" id="c_amt" placeholder="%s"></label>
    <div class="out"><span>%s</span><b id="c_rev">%s</b></div>
  </div>
  <h2>Nearby amounts</h2>
  <div class="tw"><table><tr><th class="num">Cedis</th><th class="num">%s</th></tr>%s</table></div>
  <h2 class="faq">Questions people ask</h2>
  <div class="faq">%s</div>
''' % (fmt(a, 0), plur, hd, fmt(a, 0), fmt(v), code, code, cedis(r), a, Name, fmt(v), Name, near, ''.join('<h3>%s</h3><p>%s</p>' % (q, x) for q, x in faq))
            body += FOOT.format(pairs=pair_links(slug), slug='cedi-to-' + slug, date=hd, rate=repr(r)).replace("o.textContent='GH\\u20b5 '+f(v*r);", "o&&(o.textContent='GH\\u20b5 '+f(v*r));")
            write('%s-cedis-to-%s.html' % (a, aslug), body); files.append('%s-cedis-to-%s.html' % (a, aslug))

    # ---- index
    rows = ''.join('<tr><td><a href="/rates/%s-to-cedi.html">%s to cedi</a></td><td class="num">%s</td><td class="num">%s %s</td></tr>' % (slug, ('CFA' if code == 'XOF' else sing.capitalize()), cedis(rates['ghs_per_unit'][code]), fmt(1 / rates['ghs_per_unit'][code], 4), code) for code, sing, plur, adj, sym, slug, region in CUR)
    title = 'Cedi exchange rates today (%s): dollar, pound, euro, naira, CFA to cedi' % hd
    desc = 'Today’s mid-market rates for the Ghana cedi against the dollar, pound, euro, naira, CFA, yuan, rand, Canadian dollar and dirham, %s. Converters and amount tables, refreshed every morning.' % hd
    faq = [('What is the dollar to cedi rate today?', '1 USD = %s on %s at the mid-market rate.' % (cedis(rates['ghs_per_unit']['USD']), hd)),
           ('Is the CFA higher than the cedi?', 'No. One CFA franc is worth %s; one cedi is about %s CFA.' % (cedis(rates['ghs_per_unit']['XOF']), fmt(1 / rates['ghs_per_unit']['XOF'], 1)))]
    body = HEAD.format(title=title, desc=desc, file='index.html', faq=faq_json(faq)) + '''
  <h1>Cedi exchange rates today</h1>
  <p class="stamp">%s · mid-market rates · refreshed every morning</p>
  <div class="tw"><table><tr><th>Pair</th><th class="num">1 unit in cedis</th><th class="num">1 cedi buys</th></tr>%s</table></div>
  <p>Every pair has its own page with a converter and amount tables, and every common amount has a page of its own (for example <a href="/rates/1000-dollars-to-cedis.html">1,000 dollars to cedis</a>, <a href="/rates/3000-naira-to-cedis.html">3,000 naira to cedis</a>, <a href="/rates/100-cedis-to-cfa.html">100 cedis to CFA</a>).</p>
  <h2 class="faq">Questions people ask</h2>
  <div class="faq">%s</div>
''' % (hd, rows, ''.join('<h3>%s</h3><p>%s</p>' % (q, a) for q, a in faq))
    body += FOOT.format(pairs=pair_links(None), slug='index', date=hd, rate=repr(rates['ghs_per_unit']['USD']))
    write('index.html', body); files.append('index.html')

    # ---- sitemap
    sm = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for f in files:
        loc = 'https://countmy.app/rates/' + ('' if f == 'index.html' else f)
        sm.append('  <url><loc>%s</loc><lastmod>%s</lastmod><changefreq>daily</changefreq><priority>%s</priority></url>' % (loc, date, '0.9' if f == 'index.html' or f.endswith('-to-cedi.html') else '0.6'))
    sm.append('</urlset>')
    io.open(os.path.join(ROOT, 'sitemap-rates.xml'), 'w', encoding='utf-8', newline='\n').write('\n'.join(sm) + '\n')
    return files

if __name__ == '__main__':
    p = os.path.join(OUT, 'rates.json')
    if '--offline' in sys.argv and os.path.exists(p):
        rates = json.load(io.open(p, encoding='utf-8'))
    else:
        rates = fetch_rates()
        io.open(p, 'w', encoding='utf-8', newline='\n').write(json.dumps(rates, indent=1))
    files = gen(rates)
    print('rates', rates['date'], 'USD', rates['ghs_per_unit']['USD'], 'pages', len(files))
