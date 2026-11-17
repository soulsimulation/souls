// Tests for the entry format (Soul Actions SA-F1, #2842). Each test is one acceptance item of the issue.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as F from './format.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = p => readFileSync(root + p, 'utf8');
const ENTRIES = ['content/kinds/kitchen/kettle.json', 'content/kinds/seating/bench.json', 'content/kinds/gathering/lecture.json'];
const load = p => { const {entry, errors} = F.parseEntry(read(p)); assert.deepEqual(errors, []); return entry; };
const copy = v => structuredClone(v);
const refused = (entry, path, word) => {
  const errors = F.validateEntry(entry);
  assert.ok(errors.some(e => e.path === path && (!word || e.reason.includes(word))), `expected a refusal at ${path}${word ? ` (${word})` : ''}, got ${JSON.stringify(errors)}`);
};

test('A1: the kettle, the bench and the lecture validate; three malformed entries are refused naming the field', () => {
  const [kettle, bench, lecture] = ENTRIES.map(load);
  for (const e of [kettle, bench, lecture]) assert.deepEqual(F.validateEntry(e), [], e.kind);
  const hashes = F.hashKinds([kettle, bench, lecture]);
  for (const e of [kettle, bench, lecture]) assert.match(hashes.get(e.kind).ref, /^eden:[a-z]+@prov-1220[0-9a-f]{64}$/);

  const a = copy(kettle); a.state.water.default = 'lukewarm';
  refused(a, 'state.water.default');
  const b = copy(bench); b.forms.sit.steps[0] = {step: 'teleport', to: 'left'};
  refused(b, 'forms.sit.steps.0.step', 'closed list');
  const c = copy(lecture); c.forms.begin.effects[1].field = 'title';
  refused(c, 'forms.begin.effects.1.field');
});

test('A2: a float, a duration in ticks, a field without a number or an audience, and a Soul id in a field are refused', () => {
  const kettle = load(ENTRIES[0]);
  // A float, as written in the file (1.0 is a float literal even though JSON.parse reads it as 1) and as a value.
  const text = read(ENTRIES[0]).replace('"at_mm": [0, 220, 0]', '"at_mm": [0, 220.0, 0]');
  assert.ok(F.parseEntry(text).errors.some(e => e.reason.includes('floating-point')));
  const f = copy(kettle); f.points.handle.at_mm = [0, 0.22, 0];
  refused(f, 'points.handle.at_mm.1', 'floating-point');
  // A duration in ticks, as a key and as a unit.
  const t = copy(kettle); t.forms.switch_on.effects[1] = {change: 'timer', form: 'boiled', after_ticks: 3000, event: 'boil_started'};
  refused(t, 'forms.switch_on.effects.1.after_ticks', 'ticks');
  const u = copy(kettle); u.state.heat = {n: 3, type: 'int', unit: 'mC/tick', default: 0, audience: 'public'};
  refused(u, 'state.heat.unit', 'ticks');
  // A field without a number, and one without an audience.
  const n = copy(kettle); delete n.state.water.n;
  refused(n, 'state.water.n', 'number');
  const au = copy(kettle); delete au.state.heating.audience;
  refused(au, 'state.heating.audience', 'who may see it');
  // A Soul's id inside a field: as a field that holds an id, and as a value.
  const s = copy(kettle); s.state.filled_by = {n: 3, type: 'soul', default: null, audience: 'public'};
  refused(s, 'state.filled_by.type', 'link');
  const v = copy(kettle); v.state.water = {...v.state.water, values: ['empty', 's_maya'], default: 's_maya'};
  refused(v, 'state.water.default', 'link');
});

test('A3: reordering a file\'s keys does not change the hash; changing a form does', () => {
  const kettle = load(ENTRIES[0]);
  const reverse = v => Array.isArray(v) ? v.map(reverse) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)])) : v;
  const reordered = reverse(kettle);
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(kettle));
  const hash = e => F.hashKinds([e]).get('eden:kettle');
  assert.equal(hash(reordered).hash, hash(kettle).hash);
  assert.equal(hash(reordered).beside, hash(kettle).beside);

  const changed = copy(kettle); changed.forms.switch_on.effects[1].after_us = 120000000;
  assert.notEqual(hash(changed).hash, hash(kettle).hash);
  // Looks sit beside the kind: a better picture changes the beside hash, never the kind's name.
  const looks = copy(kettle); looks.looks.model = 'look:kettle_copper';
  assert.equal(hash(looks).hash, hash(kettle).hash);
  assert.notEqual(hash(looks).beside, hash(kettle).beside);
});

