// #591: the body library, kit and upload on the CLI worlds serve. A fake world over HTTP, the real eden.mjs as a child process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const CLI = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));
const ID = 'body_' + 'a'.repeat(64);
const VALIDATE = `console.log(JSON.stringify({valid:true,admitted:{assetId:'${ID}',triangles:80,bytes:9}}));`;

async function world(t) {
  const seen = [], dir = mkdtempSync(join(tmpdir(), 'soul-cli-body-'));
  const w = {seen, dir, refuse: 'body.not-owned'};
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks), u = new URL(req.url, 'http://x'), reply = (s, v) => { res.writeHead(s, {'content-type': 'application/json'}); res.end(JSON.stringify(v)); };
    seen.push({method: req.method, path: u.pathname, query: u.search, auth: req.headers.authorization, type: req.headers['content-type'], raw, body: raw.length && /json/.test(req.headers['content-type'] ?? '') ? JSON.parse(raw.toString()) : null});
    if (u.pathname.startsWith('/w/x/body-authoring/')) { res.writeHead(200); return res.end(u.pathname.endsWith('validate.mjs') ? VALIDATE : '{}'); }
    const p = u.pathname.replace('/w/x', '');
    if (p === '/v1/edge/body' && req.method === 'GET') return reply(200, {available: true, types: ['ceramic', 'humanoid'], authoring: {skill: '/w/x/body-authoring/SKILL.md'}, uploads: [], body: {model: 'humanoid'}, presets: []});
    if (p === '/v1/edge/body' && req.method === 'PUT') {
      const b = seen.at(-1).body;
      if (b.assetId) return reply(w.refuse === '500' ? 500 : 403, {error: {code: w.refuse, message: 'no'}});
      return reply(200, {body: {model: b.ref ?? b.preset}});
    }
    if (p.startsWith('/v1/edge/body/library')) return reply(200, {contract: 'body-library/1', items: []});
    if (p === '/v1/edge/body/uploads') return w.uploadRefused ? reply(400, {error: {code: 'body.invalid', message: 'bad mesh', details: {at: 'glb'}}}) : reply(200, {asset: {assetId: ID, type: 'ceramic'}});
    reply(404, {error: {code: 'not-found', message: req.url}});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, {recursive: true, force: true}); });
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: `http://127.0.0.1:${server.address().port}/w/x`, soul: 's_a', token: 'sim_fixture_secret_token'}));
  w.cli = (...args) => new Promise(done => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (e, out, err) => { let json = null; try { json = JSON.parse(out); } catch { /* text */ } done({code: e?.code ?? 0, json, err}); }));
  w.writes = () => seen.filter(s => s.path.endsWith('/v1/edge/body') && s.method === 'PUT').map(s => s.body);
  return w;
}

test('body set: an own upload first; a body from another world goes by reference; other refusals stand', async t => {
  const w = await world(t);
  assert.equal((await w.cli('body', 'set', ID)).json.body.model, ID);
  assert.deepEqual(w.writes(), [{assetId: ID}, {ref: ID}], 'not-owned here retries as a reference');
  w.seen.length = 0; w.refuse = 'body.safe-standing-required';
  assert.equal((await w.cli('body', 'set', ID)).code, 1);
  assert.deepEqual(w.writes(), [{assetId: ID}], 'an unsafe swap is not retried');
  w.seen.length = 0;
  assert.equal((await w.cli('body', 'set', 'pip')).json.body.model, 'pip');
  assert.deepEqual(w.writes(), [{preset: 'pip'}]);
});

