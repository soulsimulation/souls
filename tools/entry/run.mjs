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
// Then the disturbances (part 2, SA-P3b #2933), per form a Soul starts: the Soul leaves as each step begins and in the
// middle of each step, a creator removes the thing, the world restarts (see "the disturbances" below). Each is a row
// named `<form>: <what happened when>`, with the stage the act was at when it was sent and how the form ended. A world
// under a launcher (…/w/<slug>; --launcher <origin> when the launcher is elsewhere) is restarted as a crash restarts
// it; a world that is not is skipped for that row, with the cause.
//
// Prints one JSON verdict: per repeat, a row per case (pass, fail, skip, why), the table per form, failures by name, and
// the wall time. Exits 0 when no case failed, 1 when one did, 2 on a bad argument or a world that could not be reached.
//
// A transport is a module whose default export makes `{name, timers, events, start(), place(kind, entry), set(id,
// fields), remove(id), offers(id), fields(id), act(id, form, args)}` from `{world, ...flags}`; for the disturbances also
// `begin(id, form, args)` → `{verdict: "started", rid, progress}`, `progress(rid)` → `{phase, step, moving}` (step null
// when the world does not say), `wait(rid)`, `leave(rid)`, `body()` → `{posture, activity, holding}` and `restart()`. `act` answers `{verdict:
// "yes"|"no", reason, code, receipt}`: `reason` is the rules' reason when the world names one. The built-in one,
// `today`, drives today's local world through its adapters (tools/entry/load.mjs, SA-F3a's forms adapter): the god CLI
// (tools/god-skill/cli.mjs) from the creator's folder (--god <dir>, default here) and the Soul CLI
// (tools/world-launcher/soul/eden.mjs) for the Soul in SOULS_HOME (--soul <name> when there are several).
// `act` and `begin` also get `{case, ids}`: the case's act and state, and which world id each of its nodes was placed
// as (a world that decides on the case's own state reads it; today's ignores it). A transport with `stepped` true runs
// a world that changes only when asked (tools/entry/v2.mjs, Engine v2's form runner): its reads are final, so the gate
// never waits on them.
import { isMain } from '../lib/is-main.mjs';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {filesOf} from './prove.mjs';
import {load as loadPlan, NEW_ENGINE_ONLY} from './load.mjs';
import {CASES, loadCases, loadEffectCases, loadKinds, same} from '../../packages/form-rules/src/load.ts';
import {decide} from '../../packages/form-rules/src/rules.ts';

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

/** A field's value as today's world holds it: a case writes a bool as 0/1 (effect cases) or true/false, and a text as
 *  a reference `{text: <id>}`, which today's def holds as the id's string (load.mjs). */
export function asWorld(entry, field, v) {
  const type = entry?.state?.[field]?.type;
  if (type === 'bool' && (v === 0 || v === 1)) return v === 1;
  if (type === 'text' && typeof v?.text === 'string') return v.text;
  return v;
}
/** The fields a Soul reads back: a text is set but a Soul's read of the thing leaves it out, so it is never compared. */
export const seen = (entry, fields) => Object.fromEntries(Object.entries(fields).filter(([k]) => entry?.state?.[k]?.type !== 'text'));
/** The fields a node starts with: the entry's defaults under the case's own. A list, schedule or timed field is not
 *  carried today (load.mjs), and a text with nothing written (null) is left unset. */
export function startFields(entry, node) {
  const out = {};
  for (const [k, v] of Object.entries({...Object.fromEntries(Object.entries(entry.state ?? {}).map(([k, f]) => [k, f.default])), ...(node?.fields ?? {})})) {
    const f = entry.state?.[k];
    if (NEW_ENGINE_ONLY.includes(f?.type) || (f?.type === 'text' && v === null)) continue;
    out[k] = asWorld(entry, k, v);
  }
  return out;
}
/** Why a case needs a field today's def does not carry (a list, schedule or timed field), or null: its start sets one, or
 *  a step or its end expects one. */
export function newEngineGap(c, kinds) {
  const kindOf = nid => kinds.get(c.state?.nodes?.[nid]?.kind);
  const needs = (nid, field) => { const f = kindOf(nid)?.state?.[field]; return NEW_ENGINE_ONLY.includes(f?.type) ? `${field} (a ${f.type} field)` : null; };
  const named = [
    ...Object.entries(c.state?.nodes ?? {}).flatMap(([nid, n]) => Object.keys(n.fields ?? {}).map(k => needs(nid, k))),
    ...(c.do ?? []).flatMap(s => (s.expect?.changes ?? []).filter(x => x.change === 'set').map(x => needs(x.node, x.field))),
    ...Object.entries(c.after ?? {}).flatMap(([nid, w]) => Object.keys(w?.fields ?? {}).map(k => needs(nid, k))),
  ].filter(Boolean);
  return named.length ? `the case needs ${named[0]}: new engine only, today's def does not carry it` : null;
}
/** The kinds a row places. */
const kindsOfRow = row => row.type === 'disturb' || !row.case ? [row.kind] : [...new Set([row.kind, ...Object.values(row.case.state?.nodes ?? {}).map(n => n.kind).filter(Boolean)])];
let allKinds;
/** The rules' own fix for a case's refusal, when the case does not state one (a case compares only what it names). */
export function rulesFix(c) {
  if (c.expect?.verdict !== 'no' || c.expect.fix) return c.expect?.fix;
  try { return decide({kinds: (allKinds ??= loadKinds()), act: c.act, state: c.state, asker: c.asker}).fix; } catch { return undefined; }
}

