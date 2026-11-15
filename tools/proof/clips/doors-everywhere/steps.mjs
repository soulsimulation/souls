// Clip kit (#2383): in Eden 2026, two building types whose outside doorways now hold real doors, both closed: the bakery
// (core/hall@3) and the dome (core/roundhouse@2). (The A-frame cottage's door has a street flower pot 1.3 m from it, where
// the hand stands to open it: refused contact.step-blocked.) Before the take, admin's Soul Clara runs to the bakery's front.
// On camera (Ctrl+K, Enter follows Clara) she walks into the bakery's shop, opening its door by hand and closing it
// behind her, back out through it to the bakery's front, then into the dome the same way (one closed door per walk: two in
// a row wait for #2370's multi-door walk).
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
  // a long walk plans the far ground coarsely and meets the shut door only on arrival (route.unreachable at 8 m): walk to
  // the dome's south door first, then in, so the walk that goes through the door starts beside it
  mark('walk to the dome (core/roundhouse@2), its doors closed');
  await eden(['act', 'walk:street-bicycle-bike-9', '--wait', '75', '--json'], 85_000);
  mark('walk into the dome');
  await eden(['act', 'walk:eden-dome', '--wait', '30', '--json'], 40_000);
  mark('inside the dome, door closed behind');
  await page.waitForTimeout(3000);
}
