#!/usr/bin/env node
// A PR that removes or renames a test the release gate compares declares it in tools/test-harness/renames.json in the
// same change (#1462), so a release never blocks on an intended rewrite. A test that newly gains an unconditional skip
// or todo needs its quarantine.json entry in the same change too: once a release takes CI's result for the suites CI
// runs (#1463), the gate no longer sees their skips.
//
//   node .github/scripts/gate-renames.mjs --base <ref|sha> [--head <ref|sha>]     (ci.yml, job `repo`)
//
// Titles are read statically from the first argument of test()/it()/describe()/suite() and t.test() in each changed test
// file the gate runs (fileStep: the commands of tools/test-harness/one-validation.sh), at the merge base and at the head.
// The gate's ids are `ancestors > title` (with the package first for V3-packages); a title gone from its step at the
// head needs an entry with that step whose `from` ends with it. A suite (describe) title that is gone needs an entry
// under it (`from` containing `<title> > `), since every test inside it changed id. Titles built at run time are listed
// as unchecked and never fail. Renamed `to` titles that no changed file declares are reported, so typos show at the PR.
// The release gate's own comparison (release-gate.mjs compareRuns) stays the backstop for anything this cannot read.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_PACKAGES, validateQuarantine, validateRenames } from '../../tools/test-harness/release-gate.mjs';

const PACKAGE_DIRS = new Set([...REQUIRED_PACKAGES, 'catalog']);
/** The gate step that runs this test file, with the package prefix for V3-packages; null when the gate does not run it. */
export function fileStep(path) {
  let m;
  if (/^apps\/server\/src\/(?:.+\/)?[^/]+\.test\.ts$/.test(path)) return { step: 'V5-server-full' };
  if (/^apps\/web\/(?:src|test)\/(?:.+\/)?[^/]+\.test\.(?:ts|tsx|mjs|js)$/.test(path)) return { step: 'V4-web' };
  if ((m = /^packages\/([^/]+)\/src\/(?:core-kit\/)?[^/]+\.test\.ts$/.exec(path)) && PACKAGE_DIRS.has(m[1])) return { step: 'V3-packages', prefix: m[1] === 'catalog' ? 'conformance' : m[1] };
  if (/^mars\/viewer\/engine\/test\/[^/]+\.test\.ts$/.test(path)) return { step: 'V3-mars-engine' };
  if (/^tools\/(?:edge-skill|client-eval)\/[^/]+\.test\.mjs$/.test(path)) return { step: 'V3-client-cli' };
  if (/^tools\/world-launcher\/[^/]+\.test\.mjs$/.test(path)) return { step: 'V3-launcher-unit' };
  if (/^tools\/test-harness\/[^/]+\.test\.mjs$/.test(path)) return { step: 'V3-harness' };
  if (path === 'tools/test-harness/walk/walk-gate.test.mjs') return { step: 'V3-walk' };
  if (/^tools\/test-harness\/bundle-budget\/(?:budget|bundle-gate)\.test\.mjs$/.test(path)) return { step: 'V3-bundle' };
  return null;
}

