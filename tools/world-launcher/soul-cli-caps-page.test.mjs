// 2.5.1 (L3 paged listings): a plain `caps` shows the world's page and says how many offers it left out
// (notListed/note); `caps --search`, `--verb` and `--all` read the whole menu with ?all=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const CLI = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));
const near = {id: 'sit:bench', verb: 'sit', label: 'Sit on the bench', available: true};
const far = {id: 'walk:far-pier', verb: 'walk', label: 'Walk to the far pier', available: true};

test('plain caps lists the page with notListed; search, verb and all read the whole menu', async (t) => {
  const seen = [], dir = mkdtempSync(join(tmpdir(), 'capspage-'));
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); seen.push(u.pathname + u.search);
    res.writeHead(200, {'content-type': 'application/json'});
    if (u.pathname !== '/v1/edge/capabilities') return res.end('{}');
    res.end(JSON.stringify(u.searchParams.get('all') === '1' ? {tick: 1, capabilities: [near, far]}
      : {tick: 1, capabilities: [near], omitted: {count: 1, byVerb: {walk: 1}, note: 'farther offers still work by id or in words'}}));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, {recursive: true, force: true});});
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: 'http://127.0.0.1:' + server.address().port, soul: 's_pip', token: 'sim_fixture'}));
  const run = (args) => new Promise((resolve, reject) => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (err, out, e) => err ? reject(new Error(e)) : resolve(JSON.parse(out))));

  const page = await run(['caps']);
  assert.equal(seen.at(-1), '/v1/edge/capabilities');
  assert.deepEqual(page.offers.map(o => o.id), ['sit:bench']);
  assert.equal(page.notListed, 1); assert.match(page.note, /farther/);

  const found = await run(['caps', '--search', 'far pier']);
  assert.equal(seen.at(-1), '/v1/edge/capabilities?all=1&search=far%20pier', '2.24.7 (#1412): the words go to the world too');
  assert.equal(found.offers[0].id, 'walk:far-pier'); assert.equal(found.notListed, undefined, 'the whole menu leaves nothing out');

  await run(['caps', '--verb', 'walk']); assert.equal(seen.at(-1), '/v1/edge/capabilities?all=1');
  await run(['caps', '--all']); assert.equal(seen.at(-1), '/v1/edge/capabilities?all=1');
});

test('#1268: a search shows the best dozen in short labels; --limit, --json, --verb and the plain page keep what they had', async (t) => {
  const label = (i) => `Walk to Pier ${i} [pier-${i}], ${'a long description of the water and the boards, '.repeat(4)}by the pond (${i} m)`;
  const menu = Array.from({length: 20}, (_, i) => ({id: `walk:pier-${i}`, verb: 'walk', label: label(i), available: true}));
  const dir = mkdtempSync(join(tmpdir(), 'capssearch-'));
  const server = createServer((req, res) => {res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({tick: 1, capabilities: menu}));});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, {recursive: true, force: true});});
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: 'http://127.0.0.1:' + server.address().port, soul: 's_pip', token: 'sim_fixture'}));
  const run = (...args) => new Promise((resolve, reject) => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (err, out, e) => err ? reject(new Error(e)) : resolve(JSON.parse(out))));

  const found = await run('caps', '--search', 'pier');
  assert.equal(found.matching, 20); assert.equal(found.shown, 12); assert.equal(found.offers.length, 12); assert.match(found.more, /--limit 20/);
  assert.ok(found.offers.every(o => o.label.length <= 80 && !o.label.includes('[')), 'short labels');
  assert.match(found.offers[3].label, /\(3 m\)$/, 'the distance stays');

  const more = await run('caps', '--search', 'pier', '--limit', '20');
  assert.equal(more.offers.length, 20); assert.equal(more.more, undefined);
  assert.equal((await run('caps', '--search', 'pier', '--json')).offers[0].label, label(0), '--json has the world\'s label');

  for (const args of [['caps'], ['caps', '--verb', 'walk'], ['caps', '--all']]) {
    const page = await run(...args);
    assert.equal(page.offers.length, 20, args.join(' ')); assert.equal(page.offers[0].label, label(0), args.join(' ')); assert.equal(page.more, undefined);
  }
  assert.equal((await run('caps', '--all', '--search', 'pier')).offers.length, 20, '--all keeps the catalogue limit');
});

