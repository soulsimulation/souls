#!/usr/bin/env node
// The Eden asks (Soul Actions SA-P9, #2889): plain requests a new owner would type in Eden, each a small file holding
// its words and the chain of forms that would satisfy it, run through the rules alone, with no engine and no model.
//
//   node tools/entry/asks.mjs [--json] [--list] [<dir>]        (default: content/asks/eden)
//
// Prints how many requests are expressible, by group, and what is missing for the rest. A request is expressible when
// every step of its chain is done by the rules on Eden's content (content/kinds, content/moves): its kinds have entries,
// its forms exist, and each form's needs are met and its effects applied in turn (@souls/form-rules `effects`, `apply`),
// with the format's own rules for carrying, pushing, placing, the six base forms and areas. The walk to a thing is
// taken as done (every thing can be gone to), so reach is never what refuses a step. A request with no chain names its
// reason from a closed list and is counted, never dropped. The words are checked against the frozen list
// (`requests.md` beside the files) on every run, so a request cannot drift. The share is a measure, not a gate: the
// command fails only on a malformed or drifted file. It also reads Engine v2's frozen list of requests (E25, #2794)
// when that file exists. The format and how to add a request: content/asks/eden/README.md.
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {allowsBase, moveBy, place} from './format.mjs';
import {loadKinds} from '../../packages/form-rules/src/load.ts';
import {apply, effects} from '../../packages/form-rules/src/effects.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const ASKS_DIR = join(ROOT, 'content/asks/eden');
export const E25_LIST = join(ROOT, 'v2/tools/battery/requests.json');
export const FORMAT = 'souls-ask/1';
export const BODY = 'eden:humanoid';
export const GROUPS = Object.freeze(['object', 'two-things', 'getting-around', 'with-others', 'over-time', 'open-ended', 'looking']);
/** Why a request has no chain. One closed list: a new reason is added here, with the requests it names. */
export const NONE = Object.freeze({
  home: 'a home: nothing says which house is the Soul\'s',
  animal: 'an animal: a thing that acts by itself and is not written as an entry',
  game: 'a ball or chasing game: play that is not a chain of forms',
  refused: 'refused by decision: the world should not do it',
});
const POSTURE_FORMS = Object.freeze({sit_down: 'sit', lie_down: 'lie', kneel: 'kneel'});
const BASE_ARG = Object.freeze({go_to: 'place', look_at: 'target', point: 'toward', touch: 'target', lean_on: 'support', wait_by: 'place'});
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The frozen list: number -> {group, words}. A line is `<n>. [<group>] <words> | things: ...`. */
export function frozen(dir) {
  const out = new Map();
  for (const line of readFileSync(join(dir, 'requests.md'), 'utf8').split('\n')) {
    const m = /^(\d+)\. \[([a-z-]+)\] (.+?) \| things: /.exec(line);
    if (m) out.set(Number(m[1]), {group: m[2], words: m[3]});
  }
  return out;
}

function wholeNumbers(v, path, bad) {
  if (typeof v === 'number') { if (!Number.isSafeInteger(v)) bad(path, 'a whole number'); return; }
  if (Array.isArray(v)) v.forEach((x, i) => wholeNumbers(x, `${path}.${i}`, bad));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) wholeNumbers(x, `${path}.${k}`, bad);
}

function steps(chain, path, things, bad) {
  if (!Array.isArray(chain)) { bad(path, 'a list of steps'); return; }
  chain.forEach((s, i) => {
    const p = `${path}.${i}`;
    if (!isObj(s)) bad(p, 'a step is an object');
    else if ('any' in s) { if (!Array.isArray(s.any) || s.any.length < 2) bad(`${p}.any`, 'two or more chains'); else s.any.forEach((c, j) => steps(c, `${p}.any.${j}`, things, bad)); }
    else if ('say' in s) { if (typeof s.say !== 'string') bad(`${p}.say`, 'what is said, in a few words'); }
    else if ('read' in s) { if (!(s.read in things)) bad(`${p}.read`, 'a thing of this request'); }
    else if (typeof s.form === 'string') { if (s.this !== undefined && !(s.this in things) && s.this !== 'me') bad(`${p}.this`, '"me" or a thing of this request'); }
    else bad(p, 'a form ({"form"}), a line said ({"say"}), a read of the copy ({"read"}) or a choice ({"any"})');
  });
}

