// Clip kit (#2621, A13): in Eden 2026, twelve new Souls join one a second, each by its own owner, while the camera
// follows the first at the arrival point. Each birth is placed on the live engine (no full-world checkpoint), so the
// world keeps moving while they arrive. Setup registers the twelve owners; the creates run during the take.
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { CLIP_WORLD, CLIP_CHECKOUT = '.', CLIP_WORK } = process.env;
if (!CLIP_WORLD || !CLIP_WORK) throw Error('join-burst: CLIP_WORLD and CLIP_WORK are set by timed-run.yml `clip`');
const EDEN = join(CLIP_CHECKOUT, 'tools/world-launcher/soul/eden.mjs'), N = 12;
const joiners = Array.from({ length: N }, (_, i) => ({ name: `Joiner${i + 1}`, dir: join(CLIP_WORK, `joiner-${i + 1}`) }));
for (const [i, j] of joiners.entries()) {
  mkdirSync(j.dir, { recursive: true });
  writeFileSync(join(j.dir, '.eden-agent.json'), JSON.stringify({ identity: `joiner${i + 1}` }));
  const r = spawnSync(process.execPath, [EDEN, 'register', CLIP_WORLD], { cwd: j.dir, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw Error(`register ${j.name} failed (${r.status}): ${(r.stderr || r.stdout).slice(-300)}`);
}
const create = (j) => new Promise((res) => {
  const t0 = Date.now();
  execFile(process.execPath, [EDEN, 'create', j.name], { cwd: j.dir, encoding: 'utf8', timeout: 180_000 },
    (e, out, err) => res({ name: j.name, code: e ? (e.code ?? 1) : 0, ms: Date.now() - t0, tail: String(err || out).slice(-200) }));
});

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2500);
  mark(`${N} Souls join, one a second`);
  const done = [];
  for (const j of joiners) { done.push(create(j)); await page.waitForTimeout(1000); }
  const first = await done[0];
  console.error(`kit: ${JSON.stringify(first)}`);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type(joiners[0].name, { delay: 100 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark(`follow ${joiners[0].name} at the arrival point`);
  const all = await Promise.all(done);
  console.error(`kit: ${JSON.stringify(all)}`);
  mark(`${all.filter((r) => r.code === 0).length} of ${N} joined`);
  await page.waitForTimeout(6000);                        // the newcomers at the arrival point, the world still moving
}
