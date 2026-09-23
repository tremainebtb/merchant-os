# -*- coding: utf-8 -*-
"""Generate the Spanish-language exchange-rate pages for Venezuela (bolívar)
and Colombia (peso) - rates/es/*.html - from a daily rate fetch.

Run by .github/workflows/rates-es.yml every morning; can be run by hand:
    python tools/gen_rates_es.py            # fetch live rates, write pages
    python tools/gen_rates_es.py --offline  # reuse rates/es/rates_es.json

Why these pages exist (22 Sep 2026): CountMy's Spanish users are in Venezuela
and Colombia (see app.js ES/CO handling, the Groq prompt's bolívar/peso
vocabulary). The exact same "one page per amount, refreshed daily" shape
that works for the cedi rate pages (19 Sep 2026 autocomplete evidence) is
even more valuable here, because Venezuela genuinely has two different,
both-actively-cited daily rates people check - confirmed live, 22 Sep 2026:
dolarapi.com's own feed shows "oficial" (BCV, ~852 VES/USD) and "paralelo"
(street/Binance-adjacent, ~948 VES/USD) about 11% apart on the same day.
Collapsing that into one number the way the cedi pages use one mid-market
rate would be actively wrong for this audience, so both are shown, labelled,
sourced - never averaged or hidden.

Colombia's peso doesn't have that oficial/paralelo split - dolarapi.com's
"co" feed gives compra/venta (buy/sell) like Ghana's bank-buys-below-sells-
above pattern, so the Colombia pages follow the cedi model instead: one
mid-point reference rate, with a plain note about what you will actually
get buying vs selling.

Data sources (both free, no auth, checked live 22 Sep 2026):
  Venezuela: https://ve.dolarapi.com/v1/dolares  (oficial + paralelo)
  Colombia:  https://co.dolarapi.com/v1/cotizaciones  (compra/venta, USD row)
Not financial advice; both pages say so and link the real institutions
(Banco Central de Venezuela, and the fact that Colombia's official TRM is
set daily by the Superintendencia Financiera).
"""
import io, json, os, sys, datetime, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'rates', 'es')
os.makedirs(OUT, exist_ok=True)

VE_AMOUNTS = [1, 5, 10, 20, 50, 100, 200, 500, 1000]
CO_AMOUNTS_USD = [1, 5, 10, 20, 50, 100, 200, 500, 1000]
CO_AMOUNTS_COP = [50000, 100000, 200000, 500000, 1000000, 2000000, 5000000]

def fetch_rates():
    with urllib.request.urlopen(urllib.request.Request(
            'https://ve.dolarapi.com/v1/dolares', headers={'User-Agent': 'countmy-rates-es/1.0'}), timeout=30) as r:
        ve = json.loads(r.read().decode('utf-8'))
    oficial = next(x['promedio'] for x in ve if x['fuente'] == 'oficial')
    paralelo = next(x['promedio'] for x in ve if x['fuente'] == 'paralelo')
    with urllib.request.urlopen(urllib.request.Request(
            'https://co.dolarapi.com/v1/cotizaciones', headers={'User-Agent': 'countmy-rates-es/1.0'}), timeout=30) as r:
        co = json.loads(r.read().decode('utf-8'))
    usd_co = next(x for x in co if x['moneda'] == 'USD')
    return {
        'date': datetime.date.today().isoformat(),
        've_oficial': oficial, 've_paralelo': paralelo,
        'co_compra': usd_co['compra'], 'co_venta': usd_co['venta'],
    }

def fmt(n, dp=2):
    if n >= 1000:
        return '{:,.{p}f}'.format(n, p=dp).replace(',', 'X').replace('.', ',').replace('X', '.')
    return '{:.{p}f}'.format(n, p=dp).replace('.', ',')

def bs(n):
    return 'Bs ' + ('{:,.2f}'.format(round(n, 2)).replace(',', 'X').replace('.', ',').replace('X', '.'))

