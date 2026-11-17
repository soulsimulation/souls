#!/usr/bin/env node
// The check gate (Soul Actions SA-P2, #2862): one command says whether an entry is valid, cheap and names no engine.
//
//   node tools/entry/check.mjs [check] [<family> | <folder> | <file>...]    (no argument: every entry under content/kinds)
//
// A family is a folder of content/kinds. Prints one JSON line per file with its findings, then a summary line, and
// exits 1 if any entry has a finding. Each finding is {rule, form, field, path, reason, fix}: the rule broken, the
// form and field at fault, and the smallest change that passes. Everything the format (format.mjs) already refuses
// is reported under the rule it breaks; the rules the format cannot see are checked here. Nothing here reads a
// float or a clock, and nothing here names a part of today's engine. Rules, and which the format already makes
// impossible to break: docs/soul-actions/entry-format.md ("The check gate").
import {existsSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import * as F from './format.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const KINDS_DIR = join(ROOT, 'content/kinds');

export const RULES = Object.freeze({
  exact: 'needs are plain data and exact: no float, nothing in ticks',
  targets: 'the act names every thing: a named argument, a ranked fallback or a described target from the closed list',
  makes: 'nothing is made from nothing, and a made thing appears where its form names',
  'engine-names': 'no step, need or effect names an engine verb, file or field',
  'no-waiting': 'no form waits for a time or a condition',
  bounded: 'state is bounded and counted at its maximum',
  'way-out': 'every chain of needs has a way out that needs nothing',
  moves: 'every kind says how it moves and how long it lasts loose',
  card: 'every kind has a card: one line of purpose, at most 80 characters',
  'no-labels': 'no card carries a label such as "quiet" or "cosy"',
  shape: 'the entry is well formed (the format\'s own rules)',
  refs: 'every kind it refers to is loaded, and kinds do not refer to each other in a circle',
});

/** What "cheap" means, counted at the maximum. A kind over any of these is refused before it runs. */
export const BUDGET = Object.freeze({stateBytes: 9216, linkEdges: 1024, forms: 32, parts: 64, perForm: 16});
const BYTES = {bool: 1, enum: 1, int: 8, duration: 8, text: 8};
const LINK_EDGE_BYTES = 8;

const CARD_MOST = 80;
const ENGINE_WORDS = new Set(['engine', 'server', 'mars', 'wire', 'tick', 'ticks', 'eden', 'mjs', 'json', 'glb', 'ts', 'js', 'file', 'path', 'api', 'rpc', 'cmd', 'sim']);
const TIME_WORDS = new Set(['hour', 'hours', 'noon', 'midnight', 'daily', 'weekly', 'weekday', 'clock', 'dawn', 'dusk', 'morning', 'evening', 'sunrise', 'sunset', 'oclock', 'am', 'pm']);
const LABEL_WORDS = ['quiet', 'cosy', 'cozy', 'calm', 'peaceful', 'lively', 'busy', 'bustling', 'crowded', 'lonely', 'relaxing', 'romantic', 'comfy', 'charming', 'popular', 'boring', 'cheerful', 'gloomy'];
const LABEL = new RegExp(`\\b(${LABEL_WORDS.join('|')})\\b`, 'i');
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isArg = v => isObj(v) && typeof v.arg === 'string';
const tokens = s => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Where a finding sits: `forms.<form>.…` gives the form; the last name on the path is the field. */
function where(path) {
  const m = /^forms\.([^.]+)/.exec(path);
  const last = path.split('.').filter(p => !/^\d+$/.test(p)).at(-1) ?? '';
  return {form: m ? m[1] : null, field: last};
}

function classify({path, reason: r}) {
  if (/floating-point|ticks/.test(r) || /(^|[_.])ticks?($|[_.])/i.test(path)) return 'exact';
  if (/closed list/.test(r)) return 'engine-names';
  if (/pause of a stated length/.test(r)) return 'no-waiting';
  if (/\.into$/.test(path)) return 'makes';
  if (/is not in takes|\.takes\.|\.select\.|names a point or slot|names a slot of this kind, or an argument|must be of type/.test(path + ' ' + r)) return 'targets';
  if (/\.needs\./.test(path)) return 'exact';
  return 'shape';
}

function finding(e) {
  return {rule: classify(e), ...where(e.path), path: e.path, reason: e.reason, fix: e.reason.includes("; ") ? e.reason.split("; ")[1] : `make it ${e.reason}`};
}

/** Findings of rules the format cannot see, from a parsed and format-valid entry. */
function rules(entry) {
  const out = [];
  const add = (rule, path, reason, fix) => out.push({rule, ...where(path), path, reason, fix});
  const state = entry.state ?? {}, links = entry.links ?? {}, forms = entry.forms ?? {};

  // engine-names: a name borrowed from today's engine. The closed lists are the format's; this catches the open
  // names an entry chooses itself.
  const named = (path, s) => { const bad = tokens(s).find(t => ENGINE_WORDS.has(t)); if (bad) add('engine-names', path, `"${s}" uses "${bad}", a word of today's engine`, `rename it for what it means in the world, without "${bad}"`); };
  for (const sec of ['state', 'links', 'points', 'slots', 'forms']) for (const k of Object.keys(entry[sec] ?? {})) named(`${sec}.${k}`, k);
  for (const [fn, f] of Object.entries(forms)) {
    for (const [i, s] of (f.steps ?? []).entries()) if (typeof s.move === 'string') named(`forms.${fn}.steps.${i}.move`, s.move);
    for (const [i, e] of (f.effects ?? []).entries()) if (typeof e.event === 'string') named(`forms.${fn}.effects.${i}.event`, e.event);
    for (const k of Object.keys(f.takes ?? {})) named(`forms.${fn}.takes.${k}`, k);
  }

  for (const [fn, f] of Object.entries(forms)) {
    const p = `forms.${fn}`;
    // targets: an argument that picks a thing or a slot is described with the list its type needs, and is used.
    const used = new Set(JSON.stringify([f.needs, f.steps, f.effects]).match(/"arg":"[^"]+"/g)?.map(s => s.slice(7, -1)));
    for (const [an, a] of Object.entries(f.takes ?? {})) {
      const wantOf = a.type === 'slot' ? 'free_slots' : a.type === 'thing' ? 'things' : null;
      if (a.select && wantOf && a.select.of !== wantOf) add('targets', `${p}.takes.${an}.select.of`, `argument "${an}" is a ${a.type} but its selector picks ${a.select.of}`, `set select.of to "${wantOf}"`);
      if (!used.has(an)) add('targets', `${p}.takes.${an}`, `argument "${an}" is taken but nothing in the form uses it`, `use {"arg": "${an}"} in a need, step or effect, or remove it`);
    }
    // makes: a create is paid for in its own form (something is removed, or a field the form needed is spent).
    (f.effects ?? []).forEach((e, i) => {
      if (e.change !== 'create') return;
      const spent = f.effects.some(x => x.change === 'remove') || f.effects.some(x => x.change === 'set' && (f.needs ?? []).some(n => n.need === 'state' && n.field === x.field));
      if (!spent) add('makes', `${p}.effects.${i}`, `creates ${e.kind} and pays for nothing`, 'add a remove effect for what it is made from, or a set of a field the form needs (spending it)');
    });
    // no-waiting: a timer that arms its own form again waits on a condition by polling; a name that counts a time of day.
    if (f.starts === 'timer' && (f.effects ?? []).some(x => x.change === 'timer' && x.form === fn)) add('no-waiting', `${p}.effects`, 'a timer form that arms itself again waits on a condition by polling', 'end the form, or make a different form the next one');
    for (const t of tokens(fn)) if (TIME_WORDS.has(t)) add('no-waiting', p, `"${fn}" names a time of day ("${t}"); times are the agent's, schedules are SA-F16's`, 'name the form for what it does');
    for (const k of ['needs', 'steps', 'effects']) if ((f[k]?.length ?? 0) > BUDGET.perForm) add('bounded', `${p}.${k}`, `${f[k].length} ${k}, more than ${BUDGET.perForm}`, `split the form so each has at most ${BUDGET.perForm} ${k}`);
  }
  for (const fname of Object.keys(state)) for (const t of tokens(fname)) if (TIME_WORDS.has(t)) add('no-waiting', `state.${fname}`, `"${fname}" names a time of day ("${t}")`, 'a schedule is SA-F16\'s; name the field for what it holds');

  // bounded: every link type says how many edges it holds, and state at its maximum is within the budget.
  let edges = 0;
  for (const [ln, l] of Object.entries(links)) { if (l.most === undefined) add('bounded', `links.${ln}.most`, `link "${ln}" has no most, so its count is unbounded`, 'set most to a whole number above zero'); else edges += l.most; }
  if (edges > BUDGET.linkEdges) add('bounded', 'links', `links at their maximum hold ${edges} edges, over ${BUDGET.linkEdges}`, 'lower a link\'s most');
  const bytes = stateBytes(entry);
  if (bytes > BUDGET.stateBytes) add('bounded', 'state', `state at its maximum is ${bytes} bytes, over ${BUDGET.stateBytes}`, 'drop a field or make a field smaller');
  if (Object.keys(forms).length > BUDGET.forms) add('bounded', 'forms', `${Object.keys(forms).length} forms, over ${BUDGET.forms}`, 'split the kind');
  const parts = Object.keys(entry.points ?? {}).length + Object.keys(entry.slots ?? {}).length;
  if (parts > BUDGET.parts) add('bounded', 'points', `${parts} points and slots, over ${BUDGET.parts}`, 'drop some, or split the kind');

  wayOut(entry, add);

  // moves: the sections are SA-F10's. Until the format defines them, data cannot break this rule and it is not checked.
  if (!('motion' in F.RESERVED) && entry.owner === 'thing' && movable(entry)) for (const s of ['motion', 'loose']) if (entry[s] === undefined) add('moves', s, `a thing that can be carried says nothing of its ${s}`, `add a "${s}" section`);

  // card: a kind has one line of purpose, short enough to read at a glance.
  if (entry.card === undefined) add('card', 'card', 'the kind has no card', 'add "card": {"text": "<key>"} naming a text entry that says what it is for, in one line');
  else if (typeof entry.text?.[entry.card.text] === 'string' && [...entry.text[entry.card.text]].length > CARD_MOST) add('card', `text.${entry.card.text}`, `the card is ${[...entry.text[entry.card.text]].length} characters, over ${CARD_MOST}`, `shorten it to at most ${CARD_MOST} characters: what it is and what can be done`);

  // no-labels: the card is facts, not a mood.
  const card = entry.text?.[entry.card?.text];
  const label = typeof card === 'string' && LABEL.exec(card);
  if (label) add('no-labels', `text.${entry.card.text}`, `the card says "${label[1]}", a label`, `cut "${label[1]}" and say the facts: what it has and what can be done`);
  return out;
}

const movable = e => Object.values(e.forms ?? {}).some(f => (f.needs ?? []).some(n => n.need === 'held_by_actor') || (f.steps ?? []).some(s => s.step === 'take' || s.step === 'put') ||
  (f.effects ?? []).some(x => x.change === 'reparent' && x.what === 'this'));

/** Every chain of needs has a way out. A form is reachable when the state its needs ask for can be reached from the
 *  defaults through reachable forms (a timer form also needs a reachable form to arm it). A field something outside
 *  must set (no form sets it, or a declared value no form of this kind sets) is open: any value can come. */
function wayOut(entry, add) {
  const state = entry.state ?? {}, forms = entry.forms ?? {}, links = entry.links ?? {};
  const setters = {}, linkers = {};
  for (const f of Object.values(forms)) for (const e of f.effects ?? []) {
    if (e.change === 'set') (setters[e.field] ??= new Set()).add(isArg(e.to) ? '*' : JSON.stringify(e.to));
    if (e.change === 'link') linkers[e.link] = true;
  }
  const reach = {}, open = new Set();
  for (const [n, fd] of Object.entries(state)) {
    reach[n] = new Set([JSON.stringify(fd.default)]);
    const s = setters[n];
    if (!s || s.has('*') || (fd.type === 'enum' && fd.values.some(v => !s.has(JSON.stringify(v)) && v !== fd.default))) open.add(n);
  }
  const linked = new Set(Object.keys(links).filter(l => !linkers[l]));
  const armed = new Set(), on = new Set();
  const ok = n => {
    if (n.need === 'state') {
      if (open.has(n.field) || !reach[n.field]) return true;
      const v = 'is' in n ? n.is : n.not;
      if (isArg(v)) return true;
      const j = JSON.stringify(v);
      return 'is' in n ? reach[n.field].has(j) : [...reach[n.field]].some(x => x !== j);
    }
    return n.need === 'linked' ? linked.has(n.link) : true;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const [fn, f] of Object.entries(forms)) {
      if (on.has(fn) || (f.starts === 'timer' && !armed.has(fn)) || (isObj(f.who) && !linked.has(f.who.link)) || !(f.needs ?? []).every(ok)) continue;
      on.add(fn); changed = true;
      for (const e of f.effects ?? []) {
        if (e.change === 'set' && reach[e.field]) reach[e.field].add(isArg(e.to) ? '*' : JSON.stringify(e.to));
        if (e.change === 'link') linked.add(e.link);
        if (e.change === 'timer') armed.add(e.form);
      }
    }
  }
  for (const [fn, f] of Object.entries(forms)) {
    if (on.has(fn)) continue;
    const i = (f.needs ?? []).findIndex(n => !ok(n));
    if (f.starts === 'timer' && !armed.has(fn)) add('way-out', `forms.${fn}`, 'a timer form that no reachable form arms', `add a timer effect for "${fn}" to a form that can be done`);
    else if (isObj(f.who) && !linked.has(f.who.link)) add('way-out', `forms.${fn}.who`, `needs the link "${f.who.link}" and nothing reachable makes it`, 'link it in a form that needs nothing');
    else if (i >= 0) { const n = f.needs[i]; add('way-out', `forms.${fn}.needs.${i}`, `needs ${n.need} ${n.field ?? n.link ?? ''} that only forms stuck behind this need can bring about`, 'let a form that needs nothing bring it about, or make the default what the need asks'); }
  }
}

/** State at its maximum, in bytes. format.mjs's own count (`stateAtMax`, SA-F6a) is used when it exists. */
function stateBytes(entry) {
  if (typeof F.stateAtMax === 'function') {
    // SA-F6a's count: whole values with every list at its maximum, and children. Counted as 8 bytes each, plus the link edges.
    const r = F.stateAtMax(entry);
    if (isObj(r) && Number.isFinite(r.values)) return (r.values + (r.children ?? 0)) * 8 + Object.values(entry.links ?? {}).reduce((a, l) => a + (l.most ?? 0) * LINK_EDGE_BYTES, 0);
  }
  let n = 0;
  for (const fd of Object.values(entry.state ?? {})) n += BYTES[fd.type] ?? 8;
  for (const l of Object.values(entry.links ?? {})) n += (l.most ?? 0) * LINK_EDGE_BYTES;
  return n;
}

/** Check one entry's text. */
export function checkText(text) {
  const {entry, errors} = F.parseEntry(text);
  if (!entry) return {entry, findings: errors.map(finding)};
  const findings = [...errors, ...F.validateEntry(entry)].map(finding);
  if (!findings.length) findings.push(...rules(entry));
  return {entry, findings};
}

/** Check files. Kinds an entry refers to are looked for among `all`, so one family can refer to another. */
export function checkFiles(files, all = files) {
  const rows = files.map(file => ({file, ...checkText(readFileSync(file, 'utf8'))}));
  const loaded = new Map();
  for (const f of all) {
    const r = rows.find(x => x.file === f) ?? checkText(readFileSync(f, 'utf8'));
    if (r.entry && !r.findings.length) loaded.set(r.entry.kind, r.entry);
  }
  for (const r of rows) {
    if (!r.entry || r.findings.length) continue;
    for (const k of F.kindRefs(r.entry)) if (!loaded.has(k)) r.findings.push({rule: 'refs', form: null, field: 'kind', path: 'forms', reason: `refers to ${k}, which is not loaded`, fix: `add ${k} under content/kinds, or name a kind that exists`});
  }
  try { F.hashKinds([...loaded.values()].filter(e => F.kindRefs(e).every(k => loaded.has(k)))); } catch (e) {
    const names = new Set(e.message.match(/[a-z][a-z0-9-]*:[a-z][a-z0-9_]*/g) ?? []);
    for (const r of rows) if (r.entry && names.has(r.entry.kind)) r.findings.push({rule: 'refs', form: null, field: 'kind', path: 'forms', reason: e.message, fix: 'break the circle: one of the kinds stops naming the other'});
  }
  return rows;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
// `entry prove <family>` runs every gate that needs no engine (prove.mjs, SA-P8).
if (isMain && process.argv[2] === 'prove') import('./prove.mjs').then(m => { process.exitCode = m.main(process.argv.slice(3)); });
// `entry run <family> --world <address>` drives a world from outside through the family's cases (run.mjs, SA-P3a).
else if (isMain && process.argv[2] === 'run') import('./run.mjs').then(async m => { process.exitCode = await m.main(process.argv.slice(3)); });
else if (isMain) {
  const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === 'check'));
  const all = F.loadDir(KINDS_DIR);
  const resolve = a => existsSync(a) ? F.loadDir(a) : existsSync(join(KINDS_DIR, a)) ? F.loadDir(join(KINDS_DIR, a)) : null;
  const missing = args.find(a => !resolve(a));
  if (missing) { console.log(JSON.stringify({error: `no such family, folder or file: ${missing}`})); process.exit(2); }
  const files = args.length ? args.flatMap(resolve) : all;
  const rows = checkFiles(files, [...new Set([...all, ...files])]);
  let bad = 0;
  for (const r of rows) { if (r.findings.length) bad++; console.log(JSON.stringify({file: relative(ROOT, r.file), kind: r.entry?.kind, ok: !r.findings.length, findings: r.findings})); }
  console.log(JSON.stringify({checked: rows.length, refused: bad, ok: bad === 0}));
  process.exitCode = bad ? 1 : 0;
}
