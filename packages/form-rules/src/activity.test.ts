import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { enter, PLACES_IN, ROLE_NEEDS, type Activity } from './activity.ts';
import { apply, parentOf, type State } from './effects.ts';
import { CASES, loadKinds, mismatches, ROOT, same } from './load.ts';
import type { Input } from './rules.ts';

type Step = { actor: string; form: string; receipt: string; expect: Record<string, unknown> };
type ActivityCase = { name: string; activity: string; state: { nodes: Input['state']['nodes'] }; enter: Step[]; after?: Record<string, unknown> };

const kinds = loadKinds();
const DIR = join(CASES, 'activity');
const cases: [string, ActivityCase][] = [];
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
  const doc = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
  assert.equal(doc.format, 'souls-activity-cases/1', file);
  for (const c of doc.cases) cases.push([file, c]);
}

/** Every case's answers, with the places given, after each Soul entered by its own act in order. */
/** The entry format's validator (tools/entry/format.mjs, lane A's), run as a tool: its errors for this entry. */
function validateEntry(entry: object): unknown[] {
  const dir = mkdtempSync(join(tmpdir(), 'activity-'));
  try {
    writeFileSync(join(dir, 'entry.json'), JSON.stringify(entry));
    const out = spawnSync(process.execPath, [join(ROOT, 'tools/entry/format.mjs'), join(dir, 'entry.json')], { encoding: 'utf8' });
    return JSON.parse(out.stdout.trim()).errors;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const runs = new Map<string, { kind: string; given: { role: string; node: string; slot: string }[]; refused: Record<string, unknown>[] }>();

for (const [file, c] of cases) {
  test(`activity/${file}: ${c.name}`, () => {
    let state: State = structuredClone({ actor: '', ...c.state });
    const given: { role: string; node: string; slot: string }[] = [];
    const refused: Record<string, unknown>[] = [];
    c.enter.forEach((step, k) => {
      const result = enter({ kinds, act: { this: c.activity, form: step.form }, state: { ...state, actor: step.actor }, asker: { sees: ['public'] }, receipt: step.receipt });
      assert.deepEqual(mismatches(step.expect, result), [], `step ${k}: ${JSON.stringify(result)}`);
      if (result.verdict !== 'yes' || !('changes' in result)) {
        refused.push(result as Record<string, unknown>);
        return;
      }
      const done = apply(state, result);
      if (!done.ok) return assert.fail(`step ${k}: ${JSON.stringify(done)}`);
      state = done.state;
      // The body is where the rules placed it, and no two members share a place.
      assert.deepEqual(parentOf(state.nodes, step.actor), result.place, `step ${k}: ${step.actor} is in its place`);
      assert.ok(!given.some((g) => g.node === result.place.node && g.slot === result.place.slot), `step ${k}: a place already given`);
      given.push({ role: result.role, ...result.place });
    });
    for (const [id, want] of Object.entries(c.after ?? {})) assert.ok(same(state.nodes[id] ?? null, want), `${id}: ${JSON.stringify(state.nodes[id] ?? null)}`);
    runs.set(`${file}:${c.name}`, { kind: c.state.nodes[c.activity].kind!, given, refused });
  });
}

const lectures = () => [...runs.values()].filter((r) => r.kind === 'test:lecture_activity');

test('A1: in three different rooms a lecture gives a speaker and six listeners distinct places', () => {
  const full = lectures().filter((r) => r.given.filter((g) => g.role === 'speaker').length === 1 && r.given.filter((g) => g.role === 'listener').length === 6);
  assert.ok(full.length >= 3, `${full.length} rooms`);
  // Three different rooms: no seat of one is a seat of another, and their furniture differs.
  const furniture = full.map((r) => r.given.filter((g) => g.role === 'listener').map((g) => `${g.node}.${g.slot}`).join(' '));
  assert.equal(new Set(furniture).size, full.length, furniture.join(' | '));
});

test('A2: a seventh listener with no free place is refused, naming that', () => {
  const refused = lectures().flatMap((r) => (r.given.filter((g) => g.role === 'listener').length === 6 ? r.refused : []));
  assert.ok(refused.some((v) => v.reason === 'no_free_place' && v.role === 'listener'), JSON.stringify(refused));
});

test('A3: the lecture entry names no engine: all but its roles is the entry format, and its roles use only their own lists', () => {
  const entry = kinds['test:lecture_activity'] as Activity;
  const { roles, ...rest } = entry;
  assert.deepEqual(validateEntry(rest), []);
  for (const [name, role] of Object.entries(roles ?? {})) {
    assert.ok(entry.links && name in entry.links, `${name} is a link type of the kind`);
    assert.ok(ROLE_NEEDS.includes(role.need), `${name}.need`);
    assert.ok(PLACES_IN.includes(role.places!.in), `${name}.places.in`);
    assert.deepEqual(Object.keys(role.places!).filter((k) => !['in', 'slots', 'within_mm', 'posture'].includes(k)), [], `${name}.places`);
  }
  assert.doesNotMatch(JSON.stringify(entry), /engine|mars|rapier|three|tick|\.ts\b|\.mjs\b|apps\/|packages\//i);
});

test('Step 0: the supper fits the same shape, and every entering form only links a role and seats its own actor', () => {
  for (const kind of ['test:lecture_activity', 'test:supper']) {
    const entry = kinds[kind] as Activity;
    const { roles, ...rest } = entry;
    assert.deepEqual(validateEntry(rest), [], kind);
    for (const [name, form] of Object.entries(entry.forms ?? {})) {
      for (const e of form.effects ?? []) assert.ok(e.change === 'link' || (e.change === 'reparent' && e.what === 'actor'), `${kind} ${name}: ${e.change}`);
    }
    assert.ok(Object.keys(roles ?? {}).length >= 2, kind);
  }
});
