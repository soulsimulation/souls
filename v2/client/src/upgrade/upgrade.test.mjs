// R18 (#2821): after the upgrade, the memory reads old ids as "formerly". Two Souls of today's client, each with days of
// memory written by the shipping line's own writer (the way today's client writes it), come across through the frozen
// world's pairing; the v2 client's reading (R14's `knownThrough`) shows the other Soul by its new id and anyone the
// table does not name as "formerly <id>". The home is under the repository's ignored .local/.

import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openSoulMemory as shippingMemory } from '../../../../tools/world-launcher/soul/memory.mjs';
import { frozenWorld } from '../../test/compat/frozen-world.mjs';
import { knownThrough, readAliases, soulDirOf } from '../memory/memory.mjs';
import { formerSouls, rollbackHome, upgradeHome } from './upgrade.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const home = join(repo, '.local', `r18-${randomBytes(4).toString('hex')}`, '.souls');
after(() => rmSync(dirname(home), { recursive: true, force: true }));
const DAY = 86_400_000, START = Date.parse('2026-10-15T08:00:00.000Z');

test('A2: old ids read as "formerly" after the upgrade; the other Soul reads by its new id', async (t) => {
  const grant = () => `soul-${randomBytes(16).toString('hex')}-0`;
  const imported = { eden: { s_ada: { account: 'a1', grant: grant() }, s_bo: { account: 'a1', grant: grant() } } };
  const w = await frozenWorld({ imported });
  t.after(() => w.close());
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, client: '3.0.0', previousClient: '2.36.2', worlds: { eden: { url: w.url } },
    souls: { s_ada: { name: 'Ada', world: 'eden', state: 'active' }, s_bo: { name: 'Bo', world: 'eden', state: 'active' } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ version: 1, souls: { s_ada: { eden: { token: 'sim_a' } }, s_bo: { eden: { token: 'sim_b' } } } }), { mode: 0o600 });
  // Ada meets Bo (a Soul of this home) and Cal (one it never names) at the cafe, over five days.
  let clock = START;
  const mem = shippingMemory(soulDirOf(home, 's_ada'), { world: 'eden', soul: 's_ada', name: 'Ada', now: () => new Date(clock).toISOString() });
  for (let day = 0; day < 5; day++) {
    clock = START + day * DAY;
    const where = { placeId: 'cafe', place: 'Cafe' };
    mem.sawEvents([['s_bo', 'Bo'], ['s_cal', 'Cal']].map(([soulId, name], k) => ({ kind: 'approach', at: clock + k, tick: day * 10 + k + 1, from: { soulId, name }, where })));
  }
  assert.deepEqual(formerSouls(home).map((s) => s.old), ['s_ada', 's_bo']);

  const asks = [];
  const crossing = upgradeHome({ home, onAsk: (a) => { asks.push(a); w.approve(a.code, 'a1'); } });
  const { souls } = await crossing;
  assert.equal(asks.length, 2);
  const bo = souls.find((s) => s.formerly === 's_bo').soul;
  const known = knownThrough(soulDirOf(home, souls.find((s) => s.formerly === 's_ada').soul), { aliases: readAliases(home) });
  assert.deepEqual(known.people.map(({ id, name, was, formerly, shown }) => ({ id, name, was, formerly, shown })).sort((a, b) => a.name.localeCompare(b.name)), [
    { id: bo, name: 'Bo', was: 's_bo', formerly: undefined, shown: undefined },
    { id: 's_cal', name: 'Cal', was: undefined, formerly: true, shown: 'Cal (formerly s_cal)' },
  ]);
  assert.deepEqual(formerSouls(home), [], 'nothing left to bring across');

  // A rollback refuses with no kept client, and changes nothing.
  assert.throws(() => rollbackHome(home), { code: 'nothing-to-roll-back' });
});
