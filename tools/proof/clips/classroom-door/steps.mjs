// Clip kit (#2282, PR #2284): in Eden 2026, the classroom's south doorway holds a core/door@2, closed, swinging outward.
// Before the take, admin's god agent puts a lamp a few metres outside that door and admin's Soul Clara runs to it. On
// camera (Ctrl+K, Enter follows Clara) she walks into the classroom: she opens the door outward by hand, walks through
// and closes it behind her; then she walks back out to the lamp the same way.
import { execFile, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cast } from '../_shared/cast.mjs';

cast({ souls: [{ name: 'Clara', owner: 'admin' }], god: 'admin' });
const { CLIP_CHECKOUT = '.', CLIP_WORK } = process.env;
const EDEN = join(CLIP_CHECKOUT, 'tools/world-launcher/soul/eden.mjs'), GOD = join(CLIP_CHECKOUT, 'tools/god-skill/eden-god.mjs');
const DIR = join(CLIP_WORK, 'soul-clara');
const run = (script, cwd, args, ms = 90_000) => {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: ms });
  console.error(`kit: ${args.slice(0, 3).join(' ')} -> ${r.status}: ${(r.stdout + r.stderr).slice(0, 1200)}`);
  return r;
};

// the classroom stands at (42, -8.5), 19 m deep: its south door is at (42, 0.89) and opens toward +z
run(GOD, join(CLIP_WORK, 'god'), ['place', 'core/floor-lamp@2', '--at', '44,5', '--name', 'clip-lamp']);
let OUT = null;
for (let i = 0; i < 30 && !OUT; i++) {                    // a world just up may not give its catalog yet (503)
  OUT = /walk:([^\s"']*clip-lamp[^\s"']*)/.exec(run(EDEN, DIR, ['caps', '--search', 'clip-lamp', '--verb', 'walk', '--all']).stdout)?.[0] ?? null;
  if (!OUT) spawnSync('sleep', ['2']);
}
if (!OUT) throw Error('kit: no walk to the lamp is offered');
run(EDEN, DIR, ['act', OUT, '--run', '--wait', '150', '--json'], 170_000);  // off camera: to the lamp outside the door

const eden = (args, ms) => new Promise((res) => execFile(process.execPath, [EDEN, ...args], { cwd: DIR, encoding: 'utf8', timeout: ms },
  (e, out, err) => { console.error(`kit: ${args.join(' ')} -> ${e ? (e.code ?? 1) : 0}: ${String(out || err).slice(0, 1200)}`); res(!e); }));

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Clara', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Clara, outside the classroom door (closed)');
  await page.waitForTimeout(3500);
  mark('walk into the classroom');
  await eden(['act', 'walk:eden-classroom-1/classroom', '--wait', '60', '--json'], 70_000);
  mark('inside, door closed behind');
  await page.waitForTimeout(3000);
  mark('walk back out to the lamp');
  await eden(['act', OUT, '--wait', '60', '--json'], 70_000);
  mark('outside, door closed behind');
  await page.waitForTimeout(3000);
}
