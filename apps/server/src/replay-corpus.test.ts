// Replay-compatibility corpus (#1395): every frozen log in apps/server/test/fixtures/replay-corpus refolds with this
// engine to its pinned state and kernel hashes, from genesis at each pinned tick and, as a restarting server boots it,
// from genesis and from its snapshot to its head. A log recorded before a runtime policy was adopted has no rules event
// for it, so a pin that moves means the policy changed history it never adopted. A deliberate change re-pins with
// `record.ts --write` in its own commit; a new policy adds an entry. docs/testing.md#replay-corpus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptedPolicies, bootHead, entries, readerFactory, readLog, readPins, refoldAt } from '../test/fixtures/replay-corpus/corpus.ts';

const names = entries();
const REPIN = '(a deliberate change re-pins with `node apps/server/test/fixtures/replay-corpus/record.ts --write <name>` in its own commit)';

test('the corpus has a toy world, a green-field god world with a world-edit and a Mars campus world with a body and a retire', () => {
  const kinds = (name: string) => new Set(readLog(name).events.map((e) => e.kind));
  const of = (recipe: string) => names.filter((n) => readPins(n).recipe === recipe);
  assert.ok(of('toy').length >= 1, 'a toy world');
  assert.ok(of('god-greenfield').some((n) => kinds(n).has('world-edit')), 'a god world with a world-edit');
  assert.ok(of('mars-campus').some((n) => ['decision', 'body-assignment-v1', 'retire'].every((k) => kinds(n).has(k as never))), 'a campus world with decisions, a body assignment and a retire');
});

for (const name of names) {
  test(`replay corpus: ${name} refolds to its pins`, async () => {
    const pins = readPins(name), log = readLog(name), factory = await readerFactory(pins.reader);
    assert.deepEqual(adoptedPolicies(log.events), pins.adopted, 'the log is frozen: its adopted policies are as pinned');
    for (const p of pins.pins) assert.deepEqual(refoldAt(factory, log, p.tick), { state: p.state, kernel: p.kernel }, `${name} from genesis at tick ${p.tick} (${p.note}) ${REPIN}`);
    const dir = mkdtempSync(join(tmpdir(), 'replay-corpus-'));
    try {
      const want = { tick: pins.head.tick, seq: pins.head.seq, state: pins.head.state, kernel: pins.head.kernel };
      for (const [withSnapshot, from] of [[false, 'genesis'], [true, 'snapshot']] as const) {
        const { from: got, ...head } = bootHead(factory, log, pins.worldId, join(dir, `${from}.db`), withSnapshot);
        assert.equal(got, from, `${name}: the boot came from its ${from}`);
        assert.deepEqual(head, want, `${name}: boot from ${from} to the head ${REPIN}`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