// Today's engine's own names, read from its sources so that the list cannot fall behind them.
function todaysNames() {
  const schemas = read('packages/world-compiler/src/schemas.ts'), catalog = read('apps/server/src/edge/catalog/catalog.ts');
  const block = (src, start) => { const i = src.indexOf(start); assert.ok(i >= 0, start); return src.slice(i, src.indexOf('\n});', i)); };
  const names = new Set();
  for (const m of block(schemas, 'export const defSchema').matchAll(/^ {2}([a-zA-Z]+):/gm)) names.add(m[1]);
  for (const m of block(schemas, 'export const componentsSchema').matchAll(/^ {2}([a-zA-Z]+):/gm)) names.add(m[1]);
  for (const m of block(schemas, 'export const actionSchema').matchAll(/^ {2}([a-zA-Z]+):|op: z\.literal\('([a-z]+)'\)/gm)) names.add(m[1] ?? m[2]);
  for (const m of catalog.matchAll(/\['([a-z-]+)', '/g)) names.add(m[1]);
  for (const m of /PLACE_VERBS = \[([^\]]+)\]/.exec(catalog)[1].matchAll(/'([a-z-]+)'/g)) names.add(m[1]);
  names.add(/DEF_SCHEMA = '([^']+)'/.exec(schemas)[1]);
  names.add(/CATALOG_CONTRACT = '([^']+)'/.exec(catalog)[1]);
  return names;
}

// Words today's engine also uses that Engine v2's own contracts and tasks name for the same idea. They stay, and each
// says where Engine v2 names it. Anything else shared with today's names fails this test.
const ENGINE_V2_WORDS = {
  state: 'K3 (#2667): a kind declares state', slots: 'T2 on #2635: a kind says what children it admits; SA-D3 (#2855)',
  anchor: 'E2 (#2709): a selector has an anchor', place: 'E21 (#2791): a form\'s owner may be a kind of place',
  set: 'T6 on #2635: set a field is a generic change', sit: 'F1 (#2766): a step is sit or rise; E3 (#2777)',
  lie: 'E3 (#2777): where a body can sit, lie, stand or lean', stand: 'E3 (#2777); F1 (#2766): the thing\'s stand point',
  point: 'K3 (#2667): points, named places', schedule: 'E7 (#2756) and SA-F16: schedules are data',
  form: 'K3 (#2667) and F1 (#2766): a form, what can be done with a kind', body: 'T9 on #2635: bodies and behaviour',
};

test('A4: no part of the format names a verb, file or field of today\'s engine', () => {
  const today = todaysNames();
  assert.ok(today.size > 60, `read ${today.size} of today's names`);
  // The format's whole vocabulary: every exported list and table, and every key the validator accepts.
  const words = new Set();
  const add = v => { if (typeof v === 'string') words.add(v); else if (Array.isArray(v)) v.forEach(add); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { words.add(k); add(x); } };
  for (const [k, v] of Object.entries(F)) if (/^[A-Z_]+$/.test(k)) add(v);
  const src = read('tools/entry/format.mjs');
  for (const m of src.matchAll(/only\([^,]+, \[([^\]]*)\]/g)) for (const w of m[1].matchAll(/'([^']+)'/g)) words.add(w[1]);
  assert.ok(words.size > 80, `read ${words.size} words of the format`);
  const shared = [...words].filter(w => today.has(w) && !(w in ENGINE_V2_WORDS));
  assert.deepEqual(shared, [], 'the format names today\'s engine');
  // No file of today's engine, nor its schema tags, in the format, its page or the entries.
  for (const p of ['tools/entry/format.mjs', 'docs/soul-actions/entry-format.md', ...ENTRIES]) {
    const body = read(p).replace(/^\/\/.*$/gm, '');
    for (const pat of [/apps\/server\//, /packages\/(?:world-compiler|kernel|engine-|generators)/, /\bdef\/1\b/, /\bkit\/2\b/, /soul-catalog\/1/, /\bcore[-/][a-z]/, /\bew:/]) assert.doesNotMatch(body, pat, `${p} names today's engine`);
  }
});

test('A5: a form owned by the body\'s family and one owned by a kind of ground both validate', () => {
  const body = {format: F.FORMAT, kind: 'eden:humanoid', owner: 'family',
    forms: {bow: {who: 'anyone', starts: 'act', needs: [], steps: [{step: 'move', move: 'bow'}], effects: []}}};
  const sand = {format: F.FORMAT, kind: 'eden:sand', owner: 'place',
    forms: {build_sandcastle: {who: 'anyone', starts: 'act', needs: [],
      steps: [{step: 'move', move: 'dig'}, {step: 'wait', us: 20000000}],
      effects: [{change: 'create', kind: 'eden:sandcastle', into: 'here', event: 'sandcastle_built'}]}}};
  const castle = {format: F.FORMAT, kind: 'eden:sandcastle', owner: 'thing', geometry: {bounds_mm: [400, 300, 400]}, forms: {}};
  for (const e of [body, sand, castle]) assert.deepEqual(F.validateEntry(e), [], e.kind);
  // The ground's hash covers the kind it makes; kinds that refer to each other in a circle are refused by name.
  const before = F.hashKinds([body, sand, castle]).get('eden:sand').hash;
  const bigger = copy(castle); bigger.geometry.bounds_mm = [600, 300, 600];
  assert.notEqual(F.hashKinds([body, sand, bigger]).get('eden:sand').hash, before);
  const loop = copy(castle); loop.forms.crumble = {who: 'anyone', starts: 'act', needs: [], steps: [], effects: [{change: 'create', kind: 'eden:sand', into: 'here', event: 'crumbled'}]};
  assert.throws(() => F.hashKinds([sand, loop]), /circle: eden:sand -> eden:sandcastle -> eden:sand/);
});
