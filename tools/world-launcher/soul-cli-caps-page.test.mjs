// 2.5.1 (L3 paged listings): a plain `caps` shows the world's page and says how many offers it left out
// (notListed/note); `caps --verb` and `--all` read the whole menu with ?all=1. #1921: `caps --search` is the local
// catalog's `find`, with no call on the world: each fake world here counts resolver and search requests, and ends at zero.
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
const catalog = (places) => ({contract: 'soul-catalog/1', worldId: 'w', scope: 'public', placeVerbs: ['walk'], anywhere: [], things: [], acts: [], kinds: {},
  places: [{id: 'world', name: 'World', kind: 'region', parent: null, at: [0, 0]}, ...places.map((p) => ({kind: 'landmark', parent: 'world', ...p}))]});
const resolverCalls = (seen) => seen.filter((u) => u.startsWith('/v1/edge/resolve') || (u.startsWith('/v1/edge/capabilities') && /[?&]search=/.test(u))).length;

/** A world with a capabilities menu (`menu(url)`), a catalog and a live picture with this Soul at the origin. */
async function world(t, menu, cat) {
  const seen = [], dir = mkdtempSync(join(tmpdir(), 'capspage-'));
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); seen.push(u.pathname + u.search);
    if (u.pathname === '/v1/edge/catalog') { res.writeHead(200, {'content-type': 'application/json', etag: '"c1"'}); return res.end(JSON.stringify(cat)); }
    res.writeHead(200, {'content-type': 'application/json'});
    if (u.pathname === '/v1/edge/live') return res.end(JSON.stringify({tick: 1, souls: [{id: 's_pip', name: 'Pip', at: [0, 0], place: 'world'}], things: {}, speech: []}));
    if (u.pathname !== '/v1/edge/capabilities') return res.end('{}');
    res.end(JSON.stringify(menu(u)));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, {recursive: true, force: true}); assert.equal(resolverCalls(seen), 0, 'no call on the resolver or its search');});
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: 'http://127.0.0.1:' + server.address().port, soul: 's_pip', token: 'sim_fixture'}));
  const run = (...args) => new Promise((resolve, reject) => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (err, out, e) => err ? reject(new Error(e)) : resolve(JSON.parse(out))));
  await run('look');   // the local copy: catalog and live picture
  return {seen, run};
}

test('plain caps lists the page with notListed; a search reads the local catalog; verb and all read the whole menu', async (t) => {
  const {seen, run} = await world(t, (u) => u.searchParams.get('all') === '1' ? {tick: 1, capabilities: [near, far]}
    : {tick: 1, capabilities: [near], omitted: {count: 1, byVerb: {walk: 1}, note: 'farther offers still work by id or in words'}},
  catalog([{id: 'far-pier', name: 'Far Pier', at: [300, 0]}]));

  const page = await run('caps');
  assert.equal(seen.at(-1), '/v1/edge/capabilities');
  assert.deepEqual(page.offers.map(o => o.id), ['sit:bench']);
  assert.equal(page.notListed, 1); assert.match(page.note, /farther/);

  const before = seen.length, found = await run('caps', '--search', 'far pier');
  assert.equal(seen.length, before, '#1921: a search makes no call on the world');
  assert.equal(found.offers[0].id, 'walk:far-pier'); assert.equal(found.notListed, undefined, 'the whole catalog leaves nothing out');

  await run('caps', '--verb', 'walk'); assert.equal(seen.at(-1), '/v1/edge/capabilities?all=1');
  await run('caps', '--all'); assert.equal(seen.at(-1), '/v1/edge/capabilities?all=1');
});

test('#1268: a search shows the best dozen in short labels; --limit, --json, --verb and the plain page keep what they had', async (t) => {
  const label = (i) => `Walk to Pier ${i} [pier-${i}], ${'a long description of the water and the boards, '.repeat(4)}by the pond (${i} m)`;
  const menu = Array.from({length: 20}, (_, i) => ({id: `walk:pier-${i}`, verb: 'walk', label: label(i), available: true}));
  const name = (i) => `Pier ${i}, ${'a long name for the water and the boards, '.repeat(4)}`;
  const {run} = await world(t, () => ({tick: 1, capabilities: menu}), catalog(Array.from({length: 20}, (_, i) => ({id: `pier-${i}`, name: name(i), at: [i, 0]}))));

  const found = await run('caps', '--search', 'pier');
  assert.equal(found.matching, 20); assert.equal(found.shown, 12); assert.equal(found.offers.length, 12); assert.match(found.more, /--limit 20/);
  assert.ok(found.offers.every(o => o.label.length <= 80 && !o.label.includes('[')), 'short labels');
  assert.equal(found.offers[3].id, 'walk:pier-3'); assert.equal(found.offers[3].metres, 3, 'the distance stays');

  const more = await run('caps', '--search', 'pier', '--limit', '20');
  assert.equal(more.offers.length, 20); assert.equal(more.more, undefined);
  assert.equal((await run('caps', '--search', 'pier', '--json')).offers[0].label, name(0), '--json has the whole label');

  for (const args of [['caps'], ['caps', '--verb', 'walk'], ['caps', '--all']]) {
    const page = await run(...args);
    assert.equal(page.offers.length, 20, args.join(' ')); assert.equal(page.offers[0].label, label(0), args.join(' ')); assert.equal(page.more, undefined);
  }
  assert.equal((await run('caps', '--all', '--search', 'pier')).offers.length, 20, '--all keeps the catalogue limit');
});

test('#1921: bare words are a search too; a search that matches nothing says so; --verb filters the places out', async (t) => {
  const {run} = await world(t, () => ({tick: 1, capabilities: [near, far]}),
    catalog([{id: 'eden-library-1', name: 'Eden Library 1', aliases: ['Eden Library', 'the stacks'], at: [278, 0]}, {id: 'green', name: 'The Green', at: [9, 0]}]));

  const found = await run('caps', '--search', 'library');
  assert.equal(found.offers[0].id, 'walk:eden-library-1');
  assert.deepEqual((await run('caps', 'library')).offers.map(o => o.id), found.offers.map(o => o.id), 'bare words are a search too');

  const none = await run('caps', '--search', 'zeppelin');
  assert.equal(none.matching, 0); assert.match(none.note, /Nothing in this world's catalog matches "zeppelin"/);

  const sit = await run('caps', '--search', 'library', '--verb', 'sit');
  assert.deepEqual(sit.offers, [], '--verb still filters the places out');
});