/** Why a case's start cannot be set up from outside, or null. A world that takes the case's own hands, links and
 *  slots as its scene (`t.scene`, the v2 transport: it decides on the case's state) needs no take or link first. */
function setupGap(c, kinds, t) {
  const scene = new Set(t?.scene ?? []);
  for (const [id, n] of Object.entries(c.state?.nodes ?? {})) {
    if (n.kind && !kinds.has(n.kind)) return `the start needs a ${n.kind} (${id}), which is not in this family`;
    const held = Object.entries(n.hands ?? {}).filter(([, v]) => v);
    if (held.length && !scene.has('hands')) return `the start needs ${id} holding ${held.map(([h, v]) => `${v} in the ${h} hand`).join(', ')}: a take, which this run does not set up`;
    const links = Object.keys(n.links ?? {}).length && !scene.has('links'), slots = Object.keys(n.slots ?? {}).length && !scene.has('slots');
    if (links || slots || n.parent) return `the start needs links, slots or a parent on ${id}, which this run does not set up`;
  }
  return null;
}
/** Whether a case's start leans on the scene a world takes from the case (`t.scene`) or a kind from outside the family
 *  (`t.outside`): then a form that needs what that world cannot run (`t.treeGap`) is skipped, with its reason. */
function sceneGap(c, entry, form, t) {
  const leans = Object.values(c.state?.nodes ?? {}).some(n => Object.values(n.hands ?? {}).some(Boolean) || Object.keys(n.links ?? {}).length || Object.keys(n.slots ?? {}).length || t.outside?.has(n.kind));
  return leans ? t.treeGap?.(entry, form) ?? null : null;
}

/** Fields read back until they hold `want` (or the time runs out): what the world shows from outside. */
async function readUntil(t, id, want, ms = 6000) {
  const end = Date.now() + ms;
  let got = await t.fields(id);
  while (!t.stepped && !sameFields(got, want) && Date.now() < end) { await sleep(500); got = await t.fields(id); }
  return got;
}
/** Fields read back once they have stopped changing (two reads a second apart agree). */
async function settled(t, id) {
  if (t.stepped) return t.fields(id);
  await sleep(1200);
  let a = await t.fields(id);
  for (let i = 0; i < 6; i++) { await sleep(800); const b = await t.fields(id); if (same(a, b)) return b; a = b; }
  return a;
}
const sameFields = (got, want) => got && Object.entries(want).every(([k, v]) => same(got[k] ?? null, v));

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
  const unborn = newEngineGap(c, kinds); if (unborn) return {result: 'skip', why: unborn};
  const id = await placed(row.kind);
  const want = startFields(entry, c.state.nodes[c.act.this]);
  await t.set(id, want);
  const before = await readUntil(t, id, seen(entry, want));
  if (!sameFields(before, seen(entry, want))) return {result: 'fail', why: `the scene could not be set: the fields read ${JSON.stringify(before)}, not ${JSON.stringify(seen(entry, want))}`};
  if (form && !(await t.offers(id)).includes(c.act.form)) return {result: 'skip', why: `${c.act.form} is not offered by this world`};
  const gap = setupGap(c, kinds, t) ?? (c.expect.verdict === 'yes' ? sceneGap(c, entry, c.act.form, t) : null); if (gap) return {result: 'skip', why: gap};
  // the case's other things (an argument: a pot, a pail), placed and set as the effect cases place them
  const ids = {[c.act.this]: id}, others = Object.entries(c.state.nodes).filter(([nid, n]) => n.kind && nid !== c.act.this);
  for (const [nid, n] of others) { ids[nid] = await placed(n.kind); await t.set(ids[nid], startFields(kinds.get(n.kind), n)); }
  for (const [nid, n] of others) await readUntil(t, ids[nid], seen(kinds.get(n.kind), startFields(kinds.get(n.kind), n)));
  const got = await t.act(id, c.act.form, Object.fromEntries(Object.entries(c.act.args ?? {}).map(([a, v]) => [a, ids[v] ?? v])), {case: c, ids});
  const after = got.verdict === 'no' ? await settled(t, id) : await t.fields(id);
  const {off, via} = judge({...c.expect, ...(c.expect.verdict === 'no' ? {fix: rulesFix(c)} : {})}, got, before, after);
  return {result: off.length ? 'fail' : 'pass', ...(off.length ? {why: off.join('; ')} : {}), got: brief(got), ...(via ? {via} : {})};
}

