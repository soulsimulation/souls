// #3760: a paired client keeps the world's kind entries in `<home>/kinds/`, fetched from the gateway once per change.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { activitiesServed, entriesOf, refreshEntries, refreshKindsText } from './pair.mjs';
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
    assert.deepEqual(await refreshEntries({ home, world: 'eden', gateway, token: 't0k' }), { entries: 2, changed: true, written: 2 });
    assert.deepEqual(Object.keys(kindsIn(join(home, 'kinds'))).sort(), ['core:humanoid', 'eden:bench']);
    assert.deepEqual(await refreshEntries({ home, world: 'eden', gateway, token: 't0k' }), { entries: 2, changed: false });
    assert.ok(seen[1].tag, 'the second fetch sent the kept tag');

    list = [list[0], { format: 'souls-entry/1', kind: 'eden:lamp', owner: 'thing' }];
    // One entry new: only it is written; the unchanged one is left as it is (first run: a new daemon's re-fetch).
    assert.deepEqual(await refreshEntries({ home, world: 'eden', gateway, token: 't0k' }), { entries: 2, changed: true, written: 1 });
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

test('the served activities are kept beside the entries; a mark from before them, or a lost activities file, fetches again', async () => {
  const served = { format: 'souls-activities/1', activities: [{ kind: 'eden:hug', name: 'eden:hug_activity@1220ab', word: 'hug', offerer: 'eden:one', asks: 1 }] };
  const list = [{ format: 'souls-entry/1', kind: 'eden:hug', owner: 'thing' }, served];
  const seen = [];
  const raw = JSON.stringify(list), tag = `"${createHash('sha256').update(raw).digest('hex')}"`;
  const server = createServer((req, res) => {
    seen.push(req.headers['if-none-match'] ?? null);
    if (req.headers['if-none-match'] === tag) { res.writeHead(304, { etag: tag }).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', etag: tag }).end(gzipSync(raw));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = mkdtempSync(join(tmpdir(), 'entries-')), gateway = `ws://127.0.0.1:${server.address().port}/v2/ws`;
  const at = join(home, 'kinds', '.activities-eden.json'), mark = join(home, 'kinds', '.entries-eden.json');
  try {
    // An upgraded client: its mark (written before activities were kept) holds this very tag and no `activities`.
    mkdirSync(join(home, 'kinds'), { recursive: true });
    writeFileSync(join(home, 'kinds', 'eden.hug.json'), JSON.stringify(list[0]));
    writeFileSync(mark, JSON.stringify({ etag: tag, files: ['eden.hug.json'] }));
    assert.equal((await refreshEntries({ home, world: 'eden', gateway, token: 't' })).changed, true, 'no 304 on the old mark');
    assert.equal(seen.at(-1), null, 'the old tag was not sent');
    assert.deepEqual(activitiesServed(home, 'eden'), served);
    assert.equal(JSON.parse(readFileSync(mark, 'utf8')).activities, true);
    assert.equal((await refreshEntries({ home, world: 'eden', gateway, token: 't' })).changed, false, 'then revalidated by its tag');
    unlinkSync(at);
    assert.equal((await refreshEntries({ home, world: 'eden', gateway, token: 't' })).changed, true, 'its activities file gone: fetched again');
    assert.deepEqual(activitiesServed(home, 'eden'), served);
    assert.ok(readdirSync(join(home, 'kinds')).every((f) => !f.endsWith('.tmp')));
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('#1960: a creator keeps the world\'s kinds text where its checks read it, revalidated by tag', async () => {
  let text = '{1: "eden:bench", 2: "thing"}\n';
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, tag: req.headers['if-none-match'] ?? null });
    if (req.url !== '/v2/kinds' || req.headers.authorization !== 'Bearer t0k') { res.writeHead(401).end('{"refused":"token.refused"}'); return; }
    const tag = `"${createHash('sha256').update(text).digest('hex')}"`;
    if (req.headers['if-none-match'] === tag) { res.writeHead(304, { etag: tag }).end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', etag: tag }).end(gzipSync(text));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = mkdtempSync(join(tmpdir(), 'kinds-')), gateway = `ws://127.0.0.1:${server.address().port}/v2/ws`;
  try {
    assert.deepEqual(await refreshKindsText({ home, world: 'eden', gateway, token: 't0k' }), { changed: true });
    assert.equal(readFileSync(join(home, 'kinds', 'eden.kinds'), 'utf8'), text);
    assert.deepEqual(await refreshKindsText({ home, world: 'eden', gateway, token: 't0k' }), { changed: false });
    assert.ok(seen[1].tag, 'the second fetch sent the kept tag');
    text += '# souls-boot-body eden:bench\n';
    assert.deepEqual(await refreshKindsText({ home, world: 'eden', gateway, token: 't0k' }), { changed: true });
    assert.equal(readFileSync(join(home, 'kinds', 'eden.kinds'), 'utf8'), text, 'a restarted world\'s new text replaces it');
    unlinkSync(join(home, 'kinds', 'eden.kinds'));
    assert.deepEqual(await refreshKindsText({ home, world: 'eden', gateway, token: 't0k' }), { changed: true }, 'a file gone is fetched again');
    await assert.rejects(refreshKindsText({ home, world: 'eden', gateway, token: 'other' }), { code: 'token.refused' });
    await assert.rejects(refreshKindsText({ home, world: '../x', gateway, token: 't0k' }), { code: 'kinds-world' });
    assert.deepEqual(Object.keys(kindsIn(join(home, 'kinds'))), [], 'the text is not read as an entry');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
