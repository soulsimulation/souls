#!/usr/bin/env node
// The run gate, part 1 (Soul Actions SA-P3a, #2932): an entry's cases driven on a real world from outside, as an agent.
//
//   node tools/entry/run.mjs <family|folder|file> --world <address> [--repeats 2] [--transport <module>] [--cases <dir>]
//   pnpm entry run <family> --world <address>                                                         (the same)
//
// For every form of every kind in the family it runs the entry's cases (packages/form-rules/cases, the same files the
// rules' own gate runs): the case where every need is met, one per unmet need, then the expected outcomes (effects/).
// The scene is set through the creator's own commands (place a thing, set its fields, remove it); the case is then
// played by a Soul exactly as an agent plays it: it sends the act, reads the receipt, and reads the thing again. Nothing
// here reads a world's insides, a server fixture or a state hash, so Engine v2's gate (F7, #2775) runs this file
// unchanged against its gateway, with only the transport swapped. Cases are data: this tool never changes one.
//
// What a case expects, seen from outside:
// - verdict yes: the receipt completes.
// - verdict no, with a fix that is a step (walk_to, take, put): either the world refuses with that reason, or it carries
//   the fix out and the receipt completes (`via: "fix"`). Both answer the case; the row says which.
// - any other no: the act is refused or its receipt fails, with the case's reason, and the thing's fields read as before.
// - an effect case: each act as above; a `set` change reads back as its value after the step; the case's `after`
//   fields read back at the end. Changes of other kinds and events are compared when the transport can read them.
// A case the world cannot set up or start is skipped, never passed: the row names the cause (the form is not offered;
// the form is started by the world's timer; the start needs a Soul holding something; a change cannot be read here).
//
// Prints one JSON verdict: per repeat, a row per case (pass, fail, skip, why), the table per form, failures by name, and
// the wall time. Exits 0 when no case failed, 1 when one did, 2 on a bad argument or a world that could not be reached.
//
// A transport is a module whose default export makes `{name, timers, events, start(), place(kind, entry), set(id,
// fields), remove(id), offers(id), fields(id), act(id, form, args)}` from `{world, ...flags}`. `act` answers `{verdict:
// "yes"|"no", reason, code, receipt}`: `reason` is the rules' reason when the world names one. The built-in one,
// `today`, drives today's local world through its adapters (tools/entry/load.mjs, SA-F3a's forms adapter): the god CLI
// (tools/god-skill/cli.mjs) from the creator's folder (--god <dir>, default here) and the Soul CLI
// (tools/world-launcher/soul/eden.mjs) for the Soul in SOULS_HOME (--soul <name> when there are several).
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {filesOf} from './prove.mjs';
import {load as loadPlan} from './load.mjs';
import {CASES, loadCases, loadEffectCases, same} from '../../packages/form-rules/src/load.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GOD = join(ROOT, 'tools/god-skill/cli.mjs'), SOUL = join(ROOT, 'tools/world-launcher/soul/eden.mjs');
const STEP_FIXES = new Set(['walk_to', 'take', 'put']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- the cases, from the entry and its case files

/** The family's entries: every file the target names that reads as an entry. */
async function entriesOf(target) {
  const files = filesOf(target);
  if (!files) return null;
  const rows = await loadPlan(target, {plan: true});
  return rows.filter(r => r.kind).map(r => ({...r, entry: JSON.parse(readFileSync(join(ROOT, r.file), 'utf8'))}));
}

/** The cases of a family, in run order: per kind, per form, the met case, the unmet ones by need, other rule cases; then
 *  the effect cases that act on one of its kinds. Pure: no world. */
export function casesFor(kinds, {cases: dir = CASES} = {}) {
  const byKind = new Map(kinds.map(k => [k.kind, k.entry]));
  const kindOf = (c, act) => c.state?.nodes?.[act.this]?.kind;
  const rules = loadCases(dir).filter(([, c]) => byKind.has(kindOf(c, c.act)));
  const effectsDir = join(dir, 'effects');
  const effects = existsSync(effectsDir) ? loadEffectCases(effectsDir).filter(([, c]) => c.do.some(s => byKind.has(kindOf(c, s.act)))) : [];
  const order = c => c.expect.verdict === 'yes' ? -1 : c.expect.need ?? 99;
  const out = [];
  for (const [kind, entry] of byKind) {
    const forms = Object.keys(entry.forms ?? {});
    for (const form of [...forms, null]) {
      const own = rules.filter(([, c]) => kindOf(c, c.act) === kind && (form ? c.act.form === form : !forms.includes(c.act.form)));
      own.sort(([, a], [, b]) => order(a) - order(b));
      for (const [file, c] of own) out.push({type: 'rule', name: c.name, file: relative(ROOT, file), kind, form: c.act.form, case: c});
    }
  }
  for (const [file, c] of effects) out.push({type: 'effect', name: c.name, file: relative(ROOT, file), kind: kindOf(c, c.do[0].act), form: c.do.map(s => s.act.form).join(' → '), case: c});
  return out;
}

// ---------------------------------------------------------------- playing one case through a transport

/** The fields a node starts with: the entry's defaults under the case's own. */
function startFields(entry, node) {
  return {...Object.fromEntries(Object.entries(entry.state ?? {}).map(([k, f]) => [k, f.default])), ...(node?.fields ?? {})};
}

/** Why a case's start cannot be set up from outside, or null. */
function setupGap(c, kinds) {
  for (const [id, n] of Object.entries(c.state?.nodes ?? {})) {
    if (n.kind && !kinds.has(n.kind)) return `the start needs a ${n.kind} (${id}), which is not in this family`;
    const held = Object.entries(n.hands ?? {}).filter(([, v]) => v);
    if (held.length) return `the start needs ${id} holding ${held.map(([h, v]) => `${v} in the ${h} hand`).join(', ')}: a take, which this run does not set up`;
    if (Object.keys(n.links ?? {}).length || Object.keys(n.slots ?? {}).length || n.parent) return `the start needs links, slots or a parent on ${id}, which this run does not set up`;
  }
  return null;
}

/** Fields read back until they hold `want` (or the time runs out): what the world shows from outside. */
async function readUntil(t, id, want, ms = 6000) {
  const end = Date.now() + ms;
  let got = await t.fields(id);
  while (!sameFields(got, want) && Date.now() < end) { await sleep(500); got = await t.fields(id); }
  return got;
}
/** Fields read back once they have stopped changing (two reads a second apart agree). */
async function settled(t, id) {
  await sleep(1200);
  let a = await t.fields(id);
  for (let i = 0; i < 6; i++) { await sleep(800); const b = await t.fields(id); if (same(a, b)) return b; a = b; }
  return a;
}
const sameFields = (got, want) => got && Object.entries(want).every(([k, v]) => same(got[k], v));

/** Check one act's answer against what its case expects. A list of what is off, and how it was met. */
function judge(expect, got, before, after) {
  const off = [];
  let via;
  if (expect.verdict === 'yes') { if (got.verdict !== 'yes') off.push(`expected the act to complete; it was ${got.verdict === 'no' ? `refused (${got.code ?? got.reason})` : got.verdict}`); }
  else if (expect.verdict === 'no') {
    if (got.verdict === 'yes' && expect.fix?.step && STEP_FIXES.has(expect.fix.step)) via = 'fix';
    else if (got.verdict !== 'no') off.push(`expected a refusal (${expect.reason}); the act completed`);
    else if (got.reason !== expect.reason) off.push(`expected the reason ${expect.reason}; the world gave ${got.reason ?? 'none'} (${got.code ?? ''})`);
    if (got.verdict === 'no' && !same(before, after)) off.push(`refused, yet the fields changed: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  }
  return {off, via};
}

async function ruleCase(t, row, kinds, placed) {
  const c = row.case, entry = kinds.get(row.kind), form = entry.forms?.[c.act.form];
  if (form && form.starts !== 'act') return {result: 'skip', why: `${c.act.form} is started by the world (${form.starts}), not by an act`};
  const id = await placed(row.kind);
  const want = startFields(entry, c.state.nodes[c.act.this]);
  await t.set(id, want);
  const before = await readUntil(t, id, want);
  if (!sameFields(before, want)) return {result: 'fail', why: `the scene could not be set: the fields read ${JSON.stringify(before)}, not ${JSON.stringify(want)}`};
  if (form && !(await t.offers(id)).includes(c.act.form)) return {result: 'skip', why: `${c.act.form} is not offered by this world`};
  const gap = setupGap(c, kinds); if (gap) return {result: 'skip', why: gap};
  const got = await t.act(id, c.act.form, c.act.args);
  const after = got.verdict === 'no' ? await settled(t, id) : await t.fields(id);
  const {off, via} = judge(c.expect, got, before, after);
  return {result: off.length ? 'fail' : 'pass', ...(off.length ? {why: off.join('; ')} : {}), got: brief(got), ...(via ? {via} : {})};
}

async function effectCase(t, row, kinds, placed) {
  const c = row.case;
  const gap = setupGap(c, kinds); if (gap) return {result: 'skip', why: gap};
  const ids = {};
  for (const [nid, n] of Object.entries(c.state.nodes)) if (n.kind) { ids[nid] = await placed(n.kind); await t.set(ids[nid], startFields(kinds.get(n.kind), n)); }
  for (const [nid, n] of Object.entries(c.state.nodes)) if (n.kind) await readUntil(t, ids[nid], startFields(kinds.get(n.kind), n));
  const steps = [];
  for (const [k, step] of c.do.entries()) {
    const kind = c.state.nodes[step.act.this]?.kind, form = kinds.get(kind)?.forms?.[step.act.form], id = ids[step.act.this];
    if (form && form.starts !== 'act') {
      if (!t.timers) return {result: 'skip', why: `step ${k}: ${step.act.form} is started by the world's timer, which this world does not run`, steps};
      const want = setsOf(step.expect, ids)[id] ?? {}, got = await readUntil(t, id, want, (timerAfter(c, step) ?? 0) / 1000 + 10000);
      if (!sameFields(got, want)) return {result: 'fail', why: `step ${k}: ${step.act.form} by the world: the fields read ${JSON.stringify(got)}`, steps};
      steps.push({step: k, form: step.act.form, by: 'world'});
      continue;
    }
    const offered = await t.offers(id);
    if (form && !offered.includes(step.act.form)) return {result: 'skip', why: `step ${k}: ${step.act.form} is not offered by this world`, steps};
    const unread = (step.expect?.changes ?? []).filter(x => x.change !== 'set').map(x => x.change);
    if (unread.length && !t.reads?.includes?.(unread[0])) return {result: 'skip', why: `step ${k}: a ${unread[0]} change cannot be read from outside on this world`, steps};
    const before = await t.fields(id);
    const args = Object.fromEntries(Object.entries(step.act.args ?? {}).map(([a, v]) => [a, ids[v] ?? v]));
    const got = await t.act(id, step.act.form, args);
    const sets = setsOf(step.expect, ids);
    const after = got.verdict === 'no' ? await settled(t, id) : await readUntil(t, id, sets[id] ?? {});
    const {off, via} = judge(step.expect ?? {}, got, before, after);
    for (const [nid, want] of Object.entries(sets)) { const now = nid === id ? after : await readUntil(t, nid, want); if (!sameFields(now, want)) off.push(`after the step, ${nid} reads ${JSON.stringify(now)}, not ${JSON.stringify(want)}`); }
    if (t.events && step.expect?.events && !same((got.events ?? []).map(e => e.event), step.expect.events.map(e => e.event))) off.push(`events ${JSON.stringify(got.events)} differ`);
    steps.push({step: k, form: step.act.form, got: brief(got), ...(via ? {via} : {})});
    if (off.length) return {result: 'fail', why: `step ${k}: ${off.join('; ')}`, steps};
  }
  for (const [nid, want] of Object.entries(c.after ?? {})) {
    if (!ids[nid] || !want?.fields) continue;
    const now = await readUntil(t, ids[nid], want.fields);
    if (!sameFields(now, want.fields)) return {result: 'fail', why: `after: ${nid} reads ${JSON.stringify(now)}, not ${JSON.stringify(want.fields)}`, steps};
  }
  return {result: 'pass', steps};
}
const timerAfter = (c, step) => c.do.flatMap(s => s.expect?.timers ?? []).find(x => x.form === step.act.form)?.after_us;
/** The `set` changes a step expects, as fields per world id. */
function setsOf(expect, ids) {
  const out = {};
  for (const x of expect?.changes ?? []) if (x.change === 'set' && ids[x.node]) (out[ids[x.node]] ??= {})[x.field] = x.to;
  return out;
}
const brief = g => ({verdict: g.verdict, ...(g.reason ? {reason: g.reason} : {}), ...(g.code ? {code: g.code} : {}), ...(g.receipt ? {receipt: g.receipt} : {})});

/** Run every case once. Things are placed fresh for each case and removed after it. */
export async function runOnce(t, kinds, rows) {
  const out = [];
  for (const row of rows) {
    const mine = [];
    const placed = async kind => { const id = await t.place(kind, kinds.get(kind)); mine.push(id); return id; };
    const t0 = Date.now();
    let r;
    try { r = row.type === 'rule' ? await ruleCase(t, row, kinds, placed) : await effectCase(t, row, kinds, placed); }
    catch (e) { r = {result: 'fail', why: `the run broke: ${String(e.message ?? e).split(ROOT).join('')}`}; }
    for (const id of mine) await t.remove(id).catch(() => {});
    out.push({case: row.name, type: row.type, kind: row.kind, form: row.form, file: row.file, ...r, ms: Date.now() - t0});
  }
  return out;
}

/** The table per form: cases, passed, failed, skipped. */
function table(rows) {
  const t = {};
  for (const r of rows) { const k = `${r.kind} ${r.type === 'effect' ? '(outcomes)' : r.form}`; const x = (t[k] ??= {cases: 0, passed: 0, failed: 0, skipped: 0}); x.cases++; x[{pass: 'passed', fail: 'failed', skip: 'skipped'}[r.result]]++; }
  return t;
}

export async function run(target, {world, repeats = 2, transport, cases, ...flags} = {}) {
  const t0 = Date.now();
  const loaded = await entriesOf(target);
  if (!loaded) return {error: `no such family, folder or file: ${target}`};
  const kinds = new Map(loaded.filter(k => k.entry.forms && Object.keys(k.entry.forms).length).map(k => [k.kind, k.entry]));
  const rows = casesFor([...kinds].map(([kind, entry]) => ({kind, entry})), {cases: cases && resolve(cases)});
  const make = transport ? (await import(pathToFileURL(resolve(transport)).href)).default : todayTransport;
  const t = await make({world, ...flags});
  await t.start?.(loaded);
  const runs = [];
  for (let i = 0; i < repeats; i++) { const s = Date.now(); const r = await runOnce(t, kinds, rows); runs.push({repeat: i + 1, wall_ms: Date.now() - s, cases: r}); }
  await t.stop?.();
  const failed = [...new Set(runs.flatMap(r => r.cases.filter(c => c.result === 'fail').map(c => c.case)))];
  const skipped = Object.entries(Object.groupBy(runs[0]?.cases.filter(c => c.result === 'skip') ?? [], c => c.why)).map(([why, cs]) => ({why, cases: cs.map(c => c.case)}));
  return {
    target, world, transport: t.name, repeats, kinds: [...kinds.keys()], ok: !failed.length, failed,
    passed_every_repeat: runs.every(r => r.cases.every(c => c.result !== 'fail')),
    table: table(runs[0]?.cases ?? []), skipped, runs, wall_ms: Date.now() - t0,
  };
}

// ---------------------------------------------------------------- today's world, through its adapters

/** Today's local world: the creator's god CLI sets the scene, the Soul CLI plays the case. */
export function todayTransport({world, god = process.cwd(), soul} = {}) {
  if (!world) throw new Error('--world <url> names the world');
  const cli = (file, args, opts) => {
    const r = spawnSync(process.execPath, [file, ...args], {encoding: 'utf8', env: process.env, maxBuffer: 64 << 20, ...opts});
    return {status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim()};
  };
  const godCli = args => { const r = cli(GOD, args, {cwd: resolve(god)}); if (r.status !== 0 || /REFUSED/.test(r.out)) throw new Error(`god ${args[0]}: ${r.out || r.err}`); return r.out; };
  const soulCli = args => { const r = cli(SOUL, soul ? [soul, ...args] : args); let j = null; try { j = JSON.parse(r.out); } catch { /* not json */ } if (!j) throw new Error(`soul ${args[0]}: ${r.err || r.out}`); return j; };
  const defs = new Map();
  let n = 0;
  const thing = id => soulCli(['query', JSON.stringify({thing: id})]).answers?.[0] ?? {};
  const t = {
    name: 'today', timers: false, events: false, reads: [],
    async start(loaded) {
      const status = cli(GOD, ['status'], {cwd: resolve(god)});
      if (!status.out.includes(world.replace(/\/$/, ''))) throw new Error(`the god folder ${relative(process.cwd(), resolve(god)) || '.'} holds no seat for ${world}`);
      const dir = mkdtempSync(join(tmpdir(), 'entry-run-'));
      try {
        for (const r of loaded) {
          if (!r.plan || !r.entry.forms) continue;
          const file = join(dir, `${r.plan.name}.json`);
          writeFileSync(file, JSON.stringify(r.plan));
          godCli(['define', file]);
          defs.set(r.kind, r.def);
        }
      } finally { rmSync(dir, {recursive: true, force: true}); }
    },
    async place(kind) {
      const def = defs.get(kind); if (!def) throw new Error(`${kind} could not be loaded into this world`);
      const me = soulCli(['here']).me?.pos ?? [0, 0];
      // beside the Soul, out of reach of any point on it: the Soul walks there as the form asks
      for (const [dx, dz] of [[3, 0], [0, 3], [-3, 0], [0, -3], [4, 4]]) {
        const r = cli(GOD, ['place', def, '--at', `${(me[0] + dx).toFixed(2)},${(me[1] + dz).toFixed(2)}`, '--name', `run-${kind.split(':')[1]}-${++n}`, '--json'], {cwd: resolve(god)});
        let j = null; try { j = JSON.parse(r.out); } catch { /* refused in words */ }
        if (j?.accepted && j.ids) return Object.values(j.ids)[0];
      }
      throw new Error(`no room to place ${kind} beside the Soul`);
    },
    async set(id, fields) { godCli(['set', id, '--state', JSON.stringify(fields)]); },
    async remove(id) { godCli(['remove', id]); },
    async offers(id) { return (thing(id).acts ?? []).map(a => a.split(':').at(-1)); },
    async fields(id) { return thing(id).state ?? null; },
    async act(id, form, args) {
      const j = soulCli(['act', `object:${id}:${form}`, ...(args && Object.keys(args).length ? [JSON.stringify(args)] : []), '--wait', '--json']);
      const rc = j.receipt;
      if (!j.accepted) return {verdict: 'no', code: j.code, reason: reasonOf(j.code)};
      if (rc?.phase === 'completed') return {verdict: 'yes', receipt: rc.phase};
      if (['failed', 'cancelled', 'refused'].includes(rc?.phase)) return {verdict: 'no', code: rc.code, reason: reasonOf(rc.code), receipt: rc.phase};
      return {verdict: 'open', receipt: rc?.phase ?? 'none'};
    },
  };
  return t;
}
/** The rules' reason in today's codes: the forms adapter names it `form.<reason>`; an act the world does not offer is bad input. */
function reasonOf(code) {
  if (typeof code !== 'string') return null;
  if (code.startsWith('form.')) return code.slice(5);
  if (code === 'capability.unknown') return 'bad_input';
  return code;
}

// ---------------------------------------------------------------- the command line

export async function main(argv) {
  const args = argv[0] === 'run' ? argv.slice(1) : argv;
  const flag = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const target = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  const usage = 'usage: node tools/entry/run.mjs <family|folder|file> --world <address> [--repeats 2] [--transport <module>] [--cases <dir>] [--god <dir>] [--soul <name>]';
  if (!target || !flag('world')) { console.log(JSON.stringify({error: usage})); return 2; }
  const repeats = Number(flag('repeats') ?? 2);
  if (!Number.isInteger(repeats) || repeats < 1) { console.log(JSON.stringify({error: '--repeats takes a whole number of at least 1'})); return 2; }
  let v;
  try { v = await run(target, {world: flag('world'), repeats, transport: flag('transport'), cases: flag('cases'), god: flag('god'), soul: flag('soul')}); }
  catch (e) { console.log(JSON.stringify({error: String(e.message ?? e).split(ROOT).join('')})); return 2; }
  console.log(JSON.stringify(v, null, 1));
  return v.error ? 2 : v.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await main(process.argv.slice(2));