async function effectCase(t, row, kinds, placed) {
  const c = row.case;
  const gap = setupGap(c, kinds, t) ?? newEngineGap(c, kinds); if (gap) return {result: 'skip', why: gap};
  const ids = {};
  for (const [nid, n] of Object.entries(c.state.nodes)) if (n.kind) { ids[nid] = await placed(n.kind); await t.set(ids[nid], startFields(kinds.get(n.kind), n)); }
  for (const [nid, n] of Object.entries(c.state.nodes)) if (n.kind) await readUntil(t, ids[nid], seen(kinds.get(n.kind), startFields(kinds.get(n.kind), n)));
  const steps = [];
  let moved = null;
  for (const [k, step] of c.do.entries()) {
    const kind = c.state.nodes[step.act.this]?.kind, form = kinds.get(kind)?.forms?.[step.act.form], id = ids[step.act.this];
    if (!id) return {result: 'skip', why: `step ${k}: it acts on ${step.act.this}, which an earlier step made, and this run places only the case's own things`, steps};
    if (form && form.starts !== 'act') {
      if (!t.timers) return {result: 'skip', why: `step ${k}: ${step.act.form} is started by the world's timer, which this world does not run`, steps};
      const want = setsOf(step.expect, ids, c, kinds)[id] ?? {}, got = await readUntil(t, id, want, (timerAfter(c, step) ?? 0) / 1000 + 10000);
      if (!sameFields(got, want)) return {result: 'fail', why: `step ${k}: ${step.act.form} by the world: the fields read ${JSON.stringify(got)}`, steps};
      steps.push({step: k, form: step.act.form, by: 'world'});
      continue;
    }
    const offered = await t.offers(id);
    if (form && !offered.includes(step.act.form)) return {result: 'skip', why: `step ${k}: ${step.act.form} is not offered by this world`, steps};
    const tree = step.expect?.verdict === 'yes' && sceneGap(c, kinds.get(kind), step.act.form, t);
    if (tree) return {result: 'skip', why: `step ${k}: ${tree}`, steps};
    // a world that decides on the case's start (t.scene) cannot see what an earlier step linked or moved
    if (k > 0 && t.scene && !t.tree && moved) return {result: 'skip', why: `step ${k}: an earlier step ${moved}, and this world decides on the case's start`, steps};
    const unread = (step.expect?.changes ?? []).filter(x => x.change !== 'set').map(x => x.change);
    const blind = unread.find(x => !t.reads?.includes?.(x));
    if (blind) return {result: 'skip', why: `step ${k}: a ${blind} change cannot be read from outside on this world`, steps};
    const before = await t.fields(id);
    const args = Object.fromEntries(Object.entries(step.act.args ?? {}).map(([a, v]) => [a, ids[v] ?? v]));
    const got = await t.act(id, step.act.form, args, {case: {act: step.act, state: step.actor ? {...c.state, actor: step.actor} : c.state}, ids});
    const sets = setsOf(step.expect, ids, c, kinds);
    const after = got.verdict === 'no' ? await settled(t, id) : await readUntil(t, id, sets[id] ?? {});
    const {off, via} = judge(step.expect ?? {}, got, before, after);
    for (const [nid, want] of Object.entries(sets)) { const now = nid === id ? after : await readUntil(t, nid, want); if (!sameFields(now, want)) off.push(`after the step, ${nid} reads ${JSON.stringify(now)}, not ${JSON.stringify(want)}`); }
    if (unread.length && got.verdict === 'yes') {
      const want = (step.expect.changes ?? []).filter(x => x.change !== 'set').map(changeLine).sort(), have = (got.changes ?? []).map(changeLine).sort();
      if (!same(want, have)) off.push(`its changes were ${JSON.stringify(have)}, not ${JSON.stringify(want)}`);
    }
    if (t.events && step.expect?.events && !same((got.events ?? []).map(e => e.event), step.expect.events.map(e => e.event))) off.push(`events ${JSON.stringify(got.events)} differ`);
    steps.push({step: k, form: step.act.form, got: brief(got), ...(via ? {via} : {})});
    const changed = got.verdict === 'yes' && (form?.effects ?? []).find(e => ['link', 'unlink', 'reparent', 'create', 'remove'].includes(e.change));
    if (changed) moved ??= `${changed.change === 'link' || changed.change === 'unlink' ? `${changed.change}ed` : changed.change === 'reparent' ? 'moved' : `${changed.change}d`} something`;
    if (off.length) return {result: 'fail', why: `step ${k}: ${off.join('; ')}`, steps};
  }
  for (const [nid, want] of Object.entries(c.after ?? {})) {
    if (!ids[nid] || !want?.fields) continue;
    const entry = kinds.get(c.state.nodes[nid]?.kind), fields = seen(entry, Object.fromEntries(Object.entries(want.fields).map(([k, v]) => [k, asWorld(entry, k, v)])));
    const now = await readUntil(t, ids[nid], fields);
    if (!sameFields(now, fields)) return {result: 'fail', why: `after: ${nid} reads ${JSON.stringify(now)}, not ${JSON.stringify(fields)}`, steps};
  }
  return {result: 'pass', steps};
}
// ---------------------------------------------------------------- the disturbances (part 2, SA-P3b #2933)
//
// Per form a Soul starts by an act, from that form's case where every need is met: the Soul leaves as each step begins
// and in the middle of each step; a creator removes the thing in the middle of the first step; the world restarts in the
// middle of the first step. After each, read from outside: the form has ended, with a named reason when it did not
// complete; the Soul is not busy and holds what it held before; the thing (unless removed) reads as before and its form
// completes again as it stands, never set up again (so a thing left stuck fails); after a removal a fresh thing's form
// completes. A disturbance that lands after the form completed did not test anything: it is skipped, never passed.

