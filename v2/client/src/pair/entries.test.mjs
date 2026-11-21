// #3760: a paired client keeps the world's kind entries in `<home>/kinds/`, fetched from the gateway once per change.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { entriesOf, refreshEntries } from './pair.mjs';
import { kindsIn } from '../check/state.mjs';

test('the entries address is the socket address\'s, over http(s)', () => {
  assert.equal(entriesOf('ws://127.0.0.1:7/v2/ws'), 'http://127.0.0.1:7/v2/entries');
  assert.equal(entriesOf('wss://soul.example.test/preview/w/eden/v2/ws'), 'https://soul.example.test/preview/w/eden/v2/entries');
});

test('entries are written where the checks read them, revalidated by tag, and replaced on a change', async () => {
  let list = [{ format: 'souls-entry/1', kind: 'eden:bench', owner: 'thing', forms: { sit: {} } }, { format: 'souls-entry/1', kind: 'core:humanoid', owner: 'family' }];
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ auth: req.headers.authorization, tag: req.headers['if-none-match'] ?? null });
    if (req.url !== '/v2/entries' || req.headers.authorization !== 'Bearer t0k') { res.writeHead(401).end('{"refused":"token.refused"}'); return; }
    const raw = JSON.stringify(list), tag = `"${createHash('sha256').update(raw).digest('hex')}"`;
    if (req.headers['if-none-match'] === tag) { res.writeHead(304, { etag: tag }).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', etag: tag }).end(gzipSync(raw));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = mkdtempSync(join(tmpdir(), 'entries-')), gateway = `ws://127.0.0.1:${server.address().port}/v2/ws`;
  try {
    writeFileSync(join(home, 'keep'), ''); // something of the owner's beside it is left alone
    assert.deepEqual(await refreshEntries({ home, world: 'eden', gateway, token: 't0k' }), { entries: 2, changed: true });
    assert.deepEqual(Object.keys(kindsIn(join(home, 'kinds'))).sort(), ['core:humanoid', 'eden:bench']);
    assert.deepEqual(await refreshEntries({ home, world: 'eden', gateway, token: 't0k' }), { entries: 2, changed: false });
    assert.ok(seen[1].tag, 'the second fetch sent the kept tag');

    list = [list[0], { format: 'souls-entry/1', kind: 'eden:lamp', owner: 'thing' }];
    assert.deepEqual(await refreshEntries({ home, world: 'eden', gateway, token: 't0k' }), { entries: 2, changed: true });
    assert.deepEqual(Object.keys(kindsIn(join(home, 'kinds'))).sort(), ['eden:bench', 'eden:lamp'], 'an entry the world dropped is removed');

    unlinkSync(join(home, 'kinds', 'eden.lamp.json'));
    assert.equal((await refreshEntries({ home, world: 'eden', gateway, token: 't0k' })).changed, true, 'a file gone is fetched again');
    assert.ok(existsSync(join(home, 'kinds', 'eden.lamp.json')));

    await assert.rejects(refreshEntries({ home, world: 'eden', gateway, token: 'other' }), { code: 'token.refused' });
    assert.ok(readdirSync(join(home, 'kinds')).every((f) => !f.endsWith('.tmp')));
    assert.equal(JSON.parse(readFileSync(join(home, 'kinds', '.entries-eden.json'), 'utf8')).files.length, 2);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
