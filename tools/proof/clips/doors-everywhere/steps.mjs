// Clip kit (#2383): in Eden 2026, two building types whose outside doorways now hold real doors, both closed: the dome
// (core/roundhouse@2) and the bakery (core/hall@3). Each walk into a building starts far from it (review of #2397: a long
// walk is planned through the door from the start, not stopped short of it). Before the take, admin's Soul Clara runs to
// the bakery's front, about 55 m from the dome. On camera (Ctrl+K, Enter follows Clara) she runs from there into the dome,
// opening its door by hand and closing it behind her, walks back out through it, then runs from the dome about 55 m into
// the bakery's shop the same way (one closed door per walk).
import { execFile, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cast } from '../_shared/cast.mjs';

cast({ souls: [{ name: 'Clara', owner: 'admin' }] });
const { CLIP_CHECKOUT = '.', CLIP_WORK } = process.env;
const EDEN = join(CLIP_CHECKOUT, 'tools/world-launcher/soul/eden.mjs');
const DIR = join(CLIP_WORK, 'soul-clara');
const run = (script, cwd, args, ms = 90_000) => {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: ms });
  console.error(`kit: ${args.slice(0, 3).join(' ')} -> ${r.status}: ${(r.stdout + r.stderr).slice(0, 1200)}`);
  return r;
};

// the bakery (int-bakery, a hall turned east) stands at (77.5, -15.5); the dome (eden-dome) about 55 m north-east
for (let i = 0; i < 30; i++) {                            // a world just up may not give its catalog yet (503)
  if (run(EDEN, DIR, ['catalog']).status === 0) break;
  spawnSync('sleep', ['2']);
}
run(EDEN, DIR, ['act', 'walk:int-bakery', '--run', '--wait', '150', '--json'], 170_000);  // off camera: the bakery's front, ~55 m from the dome

const eden = (args, ms) => new Promise((res) => execFile(process.execPath, [EDEN, ...args], { cwd: DIR, encoding: 'utf8', timeout: ms },
  (e, out, err) => { console.error(`kit: ${args.join(' ')} -> ${e ? (e.code ?? 1) : 0}: ${String(out || err).slice(0, 1200)}`); res(!e); }));

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Clara', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Clara at the bakery front, ~55 m from the dome (core/roundhouse@2), its doors closed');
  await page.waitForTimeout(1500);
  mark('one walk from ~55 m away: run into the dome');
  await eden(['act', 'walk:eden-dome', '--run', '--wait', '60', '--json'], 70_000);
  mark('inside the dome, door closed behind');
  await page.waitForTimeout(1000);
  mark('walk back out through the dome door');
  await eden(['act', 'walk:street-bicycle-bike-9', '--wait', '30', '--json'], 40_000);
  mark('one walk from ~55 m away: run into the bakery (core/hall@3) shop, its door closed');
  await eden(['act', 'walk:int-bakery/shop', '--run', '--wait', '60', '--json'], 70_000);
  mark('inside the bakery, door closed behind');
  await page.waitForTimeout(1500);
}
