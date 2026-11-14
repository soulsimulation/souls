// #824 (2.8.0): a refused act prints the world's `alternatives` (at most 3) beside did_you_mean.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const CLI = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));

/** #1921: the world's resolver and its search are never asked by the client: a fake world counts both. */
const resolverCalls = (seen) => seen.filter(([u]) => u.startsWith('/v1/edge/resolve') || (u.startsWith('/v1/edge/capabilities') && /[?&]search=/.test(u))).length;
const CATALOG = {contract: 'soul-catalog/1', worldId: 'w', scope: 'public', placeVerbs: ['walk'], anywhere: [{id: 'wave:here', verb: 'wave', label: 'Wave'}],
  places: [{id: 'world', name: 'World', kind: 'region', parent: null, at: [0, 0]}, {id: 'library', name: 'Library', kind: 'building', parent: 'world', at: [10, 0]}], things: [], acts: [], kinds: {}};

test('#1921 act: words are read by the local find and exit 2 with its ids, with no call on the world; an id with no colon (pray) still acts', async t => {
  const seen = [];
  const server = createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const body = JSON.parse(b || '{}'); seen.push([req.url, body]);
      if (req.url === '/v1/edge/catalog') { res.writeHead(200, {'content-type': 'application/json', etag: '"c1"'}); return res.end(JSON.stringify(CATALOG)); }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({accepted: true, receipt: {id: 'r1', capability: body.capability, phase: 'started'}, channel: 'body'}));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), 'eden-cli-words-'));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: `http://127.0.0.1:${server.address().port}`, token: 'tok'}));
  const run = (...args) => new Promise(res => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (e, out) => res({code: e?.code ?? 0, out: JSON.parse(out)})));
  await run('catalog'); seen.length = 0;
  const words = await run('act', 'walk to the library', '{"with":["Bo"]}');
  assert.equal(words.code, 2); assert.equal(words.out.accepted, false); assert.equal(words.out.code, 'act.not-an-id');
  assert.deepEqual(words.out.candidates, [{id: 'walk:library', label: 'Library'}]);
  assert.deepEqual(seen, [], 'no call on the world: no resolve, no act');
  const pray = await run('act', 'pray', '{"text":"rain"}');
  assert.equal(pray.code, 0); assert.equal(pray.out.accepted, true);
  { const [u, b] = seen.at(-1); assert.equal(u, '/v1/edge/act'); assert.deepEqual([b.capability, b.params, b.strict], ['pray', {text: 'rain'}, true]); }
  const id = await run('act', 'walk:library');
  assert.equal(id.code, 0); assert.equal(id.out.accepted, true);
  const [url, body] = seen.at(-1); assert.equal(url, '/v1/edge/act'); assert.equal(body.strict, true); assert.equal(body.capability, 'walk:library');
  assert.equal(resolverCalls(seen), 0);
});

test('act: a refusal prints alternatives (at most 3); none when the world sends none', async t => {
  const alts = [{id: 'walk:field', label: 'Green field'}, {id: 'gather:field', label: 'Gather'}, {id: 'jog:field', label: 'Jog'}, {id: 'sit:here', label: 'Sit'}];
  const server = createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const body = JSON.parse(b || '{}'); res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify(body.capability === 'fly:field' ? {accepted: false, code: 'ride.unavailable', reason: 'No matching ride.', did_you_mean: [], alternatives: alts} : {accepted: false, code: 'capability.params', reason: 'Bad params.'}));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), 'eden-cli-alternatives-'));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: `http://127.0.0.1:${server.address().port}`, token: 'tok'}));
  const cli = (...args) => new Promise((res, rej) => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (e, out, err) => e ? rej(new Error(err || e.message)) : res(JSON.parse(out))));
  const fly = await cli('act', 'fly:field');
  assert.equal(fly.code, 'ride.unavailable'); assert.deepEqual(fly.alternatives, alts.slice(0, 3)); assert.equal(fly.did_you_mean, undefined);
  const bad = await cli('act', 'walk:field');
  assert.equal(bad.code, 'capability.params'); assert.equal(bad.alternatives, undefined);
});

test('#1268: a refused act prints one short list; --json is the world\'s answer', async t => {
  const place = (id, name) => ({id, verb: 'walk', label: `Walk to ${name} [${id.slice(5)}], ${'a small hall beside the pond, with a long description of it, '.repeat(3)}(40 m)`, available: true, params: {with: {type: 'array', optional: true, maxItems: 6}}});
  const candidates = [place('walk:hall', 'Hall'), place('walk:pond', 'Pond'), place('walk:knoll', 'Knoll'), place('walk:barn', 'Barn')];
  const did_you_mean = candidates.map(c => ({id: c.id, label: c.label}));
  const alternatives = [{id: 'walk:hall', label: place('walk:hall', 'Hall').label, why: 'walks to hall', partial: true}];
  const refusal = {code: 'capability.unknown', reason: 'Nothing offered matches.', did_you_mean, candidates, alternatives, discovery: {kind: 'interaction', candidates: []}};
  const server = createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({accepted: false, ...refusal}));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), 'eden-cli-refusal-'));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: `http://127.0.0.1:${server.address().port}`, token: 'tok'}));
  const cli = (...args) => new Promise((res, rej) => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (e, out, err) => e ? rej(new Error(err || e.message)) : res(JSON.parse(out))));

  for (const out of [await cli('act', 'walk:nowhere')]) {
    assert.equal(out.code, 'capability.unknown'); assert.equal(out.reason, 'Nothing offered matches.');
    assert.deepEqual(out.did_you_mean.map(d => d.id), ['walk:hall', 'walk:pond', 'walk:knoll']);
    assert.deepEqual(out.did_you_mean[0].params, ['with']); assert.ok(out.did_you_mean.every(d => d.label.length <= 80 && d.available === undefined));
    assert.equal(out.candidates, undefined); assert.equal(out.discovery, undefined);
    assert.equal(out.alternatives[0].why, 'walks to hall'); assert.equal(out.alternatives[0].partial, true); assert.ok(out.alternatives[0].label.length <= 80);
  }
  assert.deepEqual(await cli('act', 'walk:nowhere', '--json'), {accepted: false, ...refusal});
});
