#!/usr/bin/env node
// The new-engine playtest world, end to end (0.135 P1): a template exported by `import-eden --template`, served by
// `v2/tools/dev/run.sh`; seats paired as v2/client/served/e2e pairs them, each joining and acting through the new
// client's thin command; the observer playing the public stream and reading the gateway's answers. Fake minds (no
// model runs anywhere), loopback only, everything under an ignored .local/ folder. Nothing starts apps/server.
//
//   node tools/playtest/arena/new-engine/smoke.mjs [--template worlds/templates/hello-hamlet.json] [--seats 2] [--walk-to bench]
//        [--out <dir>] [--keep]
//
// run.sh builds what is missing (or reads V2_BIN, V2_REPLICA_PKG, V2_WEB); SOULS_REPLICA_PKG names the client's and the
// observer's replica package (default v2/target/wasm-load/pkg). Prints one line per check and a JSON summary; exit 0
// when every check passes.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain } from '../../../lib/is-main.mjs';
import { REPO_ROOT } from '../../../lib/paths.mjs';
import { startWorld, stopWorld, healthz } from './world.mjs';
import { pairSeat } from './seat.mjs';
import { streamViewer, closeViewers } from '../../observer/new-engine/stream.mjs';
import { receiptReader, finalBySequence } from '../../observer/new-engine/receipts.mjs';

const LABELS = ['alder', 'birch', 'cedar', 'dogwood', 'elm', 'fir'];

/** The command lines of a process group, read with ps (the run's own programs). */
export function groupCommands(pgid) {
  try { return execFileSync('ps', ['-ax', '-o', 'pgid=,command='], { encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter((l) => l.startsWith(`${pgid} `)).map((l) => l.slice(String(pgid).length + 1)); }
  catch { return []; }
}
/** True when no command line runs the old world's server. */
export const noOldServer = (commands) => !commands.some((c) => /apps\/server\/src\/main\.ts|tools\/world-launcher\/launcher\.mjs/.test(c));

export async function smoke({ template = 'worlds/templates/hello-hamlet.json', seats: count = 2, walkTo = 'bench', out, keep = false, log = console.log }) {
  const rows = [];
  const check = (what, pass, detail) => { rows.push({ what, pass: !!pass, detail }); log(`${pass ? 'PASS' : 'FAIL'} ${what}: ${detail}`); };
  const dir = resolve(out);
  mkdirSync(dir, { recursive: true });
  let world = null;
  const seats = [];
  try {
    world = await startWorld({ template, dir: join(dir, 'world') });
    const boot = await healthz(world);
    check('world', boot.ok && boot.body?.world === 'dev', `run.sh ready in ${(world.bootMs / 1000).toFixed(1)} s with ${template}; bootstrap ${boot.status}`);
    const commands = groupCommands(world.pid);
    check('no apps/server', noOldServer(commands) && commands.some((c) => c.includes('worldd serve')), `${commands.length} programs in the run's group, none the old server`);

    const viewer = await streamViewer({ world });
    for (const label of LABELS.slice(0, count)) seats.push(await pairSeat({ world, dir: join(dir, 'seats'), label }));
    check('paired', seats.every((s) => /^s_|^[0-9a-f]/.test(s.soul ?? '')), seats.map((s) => `${s.label} ${s.soul}`).join(', '));
    for (const s of seats) await s.join();
    const bodies = seats.map((s) => s.info().body);
    check('joined', bodies.every(Boolean), seats.map((s) => `${s.label} ${s.info().body}`).join(', '));

    const seen = await viewer.until((v) => bodies.every((b) => v.node(b)), 30_000);
    check('stream: bodies', seen, `${viewer.bodies().length} bodies in the public stream, ${viewer.parts} parts played${viewer.errors.length ? `; errors ${viewer.errors[0].slice(0, 200)}` : ''}`);

    // The new client's commands: a say, and a walk to a thing found by its words.
    const [a] = seats;
    const words = `playtest ${a.label} says hello`;
    const said = await a.cli('say', words);
    const heard = await viewer.until((v) => v.said().some((x) => x.speaker === a.info().body && x.words === words), 20_000);
    check('stream: said', said.ok && heard, `${a.label}'s say (intent ${said.sequence}) is in the public stream with its words`);
    const start = viewer.node(a.info().body)?.pos ?? null;
    const there = ((await a.cli('find', walkTo)).found ?? []).find((r) => !r.kind?.startsWith('souls:body'));
    const walk = there ? await a.cli('act', there.id, '--wait') : null;
    const moved = await viewer.until((v) => { const p = v.node(a.info().body)?.pos; return p && start && Math.hypot(p[0] - start[0], p[2] - start[2]) > 500_000; }, 20_000);
    check('stream: walk', walk?.ok !== false && walk?.phase !== 'refused' && moved, `${a.label} walks to ${there?.id ?? `nothing found for "${walkTo}"`}: ${JSON.stringify(walk?.phase ?? walk).slice(0, 160)}; the stream moves its body`);

    const reader = receiptReader(a);
    const answers = finalBySequence(await reader.read());
    const outcomes = [...answers.values()].map((r) => `${r.sequence}:${r.outcome}${r.reason ? `(${r.reason})` : ''}`);
    check('receipts', [...answers.values()].filter((r) => r.outcome === 'receipt').length >= 2, `${a.label}'s answers from the gateway: ${outcomes.join(' ')}`);
    closeViewers();
  } catch (e) {
    check('run', false, String(e?.stack ?? e).slice(0, 600));
  } finally {
    for (const s of seats) await s.stop();
    if (world && !keep) await stopWorld(world);
  }
  const pass = rows.length > 0 && rows.every((r) => r.pass);
  const summary = { pass, template, seats: count, world: world ? { boot_ms: world.bootMs, page: '<loopback>/w/dev/' } : null, checks: rows };
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const summary = await smoke({ template: opt('template'), seats: Number(opt('seats', 2)), walkTo: opt('walk-to'), out: opt('out', join(REPO_ROOT, '.local/playtest-v2', `smoke-${stamp}`)), keep: argv.includes('--keep') });
  console.log(JSON.stringify(summary));
  process.exit(summary.pass ? 0 : 1);
}
