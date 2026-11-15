// Clip kit (#2302): the native Eden core (kit.json `eden: true`) with its classroom; classroom-tv/1 has made the
// screen a TV. Before the take, admin's Soul Tess walks into the classroom in front of the screen and switches it off.
// At 20:30, the camera following Tess, she switches it on (the lesson), changes the picture four times (garden > sea >
// stars > test card) and switches it off, each by its offered id.
import { execFile, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cast } from '../_shared/cast.mjs';

cast({ souls: [{ name: 'Tess', owner: 'admin' }] });
const { CLIP_CHECKOUT = '.', CLIP_WORK } = process.env;
const EDEN = join(CLIP_CHECKOUT, 'tools/world-launcher/soul/eden.mjs'), DIR = join(CLIP_WORK, 'soul-tess'), TV = 'eden-classroom-screen-1';
const run = (args, ms = 150_000) => {
  const r = spawnSync(process.execPath, [EDEN, ...args], { cwd: DIR, encoding: 'utf8', timeout: ms });
  console.error(`kit: ${args.slice(0, 2).join(' ')} -> ${r.status}: ${(r.stdout + r.stderr).slice(0, 600)}`);
  return r.stdout + r.stderr;
};
run(['act', 'walk:eden-classroom-1', '--wait', '120', '--json']);
run(['act', 'walk-to:here', '{"at":[40.6,-13.6]}', '--wait', '60', '--json']);
if (!/"accepted": true/.test(run(['act', `object:${TV}:switch-off`, '--wait', '40', '--json']))) throw Error('kit: the classroom TV took no switch-off');

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
  await page.waitForTimeout(3500);
  for (const [act, label] of [['switch-on', 'on: the lesson'], ['change-picture', 'garden'], ['change-picture', 'sea'], ['change-picture', 'stars'], ['change-picture', 'test card'], ['switch-off', 'off']]) {
    await eden(['act', `object:${TV}:${act}`, '--wait', '40', '--json'], 50_000);
    mark(label);
    await page.waitForTimeout(3000);                      // the picture (or the dark glass) on screen
  }
}
