// First day (25 Nov): the navbar of a new-engine world's page lists the person's Souls on this world from the
// directory's `/v1/account/souls`, arriving ones too (MySouls.tsx).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
Object.assign(globalThis, { location: { origin: 'http://localhost:5960', pathname: '/w/eden/', search: '', hash: '', href: 'http://localhost:5960/w/eden/' } });
const { accountSoulsOf, retireByDirectory } = await import('./owner-mailbox.ts');

test('the navbar lists this world\'s Souls, named, and none from another world', () => {
  const grant = `soul-${'ab'.repeat(16)}-1`, other = `soul-${'cd'.repeat(16)}-2`;
  const id = (g: string) => `s_${g.replace(/^soul-/, '')}`;
  const rows = { souls: [{ soul: grant, world: 'eden', name: ' Wren ' }, { soul: other, world: 'mars', name: 'Elsewhere' }, { soul: `creator-${'ab'.repeat(16)}-1`, world: 'eden' }] };
  assert.deepEqual(accountSoulsOf(rows, 'eden', id), [{ id: id(grant), name: 'Wren' }]);
  assert.deepEqual(accountSoulsOf({ souls: [{ soul: grant, world: 'eden', name: null }] }, 'eden', id), [{ id: id(grant), name: null }]);
});

test('the engine\'s name for the world is the launcher\'s, else the page\'s slug, never the stream\'s folder', async () => {
  const { v2WorldName } = await import('./owner-mailbox.ts');
  // soul.game's Eden (0.136.0): the stream's folder is the world's id, 67 characters, and the directory knows the world as
  // `eden`; reading the folder gave no name, so the navbar asked for no Souls (first day, 25 Nov)
  const id = '9eb7c3f6f6d48e1621571a4aacfa9688', prod = `/s/w/${id}-${id}-0/views/${id}/${id}-0/0/${id}-0/1/everyone/`;
  assert.equal(v2WorldName(prod, {}, 'eden'), 'eden');
  assert.equal(v2WorldName(prod, { v2World: 'eden' }, 'toy'), 'eden', 'the launcher names it');
  assert.equal(v2WorldName(prod, { v2World: '../x' }, 'eden'), 'eden', 'a malformed name is not taken');
  assert.equal(v2WorldName('/s/w/eden/views/ab/ab-0/0/ab-0/1/everyone/', undefined, 'eden'), 'eden', 'the local stack: folder and slug agree');
  assert.equal(v2WorldName(prod), 'eden', 'this page (/w/eden/)');
  assert.equal(v2WorldName(null, { v2World: 'eden' }, 'eden'), null, 'an old-engine world');
});

test('the card retires the person\'s Soul through the directory, by its grant, confirmed (0.137)', async () => {
  const grant = `soul-${'ab'.repeat(16)}-1`, other = `soul-${'cd'.repeat(16)}-2`;
  const id = (g: string) => `s_${g.replace(/^soul-/, '')}`;
  const sent: [string, Record<string, unknown>][] = [];
  let retired: { status: number; body: unknown } = { status: 200, body: { ok: true, soul: grant } };
  const call = async (path: string, body: Record<string, unknown>) => { sent.push([path, body]);
    return path === '/v1/account/souls' ? { status: 200, body: { souls: [{ soul: other, world: 'eden' }, { soul: grant, world: 'eden', retire_asked: true }] } } : retired; };
  assert.equal(await retireByDirectory(id(grant), call, id), true);
  assert.deepEqual(sent, [['/v1/account/souls', {}], ['/v1/account/souls/retire', { soul: grant, confirm: true }]]);
  // Not on the person's list: nothing is retired.
  sent.length = 0;
  assert.equal(await retireByDirectory('s_nobody', call, id), false);
  assert.deepEqual(sent.map(([p]) => p), ['/v1/account/souls']);
  // Refused, or no one signed in: not done.
  retired = { status: 404, body: { refused: 'not-yours' } };
  assert.equal(await retireByDirectory(id(grant), call, id), false);
  assert.equal(await retireByDirectory(id(grant), async () => null, id), false);
  // The agent's ask (`souls retire`) shows on the list the card reads, which opens the question there.
  assert.deepEqual(accountSoulsOf({ souls: [{ soul: grant, world: 'eden', name: 'Fern', retire_asked: true }] }, 'eden', id), [{ id: id(grant), name: 'Fern', retireAsked: true }]);
});
