// The arrival card's rules (#3780): the light only grows, a failure shows its reason in place of the light, the first
// frame dissolves the card and then takes it out of the page with no timer left, and a `?shot` page never shows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISSOLVE_MS, STAGES, lightRadius, mountArrival, next, type Arrival } from './card.ts';

type El = { tag: string; kids: El[]; parent: El | null; dataset: Record<string, string>; vars: Record<string, string>; attrs: Record<string, string>; textContent: string; value: number; clientWidth: number; clientHeight: number;
  append(...k: El[]): void; remove(): void; setAttribute(k: string, v: string): void; style: { setProperty(k: string, v: string): void } };
function fakeDoc() {
  const el = (tag: string): El => {
    const e: El = { tag, kids: [], parent: null, dataset: {}, vars: {}, attrs: {}, textContent: '', value: 0, clientWidth: 390, clientHeight: 844,
      append: (...k) => k.forEach((c) => ((c.parent = e), e.kids.push(c))),
      remove: () => { if (e.parent) e.parent.kids = e.parent.kids.filter((c) => c !== e); e.parent = null; },
      setAttribute: (k, v) => void (e.attrs[k] = v), style: { setProperty: (k, v) => void (e.vars[k] = v) } };
    return e;
  };
  return { head: el('head'), body: el('body'), createElement: el };
}
function fakeTimers() {
  const pending = new Map<number, () => void>(); let id = 0;
  return { pending, later: (f: () => void) => pending.set(++id, f),
    run() { const fs = [...pending.values()]; pending.clear(); fs.forEach((f) => f()); } };
}

test('the light only grows with the stream, and the first frame dissolves it', () => {
  let a: Arrival = { phase: 0, state: 'loading', reason: '' };
  a = next(a, { t: 'stage', stage: 'snapshot' });
  assert.equal(a.phase, STAGES.snapshot);
  assert.equal(next(a, { t: 'stage', stage: 'pointer' }), a, 'a late pointer never shrinks the light');
  a = next(a, { t: 'stage', stage: 'drawn' });
  assert.deepEqual(a, { phase: 1, state: 'dissolving', reason: '' });
  assert.equal(next(a, { t: 'fail', reason: 'late' }), a, 'nothing but gone changes a dissolving card');
  assert.equal(next(a, { t: 'gone' }).state, 'gone');
  assert.ok(lightRadius(1, 390, 844, 120) < Math.hypot(390, 844) / 2, 'at full it never reaches the corners: no white screen');
  assert.ok(lightRadius(0.5, 390, 844, 120) > lightRadius(0.2, 390, 844, 120));
});

test('a failed load shows its reason in place of the light, and a later frame still dissolves it', () => {
  let a = next({ phase: 0.35, state: 'loading', reason: '' }, { t: 'fail', reason: 'world eden: world.json 404' });
  assert.equal(a.state, 'failed');
  assert.equal(a.reason, 'world eden: world.json 404');
  assert.equal(next(a, { t: 'gone' }), a, 'a failed card stays until a frame comes');
  a = next(a, { t: 'stage', stage: 'drawn' });
  assert.equal(a.state, 'dissolving');
});

test('mounted: titled, grows, shows a reason as plain text, then leaves the page with no timer left', () => {
  const doc = fakeDoc(), timers = fakeTimers();
  const card = mountArrival(doc as unknown as Document, 'Eden', false, timers.later);
  const root = doc.body.kids[0];
  assert.equal(root.attrs.role, 'status');
  const text = root.kids[1], title = text.kids[0], bar = text.kids[1], reason = text.kids[2];
  assert.equal(title.textContent, 'Eden');
  assert.equal(bar.value, Math.round(STAGES.begun * 1000));
  const s0 = Number(root.kids[0].vars['--s']);
  card.reach('snapshot');
  assert.ok(Number(root.kids[0].vars['--s']) > s0, 'the light grows');
  card.fail('<b>no</b> stream');
  assert.equal(root.dataset.state, 'failed');
  assert.equal(reason.textContent, '<b>no</b> stream', 'set as text, never markup');
  card.reach('drawn');
  assert.equal(root.dataset.state, 'dissolving');
  assert.equal(timers.pending.size, 1);
  card.reach('part'); card.reach('drawn');
  assert.equal(timers.pending.size, 1, 'one dissolve, however many parts follow');
  timers.run();
  assert.equal(card.state, 'gone');
  assert.equal(doc.body.kids.length, 0, 'the card is out of the page');
  assert.equal(doc.head.kids.length, 0, 'and its style');
  assert.equal(timers.pending.size, 0, 'no timer left behind');
  card.reach('part');
  assert.equal(timers.pending.size, 0);
  assert.ok(DISSOLVE_MS > 0);
});

test('a ?shot page never shows the card', () => {
  const doc = fakeDoc(), timers = fakeTimers();
  const card = mountArrival(doc as unknown as Document, 'Eden', true, timers.later);
  card.reach('drawn');
  card.fail('x');
  assert.equal(doc.body.kids.length + doc.head.kids.length + timers.pending.size, 0);
  assert.equal(card.state, 'gone');
});
