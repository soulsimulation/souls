// Clip kit (#2279): signed in as admin (the world's owner) with its god agent listening, open God Mode (Ctrl+G) and type
// a command without sending it; the agent stops listening, its lease runs out and the gateway covers the console; the
// agent listens again and the console comes back with the typed text. The page's requests carry a documentation
// placeholder as forwarded host, so the gateway's connect line shows world.example and not the runner's address.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const { CLIP_WORLD, CLIP_CHECKOUT = '.', CLIP_WORK } = process.env;
if (!CLIP_WORLD || !CLIP_WORK) throw Error('god-gateway-drop: CLIP_WORLD and CLIP_WORK are set by timed-run.yml `clip`');
const GOD = join(CLIP_CHECKOUT, 'tools/god-skill/eden-god.mjs'), DIR = join(CLIP_WORK, 'god');
const DRAFT = 'a ring of lanterns around the well';
const cli = (args) => {
  const r = spawnSync(process.execPath, [GOD, ...args], { cwd: DIR, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw Error(`${args[0]} failed (${r.status}): ${(r.stderr || r.stdout).split('\n').filter(Boolean).at(-1)?.slice(0, 300)}`);
};
mkdirSync(DIR, { recursive: true });
cli(['register', CLIP_WORLD, 'dev:admin']);
cli(['mint']);

// The god agent's listen, kept running until release() (cast.mjs's hold, with a stop).
let holding = false, held = null;
function hold() {
  holding = true;
  const again = () => {
    if (!holding) return;
    held = spawn(process.execPath, [GOD, 'listen'], { cwd: DIR, stdio: 'ignore' });
    held.unref();
    held.once('exit', () => { held = null; setTimeout(again, 1000).unref(); });
  };
  again();
}
function release() { holding = false; held?.kill(); }
process.once('exit', release);
hold();

const hasDraft = (t) => [...document.querySelectorAll('textarea')].some((e) => e.value === t && e.checkVisibility());
const gateway = () => /Connect your agent to God mode/.test(document.body.innerText);

export default async function steps(page, { mark }) {
  await page.setExtraHTTPHeaders({ 'x-forwarded-host': 'world.example' });
  await page.waitForTimeout(1500);
  await page.keyboard.press('Control+g');
  await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 20_000 });
  mark('console');
  await page.locator('textarea').first().click();
  await page.keyboard.type(DRAFT, { delay: 70 });
  mark('typed');
  release();
  mark('agent stops listening');
  await page.waitForFunction(gateway, null, { timeout: 85_000, polling: 500 });
  mark('gateway');
  await page.waitForTimeout(2500);
  hold();
  mark('agent listens again');
  await page.waitForFunction(hasDraft, DRAFT, { timeout: 20_000, polling: 250 }).then(() => mark('draft kept'), () => mark('draft not seen'));
  await page.waitForTimeout(3000);
}