/** Problems with one ask file, against the frozen list. */
export function validate(ask, list) {
  const out = [];
  const bad = (path, want) => out.push({path, want});
  if (!isObj(ask)) { bad('', 'an object'); return out; }
  if (ask.format !== FORMAT) bad('format', FORMAT);
  const was = list.get(ask.n);
  if (!was) bad('n', 'the number of a request in the frozen list');
  else {
    if (ask.words !== was.words) bad('words', `the frozen words: "${was.words}"`);
    if (ask.group !== was.group) bad('group', `the frozen group: ${was.group}`);
  }
  if (!GROUPS.includes(ask.group)) bad('group', `one of ${GROUPS.join(', ')}`);
  if (ask.when !== undefined && typeof ask.when !== 'string') bad('when', 'when the owner wants it, in their words: the client schedules it');
  wholeNumbers(ask, '', bad);
  const things = isObj(ask.things) ? ask.things : {};
  if (ask.things !== undefined && !isObj(ask.things)) bad('things', 'a map of name -> kind');
  if (ask.given !== undefined && !(isObj(ask.given) && Object.entries(ask.given).every(([k, v]) => k in things && isObj(v)))) bad('given', 'a map of thing -> {field: value}: the state the request\'s own words presume');
  for (const [k, v] of Object.entries(things)) if (k === 'me' || k === 'here' || typeof v !== 'string' || !/^[a-z0-9_]+:[a-z0-9_]+$/.test(v)) bad(`things.${k}`, 'a kind, "namespace:name"; "me" is the acting body and "here" the place');
  if (('chain' in ask) === ('none' in ask)) bad('chain', 'exactly one of "chain" and "none"');
  if ('chain' in ask) steps(ask.chain, 'chain', things, bad);
  if ('none' in ask && !(isObj(ask.none) && ask.none.why in NONE)) bad('none.why', `one of ${Object.keys(NONE).join(', ')}`);
  return out;
}

function movesData() {
  const dir = join(ROOT, 'content/moves'), out = {};
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) { const m = JSON.parse(readFileSync(join(dir, f), 'utf8')); out[m.move] = {reach_mm: m.reach_mm}; }
  return out;
}