// 2.24.7 (#1412, #1329 item 4): the world reads the words as resolve does and names the places first; an old world that
// ignores `search` gets today's local ranking, with nothing new in the output.
test('#1412: caps --search leads with the places the world names, prints its note, and degrades on an old world', async (t) => {
  const menu = [near, far, {id: 'walk:green', verb: 'walk', label: 'Walk to the green, by the library steps', available: true}];
  const library = {id: 'walk:eden-library-1', verb: 'walk', label: 'Walk to Eden Library 1 (278 m)', available: true, aliases: ['Eden Library', 'library', 'the stacks']};
  const dir = mkdtempSync(join(tmpdir(), 'capsworld-')), seen = []; let old = false;
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), q = u.searchParams.get('search'); seen.push(u.search);
    res.writeHead(200, {'content-type': 'application/json'});
    if (old || q == null) return res.end(JSON.stringify({tick: 1, capabilities: menu}));
    if (/library/.test(q)) return res.end(JSON.stringify({tick: 1, capabilities: [...menu, library], search: {query: q, places: ['walk:eden-library-1'], placesMatched: 1, truncated: false}}));
    res.end(JSON.stringify({tick: 1, capabilities: menu, search: {query: q, places: [], placesMatched: 0, truncated: false, note: `No place you know is named "${q}"; capabilities lists the whole menu to match against.`}}));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, {recursive: true, force: true});});
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: 'http://127.0.0.1:' + server.address().port, soul: 's_pip', token: 'sim_fixture'}));
  const run = (...args) => new Promise((resolve, reject) => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (err, out, e) => err ? reject(new Error(e)) : resolve(JSON.parse(out))));

  const found = await run('caps', '--search', 'library');
  assert.equal(seen.at(-1), '?all=1&search=library');
  assert.deepEqual(found.offers.map(o => o.id), ['walk:eden-library-1', 'walk:green'], 'the place the world names leads; the menu match follows, once each');
  assert.equal(found.placesMatched, 1); assert.equal(found.note, undefined);
  assert.deepEqual((await run('caps', 'library')).offers.map(o => o.id), ['walk:eden-library-1', 'walk:green'], 'bare words are a search too');

  const none = await run('caps', '--search', 'zeppelin');
  assert.equal(none.matching, 0); assert.equal(none.placesMatched, 0); assert.match(none.note, /No place you know is named "zeppelin"/);

  old = true;
  const before = await run('caps', '--search', 'library');
  assert.deepEqual(before.offers.map(o => o.id), ['walk:green'], 'an old world: local ranking over the menu, as before');
  assert.equal(before.placesMatched, undefined); assert.equal(before.note, undefined);
  const nothing = await run('caps', '--search', 'zeppelin');
  assert.deepEqual(Object.keys(nothing).sort(), ['matching', 'offers', 'shown', 'total'], 'no new fields from an old world');

  old = false;
  const sit = await run('caps', '--search', 'library', '--verb', 'sit');
  assert.deepEqual(sit.offers, [], '--verb still filters the places out');
  assert.equal(sit.placesMatched, 1); assert.match(sit.note, /knows a place named "library", but none is among --verb sit/, 'never "nothing matches" beside placesMatched 1');
});

// #1445 review: a world that sends both a page's omitted note and a search note: both reach the agent, the page's first.
test('#1445: an omitted note and a search note are both kept', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'capsboth-'));
  const server = createServer((req, res) => {res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({tick: 1, capabilities: [near],
    omitted: {count: 3, note: 'farther offers still work by id or in words.'}, search: {query: 'zeppelin', places: [], placesMatched: 0, truncated: false, note: 'No place you know is named "zeppelin".'}}));});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, {recursive: true, force: true});});
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: 'http://127.0.0.1:' + server.address().port, soul: 's_pip', token: 'sim_fixture'}));
  const out = await new Promise((resolve, reject) => execFile(process.execPath, [CLI, 'caps', '--search', 'zeppelin'], {cwd: dir}, (err, o, e) => err ? reject(new Error(e)) : resolve(JSON.parse(o))));
  assert.equal(out.notListed, 3);
  assert.equal(out.note, 'farther offers still work by id or in words. No place you know is named "zeppelin".');
});
