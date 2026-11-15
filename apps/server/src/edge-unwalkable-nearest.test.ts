// #2452 A1 (m4-hamlet-v1 score, finding 1): "go into the pond" sent as walk:g-pond is refused place.unwalkable. The refusal
// told the agent to refresh capabilities, which changes nothing (it ran catalog --refresh and a swim search, both useless).
// It now names the nearest place a walk reaches, the pond's bank, as `next`, and that walk is taken. Hello-hamlet, real genesis.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {accept} from '../test/native-owner-fixture.ts';

const hamlet = new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url);
type Act = {accepted?: boolean; code?: string; reason?: string; next?: string; receipt?: {id: string; capability: string}};

test('#2452 A1: a walk into the pond is refused naming its bank, never "refresh"; the bank\'s walk is taken', {timeout: 300000}, async t => {
  const w = await bootEden(() => {}, hamlet); t.after(w.close);
  const no = await w.edge.act(w.soul, {capability: 'walk:g-pond'}) as Act;
  assert.equal(no.accepted, false); assert.equal(no.code, 'place.unwalkable', JSON.stringify(no));
  assert.doesNotMatch(no.reason!, /refresh/, 'refreshing changes nothing here');
  assert.match(no.reason!, /the nearest place one reaches is Hamlet Pond bank \(walk:pond\)/);
  assert.equal(no.next, 'walk:pond');
  // the act find now gives the pond's row (its bank, by id) and the world's `next` both walk to the bank
  for (const capability of ['walk:g-pond.shore-bank', no.next!]) {
    const yes = await accept(w.host, Promise.resolve(w.edge.act(w.soul, {capability}))) as Act;
    assert.equal(yes.accepted, true, `${capability}: ${JSON.stringify(yes)}`);
  }
});
