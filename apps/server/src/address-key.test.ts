// #2543 A1: the one helper that decides what "the same address" means.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressKey, forwardedAddress } from './address-key.ts';

test('IPv4 is the address itself, never widened', () => {
  assert.equal(addressKey('198.51.100.8'), '198.51.100.8');
  assert.equal(addressKey(' 198.51.100.8 '), '198.51.100.8');
  assert.notEqual(addressKey('198.51.100.8'), addressKey('198.51.100.9'));
});

test('IPv6 counts by its /64, however it is written', () => {
  assert.equal(addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(addressKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(addressKey('2001:DB8:0001:0002:0:0:0:ffff'), '2001:db8:1:2::/64');
  assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(addressKey('::1'), '0:0:0:0::/64');
  assert.equal(addressKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(addressKey('2001:db8:1:2:3:4:192.0.2.1'), '2001:db8:1:2::/64');
  assert.notEqual(addressKey('2001:db8:1:2::1'), addressKey('2001:db8:1:3::1'), 'another /64 is another address');
});

test('an IPv4-mapped IPv6 address is the IPv4 address it carries', () => {
  assert.equal(addressKey('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(addressKey('::FFFF:198.51.100.8'), '198.51.100.8');
  assert.equal(addressKey('::ffff:c633:6408'), '198.51.100.8');
  assert.equal(addressKey('0:0:0:0:0:ffff:198.51.100.8'), '198.51.100.8');
});

test('a list is keyed on its first entry, or its nearest hop when asked', () => {
  assert.equal(addressKey('198.51.100.8, 203.0.113.5'), '198.51.100.8');
  assert.equal(addressKey('2001:db8:1:2::9,198.51.100.8'), '2001:db8:1:2::/64');
  assert.equal(addressKey(['198.51.100.8, 203.0.113.5', '192.0.2.1']), '198.51.100.8');
  assert.equal(addressKey('fake-one, 198.51.100.8', { hop: 'last' }), '198.51.100.8');
  assert.equal(addressKey(' , 198.51.100.8'), '198.51.100.8', 'empty entries are skipped');
  assert.equal(forwardedAddress(' 2001:db8:1:2::9 , 198.51.100.8'), '2001:db8:1:2::9', 'the address itself, before keying');
});

test('garbage is keyed as it is, trimmed; an empty value has none', () => {
  for (const g of ['unknown', 'fake-one', '1.2.3', '1.2.3.4.5', '2001:db8::1::2', ':::', 'x'.repeat(500)]) assert.equal(addressKey(` ${g} `), g, g);
  for (const e of [undefined, null, '', ' , ', []]) assert.equal(addressKey(e), null);
});

// A2: every per-address limit keys through addressKey; no other site parses x-forwarded-for itself.
test('no site parses a forwarded address by itself', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('../../../', import.meta.url).pathname;
  const sites = ['tools/world-launcher/flood.mjs', 'tools/world-launcher/launcher.mjs', 'apps/server/src/hub.ts', 'apps/server/src/http.ts',
    'apps/server/src/flood.ts', 'apps/server/src/welcome.ts', 'apps/server/src/edge/comms/index.ts'];
  for (const f of sites) assert.match(readFileSync(join(root, f), 'utf8'), /import \{ ?addressKey(, forwardedAddress)? ?\} from '[./]+(apps\/server\/src\/)?address-key\.ts'/, `${f} imports addressKey`);
  const files = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => e.isDirectory()
    ? (e.name === 'node_modules' ? [] : files(join(dir, e.name)))
    : /\.(ts|mjs)$/.test(e.name) && !/\.test\.(ts|mjs)$/.test(e.name) && e.name !== 'address-key.ts' ? [join(dir, e.name)] : []);
  const parsing = /(x-forwarded-for|xff)\b[^\n]*\.(split|trim)\(/i;
  const offenders = [...files('apps/server/src'), ...files('tools/world-launcher')]
    .flatMap((f) => readFileSync(join(root, f), 'utf8').split('\n').map((l, i) => [f, i + 1, l] as const).filter(([, , l]) => parsing.test(l)))
    .map(([f, n]) => `${f}:${n}`);
  assert.deepEqual(offenders, [], 'parse the address with addressKey instead');
});
