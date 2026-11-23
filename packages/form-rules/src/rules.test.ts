import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { generate } from './generate.ts';
import { CASES, loadCases, loadKinds, mismatches, PACKAGE } from './load.ts';
import { decide, NEEDS, REASONS } from './rules.ts';

const kinds = loadKinds();
const cases = loadCases();

// A1 and A4: every hand-written case gives its expected verdict. Adding a case file changes no code.
for (const [file, c] of cases) {
  test(`${file.slice(CASES.length + 1)}: ${c.name}`, () => {
    const verdict = decide({ kinds, ...c });
    assert.deepEqual(mismatches(c.expect, verdict), [], JSON.stringify(verdict));
  });
}

test('A1: the kettle, the seat and the lecture each have a yes per form and a case per need they declare', () => {
  for (const kind of ['eden:kettle', 'eden:bench', 'eden:lecture']) {
    for (const [name, form] of Object.entries(kinds[kind].forms ?? {})) {
      const mine = cases.filter(([, c]) => c.act.form === name && c.state.nodes[c.act.this]?.kind === kind).map(([, c]) => c);
      assert.ok(mine.some((c) => c.expect.verdict === 'yes'), `${kind} ${name}: no case where every need is met`);
      (form.needs ?? []).forEach((_, i) => {
        assert.ok(mine.some((c) => c.expect.verdict === 'no' && c.expect.need === i && c.expect.reason !== 'bad_input'), `${kind} ${name}: need ${i} has no unmet case`);
      });
    }
  }
});

test('a within_reach of another thing is unknown, not no, when its pose is not in the input', () => {
  const c = cases.find(([, k]) => k.name === 'fill_tap_in_reach')![1];
  const nodes = { ...c.state.nodes, t1: { kind: 'test:reach_tap' } };
  const v = decide({ kinds, ...c, state: { ...c.state, nodes } });
  assert.deepEqual([v.verdict, (v as { node?: string }).node, (v as { field?: string }).field], ['unknown', 't1', 'at_mm']);
});

test('A4: unknown only for a field outside the audience; the same state seen by all is definite', () => {
  for (const [, c] of cases.filter(([, c]) => c.expect.verdict === 'unknown')) {
    const all = decide({ kinds, ...c, asker: { sees: 'all' } });
    assert.notEqual(all.verdict, 'unknown', c.name);
  }
  for (const input of generate(kinds, 1000, 7)) {
    const v = decide({ kinds, ...input });
    if (v.verdict !== 'unknown') continue;
    assert.ok(v.field || v.link, 'an unknown names its field or link');
    assert.notEqual(decide({ kinds, ...input, asker: { sees: 'all' } }).verdict, 'unknown');
  }
});

test('every reason named by a verdict is in the closed list, and every verdict carries its read set', () => {
  for (const input of generate(kinds, 1000, 11)) {
    const v = decide({ kinds, ...input });
    assert.ok(Array.isArray(v.read));
    if (v.verdict === 'no') assert.ok(REASONS.includes(v.reason), v.reason);
  }
  for (const [, c] of cases) if (c.expect.reason) assert.ok(REASONS.includes(c.expect.reason as string));
  for (const entry of Object.values(kinds)) for (const f of Object.values(entry.forms ?? {})) for (const n of f.needs ?? []) assert.ok(NEEDS.includes(n.need), n.need);
});

test('never throws, whatever it is given', () => {
  const junk: unknown[] = [null, {}, { act: {}, state: {}, kinds: {}, asker: {} }, { kinds, act: { this: 'x', form: 'y' }, state: { actor: 'b', nodes: { x: { kind: 'eden:kettle' } } }, asker: { sees: [] } }];
  for (const j of junk) assert.equal(decide(j as never).verdict, 'no');
});

test('A3: the library imports nothing from apps/, mars/ or packages/engine-*', () => {
  const src = join(PACKAGE, 'src');
  for (const file of readdirSync(src)) {
    const text = readFileSync(join(src, file), 'utf8');
    const specifiers = [...text.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);
    for (const s of specifiers) {
      assert.ok(s.startsWith('./') || s.startsWith('node:'), `${file} imports ${s}`);
      assert.doesNotMatch(s, /apps\/|mars\/|engine-/, `${file} imports ${s}`);
    }
    if (file === 'rules.ts') assert.deepEqual(specifiers, [], 'rules.ts imports nothing');
  }
});

// Entry-tool consolidation: one implementation of the fixes the content lanes each made (see the PR).
test('a need on a field a closed kind names reads the container\'s audience, not the field\'s own', () => {
  const box = {
    kind: 'test:box',
    closed: { audience: { rule: 'owner' as const }, fields: ['apples'] },
    state: { apples: { n: 0, type: 'int', unit: 'count', min: 0, max: 4, default: 2 } as never, lid: { n: 1, type: 'bool', default: false, audience: { rule: 'everyone' as const } } },
    forms: { take: { who: 'anyone', starts: 'act', needs: [{ need: 'state', field: 'apples', at_least: 1 }] }, peek: { who: 'anyone', starts: 'act', needs: [{ need: 'state', field: 'lid', is: false }] } },
  };
  const ask = (form: string, sees: string[]) => decide({ kinds: { 'test:box': box } as never, act: { this: 'b', form }, state: { actor: 'me', nodes: { b: { kind: 'test:box' }, me: {} } }, asker: { sees } });
  assert.equal(ask('take', []).verdict, 'unknown', 'a stranger cannot read a closed count');
  assert.equal(ask('take', ['owner']).verdict, 'yes', 'the owner reads it through the container\'s audience');
  assert.equal(ask('peek', []).verdict, 'yes', 'a field the closed list does not name keeps its own audience');
});

