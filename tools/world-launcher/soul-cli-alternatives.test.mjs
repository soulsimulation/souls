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

test('act: words are not acted on: they print the candidates and exit 2 with no act sent; an id is sent strict', async t => {
  const seen = [];
  const candidates = [{id: 'walk:library', verb: 'walk', label: 'Walk to the library', available: true, params: {with: {type: 'array', optional: true}}}];
  const server = createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const body = JSON.parse(b || '{}'); seen.push([req.url, body]); res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify(req.url === '/v1/edge/resolve' ? {resolve: {ok: true, candidates}} : {accepted: true, receipt: {id: 'r1', capability: body.capability, phase: 'started'}, channel: 'body'}));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), 'eden-cli-words-'));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: `http://127.0.0.1:${server.address().port}`, token: 'tok'}));
  const run = (...args) => new Promise(res => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (e, out) => res({code: e?.code ?? 0, out: JSON.parse(out)})));
  const words = await run('act', 'walk to the library', '{"with":["Bo"]}');
  assert.equal(words.code, 2); assert.equal(words.out.accepted, false); assert.deepEqual(words.out.candidates, candidates);
  assert.deepEqual(seen.map(([u]) => u), ['/v1/edge/resolve'], 'no act was sent');
  const id = await run('act', 'walk:library');
  assert.equal(id.code, 0); assert.equal(id.out.accepted, true);
  const [url, body] = seen.at(-1); assert.equal(url, '/v1/edge/act'); assert.equal(body.strict, true); assert.equal(body.capability, 'walk:library');
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

test('#1268: a refused resolve and a refused act print one short list; --json is the world\'s answer; a found resolve is untouched', async t => {
  const place = (id, name) => ({id, verb: 'walk', label: `Walk to ${name} [${id.slice(5)}], ${'a small hall beside the pond, with a long description of it, '.repeat(3)}(40 m)`, available: true, params: {with: {type: 'array', optional: true, maxItems: 6}}});
  const candidates = [place('walk:hall', 'Hall'), place('walk:pond', 'Pond'), place('walk:knoll', 'Knoll'), place('walk:barn', 'Barn')];
  const did_you_mean = candidates.map(c => ({id: c.id, label: c.label}));
  const alternatives = [{id: 'walk:hall', label: place('walk:hall', 'Hall').label, why: 'walks to hall', partial: true}];
  const refusal = {code: 'capability.unknown', reason: 'Nothing offered matches.', did_you_mean, candidates, alternatives, discovery: {kind: 'interaction', candidates: []}};
  const found = {ok: true, would: {capability: 'walk:hall', label: candidates[0].label, channel: 'body'}, candidates: [candidates[0]]};
  const server = createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const body = JSON.parse(b || '{}'); res.writeHead(200, {'content-type': 'application/json'});
      if (req.url === '/v1/edge/resolve') return res.end(JSON.stringify({resolve: body.capability === 'the hall' ? found : {ok: false, ...refusal}}));
      res.end(JSON.stringify({accepted: false, ...refusal}));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), 'eden-cli-refusal-'));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: `http://127.0.0.1:${server.address().port}`, token: 'tok'}));
  const cli = (...args) => new Promise((res, rej) => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (e, out, err) => e ? rej(new Error(err || e.message)) : res(JSON.parse(out))));

  for (const out of [await cli('resolve', 'make tea'), await cli('act', 'walk:nowhere')]) {
    assert.equal(out.code, 'capability.unknown'); assert.equal(out.reason, 'Nothing offered matches.');
    assert.deepEqual(out.did_you_mean.map(d => d.id), ['walk:hall', 'walk:pond', 'walk:knoll']);
    assert.deepEqual(out.did_you_mean[0].params, ['with']); assert.ok(out.did_you_mean.every(d => d.label.length <= 80 && d.available === undefined));
    assert.equal(out.candidates, undefined); assert.equal(out.discovery, undefined);
    assert.equal(out.alternatives[0].why, 'walks to hall'); assert.equal(out.alternatives[0].partial, true); assert.ok(out.alternatives[0].label.length <= 80);
  }
  assert.equal((await cli('resolve', 'make tea')).ok, false);
  assert.deepEqual(await cli('resolve', 'make tea', '--json'), {ok: false, ...refusal});
  assert.deepEqual(await cli('act', 'walk:nowhere', '--json'), {accepted: false, ...refusal});
  assert.deepEqual(await cli('resolve', 'the hall'), found);
});
