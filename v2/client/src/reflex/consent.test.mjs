// Standing consent (Engine v2 E8, #2779, A3): the rule accepts a matching offer with no model turn, and with the
// client stopped nothing answers (the engine's lapse is v2/crates/sim/src/activity/tests/offers.rs).

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Table } from './reflex.mjs';
import { ACCEPT, OFFER, consentRule } from './consent.mjs';

const ME = 's_me', ADA = 's_ada', BO = 's_bo';
const T0 = Date.parse('2026-11-18T10:00:00Z');
const HIGH_FIVE = 'souls:high-five@1220aa';
// The offer as the engine writes it, as the daemon reads it from a frame.
const offer = (from, kind, id, toMe = true) => ({ name: OFFER, fields: { 1: id, 2: kind, 4: 60_000_000 }, actor: from, toMe, sequence: 1 });

test('A3: a standing consent accepts a matching offer with no model turn, and nothing else', () => {
  const t = new Table(ME);
  const r = t.add(consentRule({ kind: HIGH_FIVE, from: [ADA], expires: 3600 }), T0);
  assert.deepEqual(t.onEvent(offer(ADA, HIGH_FIVE, 'o1'), T0), [{ rule: r.id, intent: { verb: ACCEPT, target: 'o1' } }]);
  assert.deepEqual(t.onEvent(offer(BO, HIGH_FIVE, 'o2'), T0 + 2000), [], 'from a Soul it does not name');
  assert.deepEqual(t.onEvent(offer(ADA, 'souls:hug@1220bb', 'o3'), T0 + 4000), [], 'an offer of another kind');
  assert.deepEqual(t.onEvent(offer(ADA, HIGH_FIVE, 'o4', false), T0 + 6000), [], 'an offer to someone else');
  assert.deepEqual(t.onEvent(offer(ADA, HIGH_FIVE, 'o5'), T0 + 3600_000), [], 'expired');
  // Listed and removable like every reflex.
  const u = new Table(ME);
  const c = u.add(consentRule({ kind: HIGH_FIVE, from: [ADA], expires: 60 }), T0);
  assert.equal(u.list(T0).length, 1);
  u.remove(c.id);
  assert.deepEqual(u.onEvent(offer(ADA, HIGH_FIVE, 'o6'), T0), [], 'cancelled');
  // Narrow and expiring: a consent names a kind and its Souls, and every rule expires.
  assert.throws(() => consentRule({ kind: HIGH_FIVE, from: [], expires: 60 }), { code: 'consent-from-none' });
  assert.throws(() => consentRule({ from: [ADA], expires: 60 }), { code: 'consent-kind-not-a-name' });
  assert.throws(() => t.add(consentRule({ kind: HIGH_FIVE, from: [ADA] }), T0), { code: 'reflex-without-expiry' });
});
