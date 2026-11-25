// First day (25 Nov): the navbar of a new-engine world's page lists the person's Souls on this world from the
// directory's `/v1/account/souls`, arriving ones too (MySouls.tsx).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
Object.assign(globalThis, { location: { origin: 'http://localhost:5960', pathname: '/w/eden/', search: '', hash: '', href: 'http://localhost:5960/w/eden/' } });
const { accountSoulsOf } = await import('./owner-mailbox.ts');

test('the navbar lists this world\'s Souls, named, and none from another world', () => {
  const grant = `soul-${'ab'.repeat(16)}-1`, other = `soul-${'cd'.repeat(16)}-2`;
  const id = (g: string) => `s_${g.replace(/^soul-/, '')}`;
  const rows = { souls: [{ soul: grant, world: 'eden', name: ' Wren ' }, { soul: other, world: 'mars', name: 'Elsewhere' }, { soul: `creator-${'ab'.repeat(16)}-1`, world: 'eden' }] };
  assert.deepEqual(accountSoulsOf(rows, 'eden', id), [{ id: id(grant), name: 'Wren' }]);
  assert.deepEqual(accountSoulsOf({ souls: [{ soul: grant, world: 'eden', name: null }] }, 'eden', id), [{ id: id(grant), name: null }]);
});

test('the engine\'s name for the world comes from the page\'s stream, not its slug', async () => {
  const { v2WorldName } = await import('./owner-mailbox.ts');
  assert.equal(v2WorldName('/s/w/eden/views/ab/ab-0/0/ab-0/1/everyone/'), 'eden');
  assert.equal(v2WorldName('/s/other/'), null);
  assert.equal(v2WorldName(null), null);
});
