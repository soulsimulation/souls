// node --test tools/world-launcher/handover-reconnect.test.mjs (#2501; a real Eden 2026 world, fake minds, a free block of ports)
// A release's handover, as a visitor's page sees it: the previous launcher generation runs /w/eden (the eden-2026 template,
// as production runs it); the next one adopts it and takes it over with pre-warm (children.mjs takeOver, release = the old
// pool's stop, as keeper.mjs relays it). One viewer socket is held. When it closes, it retries 50 to 150 ms later, as the
// page does, and waits on the next pool the way the launcher's upgrade handler does (pool.ensure). Then it sends hello
// and waits for the welcome. The bar is the release probe's: close to first message on the next socket <= 6500 ms. World
// time never stops: the next process restores the very tick the stopped one saved, and then runs every tick owed for the
// pause. (#2501's fix itself, the first perception pass sliced in the boot catch-up, is held by
// apps/server/src/god/perceive-catch-up.test.ts: whether that pass starts inside a catch-up this short is a matter of timing.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ChildPool, defaultCommand } from './children.mjs';
import { decorateCommand } from './production.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';

const BAR_MS = 6500;   // deploy/release-probe.mjs RECONNECT_BAR_MS
const root = new URL('../../', import.meta.url).pathname;
const P0 = await testPort(6), origin = `http://127.0.0.1:${P0}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('#2501: a handover of Eden 2026 reconnects its viewer within the release bar, and no tick is skipped', { timeout: 600_000 }, async (t) => {
  mkdirSync(join(root, '.local'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local/handover-reconnect-')), logDir = join(dir, 'logs'), pools = [];
  const world = { slug: 'eden', worldKey: 'eden-2026', name: 'Eden', dataDir: join(dir, 'eden'), template: 'eden-2026', templateFile: join(root, 'worlds/templates/eden-2026.json'), bodyCollectionPath: join(dir, 'body-collections.sqlite') };
  const pool = () => { const p = new ChildPool({ root, range: [P0 + 1, P0 + 5], logDir, publicOrigin: origin, healthPath: (s) => `/w/${s}/healthz`, prewarm: true, libraryDir: join(dir, 'library'),
    decorate: (c) => decorateCommand(c, { devAuth: true, publicOrigin: origin, base: '', worldHeapMb: 2048, build: 'dev' }), command: (w, p, o) => defaultCommand(w, p, o) }); pools.push(p); return p; };
  const log = () => { try { return readFileSync(join(logDir, 'eden.log'), 'utf8'); } catch { return ''; } };
  t.after(async () => { for (const p of pools) await p.closeAll().catch(() => {}); if (!process.env.HANDOVER_TEST_KEEP) rmSync(dir, { recursive: true, force: true }); });
  const viewer = (port) => {
    const s = { made: Date.now(), open: null, first: null, close: null, ws: new WebSocket(`ws://127.0.0.1:${port}/w/eden/ws`) };
    s.welcome = new Promise((yes) => { s.ws.onopen = () => { s.open = Date.now(); s.ws.send(JSON.stringify({ t: 'hello', proto: 1 })); }; s.ws.onmessage = () => { if (s.first == null) { s.first = Date.now(); yes(); } }; });
    s.closed = new Promise((yes) => { s.ws.onclose = (e) => { s.close = Date.now(); s.code = e.code; yes(); }; s.ws.onerror = () => {}; });
    return s;
  };
  try {
    const A = pool(), port = await A.ensure(world, { timeoutMs: 300_000 });
    const v = viewer(port); await v.welcome; await sleep(3000);
    const st = A.status('eden'), B = pool();
    B.adopt(world, { port: st.port, pid: st.pid, script: 'apps/server/src/main.ts', healthPort: st.healthPort, readPorts: st.readPorts });
    const before = log().length;
    const again = v.closed.then(async () => { await sleep(50 + Math.random() * 100); return viewer(await B.ensure(world, { timeoutMs: 120_000 })); });
    await B.takeOver('eden', (s) => A.stop(s));
    const next = await again; await next.welcome;
    const reconnectMs = next.first - v.close;
    t.diagnostic(`reconnect ${reconnectMs} ms (bar ${BAR_MS}): previous process stopped in ${B.state('eden').releaseMs} ms, 101 at +${next.open - v.close} ms`);
    assert.ok(reconnectMs <= BAR_MS, `the viewer's welcome came ${reconnectMs} ms after its close (bar ${BAR_MS} ms)`);
    next.ws.close();
    // world time never stops: the tick saved at the stop is the tick restored, and the pause's ticks are all run
    let lines = ''; for (let i = 0; i < 600 && !/\[clock\] caught up \d+ ticks/.test(lines); i++) { await sleep(50); lines = log().slice(before); }
    const saved = Number(/\[world\] SIGTERM: saving snapshot at tick (\d+)/.exec(lines)?.[1]), restored = /\[world\] \S+ booted from (\w+), tick (\d+)/.exec(lines);
    assert.equal(restored?.[1], 'snapshot', 'the next process boots from the snapshot the stopped one saved');
    assert.equal(Number(restored[2]), saved, 'it restores the very tick the stopped process saved');
    const owed = Number(/\[clock\] (\d+) ticks owed to the wall/.exec(lines)?.[1]), caught = /\[clock\] caught up (\d+) ticks/.exec(lines);
    assert.ok(owed > 0 && Number(caught?.[1]) >= owed, `the ticks owed for the pause run (${owed} owed, ${caught?.[1]} run)`);
    // none dropped: a host slower than the wall (a loaded runner) may end the catch-up still owing a tick or two, which the
    // running clock then runs first (WorldHost.oweToClock); a dropped tick says "not run"
    assert.doesNotMatch(lines, /ticks still owed when the catch-up stopped[^\n]*not run/);
  } catch (e) { t.diagnostic(`--- eden.log\n${log().slice(-6000)}`); throw e; }
});