/** Run one chain from a state. Returns {missing, refused, state}: what is not written, and the first step refused. */
function runChain(chain, ctx, state) {
  const {kinds, things} = ctx;
  const missing = [], kindOf = id => id === 'me' ? BODY : things[id];
  let refused = null, receipt = 0;
  const refuse = (i, why) => { if (!refused) refused = {step: i, why}; };
  for (let i = 0; i < chain.length; i++) {
    const s = chain[i];
    if ('say' in s) continue;
    if ('any' in s) {
      const tries = s.any.map(c => runChain(c, ctx, state));
      const ok = tries.find(t => !t.missing.length && !t.refused);
      if (ok) { state = ok.state; continue; }
      missing.push(...tries[0].missing);
      if (tries[0].refused) refuse(i, tries[0].refused.why);
      continue;
    }
    if ('read' in s) {
      const e = kinds[kindOf(s.read)];
      if (!e) missing.push(`entry ${kindOf(s.read)}`);
      else if (s.field === 'stock' ? !e.stock : s.field !== undefined && !e.state?.[s.field]) missing.push(`${s.field === 'stock' ? 'stock' : 'field ' + s.field} of ${e.kind}`);
      continue;
    }
    const self = s.this ?? 'me', kind = kindOf(self), entry = kinds[kind];
    let args = s.args ?? {};
    const named = [...Object.values(args).map(v => isObj(v) ? v.node : v), s.carry, s.push, s.place?.thing, s.place?.anchor]
      .filter(v => typeof v === 'string' && v in things).map(kindOf);
    const absent = [kind, ...named].filter(k => !kinds[k]);
    for (const k of new Set(absent)) missing.push(`entry ${k}`);
    const form = entry?.forms?.[s.form];
    if (entry && !form) missing.push(`form ${s.form} of ${kind}`);
    if (absent.length || refused) continue;
    // The format's own rules, before the form's needs: how a thing moves, where it is put, what an area forbids. They are
    // asked even when the form is not written yet, so a request the rules would refuse anyway says so.
    const target = BASE_ARG[s.form] && args[BASE_ARG[s.form]] in things ? kinds[kindOf(args[BASE_ARG[s.form]])] : null;
    if (target && self === 'me') { const r = allowsBase(target, s.form); if (!r.ok) { refuse(i, `${r.code}: ${r.reason}`); continue; } }
    const spot = POSTURE_FORMS[s.form] && args.spot in things ? kinds[kindOf(args.spot)] : null;
    const forbids = spot && Object.entries(spot.areas ?? {}).find(([, a]) => a.forbids?.includes(POSTURE_FORMS[s.form]));
    if (forbids) { refuse(i, `forbidden: ${spot.kind} forbids "${POSTURE_FORMS[s.form]}" (area ${forbids[0]})`); continue; }
    if (s.carry || s.push) {
      const r = moveBy(kinds[kindOf(s.carry ?? s.push)], {act: s.carry ? 'carry' : 'push', souls: s.souls ?? 1});
      if (!r.ok) { refuse(i, `${r.code}: ${r.reason}`); continue; }
    }
    if (isObj(s.place)) {
      // place() knows a thing put by itself by its entry; two things of one kind are two copies, so the anchor is a copy.
      const anchor = s.place.anchor ? kinds[kindOf(s.place.anchor)] : undefined;
      const r = place(kinds[kindOf(s.place.thing)], {at: s.place.at, facing: s.place.facing}, {anchor: anchor && s.place.anchor !== s.place.thing ? {...anchor} : anchor});
      if (!r.ok) { refuse(i, `${r.code}: ${r.reason}`); continue; }
    }
    if (!form) continue;
    // An argument the form does not take is refused, never dropped: "play a sad tune" on a form with no mood is no yes.
    const untaken = Object.keys(args).filter(a => !Object.hasOwn(form.takes ?? {}, a));
    if (untaken.length) { refuse(i, `not_taken: ${kind} ${s.form} takes no argument ${untaken.map(a => `"${a}"`).join(', ')}`); continue; }
    // A slot argument the chain leaves out is chosen as the engine would choose it, by the form's selector: a free slot of
    // this thing (the request stands everyone in one place, so the first free one in the kind's own order is the nearest).
    // It is chosen before the hand is placed, so a reach for that slot starts there.
    for (const [name, t] of Object.entries(form.takes ?? {})) {
      if (name in args || t.type !== 'slot' || t.select?.of !== 'free_slots' || t.select?.in !== 'this') continue;
      const free = Object.entries(entry.slots ?? {}).find(([slot, d]) => (state.nodes[self]?.slots?.[slot]?.length ?? 0) < d.most);
      if (free) args = {...args, [name]: free[0]};
    }
    // The walk to the thing is taken as done: the hand starts at the point the form reaches for.
    const nodes = structuredClone(state.nodes);
    for (const n of form.needs ?? []) {
      if (n.need !== 'within_reach') continue;
      const name = isObj(n.point) ? args[n.point.arg] : n.point;
      const at = entry.points?.[name]?.at_mm ?? entry.slots?.[name]?.at_mm;
      if (at) nodes.me.effector_mm = at;
    }
    const step = {...state, nodes, actor: 'me'};
    const result = effects({kinds, act: {this: self, form: s.form, args}, state: step, receipt: `ask-${++receipt}-${i}`});
    if (result.verdict !== 'yes') { refuse(i, `${result.reason ?? 'unknown'}${result.detail?.what ? ': ' + result.detail.what : ''}`); continue; }
    const next = apply(step, result);
    if (!next.ok) { refuse(i, next.reason); continue; }
    state = next.state;
  }
  return {missing: [...new Set(missing)], refused, state};
}

