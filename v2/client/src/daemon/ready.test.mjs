// The first command waits for its daemon to listen (#4700): the daemon it starts writes `ready` on a pipe once its
// socket listens, so a daemon slow to start (its library loaded on a machine under load) is waited for, not given a
// fixed 5 s and then `connect ENOENT`; one that ends as it starts is told at once, by name. No gateway is needed.
// Run from v2/ with replica's wasm-bindgen package in target/wasm-load/pkg.

import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { DEFAULT_PKG, call, request } from './client.mjs';
import { runtimeOf } from '../home/home.mjs';

const PKG = resolve(process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG);
const SOUL = 's_readytest';
const dir = mkdtempSync(join(tmpdir(), 'souls-ready-'));
const homes = [];

after(async () => {
  for (const home of homes) await request(runtimeOf(home, SOUL).socket, { op: 'stop' }).catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

function makeHome(name, token = `soul-${'5e'.repeat(16)}-2.${randomBytes(32).toString('hex')}`) {
  const home = join(dir, name, '.souls');
  mkdirSync(home, { recursive: true });
  // A gateway on a port nothing listens on: the daemon answers its commands while it reconnects.
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway: 'ws://127.0.0.1:1/v2/ws' } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [SOUL]: { local: { token } } } }), { mode: 0o600 });
  homes.push(home);
  return home;
}

/** The library, loaded `ms` late: a daemon as slow to start as one on a loaded machine. */
function slowPkg(ms) {
  const pkg = join(dir, `pkg-${ms}`);
  mkdirSync(pkg);
  symlinkSync(join(PKG, 'replica_bg.wasm'), join(pkg, 'replica_bg.wasm'));
  writeFileSync(join(pkg, 'replica.js'), `await new Promise((ok) => setTimeout(ok, ${ms}));\nexport * from ${JSON.stringify(pathToFileURL(join(PKG, 'replica.js')).href)};\n`);
  return pkg;
}

test('#4700: the first command waits for a daemon that takes 7 s to listen, and is answered by it', async () => {
  const home = makeHome('slow'), t0 = performance.now();
  const said = await call(home, SOUL, { op: 'status' }, { pkg: slowPkg(7000) });
  const took = performance.now() - t0;
  assert.equal(said.ok, true, JSON.stringify(said));
  assert.equal(said.started, true);
  assert.equal(said.soul, SOUL);
  assert.ok(took >= 7000 && took < 15_000, `answered after ${Math.round(took)} ms`);
});

test('#4700: a daemon that ends as it starts is told at once, with its reason, not waited for', async () => {
  const home = makeHome('bad', 'not-a-token'), t0 = performance.now();
  await assert.rejects(call(home, SOUL, { op: 'status' }, { pkg: PKG }), (e) => {
    assert.equal(e.code, 'daemon-not-started');
    assert.match(e.message, /token-not-a-soul-token/);
    return true;
  });
  assert.ok(performance.now() - t0 < 5000, `told after ${Math.round(performance.now() - t0)} ms`);
});

test('#4700: two first commands at once: one daemon starts, and both are answered by it', async () => {
  const home = makeHome('two'), pkg = slowPkg(2000);
  const [a, b] = await Promise.all([call(home, SOUL, { op: 'status' }, { pkg }), call(home, SOUL, { op: 'status' }, { pkg })]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(a.pid, b.pid);
});
