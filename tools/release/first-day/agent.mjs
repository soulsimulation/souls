// The test driver's stand-in for a naive agent's client: pairs a new Soul for the world as `eden.mjs pair` does
// (v2/client/src/pair/pair.mjs), prints the code, waits for the owner's approval on the page, then joins the world
// (`life:join`, the client lane's auto-join, sent here by hand). One JSON line per event on stdout.
//   node agent.mjs <folder> <directory> <world> <gateway> <advert>
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
const ROOT = resolve(import.meta.dirname, '../../..');
const [folder, directory, world, gateway, advert] = process.argv.slice(2);
const home = join(folder, '.souls');
mkdirSync(folder, { recursive: true });
const env = { PATH: process.env.PATH, HOME: process.env.HOME, SOULS_HOME: home, SOULS_REPLICA_PKG: join(ROOT, 'v2/target/wasm-load/pkg'), BRAIN_MODE: 'fake' };
const say = (o) => process.stdout.write(JSON.stringify({ at: Date.now(), ...o }) + '\n');
const run = (args, onLine) => new Promise((ok) => {
  const p = spawn(process.execPath, args, { cwd: folder, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; for (const l of String(d).split('\n')) { try { onLine?.(JSON.parse(l)); } catch { /* not JSON */ } } });
  p.stderr.on('data', () => {});
  p.on('close', (code) => ok({ code, out }));
});
const paired = await run([join(ROOT, 'v2/client/src/pair/pair.mjs'), '--directory', directory, '--world', world, '--gateway', gateway,
  '--device', 'test laptop', '--label', 'claude', '--advert', advert], (j) => { if (j.step === 'approve') say({ step: 'asked', code: j.code }); });
const last = paired.out.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).at(-1);
if (!last?.ok) { say({ step: 'pair-failed', out: paired.out.slice(-400) }); process.exit(1); }
say({ step: 'paired', soul: last.soul });
const cli = join(ROOT, 'v2/client/src/cli/souls.mjs');
const joined = await run([cli, 'act', 'life:join', '--wait', '--soul', last.soul]);
say({ step: 'joined', code: joined.code, out: joined.out.trim().split('\n').at(-1)?.slice(0, 300) });
// keep the daemon's Soul connected for the rest of the take
await new Promise((r) => setTimeout(r, Number(process.env.HOLD_MS ?? 240_000)));
await run([cli, 'quit', '--soul', last.soul]);
