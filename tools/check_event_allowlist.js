#!/usr/bin/env node
// Guardrail against the exact bug found live 22 Sep: app.js called
// ping('voice_es') and track('voice_extracted', {lang:'es'}) for months,
// but the Worker's /ping event-name allowlist never had 'voice_es' added -
// every one of those pings was silently rejected with a 400 (ping()
// swallows the error), so Spanish voice usage was invisible in analytics
// the whole time Spanish was live. Nobody noticed because the failure was
// silent on both ends: no error shown to the user, no alert to the owner.
//
// This script makes that whole CLASS of bug impossible to ship silently
// again: it extracts every event name app.js actually sends via ping(),
// and fails if any of them is missing from worker.js's allowlist. Run it
// by hand (`node tools/check_event_allowlist.js`) or wire it into CI - see
// .github/workflows/check.yml, which runs it on every push touching
// app.js or worker/worker.js.
//
// Static analysis, not a full JS parser: it understands plain string
// literals ('open'), a ternary of two literals, and the one dynamic
// pattern this file actually uses - ping('prefix_' + someVar) - by
// tracing someVar back to the function that produced it (const x =
// someFn(...)) and reading every literal that function actually
// `return`s, brace-matched to that one function's body only. Anything
// shaped some other way is printed as "needs manual review" rather than
// silently skipped, so a genuinely new pattern gets a human's eyes
// instead of a false pass.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const workerJs = fs.readFileSync(path.join(ROOT, 'worker', 'worker.js'), 'utf8');

function extractAllowlist(src) {
  // The allowlist is the array literal right after "if (!['open', 'save', ..."
  // in handlePing - find it structurally, not by a brittle line number.
  const m = src.match(/if \(!\[([\s\S]*?)\]\.includes\(eventType\)\)/);
  if (!m) throw new Error('Could not find the ping() event allowlist in worker.js - has handlePing changed shape?');
  const names = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  if (!names.length) throw new Error('Found the allowlist block but extracted zero event names - regex likely broken');
  return new Set(names);
}

function lineOf(src, index) { return src.slice(0, index).split('\n').length; }

// Given the source and the index right after "function NAME(", returns the
// full function body text by counting braces from the first "{" onward.
function functionBodyAt(src, nameIndex) {
  const braceStart = src.indexOf('{', nameIndex);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(braceStart, i + 1); }
  }
  return null;
}

function literalsReturnedBy(src, fnName) {
  const def = new RegExp('function\\s+' + fnName + '\\s*\\(').exec(src);
  if (!def) return null;
  const body = functionBodyAt(src, def.index);
  if (!body) return null;
  const values = new Set();
  const re = /\breturn\s+'([^']+)'/g;
  let m;
  while ((m = re.exec(body))) values.add(m[1]);
  return values;
}

// Finds every "ping(" that is a real call (not the `function ping(`
// declaration itself), then reads its argument list with paren-depth
// counting so a nested call like isAndroid() inside the arguments doesn't
// truncate the match at its own closing paren.
function findPingCallSites(src) {
  const sites = [];
  const openRe = /\bping\(/g;
  let m;
  while ((m = openRe.exec(src))) {
    const before = src.slice(Math.max(0, m.index - 12), m.index);
    if (/function\s+$/.test(before)) continue; // the declaration, not a call
    const argsStart = m.index + m[0].length;
    let depth = 1, i = argsStart;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    if (depth !== 0) continue; // unbalanced - shouldn't happen in valid JS
    sites.push({ argText: src.slice(argsStart, i - 1).trim(), index: m.index });
  }
  return sites;
}

function findPingCalls(src) {
  const calls = { literal: [], dynamicPrefix: [], needsReview: [] };
  for (const { argText, index } of findPingCallSites(src)) {
    const line = lineOf(src, index);
    if (!argText) continue; // ping() with no args isn't a real call site
    const litOnly = argText.match(/^'([^']+)'$/);
    if (litOnly) { calls.literal.push({ name: litOnly[1], line }); continue; }
    const ternary = argText.match(/^.+\?\s*'([^']+)'\s*:\s*'([^']+)'$/);
    if (ternary) { calls.literal.push({ name: ternary[1], line }); calls.literal.push({ name: ternary[2], line }); continue; }
    const prefixConcat = argText.match(/^'([a-zA-Z0-9_]*_)'\s*\+\s*([a-zA-Z0-9_]+)$/);
    if (prefixConcat) {
      const [, prefix, varName] = prefixConcat;
      // Trace the variable back to the function call that produced it,
      // searching backward from the ping() site for its own declaration -
      // e.g. "const spokenLang = guessSpokenLang(heard);" - so the
      // returned literals we check are scoped to THAT function only, not
      // every `return '...'` in the whole file.
      const before = src.slice(0, index);
      const declRe = new RegExp('(?:const|let|var)\\s+' + varName + '\\s*=\\s*([a-zA-Z0-9_]+)\\s*\\(');
      const decls = [...before.matchAll(new RegExp(declRe.source, 'g'))];
      const decl = decls[decls.length - 1]; // nearest preceding declaration
      if (!decl) { calls.needsReview.push({ raw: argText, line, reason: `could not find where "${varName}" is assigned` }); continue; }
      const fnName = decl[1];
      const values = literalsReturnedBy(src, fnName);
      if (!values || !values.size) { calls.needsReview.push({ raw: argText, line, reason: `"${varName}" comes from ${fnName}(), but could not resolve its literal return values` }); continue; }
      for (const v of values) calls.dynamicPrefix.push({ name: prefix + v, line, via: `'${prefix}' + ${varName}, where ${varName} = ${fnName}(...) can return '${v}'` });
      continue;
    }
    calls.needsReview.push({ raw: argText, line, reason: 'unrecognized ping() argument shape' });
  }
  return calls;
}

const allowlist = extractAllowlist(workerJs);
const calls = findPingCalls(appJs);
const allFound = [...calls.literal, ...calls.dynamicPrefix];

let failed = false;
const missing = allFound.filter(c => !allowlist.has(c.name));
const seenNames = new Set();
const uniqueMissing = missing.filter(c => (seenNames.has(c.name) ? false : (seenNames.add(c.name), true)));

console.log(`Checked ${allFound.length} ping() call sites in app.js against ${allowlist.size} allowed event names in worker.js.\n`);

if (uniqueMissing.length) {
  failed = true;
  console.log('MISSING FROM THE WORKER ALLOWLIST - these pings will be silently rejected (400) right now:');
  for (const c of uniqueMissing) {
    const site = allFound.find(x => x.name === c.name);
    console.log(`  '${c.name}'  (app.js:${site.line}${site.via ? ', ' + site.via : ''})`);
  }
  console.log('\nFix: add the missing name(s) to the allowlist array in worker/worker.js (handlePing), same place voice_es was added 22 Sep.\n');
}

if (calls.needsReview.length) {
  console.log('NEEDS MANUAL REVIEW - could not statically verify these ping() calls:');
  for (const c of calls.needsReview) console.log(`  app.js:${c.line}: ping(${c.raw})  -  ${c.reason}`);
  console.log('');
}

if (!failed && !calls.needsReview.length) console.log('All good - every ping() event name app.js can send is in the Worker allowlist.');

process.exit(failed ? 1 : 0);
