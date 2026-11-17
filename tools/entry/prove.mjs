#!/usr/bin/env node
// One command for the gates that need no engine (Soul Actions SA-P8, #2864).
//
//   node tools/entry/prove.mjs <family|folder|file> [--cases <dir>] [--out <dir>]
//   pnpm entry prove <family>                                      (the same)
//
// Runs, in order: the check gate (check.mjs), the entry's expected outcomes through the rules (its rule cases and
// effect cases, @souls/form-rules), and the thing look gate (look.mjs, one sheet per kind). Prints one JSON verdict:
// which gates ran, which passed, which failed and why, and which wait for a runner (run, body-look, find). Exits 0
// when no gate failed, 1 when one did (`failed` names it), 2 on a bad argument.
//
// Cases: a rule case belongs to a kind when the act's thing is of that kind; an effect case belongs to a family when
// any of its acts is on one of the family's kinds. Cases are read from packages/form-rules/cases (or --cases <dir>,
// with its effects/ folder). Each kind with forms needs, as the published examples have: a case where every need of
// each form is met, a case where each need is unmet, and each form done in an effect case. A kind outside
// content/kinds (a scratch folder) is proven over the published one of the same name.
//
// The look gate draws `looks.shape`. An entry cannot carry a shape until SA-D3 (#2855) says how (the format refuses
// the floats a shape in metres has), so a kind with no shape waits for one rather than failing; every other look
// error fails. Sheets go to --out (default .local/look/<time>); look at them, never commit them.
import {existsSync, readFileSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {checkFiles, KINDS_DIR} from './check.mjs';
import {loadDir} from './format.mjs';
import {look} from './look.mjs';
import {CASES, KIND_DIRS, loadCases, loadEffectCases, loadKinds, mismatches, same} from '../../packages/form-rules/src/load.ts';
import {decide} from '../../packages/form-rules/src/rules.ts';
import {apply, effects} from '../../packages/form-rules/src/effects.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** The gates that need a runner (Engine v2). The verdict names them as waiting. */
export const RUNNER_GATES = Object.freeze(['run', 'body-look', 'find']);
const NO_SHAPE = 'looks.shape.shapes is missing: there is nothing to draw';

/** The files a target names: a file or folder on disk, else a family under content/kinds. */
export function filesOf(target) {
  if (existsSync(target)) return loadDir(resolve(target));
  if (existsSync(join(KINDS_DIR, target))) return loadDir(join(KINDS_DIR, target));
  return null;
}

/** Run one rule case; a list of what did not match. */
function ruleCase(kinds, c) {
  const v = decide({kinds, ...c});
  const off = mismatches(c.expect, v);
  return off.length ? [`${off.join(', ')} differ: got ${JSON.stringify(Object.fromEntries(off.map(k => [k, v[k]])))}`] : [];
}

/** Run one effect case as packages/form-rules runs it: each act through effects and apply, again with its receipt, then the state after. */
function effectCase(kinds, c) {
  const out = [];
  let state = structuredClone(c.state);
  for (const [k, step] of c.do.entries()) {
    const result = effects({kinds, act: step.act, state: {...state, actor: step.actor ?? state.actor, now_us: step.now_us ?? state.now_us}, receipt: step.receipt});
    const off = step.expect ? mismatches(step.expect, result) : [];
    if (off.length) { out.push(`step ${k}: ${off.join(', ')} differ: got ${JSON.stringify(Object.fromEntries(off.map(x => [x, result[x]])))}`); break; }
    const once = apply(state, result);
    if (!once.ok) { out.push(`step ${k}: cannot apply (${once.reason}, change ${once.change})`); break; }
    if (result.verdict !== 'yes') continue;
    const twice = apply(once.state, result);
    if (!(twice.ok && twice.again && same(twice.state, once.state))) { out.push(`step ${k}: applied again with its receipt, it changed the state`); break; }
    state = once.state;
  }
  if (!out.length) for (const [id, want] of Object.entries(c.after ?? {})) if (!same(state.nodes[id] ?? null, want)) out.push(`after: ${id} is ${JSON.stringify(state.nodes[id] ?? null)}`);
  return out;
}

/** The cases gate: the family's cases through the rules, and what each kind still lacks a case for. */
export function provenCases(entries, {cases: casesDir = CASES} = {}) {
  // Every published and test kind, with the family's own entries over any of the same name.
  const mine = new Map(entries.map(e => [e.kind, e]));
  const kinds = {...loadKinds(KIND_DIRS), ...Object.fromEntries(mine)};
  const kindOf = (c, act) => c.state?.nodes?.[act.this]?.kind;
  const rules = loadCases(casesDir).filter(([, c]) => mine.has(kindOf(c, c.act)));
  const effectsDir = join(casesDir, 'effects');
  const done = existsSync(effectsDir) ? loadEffectCases(effectsDir).filter(([, c]) => c.do.some(s => mine.has(kindOf(c, s.act)))) : [];
  const findings = [];
  const name = f => relative(ROOT, f);
  for (const [file, c] of rules) for (const why of ruleCase(kinds, c)) findings.push({case: c.name, file: name(file), reason: why});
  for (const [file, c] of done) for (const why of effectCase(kinds, c)) findings.push({case: c.name, file: name(file), reason: why});
  // What each kind's forms lack: a yes, an unmet case per need, and the form done in an effect case.
  for (const [kind, e] of mine) for (const [fn, f] of Object.entries(e.forms ?? {})) {
    const own = rules.map(([, c]) => c).filter(c => c.act.form === fn && kindOf(c, c.act) === kind);
    const lack = why => findings.push({kind, form: fn, reason: why, fix: `add a case to ${name(casesDir)}`});
    if (!own.some(c => c.expect.verdict === 'yes')) lack('no rule case where every need is met');
    (f.needs ?? []).forEach((n, i) => {
      if (!own.some(c => c.expect.verdict === 'no' && c.expect.need === i && c.expect.reason !== 'bad_input')) lack(`no rule case where need ${i} (${n.need}) is unmet`);
    });
    if (!done.some(([, c]) => c.do.some(s => s.act.form === fn && kindOf(c, s.act) === kind && s.expect?.verdict === 'yes'))) lack(`not done in any effect case (${name(effectsDir)})`);
  }
  return {ran: true, ok: !findings.length, rule_cases: rules.length, effect_cases: done.length, findings};
}

/** The look gate over the family: a sheet per kind. A kind with no shape waits for one (SA-D3, #2855). */
export function provenLook(target, {out} = {}) {
  const {out: dir, results} = look(target, {out});
  const kinds = results.map(r => {
    const errors = r.errors ?? [];
    if (errors.length === 1 && errors[0] === NO_SHAPE) return {kind: r.kind, waits: 'a shape: an entry cannot carry one until SA-D3 (#2855)', frames: r.frames};
    return {kind: r.kind ?? relative(ROOT, r.file), ok: !errors.length, sheet: r.sheet && relative(ROOT, r.sheet), frames: r.frames, distinct: r.distinct, errors};
  });
  const failed = kinds.some(k => k.ok === false), waiting = kinds.length > 0 && kinds.every(k => k.waits);
  return {ran: !waiting, ok: !failed && !waiting ? true : failed ? false : null, out: relative(ROOT, dir) || dir, kinds};
}

/** Every gate for one target. */
export function prove(target, {cases, out} = {}) {
  const files = filesOf(target);
  if (!files) return {error: `no such family, folder or file: ${target}`};
  // Kinds an entry refers to are looked for among the published ones; a scratch copy stands in for the published
  // kind of the same name.
  const own = new Set(files.map(kindName));
  const all = [...new Set([...loadDir(KINDS_DIR).filter(f => files.includes(f) || !own.has(kindName(f))), ...files])];
  const rows = checkFiles(files, all);
  const check = {ran: true, ok: rows.every(r => !r.findings.length), kinds: rows.map(r => ({file: relative(ROOT, r.file), kind: r.entry?.kind, ok: !r.findings.length, findings: r.findings}))};
  const gates = {check};
  const skip = {ran: false, ok: null, skipped: 'the check gate failed'};
  // A case file that cannot be read is a failed gate, not a crash.
  const cased = () => { try { return provenCases(rows.map(r => r.entry), {cases: cases && resolve(cases)}); } catch (e) { return {ran: true, ok: false, findings: [{reason: e.message.split(ROOT).join("")}]}; } };
  gates.cases = check.ok ? cased() : skip;
  gates.look = check.ok ? provenLook(files.length === 1 ? files[0] : resolve(existsSync(target) ? target : join(KINDS_DIR, target)), {out}) : skip;
  for (const g of RUNNER_GATES) gates[g] = {ran: false, ok: null, waits: 'a runner (Engine v2)'};
  const failed = Object.entries(gates).filter(([, g]) => g.ok === false).map(([n]) => n);
  return {
    target, kinds: rows.map(r => r.entry?.kind ?? relative(ROOT, r.file)), ok: !failed.length, failed,
    ran: Object.entries(gates).filter(([, g]) => g.ran).map(([n]) => n),
    waits: Object.entries(gates).filter(([, g]) => g.waits || g.kinds?.some(k => k.waits)).map(([n]) => n),
    gates,
  };
}

function kindName(file) { try { return JSON.parse(readFileSync(file, 'utf8')).kind; } catch { return file; } }

/** The command line: `prove <target> [--cases <dir>] [--out <dir>]`. Returns the exit code. */
export function main(argv) {
  const args = argv[0] === 'prove' ? argv.slice(1) : argv;
  const flag = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const target = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  if (!target) { console.log(JSON.stringify({error: 'usage: node tools/entry/prove.mjs <family|folder|file> [--cases <dir>] [--out <dir>]'})); return 2; }
  const v = prove(target, {cases: flag('cases'), out: flag('out')});
  console.log(JSON.stringify(v));
  return v.error ? 2 : v.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