test('a search of a closed container the asker cannot see into is unknown, naming only the container and its closed section', () => {
  const stump = {
    kind: 'test:stump',
    closed: { audience: { rule: 'creator' as const }, fields: [] },
    slots: { inside: { admits: 'thing', most: 3 } },
    forms: { search: { who: 'anyone', starts: 'act', takes: { thing: { type: 'thing', select: { of: 'things', in: 'this', anchor: 'me', order: 'nearest', rank: 1 } } }, needs: [{ need: 'hand', free: true }] } },
  };
  const ask = (inside: string[]) => decide({
    kinds: { 'test:stump': stump } as never,
    act: { this: 's', form: 'search' },
    state: { actor: 'me', nodes: { s: { kind: 'test:stump', slots: { inside } }, ...Object.fromEntries(inside.map((id) => [id, {}])), me: { hands: { right: null } } } },
    asker: { sees: ['public'] },
  });
  const empty = ask([]), full = ask(['t1', 't2']);
  assert.deepEqual(empty, { verdict: 'unknown', need: -1, node: 's', field: 'closed', read: [] });
  assert.deepEqual(full, empty, 'the same answer whatever it holds: no slot, thing or count is named');
});

test('a state need\'s fix passes over a form that would itself be refused now', () => {
  const lamp = {
    kind: 'test:lamp',
    state: { level: { n: 0, type: 'int', unit: 'permille', min: 0, max: 1000, default: 0, audience: { rule: 'everyone' as const } } },
    forms: {
      bright: { who: 'anyone', starts: 'act', needs: [{ need: 'state', field: 'level', at_least: 1000 }] },
      // a dimmer step: it reaches full only from a lamp already lit, so on a dark lamp it is no fix
      dim_up: { who: 'anyone', starts: 'act', needs: [{ need: 'state', field: 'level', at_least: 1 }], effects: [{ change: 'set', field: 'level', to: 1000, event: 'brightened' }] },
      switch_on: { who: 'anyone', starts: 'act', needs: [], effects: [{ change: 'set', field: 'level', to: 1000, event: 'lit' }] },
    },
  };
  const ask = (level: number) => decide({ kinds: { 'test:lamp': lamp } as never, act: { this: 'l', form: 'bright' }, state: { actor: 'me', nodes: { l: { kind: 'test:lamp', fields: { level } }, me: {} } }, asker: { sees: [] } });
  const dark = ask(0), lit = ask(500);
  assert.equal(dark.verdict, 'no');
  assert.deepEqual(dark.verdict === 'no' && dark.fix, { form: 'switch_on' }, 'dim_up needs a lit lamp, so the dark lamp is told to switch on');
  assert.deepEqual(lit.verdict === 'no' && lit.fix, { form: 'dim_up' }, 'a lit lamp is dimmed up, the first form in order that is ready');
});

test('reach to another thing: walk-first, else the measured pose (`of`), else unknown', () => {
  const touch = (needs: unknown[], steps: unknown[]) => ({ kind: 'test:hand', forms: { touch: { who: 'anyone', starts: 'act', takes: { thing: { type: 'thing' } }, needs, steps } } });
  const ball = { kind: 'test:ball', points: { top: { at_mm: [0, 100, 0] } } };
  const ask = (entry: unknown, ballAt?: number[]) => decide({
    kinds: { 'test:hand': entry, 'test:ball': ball } as never,
    act: { this: 'h', form: 'touch', args: { thing: 'x' } },
    state: { actor: 'me', nodes: { room: { loose: ['me', 'x'] }, h: { kind: 'test:hand' }, me: { effector_mm: [0, 100, 0] }, x: { kind: 'test:ball', ...(ballAt ? { at_mm: ballAt } : {}) } }, moves: { tap: { reach_mm: 50 } } },
    asker: { sees: [] },
  });
  const walks = touch([{ need: 'within_reach', point: { arg: 'thing' } }], [{ step: 'walk_to', point: { arg: 'thing' } }]);
  const measured = touch([{ need: 'within_reach', point: 'top', of: { arg: 'thing' } }], [{ step: 'move', move: 'tap', toward: { arg: 'thing' } }]);
  const neither = touch([{ need: 'within_reach', point: { arg: 'thing' } }], []);
  assert.equal(ask(walks).verdict, 'yes', 'the form walks to it and it is in the actor\'s place');
  assert.equal(ask(measured, [0, 0, 0]).verdict, 'yes', 'its pose is measured and its point is within the move\'s reach');
  assert.equal(ask(measured).verdict, 'unknown', 'no walk and no pose');
  assert.equal(ask(neither).verdict, 'unknown', 'no walk and no `of`');
});