const CALL = /(?<![\w$.])(test|it|describe|suite)(?:\.(skip|todo|only))?\s*\(|(?<![\w$.])(?:t|t\d|ctx|context|st|sub)\.test\s*\(/y;
const STRING_END = { "'": "'", '"': '"' };
function readString(src, i) { // src[i] is the quote; returns [value, index after]
  const q = src[i]; let out = '';
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { const n = src[++j]; out += n === 'n' ? '\n' : n === 't' ? '\t' : n; continue; }
    if (c === q) return [out, j + 1];
    if (c === '\n' && q !== '`') return [null, j];
    if (q === '`' && c === '$' && src[j + 1] === '{') return [null, j];
    out += c;
  }
  return [null, src.length];
}
/** Every test/suite call with a literal title: { title, kind: 'test'|'suite', skip: 'none'|'always'|'conditional' }; `dynamic` counts the others. */
export function testTitles(src) {
  const calls = []; let dynamic = 0;
  if (!/['"]node:test['"]/.test(src)) return { calls, dynamic: 0, unread: true };
  let i = 0, depth = []; // depth: template-literal `${` nesting, so code inside a template is still scanned
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); i = n < 0 ? src.length : n + 2; continue; }
    if (c in STRING_END) { const [, j] = readString(src, i); i = Math.max(j, i + 1); continue; }
    if (c === '`') { // skip the template's text; resume scanning at each ${
      let j = i + 1;
      for (; j < src.length; j++) { if (src[j] === '\\') { j++; continue; } if (src[j] === '`') break; if (src[j] === '$' && src[j + 1] === '{') { depth.push(0); j++; break; } }
      i = j + 1; continue;
    }
    if (depth.length && c === '{') { depth[depth.length - 1]++; i++; continue; }
    if (depth.length && c === '}') { if (depth[depth.length - 1]-- === 0) { depth.pop(); // back inside the template text
      let j = i + 1;
      for (; j < src.length; j++) { if (src[j] === '\\') { j++; continue; } if (src[j] === '`') break; if (src[j] === '$' && src[j + 1] === '{') { depth.push(0); j++; break; } }
      i = j + 1; continue; } i++; continue; }
    CALL.lastIndex = i;
    const m = CALL.exec(src);
    if (!m) { i++; continue; }
    let j = CALL.lastIndex; while (/\s/.test(src[j] || '')) j++;
    const q = src[j];
    const [title, after] = q in STRING_END || q === '`' ? readString(src, j) : [null, j];
    if (title === null) { dynamic++; i = CALL.lastIndex; continue; }
    let skip = m[2] === 'skip' || m[2] === 'todo' ? 'always' : 'none';
    let k = after; while (/\s/.test(src[k] || '')) k++;
    if (skip === 'none' && src[k] === ',') {
      k++; while (/\s/.test(src[k] || '')) k++;
      if (src[k] === '{') { // the options object, up to its closing brace
        let d = 0, e = k;
        for (; e < src.length; e++) { if (src[e] === '{') d++; else if (src[e] === '}' && --d === 0) break; else if (src[e] in STRING_END) e = readString(src, e)[1] - 1; }
        const opt = /\b(?:skip|todo)\s*:\s*([^,}]+)/.exec(src.slice(k, e));
        if (opt) { const v = opt[1].trim(); skip = v === 'false' ? 'none' : v === 'true' || /^['"`]/.test(v) ? 'always' : 'conditional'; }
      }
    }
    calls.push({ title, kind: m[1] === 'describe' || m[1] === 'suite' ? 'suite' : 'test', skip });
    i = after;
  }
  return { calls, dynamic };
}

/** How the gate prints a title: Node's TAP escapes backslash and '#'. */
export const tapTitle = t => t.replace(/\\/g, '\\\\').replace(/#/g, '\\#').replace(/\n/g, '\\n');
const leafOf = id => id.split(' > ').at(-1);

/** files: [{ path, base: source|null, head: source|null }]; renames/quarantine: the head's parsed JSON. */
export function checkRenames(files, renamesJson, quarantineJson) {
  const problems = [], unchecked = [], declared = [], notes = [];
  const renames = [...validateRenames(renamesJson).values()];
  const quarantine = [...validateQuarantine(quarantineJson).values()];
  const groups = new Map();
  for (const f of files) {
    const at = fileStep(f.path); if (!at) continue;
    const key = `${at.step}\u0000${at.prefix || ''}`;
    if (!groups.has(key)) groups.set(key, { ...at, base: [], head: [], files: [] });
    const g = groups.get(key); g.files.push(f.path);
    for (const side of ['base', 'head']) {
      if (f[side] === null || f[side] === undefined) continue;
      const r = testTitles(f[side]);
      if (r.unread) { unchecked.push({ path: f.path, side, why: 'no node:test import' }); continue; }
      if (r.dynamic) unchecked.push({ path: f.path, side, why: `${r.dynamic} title(s) built at run time` });
      for (const c of r.calls) g[side].push({ ...c, path: f.path });
    }
  }
  for (const g of groups.values()) {
    const inStep = e => e.step === g.step && (!g.prefix || e.from.startsWith(`${g.prefix} > `));
    const headTitles = new Set(g.head.map(c => tapTitle(c.title)));
    for (const c of g.base) {
      const t = tapTitle(c.title);
      if (headTitles.has(t) || problems.some(p => p.step === g.step && p.title === t)) continue;
      const hit = c.kind === 'suite' ? renames.find(e => inStep(e) && (e.from.includes(`${t} > `) || e.from === t || e.from.endsWith(` > ${t}`)))
        : renames.find(e => inStep(e) && (e.from === t || e.from.endsWith(` > ${t}`)));
      if (hit) declared.push({ step: g.step, title: t, from: hit.from, to: hit.to, pr: hit.pr });
      else problems.push({ kind: c.kind === 'suite' ? 'suite-gone' : 'gone', step: g.step, path: c.path, title: t,
        why: c.kind === 'suite'
          ? `suite "${t}" (${c.path}) is gone at the head: every test inside it changed id; add a renames.json entry (step ${g.step}) for each, from "${g.prefix ? g.prefix + ' > ' : ''}${t} > <test>"`
          : `"${t}" (${c.path}) ran in ${g.step} at the base and is gone at the head: add a renames.json entry {step: "${g.step}", from: "${g.prefix ? g.prefix + ' > ' : ''}${t}", to, reason, pr}` });
    }
    // a declared rename's replacement should be declared by some changed file of the step
    const dynamicHead = unchecked.some(u => u.side === 'head' && g.files.includes(u.path));
    for (const d of declared.filter(d => d.step === g.step)) for (const to of d.to)
      if (!headTitles.has(leafOf(to)) && !dynamicHead) notes.push(`renames.json: "${to}" (replacing "${d.from}") is not a test title in the changed ${g.step} files`);
    // a newly unconditional skip/todo needs its quarantine entry; the gate stops seeing CI-covered steps' skips (#1463)
    const skippedBefore = new Set(g.base.filter(c => c.skip === 'always').map(c => tapTitle(c.title)));
    for (const c of g.head.filter(c => c.skip !== 'none')) {
      const t = tapTitle(c.title);
      if (skippedBefore.has(t)) continue;
      if (c.skip === 'conditional') { notes.push(`${c.path}: "${t}" has a conditional skip/todo; the gate reports it if it skips there`); continue; }
      const q = quarantine.find(e => e.step === g.step && ['skip', 'todo'].includes(e.status) && (e.id === t || e.id.endsWith(` > ${t}`)));
      if (!q) problems.push({ kind: 'skip', step: g.step, path: c.path, title: t,
        why: `"${t}" (${c.path}) is newly skipped or todo in ${g.step}: a skipped check is unproved; remove the skip, or add a quarantine.json entry {step: "${g.step}", id, status, reason, owner}` });
    }
  }
  return { ok: !problems.length, problems, declared, unchecked, notes, groups: groups.size };
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const show = (ref, path) => { try { return execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const ZERO = /^0*$/;
export function main(argv = process.argv.slice(2), log = console.log) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const base = opt('--base'), head = opt('--head') || 'HEAD';
  let mb;
  try { if (!base || ZERO.test(base)) throw Error('no base'); mb = git('merge-base', base, head).trim(); }
  catch { log(`gate renames: no usable base (${base || 'none'}); nothing to compare`); return 0; }
  const paths = git('diff', '--name-only', '--no-renames', `${mb}...${head}`).split('\n').filter(p => p && fileStep(p));
  const files = paths.map(path => ({ path, base: show(mb, path), head: show(head, path) }));
  const json = (path, empty) => { const s = show(head, path); return s === null ? empty : JSON.parse(s); };
  const r = checkRenames(files, json('tools/test-harness/renames.json', { schemaVersion: 1, entries: [] }),
    json('tools/test-harness/quarantine.json', { schemaVersion: 1, entries: [], scopeExclusions: [{ step: 'V7', owner: '-', reason: '-' }, { step: 'V8', owner: '-', reason: '-' }] }));
  log(`gate renames: ${files.length} changed gate test file(s) in ${r.groups} step group(s); ${r.declared.length} declared rename(s); ${r.problems.length} problem(s)`);
  for (const d of r.declared) log(`  declared ${d.step}: "${d.from}" -> ${JSON.stringify(d.to)} (${d.pr})`);
  for (const u of r.unchecked) log(`  unchecked ${u.path} (${u.side}): ${u.why}`);
  for (const n of r.notes) log(`  note: ${n}`);
  for (const p of r.problems) { log(`  PROBLEM: ${p.why}`); if (process.env.GITHUB_ACTIONS) log(`::error file=${p.path},title=gate rename::${p.why}`); }
  if (process.env.GITHUB_STEP_SUMMARY && r.problems.length) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Gate renames\n\n${r.problems.map(p => `- ${p.why}`).join('\n')}\n\nSee docs/testing/remote-gate.md#renames.\n`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