/** Whether a given value is one its field can hold: a flag, a whole number in its bounds, one of an enum's values. */
function holds(def, v) {
  if (def.type === 'bool') return typeof v === 'boolean' || v === 0 || v === 1;
  if (def.type === 'int') return Number.isSafeInteger(v) && (def.min === undefined || v >= def.min) && (def.max === undefined || v <= def.max);
  if (def.type === 'enum') return def.values?.includes(v) ?? false;
  return v !== undefined;
}

/** Whether one ask is expressible, and if not, why. */
export function judge(ask, kinds, moves) {
  if (ask.none) return {n: ask.n, group: ask.group, ok: false, none: ask.none.why};
  const things = ask.things ?? {};
  // Everyone and everything of the request stands loose in one place, in the state a copy starts in; `given` is the state
  // the request's own words presume ("turn the lamp off": the lamp is on), set before the chain runs. A given field the
  // kind does not have is missing; a value its field cannot hold is refused before the first step.
  const nodes = {here: {loose: ['me', ...Object.keys(things)]}, me: {kind: BODY, hands: {left: null, right: null}}};
  const missing = [];
  let refused = null;
  for (const [id, kind] of Object.entries(things)) {
    nodes[id] = {kind};
    for (const [field, value] of Object.entries(ask.given?.[id] ?? {})) {
      const def = kinds[kind]?.state?.[field];
      if (!kinds[kind]) continue;
      if (!def) { missing.push(`field ${field} of ${kind}`); continue; }
      if (!holds(def, value)) refused ??= {step: 'given', why: `given_value: ${id}.${field} cannot be ${JSON.stringify(value)}`};
      (nodes[id].fields ??= {})[field] = value;
    }
  }
  if (missing.length || refused) return {n: ask.n, group: ask.group, ok: false, missing, refused};
  const r = runChain(ask.chain, {kinds, things}, {actor: 'me', nodes, moves});
  return {n: ask.n, group: ask.group, ok: !r.missing.length && !r.refused, missing: r.missing, refused: r.refused};
}

const pct = (a, b) => b ? `${Math.floor((a * 100) / b)} %` : '-';

