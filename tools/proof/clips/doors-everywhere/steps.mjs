// Clip kit (#2383): in Eden 2026, two building types whose outside doorways now hold real doors, both closed: the A-frame
// cottage (core/cottage@2) and the bakery (core/hall@3). Before the take, admin's Soul Clara runs to the bakery's front.
// On camera (Ctrl+K, Enter follows Clara) she walks into the bakery's shop, opening its door by hand and closing it
// behind her, back out through it to the bakery's front, then into the A-frame cottage's living room the same way (one
// closed door per walk: two in a row wait for #2370's multi-door walk).
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

// the bakery (int-bakery, a hall turned east) stands at (77.5, -15.5); the A-frame cottage at (76.5, -25.5), 10 m south
for (let i = 0; i < 30; i++) {                            // a world just up may not give its catalog yet (503)
  if (run(EDEN, DIR, ['catalog']).status === 0) break;
  spawnSync('sleep', ['2']);
}
run(EDEN, DIR, ['act', 'walk:int-bakery', '--run', '--wait', '150', '--json'], 170_000);  // off camera: to the bakery's front

const eden = (args, ms) => new Promise((res) => execFile(process.execPath, [EDEN, ...args], { cwd: DIR, encoding: 'utf8', timeout: ms },
  (e, out, err) => { console.error(`kit: ${args.join(' ')} -> ${e ? (e.code ?? 1) : 0}: ${String(out || err).slice(0, 1200)}`); res(!e); }));

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Clara', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Clara, at the bakery (core/hall@3), its door closed');
  await page.waitForTimeout(3500);
  mark('walk into the bakery shop');
  await eden(['act', 'walk:int-bakery/shop', '--wait', '60', '--json'], 70_000);
  mark('inside the bakery, door closed behind');
  await page.waitForTimeout(3000);
  mark('walk back out through the bakery door to its front');
  await eden(['act', 'walk:int-bakery', '--wait', '60', '--json'], 70_000);
  mark('walk into the A-frame cottage (core/cottage@2) living room, its door closed');
  await eden(['act', 'walk:eden-a-frame/living', '--wait', '60', '--json'], 70_000);
  mark('inside the cottage, door closed behind');
  await page.waitForTimeout(3000);
}
