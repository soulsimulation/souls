// Clip kit (#2383), part 1 of 2 (part 2: doors-everywhere-bakery): in Eden 2026, the dome (core/roundhouse@2), whose
// outside doorways now hold real doors, closed. The walk in starts far from it (review of #2397: a long walk is planned
// through the door from the start, not stopped short of it). Before the take, admin's Soul Clara runs to the bakery's
// front, about 55 m from the dome. On camera (Ctrl+K, Enter follows Clara) she runs from there into the dome, opening its
// door by hand and closing it behind her, then walks back out through it.
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
  await eden(['act', 'walk:eden-dome', '--run', '--wait', '80', '--json'], 90_000);
  mark('inside the dome, door closed behind');
  await page.waitForTimeout(1000);
  mark('walk back out through the dome door');
  await eden(['act', 'walk:street-bicycle-bike-9', '--wait', '40', '--json'], 50_000);
  await page.waitForTimeout(1000);
}
