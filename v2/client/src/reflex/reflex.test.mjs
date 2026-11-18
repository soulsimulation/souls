// The reflex table (Engine v2 R9, #2728) and the matcher it shares with R13 and R15. The 1,000-event run needs
// replica's wasm-bindgen package (SOULS_REPLICA_PKG, else v2/target/wasm-load/pkg) and is skipped without it;
// R9_REPORT=1 prints its delays, for the PR.

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { matches, parseWhen } from '../match/match.mjs';
import { reflexRequest } from '../cli/reflex.mjs';
import { DEFAULT_PKG } from '../daemon/client.mjs';
import { Table, parseReflex } from './reflex.mjs';

const ME = 's_me', ADA = 's_ada', BO = 's_bo';
const T0 = Date.parse('2026-11-18T10:00:00Z');
// B5's proposal event is not merged: a fixture event of the same shape, an offer with its id and its kind.
const offer = (from, kind, id = 'o1', sequence = 1) => ({ name: 'eden:offer', fields: { 1: id, 2: kind }, actor: from, toMe: true, sequence });
const jab = (from, sequence) => ({ name: 'eden:jab', fields: { 1: 'left' }, actor: from, toMe: true, sequence });
const block = { when: { event: 'eden:jab' }, send: { verb: 'eden:block' }, expires: 60, cooldown: 0, max: 1000 };

test('matcher: name, from, toMe and fields; an event this Soul caused never matches', () => {
  const p = parseWhen({ event: ['eden:offer', 'eden:wave'], from: [ADA], toMe: true, fields: { 2: 'eden:high-five' } });
  assert.ok(matches(p, offer(ADA, 'eden:high-five'), ME));
  assert.ok(!matches(p, offer(BO, 'eden:high-five'), ME));
  assert.ok(!matches(p, offer(ADA, 'eden:hug'), ME));
  assert.ok(!matches(p, { ...offer(ADA, 'eden:high-five'), toMe: false }, ME));
  assert.ok(!matches(p, { ...offer(ADA, 'eden:high-five'), name: 'eden:other' }, ME));
  assert.ok(!matches(parseWhen({ event: 'eden:offer' }), offer(ME, 'eden:high-five'), ME));
  for (const [bad, code] of [[{}, 'when-event-not-a-name'], [{ event: 'Offer' }, 'when-event-not-a-name'],
    [{ event: 'eden:offer', from: [] }, 'when-from-not-souls'], [{ event: 'eden:offer', who: 1 }, 'when-unknown-key'],
    [{ event: 'eden:offer', fields: { x: 1 } }, 'when-fields-not-values']]) {
    assert.throws(() => parseWhen(bad), { code });
  }
});

test('A2: a rule never fires on an event its own intent caused', () => {
  const t = new Table(ME);
  t.add(block, T0);
  assert.equal(t.onEvent(jab(ME, 1), T0).length, 0);
  assert.equal(t.onEvent(jab(ADA, 2), T0).length, 1);
});

test('A2: expiry, cool-down and count hold', () => {
  const t = new Table(ME);
  const r = t.add({ when: { event: 'eden:jab' }, send: { verb: 'eden:block' }, expires: 10, max: 3, cooldown: 500 }, T0);
  assert.equal(t.onEvent(jab(ADA, 1), T0).length, 1);
  assert.equal(t.onEvent(jab(ADA, 2), T0 + 499).length, 0, 'inside the cool-down');
  assert.equal(t.onEvent(jab(ADA, 3), T0 + 500).length, 1);
  assert.equal(t.onEvent(jab(ADA, 4), T0 + 1000).length, 1);
  assert.equal(t.onEvent(jab(ADA, 5), T0 + 1500).length, 0, 'spent: max 3');
  assert.equal(t.list(T0 + 1500).length, 0, 'a spent rule leaves the table');
  const e = new Table(ME);
  e.add({ ...block, expires: 10 }, T0);
  assert.equal(e.onEvent(jab(ADA, 1), T0 + 9999).length, 1);
  assert.equal(e.onEvent(jab(ADA, 2), T0 + 10000).length, 0, 'expired');
  assert.equal(r.fired, 3);
  // Defaults: a cool-down of a second and a count of 100; a rule with no expiry is refused.
  const d = parseReflex({ when: { event: 'eden:jab' }, send: { verb: 'eden:block' }, expires: 5 }, T0);
  assert.deepEqual([d.cooldown, d.max, d.expiresAt], [1000, 100, T0 + 5000]);
  assert.throws(() => parseReflex({ when: { event: 'eden:jab' }, send: { verb: 'eden:block' } }, T0), { code: 'reflex-without-expiry' });
  for (const bad of [{ expires: 0 }, { expires: 1.5 }, { max: 0 }, { cooldown: -1 }]) {
    assert.throws(() => parseReflex({ ...block, ...bad }, T0), /-not-a-count/);
  }
  assert.throws(() => t.remove('r9'), { code: 'reflex-not-found' });
});