/** The disturbances of one family, after its cases: per kind, per form started by an act. Pure: no world. */
export function disturbancesFor(kinds, rows) {
  const out = [];
  for (const [kind, entry] of kinds) for (const [form, f] of Object.entries(entry.forms ?? {})) {
    if (f.starts !== 'act') continue;
    const met = rows.find(r => r.type === 'rule' && r.kind === kind && r.form === form && r.case.expect.verdict === 'yes');
    const n = Math.max(1, (f.steps ?? []).length), first = (f.steps ?? []).length ? {step: 0, at: 'mid'} : {step: 0, at: 'start'};
    const stages = [];
    for (let k = 0; k < n; k++) stages.push({step: k, at: 'start'}, ...((f.steps ?? []).length ? [{step: k, at: 'mid'}] : []));
    const all = [...stages.map(s => ({how: 'leave', stage: s})), {how: 'remove', stage: first}, {how: 'restart', stage: first}];
    for (const d of all) out.push({type: 'disturb', name: `${form}: ${disturbName(d)}`, kind, form, ...d, steps: (f.steps ?? []).length, case: met?.case ?? null, file: met?.file});
  }
  return out;
}
const stageName = s => `${s.at === 'start' ? 'as step' : 'in the middle of step'} ${s.step + 1}${s.at === 'start' ? ' begins' : ''}`;
function disturbName({how, stage}) {
  return {leave: 'the Soul leaves', remove: 'a creator removes the thing', restart: 'the world restarts'}[how] + ' ' + stageName(stage);
}

/** Read the receipt until the act is at the stage. `{at}` the progress there, `{ended}` if the form ended first, `{gap}`
 *  when this world's receipt cannot show the stage. */
async function reach(t, rid, first, stage, steps) {
  if (stage.step > 0 && steps > 1 && first.step == null) return {gap: 'this world\'s receipt does not say which step is under way'};
  const atStage = p => (p.step ?? 0) === stage.step && (stage.at === 'start' ? !p.moving : p.moving);
  const passed = p => (p.step ?? 0) > stage.step || (stage.at === 'start' && p.moving);
  let p = first;
  for (const end = Date.now() + 20000; Date.now() < end; p = await t.progress(rid)) {
    if (!['accepted', 'started'].includes(p.phase)) return {ended: p};
    if (atStage(p)) return {at: p};
    if (passed(p)) return {passed: p};
    if (!t.stepped) await sleep(150);
  }
  return {passed: p};
}

