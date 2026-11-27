// node --test tools/world-launcher/disk-low-create.test.mjs
// #2538 A1/A2: under --disk-min-free-mb (a faked free-space reading), POST /__sim/worlds answers 503 host.disk-low with
// Retry-After and healthz raises the host code `disk`; without the setting a world is made even on a full disk reading.
// Fake world processes (fake-world.mjs), temp data dirs, free ports.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLauncher } from './launcher.mjs';
import { testPort } from '../lib/test-port.ts';

const B = await testPort(6), dir = mkdtempSync(join(tmpdir(), 'disk-low-create-'));
const fake = new URL('./fake-world.mjs', import.meta.url).pathname;
const command = (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port) } });
const open = (i, extra) => openLauncher({ port: B + 3 * i, range: [B + 3 * i + 1, B + 3 * i + 2], dataDir: join(dir, `data-${i}`), command, eager: 0, log: () => {}, ...extra });
const create = (port, name) => fetch(`http://127.0.0.1:${port}/__sim/worlds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
const open1 = [];
after(async () => { for (const l of open1) await l.close(); rmSync(dir, { recursive: true, force: true }); });

test('disk under the floor: world creation is refused with a named, retriable answer and healthz says disk', async () => {
  const L = await open(0, { diskMinFreeMb: 2048, diskFreeMb: () => 100 }); open1.push(L);
  const r = await create(B, 'Full disk');
  assert.equal(r.status, 503); assert.equal(r.headers.get('retry-after'), '600');
  const b = await r.json();
  assert.equal(b.code, 'host.disk-low'); assert.equal(b.retry_after, 600); assert.deepEqual(b.limit, { scope: 'disk' });
  assert.match(b.message, /disk is nearly full.*Try again in 10 minutes/);
  const worlds = await (await fetch(`http://127.0.0.1:${B}/__sim/worlds.json`)).json();
  assert.deepEqual(worlds.worlds, [], 'nothing was made');
  const h = await (await fetch(`http://127.0.0.1:${B}/__sim/healthz`)).json();
  assert.equal(h.hostOk, false); assert.ok(h.hostCodes.includes('disk'), JSON.stringify(h));
});

test('without --disk-min-free-mb the free-space reading is never consulted and a world is made', async () => {
  let reads = 0;
  const L = await open(1, { diskFreeMb: () => { reads++; return 0; } }); open1.push(L);
  const r = await create(B + 3, 'Laptop world');
  assert.equal(r.status, 201, await r.clone().text());
  const h = await (await fetch(`http://127.0.0.1:${B + 3}/__sim/healthz`)).json();
  assert.ok(!(h.hostCodes ?? []).includes('disk')); assert.equal(reads, 0);
});
