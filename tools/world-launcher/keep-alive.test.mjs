// #2235 A7: every registered world keeps living. The launcher boots registered worlds that have no process, one at a
// time and only into free room (it never puts another world to sleep to do so), and a visitor's boot still evicts the
// least recently used idle world when the registry does not fit. Fake world processes (fake-world.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLauncher } from './launcher.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';

const BASE = await testPort(6);
const dir = mkdtempSync(join(tmpdir(), 'keep-alive-'));
const templatesDir = join(dir, 'templates'); mkdirSync(templatesDir);
writeFileSync(join(templatesDir, 'hello-hamlet.json'), JSON.stringify({ schema: 'genesis/1', name: 'Hello hamlet', description: 'a hamlet', batches: [] }));
const webDir = join(dir, 'web'); mkdirSync(webDir); writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Sim</title>');
const fake = new URL('./fake-world.mjs', import.meta.url).pathname;
const command = (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port) } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('registered worlds with no process are booted back, only into free room; a visit still evicts the least recently used', { timeout: 60_000 }, async () => {
  const P = BASE, base = `http://127.0.0.1:${P}`;
  const L = await openLauncher({ port: P, range: [BASE + 1, BASE + 5], dataDir: join(dir, 'data'), webDir, templatesDir, command, eager: 0, idleMs: 0,
    maxRunning: 2, keepAlive: true, keepAliveMs: 100, log: () => {} });
  const kids = async () => Object.fromEntries((await (await fetch(`${base}/__sim/launcher`)).json()).children.map((c) => [c.slug, c.status]));
  const until = async (ok, what) => { for (let i = 0; i < 100; i++) { if (ok(await kids())) return; await wait(100); } assert.fail(`${what}: ${JSON.stringify(await kids())}`); };
  try {
    for (const name of ['One', 'Two']) { assert.equal((await fetch(`${base}/__sim/worlds`, { method: 'POST', body: JSON.stringify({ name }) })).status, 201); await wait(20); }
    await until((k) => k.one === 'running' && k.two === 'running', 'both created worlds run');
    await L.pool.stop('one');   // a crash past its restarts, an eviction, a world never booted since the launcher started
    await until((k) => k.one === 'running', 'the stopped world is booted back by the keep-alive');
    // a third world does not fit under maxRunning 2: creating it (a visit) evicts the least recently used idle world
    assert.equal((await fetch(`${base}/__sim/worlds`, { method: 'POST', body: JSON.stringify({ name: 'Three' }) })).status, 201);
    await until((k) => k.three === 'running' && Object.values(k).filter((s) => s === 'running').length === 2, 'the newcomer runs, one world gave way');
    const out = Object.entries(await kids()).find(([, s]) => s !== 'running')[0];
    await wait(600);   // several keep-alive rounds: there is no free room, so nothing is put to sleep to bring it back
    const k = await kids();
    assert.equal(k[out], 'asleep', `${out} waits for room`);
    assert.equal(Object.values(k).filter((s) => s === 'running').length, 2);
  } finally { await L.close(); }
});

test('at start every registered world is booted, not only the most recent; a world that crashes is restarted', { timeout: 60_000 }, async () => {
  const P = BASE, base = `http://127.0.0.1:${P}`, data = join(dir, 'data-start');
  const open = (o) => openLauncher({ port: P, range: [BASE + 1, BASE + 5], dataDir: data, webDir, templatesDir, command, idleMs: 0, maxRunning: 4, keepAlive: true, keepAliveMs: 100, log: () => {}, ...o });
  const kids = async () => Object.fromEntries((await (await fetch(`${base}/__sim/launcher`)).json()).children.map((c) => [c.slug, c]));
  const until = async (ok, what) => { for (let i = 0; i < 100; i++) { if (ok(await kids())) return; await wait(100); } assert.fail(`${what}: ${JSON.stringify(await kids())}`); };
  let L = await open({ eager: 0 });
  try { for (const name of ['Alpha', 'Beta', 'Gamma']) { assert.equal((await fetch(`${base}/__sim/worlds`, { method: 'POST', body: JSON.stringify({ name }) })).status, 201); await wait(20); } }
  finally { await L.close(); }   // a deploy or a host restart: no world has a process
  L = await open({ eager: 1 });  // the launcher wakes only the most recent world eagerly; the keep-alive boots the rest
  try {
    await until((k) => ['alpha', 'beta', 'gamma'].every((s) => k[s]?.status === 'running'), 'every registered world runs');
    const { pid } = (await kids()).beta;
    process.kill(pid, 'SIGKILL');   // a crash
    await until((k) => k.beta?.status === 'running' && k.beta.pid !== pid, 'the crashed world is running again, in a new process');
  } finally { await L.close(); }
});
