#!/usr/bin/env node
// A release reload on this machine, watched by the release probe (R14): the keeper and launcher of this checkout, one
// Eden 2026 world (fake minds), release-probe.mjs in real headless Chrome on its page, then one SIGHUP handover (what
// activate.sh's `systemctl reload` does) and the probe's bar. Nothing outside <out> is written; no production anything.
//
//   node tools/world-launcher/deploy/reload-local.mjs [--out .local/reload-local/<ts>] [--port 24900] [--after-s 30]
//        [--settle-s 10] [--warm-s 20]
//
// Needs: pnpm install, the web build (pnpm -C apps/web build) and Google Chrome (the probe's `channel: 'chrome'`). The
// new generation runs the same code as the old one: what is measured is the reload itself (stop, standby go, boot,
// /healthz, the viewer's upgrade), as production's probe measures it (reconnectMs, heldMs; bar RECONNECT_BAR_MS).
// Exit: the probe's own (0 pass, 1 fail, 3 rolled back); 2 when the setup could not run.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const out = resolve(flag('out', join(ROOT, '.local/reload-local', new Date().toISOString().replace(/[:.]/g, '-'))));
const port = Number(flag('port', 24900)), afterS = Number(flag('after-s', 30)), settleS = Number(flag('settle-s', 10)), warmS = Number(flag('warm-s', 20));
const data = join(out, 'data'), origin = `http://127.0.0.1:${port}`, PROBE = join(out, 'probe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => console.log(`[reload-local] ${s}`);
if (!existsSync(join(ROOT, 'apps/web/dist/index.html'))) { console.error('no web build: pnpm -C apps/web build'); process.exit(2); }
mkdirSync(data, { recursive: true });
// Eden 2026 is a hidden template (public creation never offers it): a copy of the templates with it shown, for --templates-dir
const templates = join(out, 'templates'); mkdirSync(templates, { recursive: true });
for (const f of readdirSync(join(ROOT, 'worlds/templates')).filter((f) => f.endsWith('.json'))) {
  const t = JSON.parse(readFileSync(join(ROOT, 'worlds/templates', f), 'utf8'));
  if (f === 'eden-2026.json') delete t.hidden;
  writeFileSync(join(templates, f), JSON.stringify(t));
}

const children = [];
const run = (name, args, env = {}) => {
  const c = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, BRAIN_MODE: 'fake', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = join(out, `${name}.log`); let buf = '';
  const keep = (d) => { buf += d; writeFileSync(log, buf); };
  c.stdout.on('data', keep); c.stderr.on('data', keep); children.push(c);
  c.done = new Promise((r) => c.once('exit', (code) => r(code)));
  return c;
};
const status = () => { try { return JSON.parse(readFileSync(join(data, 'keeper.json'), 'utf8')); } catch { return null; } };
async function until(what, ok, ms) {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) { try { if (await ok()) return; } catch { /* not yet */ } await sleep(250); }
  throw new Error(`${what}: not within ${ms / 1000} s`);
}
let code = 2;
try {
  // the keeper and its launcher (the dev sign-in, no Clerk), one world kept running, as production keeps Eden
  const keeper = run('keeper', ['tools/world-launcher/keeper.mjs', '--link', ROOT, '--port', String(port), '--data', data, '--range', `${port + 1}-${port + 40}`, '--eager', '1', '--templates-dir', templates]);
  await until('launcher', async () => (await fetch(`${origin}/__sim/healthz`)).ok, 120_000);
  const made = await (await fetch(`${origin}/__sim/worlds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Reload Eden', template: 'eden-2026' }) })).json();
  if (!made?.slug) throw new Error(`world not created: ${JSON.stringify(made).slice(0, 300)}`);
  const page = `/w/${made.slug}/`;
  await until('world', async () => (await fetch(`${origin}${page}healthz`)).ok, 300_000);
  say(`world ${made.slug} up; it runs ${warmS} s before the probe starts`); await sleep(warmS * 1000);
  // the probe, as eyes.mjs runs it (desktop and phone on the same page), without the CLI loop
  // both generations run this checkout, so the build the pages must end on is the one they start on
  const build = (await (await fetch(`${origin}${page}healthz`)).json()).build;
  const probe = run('probe', ['tools/world-launcher/deploy/release-probe.mjs', '--origin', origin, '--pages', page, '--phone-pages', page, '--out', PROBE, '--after-s', String(afterS), '--settle-s', String(settleS), '--expect-build', build]);
  await Promise.race([until('probe ready', () => existsSync(join(PROBE, 'ready')), 300_000), probe.done.then((c) => { throw new Error(`the probe exited (${c}) before it was ready`); })]);
  // the reload: activate.sh's reload, a SIGHUP to the keeper, done once keeper.json's handover ends
  const before = status()?.handover?.startedAt ?? null;
  say('probe ready: reloading (SIGHUP)'); keeper.kill('SIGHUP');
  await until('handover', () => { const h = status()?.handover; return h && h.startedAt !== before && ['done', 'failed', 'rolled-back'].includes(h.state); }, 600_000);
  const h = status().handover;
  say(`handover ${h.state} in ${h.ms} ms: ${Object.entries(h.worlds ?? {}).map(([s, w]) => `${s} ${w.ms} ms${w.warm?.ok ? ` (pre-warmed ${w.warm.ms} ms)` : ''}`).join(', ')}`);
  writeFileSync(join(PROBE, 'released'), new Date().toISOString());
  code = await probe.done;
  const bar = JSON.parse(readFileSync(join(PROBE, 'report.json'), 'utf8')).bar;
  writeFileSync(join(out, 'result.json'), JSON.stringify({ at: new Date().toISOString(), handover: h, bar }, null, 1) + '\n');
  say(`probe ${bar.pass ? 'PASS' : 'FAIL'} (exit ${code}): reconnectMaxMs ${bar.reconnectMaxMs} (bar ${bar.reconnectBarMs}), held ${bar.reconnectHeldMaxMs} ms, retry ${bar.reconnectRetryMaxMs} ms, drops ${bar.drops}, Reconnecting ${bar.reconnectingShown.join('; ') || 'never shown'}, error pages ${bar.errorPages}, host load ${bar.hostLoad.join(' -> ')}`);
  say(`all files in ${out}`);
} catch (e) { console.error(`[reload-local] ${e.message} (logs in ${out})`); code = 2; }
finally {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  await Promise.race([Promise.all(children.map((c) => c.done)), sleep(60_000)]);
}
process.exit(code);
