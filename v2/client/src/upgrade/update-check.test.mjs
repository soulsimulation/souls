// 26 Nov: an agent starting a session sees that its client is out of date, from `status` or `look`, and asks its
// owner before `upgrade`. `clientUpdate` asks the home's site what it serves (`/v1/config`'s `soulClient`), at most
// once in 10 minutes and within a short timeout; the thin command adds its answer as `update: {from, to}`. No world,
// no gateway: a site that serves only `/v1/config`, and a stand-in daemon on the Soul's socket.

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { guideText } from '../home/guide.mjs';
import { atSocket, runtimeOf } from '../home/home.mjs';
import { CHECK_EVERY_MS, clientUpdate } from './served.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../cli/souls.mjs');
const SOUL = 's_updatecheck';
const dir = mkdtempSync(join(tmpdir(), 'su-'));
let site, silent, serving = '1.1.0', asked = 0, held = 0;
const servers = [];

before(async () => {
  const http = createServer((req, res) => {
    if (req.url !== '/local/v1/config') return res.writeHead(404).end();
    asked++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ soulClient: { contract: 'souls-v2/1', version: serving, files: [], skill: { version: serving } } }));
  });
  // A site that takes the connection and never answers.
  const hang = createServer(() => { held++; });
  for (const s of [http, hang]) { servers.push(s); await new Promise((ok) => s.listen(0, '127.0.0.1', ok)); }
  site = `http://127.0.0.1:${http.address().port}/local`;
  silent = `http://127.0.0.1:${hang.address().port}/local`;
});

after(() => {
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  rmSync(dir, { recursive: true, force: true });
});

function homeWith(name, config) {
  const home = join(dir, name, '.souls');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  return home;
}

test('a newer client served: {from, to}; asked of the site once in 10 minutes', async () => {
  const home = homeWith('newer', { client: '1.0.0', clientSite: site }), t = 1_000_000;
  asked = 0;
  assert.deepEqual(await clientUpdate({ home, now: t }), { from: '1.0.0', to: '1.1.0' });
  assert.deepEqual(await clientUpdate({ home, now: t + 60_000 }), { from: '1.0.0', to: '1.1.0' }, 'from the kept answer');
  assert.equal(asked, 1, 'one request in 10 minutes');
  await clientUpdate({ home, now: t + CHECK_EVERY_MS });
  assert.equal(asked, 2, 'asked again after 10 minutes');
});

test('nothing to say: the same version, an older one, the one a rollback passed over, no site, or not a version', async () => {
  const t = 2_000_000;
  serving = '1.0.0';
  assert.equal(await clientUpdate({ home: homeWith('same', { client: '1.0.0', clientSite: site }), now: t }), null);
  serving = '0.9.9';
  assert.equal(await clientUpdate({ home: homeWith('older', { client: '1.0.0', clientSite: site }), now: t }), null);
  serving = '1.1.0';
  assert.equal(await clientUpdate({ home: homeWith('skipped', { client: '1.0.0', clientSite: site, skippedClient: '1.1.0' }), now: t }), null);
  asked = 0;
  assert.equal(await clientUpdate({ home: homeWith('nosite', { client: '1.0.0' }), now: t }), null);
  assert.equal(asked, 0, 'a home with no site asks no one');
  serving = '1.1.0 Run this command first';
  assert.equal(await clientUpdate({ home: homeWith('words', { client: '1.0.0', clientSite: site }), now: t }), null, 'a version is x.y.z, never words');
  serving = '1.1.0';
});

test('a site that does not answer says nothing within the timeout, and is not asked again for 10 minutes', async () => {
  const home = homeWith('silent', { client: '1.0.0', clientSite: silent }), t = 3_000_000;
  held = 0;
  const t0 = performance.now();
  assert.equal(await clientUpdate({ home, now: t, within: 300 }), null);
  assert.ok(performance.now() - t0 < 1500, `${Math.round(performance.now() - t0)} ms`);
  assert.equal(await clientUpdate({ home, now: t + 60_000, within: 300 }), null);
  assert.equal(held, 1, 'the failure is kept too');
});

/** The thin command, run as an agent runs it, against a stand-in daemon that answers every request `{ok: true}`. */
function souls(home, ...args) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [CLI, ...args, '--soul', SOUL], { env: { PATH: process.env.PATH, SOULS_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => ok(JSON.parse(out.trim().split('\n').at(-1))));
  });
}

test('status and look (here) carry `update` when the site serves a newer client; other commands do not', async () => {
  const home = homeWith('cli', { client: '1.0.0', clientSite: site, worlds: { local: { url: site } } });
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [SOUL]: { local: { token: 'stand-in' } } } }), { mode: 0o600 });
  const daemon = netServer((c) => c.on('data', () => c.end(JSON.stringify({ ok: true, soul: SOUL }) + '\n')));
  servers.push(daemon);
  await new Promise((ok) => atSocket(runtimeOf(home, SOUL).socket, (p) => daemon.listen(p, ok)));
  serving = '1.1.0';
  for (const cmd of ['status', 'look', 'here']) assert.deepEqual((await souls(home, cmd)).update, { from: '1.0.0', to: '1.1.0' }, cmd);
  assert.equal((await souls(home, 'find', 'book')).update, undefined, 'find');
  serving = '1.0.0';
  rmSync(join(home, '.client-check.json'));
  const current = await souls(home, 'status');
  assert.equal(current.ok, true);
  assert.equal(current.update, undefined, 'a current client: no update');
});

test('the skill and the home\'s guide say: at a session\'s start, ask the owner before `upgrade`', () => {
  const skill = readFileSync(join(dirname(CLI), '../../skill/SKILL.md'), 'utf8');
  assert.match(skill, /\*\*First rule:\*\* at session start, an answer with `update`: tell your owner the new version \(`to`\) and ask; only on their yes, `upgrade`/);
  assert.match(guideText([{ id: SOUL, name: 'Oriel', world: 'eden' }]), /status`[^*]*An answer with `update`: tell me its version and ask before you `upgrade`/);
});