def cop(n):
    return '$' + '{:,.0f}'.format(round(n)).replace(',', '.')

MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
def human_date(iso):
    d = datetime.date.fromisoformat(iso)
    return '%d de %s de %d' % (d.day, MESES[d.month - 1], d.year)

HEAD = '''<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="https://countmy.app/rates/es/{file}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="https://countmy.app/og-image.png">
<meta property="og:url" content="https://countmy.app/rates/es/{file}">
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
.two{{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0}}
.two .card{{background:var(--surface);border:1px solid var(--rule);border-radius:14px;padding:14px}}
.two .card .lbl{{font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:700;margin-bottom:4px}}
.two .card .v{{font-family:Manrope,system-ui,sans-serif;font-weight:800;font-size:1.3rem;font-variant-numeric:tabular-nums}}
</style>
<script type="application/ld+json">
{{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{faq}]}}
</script>
</head>
<body>
<div class="wrap">
  <div class="top"><a href="/?lang=es">Count<span class="my">My</span></a></div>
'''

FOOT_VE = '''
  <h2>Otros montos hoy</h2>
  <p class="pairs">{pairs}</p>
  <a class="cta" href="/?lang=es&amp;utm_source=rates&amp;utm_medium=page&amp;utm_campaign={slug}"><svg viewBox="0 0 24 24" fill="none"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" stroke="currentColor" stroke-width="2"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>¿Vendiste hoy? Dilo, CountMy lo anota</a>
  <p class="cta-sub">Cuaderno de cuentas gratis para cualquier negocio. Sin contraseña, sin clave del banco.</p>
  <p class="foot">Tasas: <a href="https://ve.dolarapi.com" rel="noopener">dolarapi.com</a> (oficial = Banco Central de Venezuela; paralelo = mercado informal), esta página se generó el {date}. El precio real depende de dónde cambies - el paralelo cambia varias veces al día. No es asesoría financiera. <a href="/guides/cuaderno-de-ventas-diarias.html">Guías para tu negocio</a> · <a href="/privacidad.html">Privacidad</a></p>
</div>
<script>
(function(){{var ro={ro};var rp={rp};var a=document.getElementById('c_amt'),oo=document.getElementById('c_out_of'),op=document.getElementById('c_out_pa');if(!a)return;function f(n){{return n>=1000?Math.round(n).toLocaleString('es-VE'):n.toFixed(2);}}
a.addEventListener('input',function(){{var v=parseFloat(a.value)||0;if(oo)oo.textContent='Bs '+f(v*ro);if(op)op.textContent='Bs '+f(v*rp);}});}})();
</script>
</body>
</html>
'''

FOOT_CO = '''
  <h2>Otros montos hoy</h2>
  <p class="pairs">{pairs}</p>
  <a class="cta" href="/?lang=es&amp;utm_source=rates&amp;utm_medium=page&amp;utm_campaign={slug}"><svg viewBox="0 0 24 24" fill="none"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" stroke="currentColor" stroke-width="2"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>¿Vendiste hoy? Dilo, CountMy lo anota</a>
  <p class="cta-sub">Cuaderno de cuentas gratis para cualquier negocio. Sin contraseña, sin clave del banco.</p>
  <p class="foot">Tasa: <a href="https://co.dolarapi.com" rel="noopener">dolarapi.com</a> (compra/venta del mercado), esta página se generó el {date}. La TRM oficial la fija la Superintendencia Financiera de Colombia cada día hábil. No es asesoría financiera. <a href="/guides/cuaderno-de-ventas-diarias.html">Guías para tu negocio</a> · <a href="/privacidad.html">Privacidad</a></p>
</div>
<script>
(function(){{var r={r};var a=document.getElementById('c_amt'),o=document.getElementById('c_out');if(!a)return;function f(n){{return n.toLocaleString('es-CO',{{maximumFractionDigits:0}});}}
a.addEventListener('input',function(){{var v=parseFloat(a.value)||0;o.textContent='$'+f(v*r);}});}})();
</script>
</body>
</html>
'''