test('A3: a standing consent joins the offer it matched, and nothing else', () => {
  const t = new Table(ME);
  t.add({ when: { event: 'eden:offer', from: [ADA], toMe: true, fields: { 2: 'eden:high-five' } },
    send: { verb: 'eden:join', target: '$field:1', parameters: { with: '$from' } }, expires: 3600, max: 5 }, T0);
  assert.deepEqual(t.onEvent(offer(ADA, 'eden:high-five', 'o42'), T0),
    [{ rule: 'r1', intent: { verb: 'eden:join', target: 'o42', parameters: { with: ADA } } }]);
  assert.deepEqual(t.onEvent(offer(ADA, 'eden:hug', 'o43'), T0 + 5000), [], 'an offer of another kind');
  assert.deepEqual(t.onEvent(offer(BO, 'eden:high-five', 'o44'), T0 + 5000), [], 'from a Soul it does not name');
  // A consent with no list of Souls is still refused without an expiry, like every rule.
  assert.throws(() => parseReflex({ when: { event: 'eden:offer' }, send: { verb: 'eden:join', target: '$field:1' } }, T0), { code: 'reflex-without-expiry' });
  assert.throws(() => parseReflex({ ...block, send: { verb: 'eden:join', target: '$who' } }, T0), { code: 'send-unknown-value' });
});

test('A4: each firing is shown once, in the next answer\'s changed', () => {
  const t = new Table(ME);
  assert.equal(t.op({ op: 'reflex', do: 'add', rule: block }, T0).added, 'r1');
  t.onEvent(jab(ADA, 7), T0);
  t.onEvent(jab(BO, 8), T0);
  assert.deepEqual(t.changed(), [
    { kind: 'reflex', rule: 'r1', event: 'eden:jab', sequence: 7, intent: { verb: 'eden:block' } },
    { kind: 'reflex', rule: 'r1', event: 'eden:jab', sequence: 8, intent: { verb: 'eden:block' } },
  ]);
  assert.deepEqual(t.changed(), []);
  assert.equal(t.op({ do: 'list' }, T0).reflexes[0].fired, 2);
  assert.deepEqual(t.op({ do: 'remove', id: 'r1' }, T0).reflexes, []);
});

test('the reflex command\'s arguments', () => {
  assert.deepEqual(reflexRequest([]), { op: 'reflex', do: 'list' });
  assert.deepEqual(reflexRequest(['remove', 'r2']), { op: 'reflex', do: 'remove', id: 'r2' });
  assert.deepEqual(reflexRequest(['add', JSON.stringify(block)]), { op: 'reflex', do: 'add', rule: block });
  assert.throws(() => reflexRequest(['add', '{']), /must be JSON/);
  assert.throws(() => reflexRequest(['nonsense']), /usage/);
});

const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
test('A1: 1,000 matching events send 1,000 intents, the daemon\'s own delay under 5 ms at p99, twice', { skip: !existsSync(join(PKG, 'replica.js')) && 'no replica package' }, async () => {
  const wire = await import(pathToFileURL(join(PKG, 'replica.js')).href);
  wire.initSync({ module: readFileSync(join(PKG, 'replica_bg.wasm')) });
  const scope = new Uint8Array(16).fill(7);
  for (const repeat of [1, 2]) {
    const t = new Table(ME);
    // The hall's load: other rules in the table that do not match.
    for (let k = 0; k < 50; k++) t.add({ when: { event: `eden:other-${k}` }, send: { verb: 'eden:wave' }, expires: 60 }, T0);
    t.add(block, T0);
    const delays = [];
    let sent = 0, sequence = 0;
    for (let i = 0; i < 1000; i++) {
      const event = jab(ADA, i + 1);
      const a = performance.now();
      for (const f of t.onEvent(event, T0 + i)) {
        // What the daemon does for each firing: build the intent's bytes through replica, as its `act` does.
        wire.wireIntent(scope, 7n, f.intent.verb, BigInt(++sequence), new Uint8Array(), BigInt(Number.MAX_SAFE_INTEGER), '');
        sent++;
      }
      delays.push(performance.now() - a);
    }
    delays.sort((x, y) => x - y);
    const p = (q) => delays[Math.min(delays.length - 1, Math.floor(q * delays.length))];
    if (process.env.R9_REPORT) console.log(JSON.stringify({ repeat, sent, model_turns: 0, p50_ms: +p(0.5).toFixed(4), p99_ms: +p(0.99).toFixed(4), max_ms: +delays.at(-1).toFixed(4) }));
    assert.equal(sent, 1000);
    assert.equal(t.changed().length, 1000);
    assert.ok(p(0.99) < 5, `p99 ${p(0.99)} ms`);
  }
});
