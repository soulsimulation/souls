// Replays a recorded kit run from genesis on an exported tree with probe.mjs (logging only); a copy of the #1453 diagnosis
// replay without its commit check (the exports have no repository). Usage: node replay.mjs <runDir> <treeDir> <port> <until> <out.log>
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, cpSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const [runArg, treeArg, port, until, outLog] = process.argv.slice(2), run = resolve(runArg), tree = resolve(treeArg), here = resolve(import.meta.dirname);
const work = `${here}/work-${run.split('/').pop()}`; rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
for (const f of readdirSync(`${run}/data`).filter(f => f.startsWith('sim.db'))) cpSync(`${run}/data/${f}`, `${work}/${f}`);
const sql = (q) => spawnSync('sqlite3', [`${work}/sim.db`, q], { encoding: 'utf8' }).stdout.trim();
sql('delete from snapshots; pragma wal_checkpoint(TRUNCATE);');
const worldId = sql('select world_id from events limit 1'), key = worldId.replace(/-\d+$/, '');
await new Promise((res) => { const p = spawn(process.execPath, ['apps/server/src/main.ts'], { cwd: tree, env: { ...process.env, WORLD_KEY: key, WORLD_ID: worldId, ENGINE: 'mars', PORT: port, DEV_AUTH: '1', BRAIN_MODE: 'fake', SEED_NATIVES: '0', EDGE_FADING: '1', DATA_DIR: work, INVITE_REQUIRED: '0', GENESIS_FILE: `${tree}/worlds/templates/eden-2026.json`, UNTIL: until, NODE_OPTIONS: `--import file://${here}/probe.mjs` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = ''; const on = d => { buf += d; if (/listening on|Error/.test(buf.slice(-2000))) p.kill(); }; p.stdout.on('data', on); p.stderr.on('data', on); p.on('close', () => { writeFileSync(outLog, buf); res(); }); });
console.log('replayed', outLog);
