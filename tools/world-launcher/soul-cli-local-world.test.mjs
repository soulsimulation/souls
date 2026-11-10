// #1737: the world on this machine. `look` and `find` answer from the two files a Soul's folder keeps (the catalog by its
// tag, the live picture while fresh); a current copy costs the world nothing, a replaced catalog is fetched once, and a
// world that stops answering leaves the copy in use with a note.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const CLI = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));
const catalogOf = (version, bookName) => ({contract: 'soul-catalog/1', worldId: 'w1', scope: 'public', placeVerbs: ['walk'], anywhere: [{id: 'sit-ground:here', verb: 'sit-ground', label: 'Sit down on the ground or floor, right here'}],
  places: [{id: 'p_lib', name: 'The Library', kind: 'building', parent: 'p_town', at: [100, 0]}, {id: 'p_town', name: 'Town', kind: 'district', parent: null, at: [0, 0]}],
  things: [{id: 'e_book', name: bookName, kind: 'book', place: 'p_lib', at: [101, 1]}],
  acts: [{id: 'read:read.e_book', verb: 'read', place: 'p_lib', thing: 'e_book', at: [101, 1], label: `read (${bookName})`}],
  counts: {places: 2, things: 1, acts: 1, kinds: 1}, _v: version});

async function world(t) {
  const seen = [], dir = mkdtempSync(join(tmpdir(), 'eden-local-world-'));
  const state = {version: 'v1', book: 'Old Atlas', up: true, starting: 0};
  const server = createServer((req, res) => {
    const url = req.url.split('?')[0]; seen.push(url);
    if (!state.up) {res.writeHead(503, {'content-type': 'application/json'}); return res.end('{"error":{"code":"world.busy"}}');}
    if (url === '/v1/edge/catalog') {
      if (state.starting > 0) {state.starting--; res.writeHead(503, {'content-type': 'application/json', 'retry-after': '1'}); return res.end('{"error":{"code":"world.starting"}}');}
      const tag = `"${state.version}"`;
      if (req.headers['if-none-match'] === tag) {res.writeHead(304, {etag: tag}); return res.end();}
      res.writeHead(200, {'content-type': 'application/json', etag: tag}); return res.end(JSON.stringify(catalogOf(state.version, state.book)));
    }
    if (url === '/v1/edge/live') {
      res.writeHead(200, {'content-type': 'application/json'});
      return res.end(JSON.stringify({contract: 'soul-live/1', tick: 100, catalog: state.version,
        souls: [{id: 's_ada', name: 'Ada', at: [100, 0], place: 'p_lib', doing: null}, {id: 's_bo', name: 'Bo', at: [105, 0], place: 'p_lib', doing: 'reading'}],
        speech: [{id: 'sp_1', name: 'Bo', place: 'p_lib', at: Date.now(), text: 'quiet please', untrusted: true}]}));
    }
    res.writeHead(404, {'content-type': 'application/json'}); res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, {recursive: true, force: true});});
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: `http://127.0.0.1:${server.address().port}`, soul: 's_ada', token: 'tok'}));
  const cli = (...args) => new Promise(res => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (e, out, err) => {let json = null; try {json = JSON.parse(out);} catch {/* words */} res({code: e?.code ?? 0, json, err});}));
  return {seen, cli, state};
}

test('look and find answer from the local copy; a current copy asks the world nothing', async t => {
  const w = await world(t);
  const look = await w.cli('look');
  assert.equal(look.code, 0, look.err);
  assert.equal(look.json.me.place, 'p_lib');
  assert.deepEqual(look.json.near.map(x => [x.name, x.metres]), [['Bo', 5]]);
  assert.deepEqual(look.json.said.map(x => [x.who, x.text, x.where]), [['Bo', 'quiet please', 'The Library']]);
  assert.deepEqual(w.seen, ['/v1/edge/live', '/v1/edge/catalog'], 'one live read and one catalog fetch');

  w.seen.length = 0;
  const found = await w.cli('find', 'read a book');
  assert.equal(found.code, 0, found.err);
  assert.equal(found.json.found[0]?.act, 'read:read.e_book');
  assert.deepEqual(w.seen, [], 'a fresh live picture and a current catalog: no call at all');
});

test('a catalog the world replaced is fetched once; a silent world leaves the copy in use with a note', async t => {
  const w = await world(t);
  assert.equal((await w.cli('look')).code, 0);
  w.state.version = 'v2'; w.state.book = 'New Atlas';
  // the live picture says which catalog is current; once it is older than its 4 s, the next command reads it and sees v2
  await new Promise(r => setTimeout(r, 4_200));
  w.seen.length = 0;
  const again = await w.cli('find', 'atlas', '--kind', 'book');
  assert.equal(again.code, 0, again.err);
  assert.match(JSON.stringify(again.json.found), /New Atlas/, 'the new catalog answers');
  assert.deepEqual(w.seen, ['/v1/edge/live', '/v1/edge/catalog'], 'one live read, then the new catalog once');
  w.state.up = false; w.seen.length = 0;
  const offline = await w.cli('catalog', '--refresh');
  assert.equal(offline.code, 0, offline.err);
  assert.match(offline.json.note, /did not give its catalog/);
  const still = await w.cli('find', 'library');
  assert.equal(still.code, 0, still.err);
  assert.equal(still.json.found[0]?.id ?? still.json.found[0]?.place, 'p_lib', 'find still answers from the copy');
});

test('on a folder with no copy yet, find fetches the live picture and the catalog itself and answers at once (lane M4)', async t => {
  const w = await world(t);
  const first = await w.cli('find', 'read');
  assert.equal(first.code, 0, first.err);
  assert.equal(first.json.found[0]?.act, 'read:read.e_book', 'acts are found before any look');
  assert.deepEqual(w.seen, ['/v1/edge/live', '/v1/edge/catalog']);
  const q = await w.cli('query', '[{"verb":"read"}]');
  assert.equal(q.code, 0, q.err); assert.match(JSON.stringify(q.json.answers), /read:read\.e_book/);
});

test('a world that has just started: find waits out world.starting and answers with the whole catalog (lane M4, #1737)', async t => {
  const w = await world(t); w.state.starting = 2;
  const t0 = Date.now(), first = await w.cli('find', 'read');
  assert.equal(first.code, 0, first.err);
  assert.equal(first.json.found[0]?.act, 'read:read.e_book');
  assert.deepEqual(w.seen, ['/v1/edge/live', '/v1/edge/catalog', '/v1/edge/catalog', '/v1/edge/catalog']);
  assert.ok(Date.now() - t0 >= 2_000, 'it waited the stated second, twice');
});
