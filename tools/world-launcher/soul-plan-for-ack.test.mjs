// #2381 A2 (finding 6 of #2364): an accepted `plan --for <message>` left the owner's card at `delivered` for 7 minutes on a
// loaded host. Here the real world (fake minds, in memory, served over HTTP) and the real client: serve runs the plan, and
// its first step's act acknowledges the card, as `act --for` does (#1753), while the card stays open for the later steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, invite, accept } from '../../apps/server/test/native-owner-fixture.ts';
import { buildApp } from '../../apps/server/src/http.ts';
import { config } from '../../apps/server/src/config.ts';
import { EdgeLedger } from '../../apps/server/src/edge/ledger/ledger.ts';

const CLI = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('#2381 A2: plan --for on a local fake-mind world acknowledges the card with its first step and keeps it open', { timeout: 300000 }, async (t) => {
  const f = fixture(':memory:'); f.brain.quiesce();
  await invite(f, 'alice');
  const a = await accept(f.host, f.souls.create('dev:alice', { name: 'Avery', description: 'Plan for a card' }));
  const token = f.souls.pairExchange(f.souls.pairCode(a, 'http://127.0.0.1:5969').code, 'scripted').token;
  const edge = new EdgeLedger(f.host, f.db);
  const app = buildApp({ cfg: { ...config, port: 5969, worldPath: '/w/eden', publicUrl: 'http://127.0.0.1:5969/w/eden', accountAuthRequired: false, webDir: '/nonexistent-plan-fixture', marsWebDir: '/nonexistent-plan-fixture' }, db: f.db, host: f.host, auth: f.auth, brain: f.brain, souls: f.souls, edge, hub: { clients: new Map(), refreshMe() {} } });
  // the app over plain HTTP, streams included (serve listens on the world's event stream)
  const server = createServer(async (q, s) => {
    const chunks = []; for await (const c of q) chunks.push(c);
    const ac = new AbortController(); s.on('close', () => ac.abort());
    const r = await app.fetch(new Request(`http://127.0.0.1${q.url}`, { method: q.method, headers: q.headers, signal: ac.signal, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
    s.writeHead(r.status, Object.fromEntries(r.headers));
    if (!r.body) return s.end();
    try { for await (const c of r.body) s.write(c); } catch { /* the client went away */ }
    s.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ticker = setInterval(() => { f.host.tickOnce(); f.host.drainInputs(); }, 5);
  const dir = mkdtempSync(join(tmpdir(), 'souls-plan-for-'));
  const cli = (...args) => new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    child.on('exit', (code) => { let json = null; try { json = JSON.parse(out); } catch { /* text */ } done({ code, out, err, json }); });
  });
  t.after(async () => { await cli('serve', '--stop'); clearInterval(ticker); server.closeAllConnections(); server.close(); f.host.stop(); f.db.close(); rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ world: `http://127.0.0.1:${server.address().port}`, soul: a.id, token }), { mode: 0o600 });
  const req = async (path, auth, body) => { const r = await app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return r.json(); };
  const card = async () => (await req(`/v1/edge/owner/${a.id}/inbox`, 'dev:alice')).inbox.latest;

  await req(`/v1/edge/owner/${a.id}/inbox`, 'dev:alice', { text: 'walk over there, then over here' });
  const m = (await req('/v1/edge/inbox/listen?timeoutMs=0', token)).backlog.at(-1);
  assert.equal((await card()).state, 'delivered');
  const caps = (await req('/v1/edge/capabilities', token)).capabilities.filter((c) => c.available);
  const walk = caps.find((c) => c.verb === 'walk' && c.target?.kind === 'place')?.id, then = caps.find((c) => c.verb === 'wave')?.id;
  assert.ok(walk && then, `a walk and a wave are on offer: ${caps.map((c) => c.id).join(' ')}`);
  const walks = [walk, then];

  assert.equal((await cli('serve')).code, 0);
  const t0 = Date.now(), p = await cli('plan', JSON.stringify(walks.slice(0, 2)), '--for', m.id);
  assert.equal(p.json?.accepted, true, p.out + p.err);
  let c = await card();
  for (let i = 0; i < 200 && c.state === 'delivered'; i++) { await sleep(50); c = await card(); }
  assert.equal(c.state, 'acknowledged', 'the first step\'s act is the acknowledgement');
  assert.ok(Date.now() - t0 < 10_000, `acknowledged ${Date.now() - t0} ms after the plan was accepted`);
  assert.equal(c.result, undefined, 'still open: the plan has a second step');
  console.log(`# card acknowledged ${Date.now() - t0} ms after plan --for was accepted`);
});