def faq_json(items):
    return ','.join('{"@type":"Question","name":%s,"acceptedAnswer":{"@type":"Answer","text":%s}}' % (json.dumps(q), json.dumps(a)) for q, a in items)

def write(file, html):
    io.open(os.path.join(OUT, file), 'w', encoding='utf-8', newline='\n').write(html)

VE_PAIR_LINKS = '<a href="/rates/es/dolar-a-bolivar.html">Dólar a bolívar</a>'
CO_PAIR_LINKS = '<a href="/rates/es/dolar-a-peso.html">Dólar a peso</a>'
# 24 Sep: the footer is headed "Otros montos hoy" but only linked the other
# country's hub, so all 18 amount pages and the Spanish index had no link in
# from anywhere (sitemap-only discovery). Now it links what the heading says.
VE_AMOUNT_LINKS = ' '.join('<a href="/rates/es/%s-dolares-a-bolivares.html">%s %s a bolívares</a>' % (a, fmt(a, 0), 'dólar' if a == 1 else 'dólares') for a in VE_AMOUNTS)
CO_AMOUNT_LINKS = ' '.join('<a href="/rates/es/%s-dolares-a-pesos.html">%s %s a pesos</a>' % (a, fmt(a, 0), 'dólar' if a == 1 else 'dólares') for a in CO_AMOUNTS_USD)
ES_HUBS = '<a href="/rates/es/index.html">Todas las tasas de hoy</a> ' + VE_PAIR_LINKS + ' ' + CO_PAIR_LINKS
VE_FOOT_PAIRS = VE_AMOUNT_LINKS + ' ' + ES_HUBS
CO_FOOT_PAIRS = CO_AMOUNT_LINKS + ' ' + ES_HUBS