test('body library, show, save, forget, publish, unpublish reach their routes; bad arguments reach nothing', async t => {
  const w = await world(t), at = () => { const s = w.seen.at(-1); return `${s.method} ${s.path.replace('/w/x', '')}${s.query}`; };
  await w.cli('body', 'library'); assert.equal(at(), 'GET /v1/edge/body/library?scope=mine');
  await w.cli('body', 'library', 'core', '--q', 'pip', '--limit', '5'); assert.equal(at(), 'GET /v1/edge/body/library?scope=core&q=pip&limit=5');
  await w.cli('body', 'show', 'pip@1'); assert.equal(at(), 'GET /v1/edge/body/library/pip@1');
  await w.cli('body', 'save', ID); assert.equal(at(), `PUT /v1/edge/body/library/${ID}`);
  await w.cli('body', 'forget', ID); assert.equal(at(), `DELETE /v1/edge/body/library/${ID}`);
  await w.cli('body', 'publish', ID); assert.equal(at(), `PUT /v1/edge/body/library/${ID}/public`);
  await w.cli('body', 'unpublish', ID); assert.equal(at(), `DELETE /v1/edge/body/library/${ID}/public`);
  const n = w.seen.length;
  assert.match((await w.cli('body', 'library', 'core', '--nope', 'x')).err, /usage: body library/);
  assert.match((await w.cli('body', 'show', '../x')).err, /usage: body show/);
  assert.match((await w.cli('body', 'publish', 'pip')).err, /usage: body publish/);
  assert.match((await w.cli('body', 'nope')).err, /usage: body \[presets \| library/);
  assert.equal(w.seen.length, n, 'none of those called the world');
});

test('body upload: a manifest or the flags, the token only to this world, refusals before and from the world', async t => {
  const w = await world(t), glb = join(w.dir, 'b.glb'), man = join(w.dir, 'm.json');
  writeFileSync(glb, 'glTF-bytes'); writeFileSync(man, JSON.stringify({type: 'ceramic', license: 'CC0', rightsConfirmed: true, name: 'Kit sculpture 1'}));
  assert.equal((await w.cli('body', 'upload', 'b.glb', '--manifest', 'm.json')).json.assetId, ID);
  const up = w.seen.at(-1);
  assert.equal(up.auth, 'Bearer sim_fixture_secret_token'); assert.match(up.type, /^multipart\/form-data/);
  assert.match(up.raw.toString(), /Kit sculpture 1/); assert.match(up.raw.toString(), /glTF-bytes/);
  assert.equal((await w.cli('body', 'upload', 'b.glb', '--type', 'ceramic', '--license', 'owned', '--rights-confirmed')).json.assetId, ID);
  const n = w.seen.length;
  assert.match((await w.cli('body', 'upload', 'b.glb', '--type', 'ceramic')).err, /Upload requires --manifest/);
  assert.match((await w.cli('body', 'upload')).err, /needs a GLB path/);
  assert.match((await w.cli('body', 'upload', 'b.glb', '--nope')).err, /Unknown body upload argument/);
  writeFileSync(glb, Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.match((await w.cli('body', 'upload', 'b.glb', '--manifest', 'm.json')).err, /no larger than 4 MiB/);
  assert.equal(w.seen.length, n, 'a refused upload never reached the world');
  writeFileSync(glb, 'x'); w.uploadRefused = true;
  assert.match((await w.cli('body', 'upload', 'b.glb', '--manifest', 'm.json')).err, /body\.invalid: bad mesh \{"at":"glb"\}/);
});

test('body kit: the world\'s files and a starter, relative to where it ran, no credential, and it names this CLI', async t => {
  const w = await world(t), r = await w.cli('body', 'kit', 'my-body', '--starter', 'rigid');
  assert.equal(r.code, 0, r.err); assert.equal(r.json.validation.valid, true);
  const kit = join(w.dir, 'my-body');
  for (const f of ['body.glb', 'manifest.json', 'kit.json', 'contract.json', 'validate.mjs']) assert.ok(existsSync(join(kit, f)), f);
  assert.ok(!readFileSync(join(kit, 'kit.json'), 'utf8').includes('sim_fixture_secret_token'));
  assert.ok(w.seen.filter(s => s.path.includes('/body-authoring/')).every(s => !s.auth), 'the kit files are public: no token sent');
  assert.match(r.json.next.join('\n'), /node eden\.mjs body upload/); assert.doesNotMatch(JSON.stringify(r.json), /eden-agent\.mjs/);
  assert.match((await w.cli('body', 'kit', 'my-body')).err, /already has/);
});
