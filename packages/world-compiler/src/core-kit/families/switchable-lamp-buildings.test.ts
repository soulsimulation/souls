// #2953: the switchable-lamp building revisions are pinned; a change here is a new revision and a new supplement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { coreLibrary } from '../../library.ts';

const PINNED: [string, string, string][] = [
  ['core/house@3', 'core/house@4', '880e9d2d18be43c048ff0a21f77f150fd04df6fb21827d75ebfd94992e826faf'],
  ['core/church@3', 'core/church@4', '0a2ded19f23cc081f901bcbd0d45e18824cf0ce209469a5ec7b4b568b414b4c8'],
];
const lampless = (d: unknown) => JSON.stringify({ ...(d as object), version: 0, ref: 0, hash: 0, description: 0,
  contents: (d as { contents: { def: string }[] }).contents.map((c) => ({ ...c, def: c.def.replace('core/floor-lamp@2', 'core/floor-lamp@1') })) });

test('switchable-lamp revisions: pinned bytes, every floor lamp on core/floor-lamp@2, nothing else changed', () => {
  const library = coreLibrary();
  for (const [from, ref, hash] of PINNED) {
    const old = library.get(from)!, d = library.get(ref)!;
    assert.equal(d.hash, hash, `${ref} keeps its bytes`);
    const lamps = d.contents!.filter((c) => c.def.startsWith('core/floor-lamp@'));
    assert.ok(lamps.length > 0 && lamps.every((c) => c.def === 'core/floor-lamp@2'), `${ref} places only the switchable lamp`);
    assert.equal(lampless(d), lampless(old), `${ref} is ${from} apart from its lamps`);
  }
});