def gen(rates):
    date = rates['date']; hd = human_date(date)
    files = []
    ro, rp = rates['ve_oficial'], rates['ve_paralelo']
    gap_pct = round((rp - ro) / ro * 100)

    # ---- Venezuela: dólar a bolívar (index/main page) ----
    title = 'Dólar a bolívar hoy (%s): oficial Bs %s, paralelo Bs %s' % (hd, fmt(ro), fmt(rp))
    desc = 'Precio del dólar en Venezuela hoy, %s: tasa oficial (BCV) y tasa paralela, lado a lado, actualizadas cada mañana. Diferencia: %s%%. Conversor y tabla de montos.' % (hd, gap_pct)
    faq = [
        ('¿Cuánto está el dólar hoy en Venezuela?', 'Oficial (BCV): %s por dólar. Paralelo: %s por dólar. Así está el %s.' % (bs(ro), bs(rp), hd)),
        ('¿Cuál es la diferencia entre el dólar oficial y el paralelo?', 'El oficial lo publica el Banco Central de Venezuela y es la referencia legal. El paralelo lo fija la oferta y demanda del mercado informal y suele ser más alto - hoy la diferencia es de %s%%.' % gap_pct),
        ('¿Cuál tasa debo usar para mis cuentas?', 'Depende de dónde y cómo cambias. Si vendes o compras en el mercado informal, el paralelo es el precio real. Para trámites y pagos formales, el oficial es la referencia legal.'),
    ]
    near = ''.join('<tr><td class="num">$%s</td><td class="num">%s</td><td class="num">%s</td></tr>' % (fmt(x, 0), bs(x * ro), bs(x * rp)) for x in VE_AMOUNTS)
    body = HEAD.format(title=title, desc=desc, file='dolar-a-bolivar.html', faq=faq_json(faq)) + '''
  <h1>Dólar a bolívar hoy</h1>
  <p class="stamp">%s · dos tasas, actualizadas cada mañana</p>
  <div class="two">
    <div class="card"><div class="lbl">Oficial (BCV)</div><div class="v">%s</div></div>
    <div class="card"><div class="lbl">Paralelo</div><div class="v">%s</div></div>
  </div>
  <p>Diferencia hoy: <b>%s%%</b>. El paralelo cambia varias veces al día; esta página se actualiza una vez cada mañana.</p>
  <div class="conv">
    <label><span>Dólares</span><input type="number" inputmode="decimal" id="c_amt" placeholder="100"></label>
    <div class="out"><span>Oficial</span><b id="c_out_of">%s</b></div>
    <div class="out"><span>Paralelo</span><b id="c_out_pa">%s</b></div>
  </div>
  <h2>Tabla de montos</h2>
  <div class="tw"><table><tr><th class="num">Dólares</th><th class="num">Bs (oficial)</th><th class="num">Bs (paralelo)</th></tr>%s</table></div>
  <h2 class="faq">Preguntas frecuentes</h2>
  <div class="faq">%s</div>
''' % (hd, bs(ro), bs(rp), gap_pct, bs(ro), bs(rp), near, ''.join('<h3>%s</h3><p>%s</p>' % (q, a) for q, a in faq))
    body += FOOT_VE.format(pairs=VE_FOOT_PAIRS, slug='dolar-bolivar', date=hd, ro=repr(ro), rp=repr(rp))
    write('dolar-a-bolivar.html', body); files.append('dolar-a-bolivar.html')

    # ---- Venezuela: amount pages ----
    for a in VE_AMOUNTS:
        vo, vp = a * ro, a * rp
        unit = fmt(a, 0) + (' dólar' if a == 1 else ' dólares')
        title = '%s a bolívares hoy (%s): %s oficial, %s paralelo' % (unit, hd, bs(vo), bs(vp))
        desc = 'Cuánto es %s en bolívares hoy %s: %s a tasa oficial y %s a tasa paralela. Tabla de montos cercanos.' % (unit, hd, bs(vo), bs(vp))
        faq = [('¿Cuánto es %s en bolívares?' % unit, '%s = %s oficial (BCV) o %s paralelo, %s.' % (unit, bs(vo), bs(vp), hd))]
        near = ''.join('<tr><td class="num">$%s</td><td class="num">%s</td><td class="num">%s</td></tr>' % (fmt(x, 0), bs(x * ro), bs(x * rp)) for x in VE_AMOUNTS)
        body = HEAD.format(title=title, desc=desc, file='%s-dolares-a-bolivares.html' % a, faq=faq_json(faq)) + '''
  <h1>%s a bolívares hoy</h1>
  <p class="stamp">%s · dos tasas, actualizadas cada mañana</p>
  <div class="two">
    <div class="card"><div class="lbl">Oficial (BCV)</div><div class="v">%s</div></div>
    <div class="card"><div class="lbl">Paralelo</div><div class="v">%s</div></div>
  </div>
  <div class="conv">
    <label><span>Dólares</span><input type="number" inputmode="decimal" id="c_amt" placeholder="%s"></label>
    <div class="out"><span>Oficial</span><b id="c_out_of">%s</b></div>
    <div class="out"><span>Paralelo</span><b id="c_out_pa">%s</b></div>
  </div>
  <h2>Montos cercanos</h2>
  <div class="tw"><table><tr><th class="num">Dólares</th><th class="num">Bs (oficial)</th><th class="num">Bs (paralelo)</th></tr>%s</table></div>
  <h2 class="faq">Preguntas frecuentes</h2>
  <div class="faq">%s</div>
''' % (unit, hd, bs(vo), bs(vp), a, bs(vo), bs(vp), near, ''.join('<h3>%s</h3><p>%s</p>' % (q, x) for q, x in faq))
        body += FOOT_VE.format(pairs=VE_FOOT_PAIRS, slug='dolar-bolivar', date=hd, ro=repr(ro), rp=repr(rp))
        write('%s-dolares-a-bolivares.html' % a, body); files.append('%s-dolares-a-bolivares.html' % a)

    # ---- Colombia: dólar a peso (index/main page) ----
    compra, venta = rates['co_compra'], rates['co_venta']
    mid = (compra + venta) / 2
    title = 'Dólar a peso colombiano hoy (%s): $%s' % (hd, fmt(mid, 0))
    desc = 'Precio del dólar en Colombia hoy, %s: compra $%s, venta $%s. Conversor y tabla de montos, actualizado cada mañana.' % (hd, fmt(compra, 0), fmt(venta, 0))
    faq = [
        ('¿Cuánto está el dólar hoy en Colombia?', 'Compra: $%s. Venta: $%s. Así está el %s.' % (fmt(compra, 0), fmt(venta, 0), hd)),
        ('¿Compra o venta - cuál uso?', 'Si vendes dólares te pagan cerca del precio de compra; si compras dólares pagas cerca del precio de venta. La diferencia es la ganancia de la casa de cambio.'),
    ]
    near = ''.join('<tr><td class="num">$%s</td><td class="num">%s</td></tr>' % (fmt(x, 0), cop(x * mid)) for x in CO_AMOUNTS_USD)
    near2 = ''.join('<tr><td class="num">%s</td><td class="num">$%s</td></tr>' % (cop(x), fmt(x / mid, 2)) for x in CO_AMOUNTS_COP)
    body = HEAD.format(title=title, desc=desc, file='dolar-a-peso.html', faq=faq_json(faq)) + '''
  <h1>Dólar a peso colombiano hoy</h1>
  <p class="stamp">%s · actualizado cada mañana</p>
  <div class="two">
    <div class="card"><div class="lbl">Compra</div><div class="v">$%s</div></div>
    <div class="card"><div class="lbl">Venta</div><div class="v">$%s</div></div>
  </div>
  <div class="conv">
    <label><span>Dólares</span><input type="number" inputmode="decimal" id="c_amt" placeholder="100"></label>
    <div class="out"><span>Pesos</span><b id="c_out">%s</b></div>
  </div>
  <h2>Dólares a pesos</h2>
  <div class="tw"><table><tr><th class="num">Dólares</th><th class="num">Pesos</th></tr>%s</table></div>
  <h2>Pesos a dólares</h2>
  <div class="tw"><table><tr><th class="num">Pesos</th><th class="num">Dólares</th></tr>%s</table></div>
  <h2 class="faq">Preguntas frecuentes</h2>
  <div class="faq">%s</div>
''' % (hd, fmt(compra, 0), fmt(venta, 0), cop(mid), near, near2, ''.join('<h3>%s</h3><p>%s</p>' % (q, a) for q, a in faq))
    body += FOOT_CO.format(pairs=CO_FOOT_PAIRS, slug='dolar-peso', date=hd, r=repr(mid))
    write('dolar-a-peso.html', body); files.append('dolar-a-peso.html')

    # ---- Colombia: USD amount pages ----
    for a in CO_AMOUNTS_USD:
        v = a * mid
        unit = fmt(a, 0) + (' dólar' if a == 1 else ' dólares')
        title = '%s a pesos colombianos hoy (%s): %s' % (unit, hd, cop(v))
        desc = 'Cuánto es %s en pesos colombianos hoy %s: %s al precio medio del mercado. Tabla de montos cercanos.' % (unit, hd, cop(v))
        faq = [('¿Cuánto es %s en pesos?' % unit, '%s = %s el %s (compra $%s, venta $%s).' % (unit, cop(v), hd, fmt(compra, 0), fmt(venta, 0)))]
        near = ''.join('<tr><td class="num">$%s</td><td class="num">%s</td></tr>' % (fmt(x, 0), cop(x * mid)) for x in CO_AMOUNTS_USD)
        body = HEAD.format(title=title, desc=desc, file='%s-dolares-a-pesos.html' % a, faq=faq_json(faq)) + '''
  <h1>%s a pesos colombianos hoy</h1>
  <p class="stamp">%s · precio medio del mercado</p>
  <div class="big"><div class="n">%s = %s</div><p>Compra $%s · venta $%s.</p></div>
  <div class="conv">
    <label><span>Dólares</span><input type="number" inputmode="decimal" id="c_amt" placeholder="%s"></label>
    <div class="out"><span>Pesos</span><b id="c_out">%s</b></div>
  </div>
  <h2>Montos cercanos</h2>
  <div class="tw"><table><tr><th class="num">Dólares</th><th class="num">Pesos</th></tr>%s</table></div>
  <h2 class="faq">Preguntas frecuentes</h2>
  <div class="faq">%s</div>
''' % (unit, hd, unit, cop(v), fmt(compra, 0), fmt(venta, 0), a, cop(v), near, ''.join('<h3>%s</h3><p>%s</p>' % (q, x) for q, x in faq))
        body += FOOT_CO.format(pairs=CO_FOOT_PAIRS, slug='dolar-peso', date=hd, r=repr(mid))
        write('%s-dolares-a-pesos.html' % a, body); files.append('%s-dolares-a-pesos.html' % a)

    # ---- index ----
    title = 'Tasas de cambio hoy (%s): dólar a bolívar y a peso colombiano' % hd
    desc = 'Precio del dólar hoy en Venezuela (oficial y paralelo) y en Colombia (compra y venta), %s. Actualizado cada mañana.' % hd
    body = HEAD.format(title=title, desc=desc, file='index.html', faq=faq_json([])) + '''
  <h1>Tasas de cambio hoy</h1>
  <p class="stamp">%s · actualizado cada mañana</p>
  <div class="two">
    <div class="card"><div class="lbl">Venezuela · oficial</div><div class="v">%s</div></div>
    <div class="card"><div class="lbl">Venezuela · paralelo</div><div class="v">%s</div></div>
  </div>
  <div class="two">
    <div class="card"><div class="lbl">Colombia · compra</div><div class="v">$%s</div></div>
    <div class="card"><div class="lbl">Colombia · venta</div><div class="v">$%s</div></div>
  </div>
  <p class="pairs"><a href="/rates/es/dolar-a-bolivar.html">Ver dólar a bolívar completo</a> <a href="/rates/es/dolar-a-peso.html">Ver dólar a peso completo</a></p>
''' % (hd, bs(ro), bs(rp), fmt(compra, 0), fmt(venta, 0))
    body += FOOT_VE.format(pairs=VE_AMOUNT_LINKS + ' ' + CO_FOOT_PAIRS, slug='index-es', date=hd, ro=repr(ro), rp=repr(rp))
    write('index.html', body); files.append('index.html')

    # ---- sitemap ----
    sm = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for f in files:
        loc = 'https://countmy.app/rates/es/' + f  # match each page's own canonical
        sm.append('  <url><loc>%s</loc><lastmod>%s</lastmod><changefreq>daily</changefreq><priority>%s</priority></url>' % (loc, date, '0.9' if f in ('index.html', 'dolar-a-bolivar.html', 'dolar-a-peso.html') else '0.6'))
    sm.append('</urlset>')
    io.open(os.path.join(ROOT, 'sitemap-rates-es.xml'), 'w', encoding='utf-8', newline='\n').write('\n'.join(sm) + '\n')
    return files

if __name__ == '__main__':
    p = os.path.join(OUT, 'rates_es.json')
    if '--offline' in sys.argv and os.path.exists(p):
        rates = json.load(io.open(p, encoding='utf-8'))
    else:
        rates = fetch_rates()
        io.open(p, 'w', encoding='utf-8', newline='\n').write(json.dumps(rates, indent=1))
    files = gen(rates)
    print('rates-es', rates['date'], 've_oficial', rates['ve_oficial'], 've_paralelo', rates['ve_paralelo'], 'co_mid', (rates['co_compra']+rates['co_venta'])/2, 'pages', len(files))
