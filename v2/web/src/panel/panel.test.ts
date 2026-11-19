// node --test v2/web/src/panel/panel.test.ts: the creator's panel (W5, #2801). Its edits are G1's intent byte for byte
// (replica's golden), a drag sends one edit on release and none while it is held (A3), the ghost is the page's alone
// (A5: no frame leaves while dragging, so nothing can enter the log), and a build-safety refusal is listed with the Soul
// it names (A2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode } from 'cborg';
import { editIntent, idOf, opValue, readFrame, type Op, type Version } from './edit.ts';
import { CreatorSession } from './session.ts';
import { Drag, refusalText, type Body } from './drag.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const ee = new Uint8Array(16).fill(0xee);

// v2/crates/replica/fixtures/intents/goldens.txt, `edit`: a creator's batch of a place, a move of the thing it
// placed (by its name in the batch), a set and a remove.
const GOLDEN = 'a601a20102028250c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c001026a736f756c733a6564697404a10184a601010201036b736f756c733a6372617465045822122090fbc4c3f786f2765b16b6014480381b4618c4ff6a429d4873ef92cf68440426058250eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0306a301831a000f4240000002841a4000000000000003a10100a30102020103a301831a001e8480000002841a4000000000000003a10100a40103020103010407a2010402010501068450eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee8250eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0001182a071a03938700';
const place: Op = {
  op: 'place', name: 1, parent: `${'ee'.repeat(16)}.3`, at: { x: 1_000_000, y: 0, z: 0 },
  kind: 'souls:crate@122090fbc4c3f786f2765b16b6014480381b4618c4ff6a429d4873ef92cf68440426',
};
const move: Op = { op: 'move', node: 1, at: { x: 2_000_000, y: 0, z: 0 } };
const basis: Version = [ee, [ee, 0], 1, 42];
const creator = idOf(`${'c0'.repeat(16)}-1`);

test('an edit is G1\'s intent in T0\'s bytes: the golden\'s place and move, and the rest of its intent', () => {
  for (const o of [place, move]) assert.ok(GOLDEN.includes(hex(encode(opValue(o)))), `${o.op} is in the golden`);
  const mine = decode(editIntent(creator, 1, basis, [place, move], 60_000_000), { useMaps: true }) as Map<number, unknown>;
  const golden = decode(Buffer.from(GOLDEN, 'hex'), { useMaps: true }) as Map<number, unknown>;
  (golden.get(4) as Map<number, unknown[]>).get(1)!.splice(2);
  assert.equal(hex(encode(mine)), hex(encode(golden)));
});

/** A gateway stand-in: what the page sent, and answers as the world gives them. */
function signedIn() {
  const out: Uint8Array[] = [];
  const s = new CreatorSession({ send: (b) => void out.push(b) }, creator, Uint8Array.of(1), Uint8Array.of(2), 1000);
  s.frame(Uint8Array.of(0)); // the gateway's first frame
  s.frame(encode(new Map([[4, 'stream.started']])));
  assert.equal(s.state, 'open');
  out.length = 0;
  return { s, out };
}
const answer = (sequence: number, kind: number, extra: [number, unknown][] = [], at = 7) =>
  encode(new Map<number, unknown>([[1, [ee, [ee, 0], 1, at]], [2, new Map<number, unknown>([[1, new Map([[1, 2]])], [2, sequence], [3, kind], ...extra])]]));

test('A3, A5: a drag draws its ghost here, sends nothing while held, and one edit on release', async () => {
  const { s, out } = signedIn();
  const bodies: Body[] = [{ id: '2b.2', name: null, at: { x: 0, z: 0 } }];
  const drag = new Drag((id, at) => void s.edit([{ op: 'move', node: id, at: { x: at.x * 1e6, y: 0, z: at.z * 1e6 } }]), () => bodies);
  drag.down(`${'2b'.repeat(16)}.5`, { x: 3, z: 0 });
  for (let i = 1; i <= 60; i++) {
    drag.move({ x: 3 - i * 0.05, z: 0 });
    assert.equal(out.length, 0, 'no frame leaves the page while the drag is held');
  }
  assert.deepEqual(drag.ghost?.at, { x: 0, z: 0 });
  assert.equal(drag.ghost?.over?.id, '2b.2', 'the ghost over a Soul is warned of, here');
  assert.equal(s.sent, 0);
  assert.equal(drag.up(), true);
  assert.equal(s.sent, 1);
  assert.equal(out.length, 1, 'one edit on release');
  const sent = decode(out[0]!, { useMaps: true }) as Map<number, unknown>;
  assert.equal(sent.get(2), 'souls:edit');
  assert.equal(sent.get(5), 1000);
  // A drag let go of (Escape, the pointer lost) sends nothing.
  drag.down(`${'2b'.repeat(16)}.5`, { x: 1, z: 0 });
  drag.move({ x: 2, z: 0 });
  drag.cancel();
  assert.equal(drag.up(), false);
  assert.equal(out.length, 1);
});

test('answers: a receipt maps names to ids and moves the basis on; the next edit is planned against it', async () => {
  const { s, out } = signedIn();
  const got = s.edit([place]);
  s.frame(answer(1000, 1, [[4, [ee, 9]], [6, new Map([[1, [ee, 12]]])]], 9));
  const f = await got;
  assert.equal(f.t, 'receipt');
  assert.equal(f.t === 'receipt' && f.names.get(1), `${'ee'.repeat(16)}.12`);
  void s.edit([move]);
  const next = decode(out[1]!, { useMaps: true }) as Map<number, unknown>;
  assert.equal((next.get(6) as unknown[])[3], 9);
  assert.equal(next.get(5), 1001, 'a sequence is never reused');
});

test('A2: a build-safety refusal is listed by its name with the Soul it is about; others by name alone', () => {
  const f = readFrame(answer(5, 2, [[4, 'edit.would-bury'], [5, [ee, [ee, 0], 1, 7]]]));
  assert.deepEqual(f.t === 'refused' && [f.reason, f.sequence], ['edit.would-bury', 5]);
  const bodies: Body[] = [{ id: '2b.2', name: null, at: { x: 0, z: 0 } }, { id: '2b.9', name: 'Ada', at: { x: 5, z: 0 } }];
  assert.equal(refusalText('edit.would-bury', { x: 0.2, z: 0 }, bodies), 'refused edit.would-bury: Soul 2');
  assert.equal(refusalText('edit.in-use', { x: 5, z: 0.3 }, bodies), 'refused edit.in-use: Soul Ada');
  assert.equal(refusalText('edit.stale', { x: 0, z: 0 }, bodies), 'refused edit.stale');
});

test('a refused sign-in leaves the panel shut and sends no edit', async () => {
  const out: Uint8Array[] = [];
  const s = new CreatorSession({ send: (b) => void out.push(b) }, creator, Uint8Array.of(1), Uint8Array.of(2), 1);
  s.frame(Uint8Array.of(0));
  s.frame(encode(new Map([[4, 'token.refused']])));
  assert.equal(s.state, 'refused');
  await assert.rejects(s.edit([place]));
  assert.equal(out.length, 2);
});
