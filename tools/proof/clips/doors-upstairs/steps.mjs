// Clip kit (#2434): in Eden 2026, one walk from far away into an upstairs room behind two closed doors. The townhouse
// canal-west-home-3 (core/townhouse@3) has a real door in every doorway: its front door (closed) and, on the first floor,
// the bedroom's door (canal-west-home-3-door-3). Before the take, admin's Soul Clara goes up to the landing, shuts the
// bedroom door by hand, and runs out to the bakery's front, about 45 m away (the front door shut behind her). On camera
// (Ctrl+K, Enter follows Clara) one walk takes her from there through the front door, up the stairs and through the
// bedroom door, opening each by hand and closing it behind her.
import { execFile, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cast } from '../_shared/cast.mjs';

cast({ souls: [{ name: 'Clara', owner: 'admin' }] });
const { CLIP_CHECKOUT = '.', CLIP_WORK } = process.env;
const EDEN = join(CLIP_CHECKOUT, 'tools/world-launcher/soul/eden.mjs');
const DIR = join(CLIP_WORK, 'soul-clara');
const run = (args, ms = 170_000) => {
  const r = spawnSync(process.execPath, [EDEN, ...args], { cwd: DIR, encoding: 'utf8', timeout: ms });
  console.error(`kit: ${args.slice(0, 3).join(' ')} -> ${r.status}: ${(r.stdout + r.stderr).slice(0, 1200)}`);
  return r;
};

for (let i = 0; i < 30; i++) {                            // a world just up may not give its catalog yet (503)
  if (run(['catalog'], 90_000).status === 0) break;
  spawnSync('sleep', ['2']);
}
// off camera: up to the landing, the bedroom door shut by hand, then out to the bakery's front (~45 m away)
run(['act', 'walk:canal-west-home-3/landing', '--run', '--wait', '150', '--json']);
const caps = run(['caps', '--search', 'canal-west-home-3-door-3'], 90_000), out = caps.stdout + caps.stderr;
const door = /object:([^:\s"']+):close[^}]*canal-west-home-3-door-3"/s.exec(out)?.[1];
if (door) run(['act', `object:${door}:close`, '--wait', '60', '--json'], 90_000);   // else it is shut already (only "open" offered)
run(['act', 'walk:int-bakery', '--run', '--wait', '150', '--json']);

const eden = (args, ms) => new Promise((res) => execFile(process.execPath, [EDEN, ...args], { cwd: DIR, encoding: 'utf8', timeout: ms },
  (e, out, err) => { console.error(`kit: ${args.join(' ')} -> ${e ? (e.code ?? 1) : 0}: ${String(out || err).slice(0, 1200)}`); res(!e); }));

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Clara', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Clara at the bakery front, ~45 m from canal-west-home-3; its front door and its first-floor bedroom door closed');
  await page.waitForTimeout(1200);
  mark('one walk: run to the upstairs bedroom, through both doors');
  await eden(['act', 'walk:canal-west-home-3/bedroom', '--run', '--wait', '84', '--json'], 88_000);
  mark('in the upstairs bedroom, both doors closed behind');
  await page.waitForTimeout(1000);
}
