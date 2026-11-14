// Clip kit (#2281, PR #2293): no template places a `core/television@2`, so admin's god agent places one by the
// hello-hamlet plaza (`eden-god.mjs place`). At 20:30, admin's Soul Tess, the camera following it, switches the TV on,
// changes the channel three times (garden > sea > stars > test-card) and switches it off, each by its offered id.
import { execFile, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cast } from '../_shared/cast.mjs';

cast({ souls: [{ name: 'Tess', owner: 'admin' }], god: 'admin' });
const { CLIP_CHECKOUT = '.', CLIP_WORK } = process.env;
const EDEN = join(CLIP_CHECKOUT, 'tools/world-launcher/soul/eden.mjs'), GOD = join(CLIP_CHECKOUT, 'tools/god-skill/eden-god.mjs');
const DIR = join(CLIP_WORK, 'soul-tess');
const run = (script, cwd, args) => {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 90_000 });
  console.error(`kit: ${args.slice(0, 2).join(' ')} -> ${r.status}: ${(r.stdout + r.stderr).slice(0, 1200)}`);
  return r.stdout + r.stderr;
};

run(GOD, join(CLIP_WORK, 'god'), ['place', 'core/television@2', '--at', '2,-3', '--yaw', '0', '--name', 'tv', '--param', 'variant=flat']);
let TV = null;
for (let i = 0; i < 20 && !TV; i++) {
  TV = /object:([^:\s"']+):switch-on/.exec(run(EDEN, DIR, ['caps', '--search', 'television']))?.[1] ?? null;
  if (!TV) spawnSync('sleep', ['1']);
}
if (!TV) throw Error('kit: the television offers no switch-on');
console.error(`kit: television ${TV}`);

const eden = (args, ms = 60_000) => new Promise((res) => execFile(process.execPath, [EDEN, ...args], { cwd: DIR, encoding: 'utf8', timeout: ms },
  (e, out, err) => { console.error(`kit: ${args.join(' ')} -> ${e ? (e.code ?? 1) : 0}: ${String(out || err).slice(0, 600)}`); res(!e); }));

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Tess', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Tess');
  await page.waitForTimeout(2500);
  await page.mouse.move(640, 400);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(150); }   // closer, the screen in view
  await page.waitForTimeout(1000);
  for (const [act, label] of [['switch-on', 'on'], ['change-channel', 'channel 2'], ['change-channel', 'channel 3'], ['change-channel', 'channel 4'], ['switch-off', 'off']]) {
    await eden(['act', `object:${TV}:${act}`, '--wait', '40', '--json'], 50_000);
    mark(label);
    await page.waitForTimeout(3000);                      // the picture (or the dark glass) on screen
  }
}
