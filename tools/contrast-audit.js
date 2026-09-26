// CountMy contrast audit (26 Sep 2026). Paste into the console (or eval via fetch) on any page, in light AND dark mode;
// it returns every visible text run below WCAG AA (4.5:1, 3:1 for large text) against its real composited background.
// Disabled controls (greyed "next day", dim "Write it") are allowed to fail - WCAG exempts inactive controls.
(() => {
  // WCAG contrast audit of every visible text run against its composited background.
  const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const bgOf = el => {
    const stack = []; let n = el, img = false;
    while (n && n.nodeType === 1) { const cs = getComputedStyle(n); if (cs.backgroundImage && cs.backgroundImage !== 'none' && !cs.backgroundImage.startsWith('url(')) img = true; const c = parse(cs.backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } n = n.parentElement; }
    let base = { r: 255, g: 255, b: 255, a: 1 }; // canvas default
    if (!stack.length || stack[stack.length - 1].a < 1) { const html = parse(getComputedStyle(document.documentElement).backgroundColor); if (html && html.a > 0) base = over(html, base); }
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return { c: base, img };
  };
  const vis = el => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; let n = el; while (n && n.nodeType === 1) { const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false; n = n.parentElement; } return true; };
  const name = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const seen = new Set(), fails = [];
  let checked = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode; if (!t.textContent.trim()) continue;
    const el = t.parentElement; if (!el || seen.has(el)) continue; seen.add(el);
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(el.tagName)) continue;
    if (!vis(el)) continue;
    const cs = getComputedStyle(el); let fg = parse(cs.color); if (!fg) continue;
    const { c: bg, img } = bgOf(el);
    let op = 1, n = el; while (n && n.nodeType === 1) { op *= +getComputedStyle(n).opacity; n = n.parentElement; }
    fg = over({ ...fg, a: fg.a * op }, bg);
    const L1 = lum(fg), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700;
    const need = (px >= 24 || (bold && px >= 18.66)) ? 3 : 4.5;
    checked++;
    if (ratio < need) fails.push({ el: name(el), text: t.textContent.trim().slice(0, 40), fg: cs.color, bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`, ratio: Math.round(ratio * 100) / 100, need, img });
  }
  // form controls' own text colour (inputs don't have text nodes)
  document.querySelectorAll('input,select,textarea,button').forEach(el => { if (!vis(el)) return; const cs = getComputedStyle(el); const fg = parse(cs.color); const { c: bg } = bgOf(el); if (!fg) return; const f = over(fg, bg); const L1 = lum(f), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); checked++; if (ratio < 4.5 && (el.value || el.placeholder || el.textContent.trim())) fails.push({ el: name(el) + '[control]', text: (el.value || el.placeholder || el.textContent).trim().slice(0, 30), fg: cs.color, bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`, ratio: Math.round(ratio * 100) / 100, need: 4.5 }); });
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return { page: location.pathname, dark, bodyBg: getComputedStyle(document.body).backgroundColor, checked, failCount: fails.length, fails: fails.sort((a, b) => a.ratio - b.ratio).slice(0, 25) };
})()