/** Every ask in `dir`, judged, with the summary by group, by missing piece and by reason. */
export function run(dir = ASKS_DIR) {
  const list = frozen(dir), kinds = loadKinds([join(ROOT, 'content/kinds')]), moves = movesData();
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  const problems = [], results = [], seen = new Set();
  for (const f of files) {
    let ask;
    try { ask = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch (e) { problems.push({file: f, path: '', want: `JSON: ${e.message}`}); continue; }
    const v = validate(ask, list);
    if (seen.has(ask.n)) v.push({path: 'n', want: 'one file per request'});
    seen.add(ask.n);
    if (v.length) { problems.push(...v.map(p => ({file: f, ...p}))); continue; }
    results.push({file: f, ...judge(ask, kinds, moves)});
  }
  for (const n of list.keys()) if (!seen.has(n)) problems.push({file: null, path: `n=${n}`, want: 'a file for every request in the frozen list: a chain or a named reason'});
  const groups = GROUPS.map(g => {
    const rs = results.filter(r => r.group === g), ok = rs.filter(r => r.ok).length;
    return {group: g, asks: rs.length, expressible: ok, share: pct(ok, rs.length)};
  });
  const ok = results.filter(r => r.ok).length;
  const count = (rs, key) => { const m = new Map(); for (const r of rs) for (const k of key(r)) m.set(k, (m.get(k) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)); };
  const blocked = results.filter(r => !r.ok && !r.none);
  return {
    dir: relative(ROOT, dir), asks: list.size, judged: results.length, expressible: ok, share: pct(ok, list.size), groups,
    named: count(results.filter(r => r.none), r => [r.none]),
    missing: count(blocked, r => r.missing),
    refused: count(blocked.filter(r => r.refused), r => [r.refused.why]),
    onlyEntries: blocked.filter(r => !r.refused && r.missing.every(m => m.startsWith('entry '))).length,
    // Once every missing entry and form is written as its chain names it, and nothing in it is refused.
    once: ok + blocked.filter(r => !r.refused).length,
    e25: e25(),
    results, problems,
  };
}

/** Engine v2's frozen list (E25), when it exists: how many requests it has. Its requests have no chains here yet. */
function e25() {
  if (!existsSync(E25_LIST)) return {present: false, path: relative(ROOT, E25_LIST)};
  const doc = JSON.parse(readFileSync(E25_LIST, 'utf8'));
  const list = Array.isArray(doc) ? doc : doc.requests ?? [];
  return {present: true, path: relative(ROOT, E25_LIST), requests: list.length, chains: 0};
}

function print(r, {list}) {
  const out = [];
  out.push(`Eden asks (${r.dir}): ${r.expressible} of ${r.asks} expressible by the rules alone (${r.share})`, '');
  out.push('| group | asks | expressible | share |', '|---|---|---|---|');
  for (const g of r.groups) out.push(`| ${g.group} | ${g.asks} | ${g.expressible} | ${g.share} |`);
  out.push(`| all | ${r.asks} | ${r.expressible} | ${r.share} |`, '');
  out.push(`Named, with no chain: ${r.named.map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  out.push(`Blocked only by kinds with no entry yet: ${r.onlyEntries}`);
  out.push(`Expressible once every missing entry and form is written as the chains name them: ${r.once} of ${r.asks} (${pct(r.once, r.asks)})`);
  out.push('', 'Missing, by how many requests wait on it:');
  for (const [k, n] of r.missing.slice(0, list ? r.missing.length : 25)) out.push(`  ${String(n).padStart(3)}  ${k}`);
  if (!list && r.missing.length > 25) out.push(`  ... ${r.missing.length - 25} more (--list)`);
  if (r.refused.length) { out.push('', 'Refused by the rules:'); for (const [k, n] of r.refused) out.push(`  ${String(n).padStart(3)}  ${k}`); }
  out.push('', r.e25.present ? `Engine v2's list (${r.e25.path}): ${r.e25.requests} requests, ${r.e25.chains} with chains` : `Engine v2's list (${r.e25.path}): not there yet`);
  if (list) {
    out.push('', 'Each request:');
    for (const x of r.results) out.push(`  ${String(x.n).padStart(3)} ${x.ok ? 'yes' : 'no '} ${x.none ? `named: ${x.none}` : [...x.missing, ...(x.refused ? [`refused at step ${x.refused.step}: ${x.refused.why}`] : [])].join('; ')}`);
  }
  for (const p of r.problems) out.push(`PROBLEM ${p.file ?? ''} ${p.path}: want ${p.want}`);
  return out.join('\n');
}

export function main(argv) {
  const json = argv.includes('--json'), list = argv.includes('--list');
  const dir = argv.find(a => !a.startsWith('--')) ?? ASKS_DIR;
  if (!existsSync(join(dir, 'requests.md'))) { console.log(JSON.stringify({error: `no frozen list: ${join(dir, 'requests.md')}`})); return 2; }
  const r = run(dir);
  if (json) { const {results, ...rest} = r; console.log(JSON.stringify(list ? r : rest)); } else console.log(print(r, {list}));
  return r.problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