async function disturbCase(t, row, kinds, placed) {
  const c = row.case, entry = kinds.get(row.kind);
  if (!c) return {result: 'skip', why: `${row.form} has no case where every need is met to start from`};
  if (!t.begin || !t.progress || !t.wait || !t.leave || !t.body) return {result: 'skip', why: `the ${t.name} transport cannot follow an act under way`};
  if (row.how === 'restart' && !t.restart) return {result: 'skip', why: t.noRestart ?? 'this world cannot be restarted from here'};
  const scene = async () => {
    const id = await placed(row.kind, {far: true}), want = startFields(entry, c.state.nodes[c.act.this]);
    await t.set(id, want);
    const got = await readUntil(t, id, seen(entry, want));
    if (!sameFields(got, seen(entry, want))) throw new Error(`the scene could not be set: the fields read ${JSON.stringify(got)}, not ${JSON.stringify(seen(entry, want))}`);
    return {id, fields: got};
  };
  const {id, fields: before} = await scene();
  if (!(await t.offers(id)).includes(row.form)) return {result: 'skip', why: `${row.form} is not offered by this world`};
  const gap = setupGap(c, kinds, t) ?? sceneGap(c, entry, row.form, t); if (gap) return {result: 'skip', why: gap};
  // the case's other things (an argument), placed and set as the rule cases place them
  const ids = {[c.act.this]: id};
  for (const [nid, n] of Object.entries(c.state.nodes)) if (n.kind && nid !== c.act.this) { ids[nid] = await placed(n.kind); await t.set(ids[nid], startFields(kinds.get(n.kind), n)); }
  // a world that keeps the case's scene in its tree sets it now, so what the Soul holds before is the case's
  await t.arrange?.({case: c, ids});
  const body0 = await t.body();
  const b = await t.begin(id, row.form, c.act.args, {case: c, ids});
  if (b.verdict !== 'started') return {result: 'fail', why: `the act was not accepted (${b.code ?? b.reason ?? b.verdict}), though every need is met`};
  const r = await reach(t, b.rid, b.progress, row.stage, row.steps);
  if (r.gap) { await t.leave(b.rid).catch(() => {}); await t.wait(b.rid).catch(() => {}); return {result: 'skip', why: r.gap}; }
  if (r.ended) return {result: 'skip', why: `the form ended (${r.ended.phase}) before ${stageName(row.stage)}: the disturbance did not land`};
  const sent = r.at ?? r.passed;
  if (row.how === 'leave') await t.leave(b.rid);
  else if (row.how === 'remove') await t.remove(id);
  else await t.restart();
  const landed = ['accepted', 'started'].includes((await t.progress(b.rid)).phase);   // still under way once it was done
  const end = await t.wait(b.rid);
  const off = [], ended = {phase: end.receipt ?? end.verdict, ...(end.code ? {code: end.code} : {}), ...(end.text ? {reason: end.text} : {})};
  const sentAt = {step: (sent.step ?? 0) + 1, moving: sent.moving, ...(r.passed ? {late: true} : {})};
  if (end.verdict === 'yes' && !landed) return {result: 'skip', why: `the form completed before the disturbance landed: it did not test a stop`, ended, sent_at: sentAt};
  if (end.verdict === 'yes') off.push(`the receipt says completed, though the disturbance (${disturbName(row)}) landed while the form was under way: it ended with no named reason`);
  else if (end.verdict !== 'no') off.push(`the form had not ended after the disturbance (receipt ${end.receipt ?? 'none'})`);
  else if (!end.code) off.push('the form ended with no named reason');
  const body1 = await t.body();
  if (body1.posture === 'busy') off.push(`the Soul is still busy (${body1.activity})`);
  // a thing removed from the Soul's hand is gone from it: it holds the rest as before
  const held0 = row.how === 'remove' ? (body0.holding ?? []).filter(h => h !== id) : body0.holding;
  if (!same(body1.holding, held0)) off.push(`the Soul holds ${JSON.stringify(body1.holding)}, not ${JSON.stringify(held0)} as before`);
  let again;
  if (row.how === 'remove') {
    const fresh = await scene(), ids2 = {...ids, [c.act.this]: fresh.id};
    // a world that keeps a tree took the case's other things in it away with it: those are placed again
    if (t.tree) for (const [nid, n] of Object.entries(c.state.nodes)) if (n.kind && nid !== c.act.this && !(await t.fields(ids[nid]))) { ids2[nid] = await placed(n.kind); await t.set(ids2[nid], startFields(kinds.get(n.kind), n)); }
    again = await t.act(fresh.id, row.form, c.act.args, {case: c, ids: ids2});
    if (again.verdict !== 'yes') off.push(`afterwards the Soul could not do ${row.form} on a fresh thing (${again.code ?? again.reason ?? again.verdict})`);
  } else {
    const after = await settled(t, id);
    if (!sameFields(after, before)) off.push(`stopped, yet the thing's fields changed: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    if (!(await t.offers(id)).includes(row.form)) off.push(`afterwards the thing no longer offers ${row.form}`);
    else {
      again = await t.act(id, row.form, c.act.args, {case: c, ids});
      if (again.verdict !== 'yes') off.push(`afterwards ${row.form} could not be done again on the thing as it stands (${again.code ?? again.reason ?? again.verdict}): it is left unusable`);
    }
  }
  return {result: off.length ? 'fail' : 'pass', ...(off.length ? {why: off.join('; ')} : {}), sent_at: sentAt, ended, ...(again ? {again: brief(again)} : {})};
}

/** A change other than a set as one line to compare, by the case's names: what it did, to what, and where to (a made
 *  thing by its kind). A world whose `reads` names a change kind answers an act with its changes in these terms. */
export function changeLine(x) {
  const to = x.to ? `${x.to.node}${x.to.hand ? `/hand:${x.to.hand}` : x.to.slot ? `/slot:${x.to.slot}` : ''}` : '';
  if (x.change === 'create') return `create ${x.kind} into ${to}`;
  if (x.change === 'reparent') return `reparent ${x.node} into ${to}`;
  if (x.change === 'link' || x.change === 'unlink') return `${x.change} ${x.node} ${x.link} ${x.end}`;
  return `${x.change} ${x.node ?? ''}`.trim();
}
const timerAfter = (c, step) => c.do.flatMap(s => s.expect?.timers ?? []).find(x => x.form === step.act.form)?.after_us;
/** The `set` changes a step expects, as fields per world id, in the world's terms (a bool's 0/1 as false/true). */
export function setsOf(expect, ids, c, kinds) {
  const out = {};
  for (const x of expect?.changes ?? []) if (x.change === 'set' && ids[x.node] && kinds?.get(c?.state?.nodes?.[x.node]?.kind)?.state?.[x.field]?.type !== 'text') (out[ids[x.node]] ??= {})[x.field] = asWorld(kinds?.get(c?.state?.nodes?.[x.node]?.kind), x.field, x.to);
  return out;
}
const brief = g => ({verdict: g.verdict, ...(g.reason ? {reason: g.reason} : {}), ...(g.code ? {code: g.code} : {}), ...(g.detail ? {detail: g.detail} : {}), ...(g.receipt ? {receipt: g.receipt} : {})});

/** Run every case once. Things are placed fresh for each case and removed after it. */
export async function runOnce(t, kinds, rows) {
  const out = [];
  for (const row of rows) {
    const mine = [];
    const placed = async (kind, how) => { const id = await t.place(kind, kinds.get(kind), how); mine.push(id); return id; };
    const t0 = Date.now();
    let r;
    const unloaded = kindsOfRow(row).map(k => t.unloaded?.get(k) && `${k}: ${t.unloaded.get(k)}`).find(Boolean);
    if (unloaded) r = {result: 'skip', why: unloaded};
    else try { r = await {rule: ruleCase, effect: effectCase, disturb: disturbCase}[row.type](t, row, kinds, placed); }
    catch (e) { r = {result: 'fail', why: `the run broke: ${String(e.message ?? e).split(ROOT).join('')}`}; }
    // the Soul puts down what a case left in its hands (a take), so the things can be removed and the next case starts
    // with free hands
    await t.reset?.().catch(() => {});
    for (const id of mine) await t.remove(id).catch(() => {});
    out.push({case: row.name, type: row.type, kind: row.kind, form: row.form, file: row.file, ...r, ms: Date.now() - t0});
  }
  return out;
}

/** The table per form: cases, passed, failed, skipped. */
function table(rows) {
  const t = {};
  for (const r of rows) { const k = `${r.kind} ${r.type === 'effect' ? '(outcomes)' : r.type === 'disturb' ? `${r.form} (disturbed)` : r.form}`; const x = (t[k] ??= {cases: 0, passed: 0, failed: 0, skipped: 0}); x.cases++; x[{pass: 'passed', fail: 'failed', skip: 'skipped'}[r.result]]++; }
  return t;
}

export async function run(target, {world, repeats = 2, transport, cases, ...flags} = {}) {
  const t0 = Date.now();
  const loaded = await entriesOf(target);
  if (!loaded) return {error: `no such family, folder or file: ${target}`};
  const kinds = new Map(loaded.filter(k => k.entry.forms && Object.keys(k.entry.forms).length).map(k => [k.kind, k.entry]));
  const played = casesFor([...kinds].map(([kind, entry]) => ({kind, entry})), {cases: cases && resolve(cases)});
  const rows = [...played, ...disturbancesFor(kinds, played)];
  const family = [...kinds.keys()];
  const make = transport ? (await import(pathToFileURL(resolve(transport)).href)).default : todayTransport;
  const t = await make({world, ...flags});
  // A world that defines kinds as it starts also places the kinds a case names from outside the family (a flower to
  // hand in, a linen to hang): placed and set, never played.
  const others = t.defines ? kindsNamedOutside(played, kinds) : [];
  for (const o of others) kinds.set(o.kind, o.entry);
  t.outside = new Set(others.map(o => o.kind));
  await t.start?.([...loaded, ...others]);
  const runs = [];
  for (let i = 0; i < repeats; i++) { const s = Date.now(); const r = await runOnce(t, kinds, rows); runs.push({repeat: i + 1, wall_ms: Date.now() - s, cases: r}); }
  await t.stop?.();
  const failed = [...new Set(runs.flatMap(r => r.cases.filter(c => c.result === 'fail').map(c => c.case)))];
  const skipped = Object.entries(Object.groupBy(runs[0]?.cases.filter(c => c.result === 'skip') ?? [], c => c.why)).map(([why, cs]) => ({why, cases: cs.map(c => c.case)}));
  return {
    target, world, transport: t.name, repeats, kinds: family, ok: !failed.length, failed,
    passed_every_repeat: runs.every(r => r.cases.every(c => c.result !== 'fail')),
    table: table(runs[0]?.cases ?? []), skipped, runs, wall_ms: Date.now() - t0,
  };
}

/** The kinds the cases name that are not in the family, as content defines them: `{kind, entry}`. */
function kindsNamedOutside(played, kinds) {
  const named = new Set(played.flatMap(r => Object.values(r.case?.state?.nodes ?? {}).map(n => n.kind)).filter(k => k && !kinds.has(k)));
  const all = named.size ? (allKinds ??= loadKinds()) : {};
  // a body's family (the humanoid) is the Soul's own body, never a thing to place
  return [...named].filter(k => all[k] && all[k].owner !== 'family').map(k => ({kind: k, entry: all[k]}));
}

// ---------------------------------------------------------------- today's world, through its adapters

/** Today's local world: the creator's god CLI sets the scene, the Soul CLI plays the case. */
export function todayTransport({world, god = process.cwd(), soul, launcher: launcherAt} = {}) {
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
    name: 'today', timers: false, events: false, reads: [], unloaded: new Map(),
    async start(loaded) {
      const status = cli(GOD, ['status'], {cwd: resolve(god)});
      if (!status.out.includes(world.replace(/\/$/, ''))) throw new Error(`the god folder ${relative(process.cwd(), resolve(god)) || '.'} holds no seat for ${world}`);
      const dir = mkdtempSync(join(tmpdir(), 'entry-run-'));
      try {
        // kind by kind: a kind the world refuses (or one with no shape to place) skips its own cases, not the family's
        for (const r of loaded) {
          if (!r.entry.forms) continue;
          if (!r.plan) { t.unloaded.set(r.kind, unloadedWhy(r.errors)); continue; }
          const file = join(dir, `${r.plan.name}.json`);
          writeFileSync(file, JSON.stringify(r.plan));
          try { godCli(['define', file]); defs.set(r.kind, r.def); }
          catch (e) { t.unloaded.set(r.kind, `the world refused its def: ${String(e.message ?? e).replace(/^god define: /, '').split('\n')[0]}`); }
        }
      } finally { rmSync(dir, {recursive: true, force: true}); }
    },
    async place(kind, entry, {far = false} = {}) {
      const def = defs.get(kind); if (!def) throw new Error(`${kind} could not be loaded into this world`);
      const me = soulCli(['here']).me?.pos ?? [0, 0];
      // beside the Soul, out of reach of any point on it: the Soul walks there as the form asks; a big thing (a building)
      // goes further by its own size (placeDistance), so it does not cover the Soul
      // `far`: a disturbance lands while the Soul walks, so it walks longer (a creator's call takes about a second)
      const k = placeDistance(entry) / 3 * (far ? 3 : 1);
      for (const [dx, dz] of [[3, 0], [0, 3], [-3, 0], [0, -3], [4, 4]].map(([x, z]) => [x * k, z * k])) {
        const r = cli(GOD, ['place', def, '--at', `${(me[0] + dx).toFixed(2)},${(me[1] + dz).toFixed(2)}`, '--name', `run-${kind.split(':')[1]}-${++n}`, '--json'], {cwd: resolve(god)});
        let j = null; try { j = JSON.parse(r.out); } catch { /* refused in words */ }
        if (j?.accepted && j.ids) return Object.values(j.ids)[0];
      }
      throw new Error(`no room to place ${kind} beside the Soul`);
    },
    async set(id, fields) { godCli(['set', id, '--state', JSON.stringify(fields)]); },
    // a held thing is put down first: today's world does not remove a thing from a hand, so the hand would stay full
    async reset() { for (let i = 0; i < 2 && soulCli(['here']).me?.holding; i++) soulCli(['act', 'put-down:here', '--wait', '--json']); },
    async remove(id) { godCli(['remove', id]); },
    async offers(id) { return (thing(id).acts ?? []).map(a => a.split(':').at(-1)); },
    async fields(id) { return thing(id).state ?? null; },
    // today's form actions take no params (forms-adapter.ts `actions`): the adapter chooses each argument thing itself,
    // the nearest of its kind, so the case's things are placed and its args are not sent
    async act(id, form) {
      const j = soulCli(['act', `object:${id}:${form}`, '--wait', '--json']);
      // the Soul CLI's --wait can end before a form's own long wait does: follow the receipt to its end
      return j.accepted && ['accepted', 'started'].includes(j.receipt?.phase) && j.receipt?.id ? t.wait(j.receipt.id, 180000) : answer(j);
    },
    // following an act under way (part 2): today's receipt shows motion, not which of the entry's steps is under way
    async begin(id, form) {
      const j = soulCli(['act', `object:${id}:${form}`, '--json']);
      return j.accepted && j.receipt?.id ? {verdict: 'started', rid: j.receipt.id, progress: progressOf(j.receipt)} : answer(j);
    },
    async progress(rid) { return progressOf(soulCli(['receipt', rid])); },
    async leave(rid) { soulCli(['stop', rid]); },
    async wait(rid, ms = 60000) {
      let rc;
      for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) { rc = soulCli(['receipt', rid]); if (!['accepted', 'started'].includes(rc.phase)) break; }
      return {...answer({accepted: true, receipt: rc}), ...(rc?.reason ? {text: rc.reason} : {})};
    },
    async body() { const me = soulCli(['here']).me ?? {}; return {posture: me.posture, activity: me.activity?.kind ?? null, holding: me.holding ?? []}; },
    async restart() {
      const before = await launcherChild();
      process.kill(before.pid, 'SIGKILL');
      for (const end = Date.now() + 120000; Date.now() < end; await sleep(1000)) {
        const k = await launcherChild().catch(() => null);
        if (k?.held) throw new Error(`the launcher holds ${slug} after too many restarts: resume it there`);
        if (k?.status === 'running' && k.pid && k.pid !== before.pid) { try { soulCli(['here']); return; } catch { /* still waking */ } }
      }
      throw new Error(`${slug} did not come back within 2 minutes of its restart`);
    },
  };
  // A world under a launcher (…/w/<slug>) is restarted the way a crash restarts it: its process ends and the launcher
  // starts it again from its store. The launcher's own diagnostics name the process; they answer local requests only.
  const url = new URL(world), slug = /\/w\/([^/]+)/.exec(url.pathname)?.[1], launcher = launcherAt ?? url.origin;
  const launcherChild = async () => {
    const j = await (await fetch(`${launcher}/__sim/launcher`)).json();
    const k = j.children?.find(c => c.slug === slug);
    if (!k?.pid) throw new Error(`the launcher runs no ${slug}`);
    return k;
  };
  const start = t.start;
  t.start = async loaded => {
    await start(loaded);
    if (!slug) { t.restart = null; t.noRestart = 'this world is not under a launcher (…/w/<slug>), so it cannot be restarted from here'; return; }
    try { await launcherChild(); } catch (e) { t.restart = null; t.noRestart = `this world cannot be restarted from here: ${e.message}`; }
  };
  return t;
}
/** How far from the Soul a thing is placed (m): 3 m, or its own half-diagonal and 1.5 m when that is more. */
export const placeDistance = entry => { const b = entry?.geometry?.bounds_mm ?? [0, 0, 0]; return Math.max(3, Math.hypot(b[0], b[2]) / 2000 + 1.5); };
/** Why a kind with forms was not loaded: no shape to place, or the load step's own error. */
export const unloadedWhy = errors => /looks\.shape/.test(errors?.[0] ?? '') ? 'no thing to place: the kind has no looks.shape' : `not loaded: ${errors?.[0] ?? 'no def'}`;
/** An act's answer in the rules' terms, from the Soul CLI's act or receipt. */
function answer(j) {
  const rc = j.receipt;
  if (!j.accepted) return {verdict: 'no', code: j.code, reason: reasonOf(j.code)};
  if (rc?.phase === 'completed') return {verdict: 'yes', receipt: rc.phase};
  if (['failed', 'cancelled', 'refused'].includes(rc?.phase)) return {verdict: 'no', code: rc.code, reason: reasonOf(rc.code), receipt: rc.phase};
  return {verdict: 'open', receipt: rc?.phase ?? 'none'};
}
const progressOf = rc => ({phase: rc?.phase ?? 'none', step: null, moving: rc?.firstMotionTick != null});
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
  const usage = 'usage: node tools/entry/run.mjs <family|folder|file> (--world <address> | --transport <module>) [--repeats 2] [--transport <module>] [--cases <dir>] [--god <dir>] [--soul <name>] [--launcher <origin>]';
  if (!target || (!flag('world') && !flag('transport'))) { console.log(JSON.stringify({error: usage})); return 2; }
  const repeats = Number(flag('repeats') ?? 2);
  if (!Number.isInteger(repeats) || repeats < 1) { console.log(JSON.stringify({error: '--repeats takes a whole number of at least 1'})); return 2; }
  let v;
  try { v = await run(target, {world: flag('world'), repeats, transport: flag('transport'), cases: flag('cases'), god: flag('god'), soul: flag('soul'), launcher: flag('launcher')}); }
  catch (e) { console.log(JSON.stringify({error: String(e.message ?? e).split(ROOT).join('')})); return 2; }
  console.log(JSON.stringify(v, null, 1));
  return v.error ? 2 : v.ok ? 0 : 1;
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
