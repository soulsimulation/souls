// node --test tools/world-launcher/time-zone.test.mjs (#1649 part 3; proxy and fake worlds on a free block of ports)
// The New world dialog sends the creator's time zone: the launcher refuses an invalid one by name, keeps it on the
// registry row, passes it to the world as WORLD_TIME_ZONE (recorded at its first real-time boot), and lists the world's
// own zone, which the world reports in /v1/god/status, so an owner's later change shows on the list.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLauncher } from './launcher.mjs';
import { defaultCommand } from './children.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';
const P0 = await testPort(4);

const PORT = P0 + 3, RANGE = [P0, P0 + 2];
const dir = mkdtempSync(join(tmpdir(), 'launcher-1649-zone-'));
const templatesDir = join(dir, 'templates'); mkdirSync(templatesDir);
const webDir = join(dir, 'web'); mkdirSync(webDir);
const fake = new URL('./fake-world.mjs', import.meta.url).pathname;
const zones = new Map(); let statusZone = '';
const command = (w, port) => {
  const env = defaultCommand(w, port, { publicOrigin: `http://127.0.0.1:${PORT}` }).env;
  zones.set(w.slug, env.WORLD_TIME_ZONE ?? null);
  return { cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port), FAKE_BOOT_MS: '20', ...(env.WORLD_TIME_ZONE ? { WORLD_TIME_ZONE: env.WORLD_TIME_ZONE } : {}), FAKE_STATUS_ZONE: statusZone } };
};
let L;
after(async () => { await L?.close(); });
const api = (p, o = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, o);
const create = (body) => api('/__sim/worlds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const card = async (slug) => (await (await api('/__sim/worlds.json')).json()).worlds.find((w) => w.slug === slug);

test('a new world keeps the zone chosen in the dialog; an invalid zone is refused; the list shows the world\'s own zone', async () => {
  L = await openLauncher({ port: PORT, range: RANGE, dataDir: join(dir, 'data'), webDir, templatesDir, command, eager: 0, log: () => {} });
  for (const timeZone of ['Mars/Olympus', 'EST5EDT; drop', 42]) {
    const r = await create({ name: 'Bad Zone', timeZone }); const b = await r.json();
    assert.equal(r.status, 400, String(timeZone)); assert.equal(b.code, 'time.zone-invalid');
  }
  assert.equal((await (await api('/__sim/worlds.json')).json()).worlds.length, 0, 'a refused world is never made');

  const made = await create({ name: 'Tokyo Garden', timeZone: 'Asia/Tokyo' }); const w = await made.json();
  assert.equal(made.status, 201, JSON.stringify(w));
  assert.equal(zones.get(w.slug), 'Asia/Tokyo', 'the world boots with WORLD_TIME_ZONE');
  assert.equal(w.world.timeZone, 'Asia/Tokyo');
  assert.equal((await card(w.slug)).timeZone, 'Asia/Tokyo', 'shown in the world list');

  const plain = await (await create({ name: 'No Zone' })).json();
  assert.equal(zones.get(plain.slug), null, 'no zone given: the world keeps its migration default');
  assert.equal((await card(plain.slug)).timeZone, null);

  // the owner moved this world to Lisbon (POST /v1/god/env {timeZone}); the world reports it and the list follows
  statusZone = 'Europe/Lisbon';
  const moved = await (await create({ name: 'Moved Later', timeZone: 'Asia/Tokyo' })).json();
  assert.equal((await card(moved.slug)).timeZone, 'Europe/Lisbon');
});
