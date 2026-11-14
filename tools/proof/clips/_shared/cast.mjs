// Setup shared by clip kits (timed-run.yml `clip`): Souls for local dev users and an optional god agent on the clip's
// fake-mind dev world, each with its agent listening for the whole take, so no owner's card shows the Reconnect box and
// the god box shows no start prompt. Runs when the recorder imports a kit's steps, before the page opens.
// CLIP_WORLD is the world's base URL, CLIP_CHECKOUT the ref's checkout, CLIP_WORK a per-run scratch folder.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { CLIP_WORLD, CLIP_CHECKOUT = '.', CLIP_WORK } = process.env;
const EDEN = join(CLIP_CHECKOUT, 'tools/world-launcher/soul/eden.mjs'), GOD = join(CLIP_CHECKOUT, 'tools/god-skill/eden-god.mjs');
let ended = false;
process.once('exit', () => { ended = true; });

function cli(script, cwd, args) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw Error(`${args[0]} failed (${r.status}): ${(r.stderr || r.stdout).split('\n').filter(Boolean).at(-1)?.slice(0, 300)}`);
  return r.stdout;
}
/** Keep `listen` running in cwd until the recorder exits (it ends when the owner writes, so it starts again). */
function hold(script, cwd) {
  let held = null;
  const again = () => {
    if (ended) return;
    held = spawn(process.execPath, [script, 'listen'], { cwd, stdio: 'ignore' });
    held.unref();
    held.once('exit', () => setTimeout(again, 1000).unref());
  };
  again();
  process.once('exit', () => held?.kill());
}

/** cast({ souls: [{ name, owner }], god: 'admin' | null }): each Soul made by dev:<owner> and held; the god minted for
 *  dev:<god> (the dev world's owner is admin) and held. */
export function cast({ souls = [], god = null }) {
  if (!CLIP_WORLD || !CLIP_WORK) throw Error('cast: CLIP_WORLD and CLIP_WORK are set by timed-run.yml `clip`');
  for (const s of souls) {
    const dir = join(CLIP_WORK, `soul-${s.name.toLowerCase()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ identity: s.owner }));
    cli(EDEN, dir, ['register', CLIP_WORLD]);
    cli(EDEN, dir, ['create', s.name]);
    hold(EDEN, dir);
  }
  if (god) {
    const dir = join(CLIP_WORK, 'god');
    mkdirSync(dir, { recursive: true });
    cli(GOD, dir, ['register', CLIP_WORLD, `dev:${god}`]);
    cli(GOD, dir, ['mint']);
    hold(GOD, dir);
  }
}
