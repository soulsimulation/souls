// #1952 counted stair playtest (lane 7): the #1334 A9 stair kit (.local/b/strand2/run.mjs) with no stranding preload.
// Ten fake-mind Souls cross on the Village Tower House stair. Usage: node run.mjs <arm> <repoDir> <port> <outDir>
// Fresh local eden-2026 dev world (fake minds, dev auth, invites off). Real HTTP through the Soul CLI. Records, never judges: score.mjs judges.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const [arm, repoArg, port, outArg] = process.argv.slice(2);
const repo = resolve(repoArg), out = resolve(outArg), slug = `e3${arm}`, logFile = `${repo}/.lane/${slug}.log`;
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true }); mkdirSync(`${repo}/.lane`, { recursive: true }); rmSync(logFile, { force: true });
const t0 = Date.now(), log = [], note = (k, v) => { const e = { s: +((Date.now() - t0) / 1000).toFixed(1), k, v }; log.push(e); console.log(JSON.stringify(e).slice(0, 300)); };
const startedAt = new Date().toISOString();
const boot = spawnSync(process.execPath, ['tools/god-skill/dev-world.mjs', slug, port, '--genesis', 'worlds/templates/eden-2026.json', '--fresh', '--data', `${out}/data`], { cwd: repo, env: { ...process.env, INVITE_REQUIRED: '0' }, encoding: 'utf8' });
const m = /pid (\d+)/.exec(boot.stdout ?? ''); if (!m) { note('boot-failed', (boot.stdout + boot.stderr).slice(-400)); process.exit(2); }
const pid = Number(m[1]), base = `http://127.0.0.1:${port}/w/${slug}`, commit = readFileSync(`${repo}/COMMIT`, 'utf8').trim();
note('booted', { commit });
const eden = `${repo}/tools/world-launcher/soul/eden.mjs`;
const cli = (n, ...a) => new Promise(res => { const cwd = `${out}/s-${n}`; mkdirSync(cwd, { recursive: true });
  const p = spawn(process.execPath, [eden, ...a], { cwd, env: { ...process.env, SOULS_HOME: `${out}/h-${n}` } }); let o = '', e = '';
  p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d); p.on('close', () => { try { res(JSON.parse(o)); } catch { res({ error: (o + e).slice(-300) }); } }); });
const pause = ms => new Promise(r => setTimeout(r, ms));
const OPEN = new Set(['accepted', 'started', 'queued', 'waiting', 'running', 'held']);
const acts = [];
async function act(n, id, limitS = 240) {
  let r = await cli(n, 'act', id, '--json'); const rid = r.receipt?.id, t = (Date.now() - t0) / 1000;
  let rec = { n, id, t, accepted: r.accepted ?? false, code: r.code ?? r.receipt?.code ?? null, phase: r.receipt?.phase ?? null, reason: String(r.reason ?? r.receipt?.reason ?? r.error ?? '').slice(0, 200) };
  for (let k = 0; rid && OPEN.has(rec.phase) && k < limitS / 2; k++) { await pause(2000); const q = await cli(n, 'receipt', rid); if (q.phase) rec = { ...rec, code: q.code ?? null, phase: q.phase, reason: String(q.reason ?? '').slice(0, 200), endedAt: q.endedAt?.place ?? null }; }
  acts.push(rec); note('act', rec); return rec;
}
// health: every 1.5 s while the world runs; a poll without an answer counts only when the next has none either
let running = true, halted = null, unanswered = 0, maxTickMs = 0, lastGlitches = { total: 0, byRule: {} }, lastTick = 0;
const poll = (async () => { while (running) { try { const h = await (await fetch(`${base}/healthz`)).json(); unanswered = 0; lastTick = h.tick; maxTickMs = Math.max(maxTickMs, h.tickMs?.max ?? 0);
  if ((h.halted || h.paused) && !halted) { halted = { s: (Date.now() - t0) / 1000, h }; note('halt', h); }
  if ((h.glitches?.total ?? 0) !== lastGlitches.total) note('glitches', h.glitches); lastGlitches = h.glitches ?? lastGlitches;
} catch (e) { if (++unanswered >= 2 && !halted) { halted = { s: (Date.now() - t0) / 1000, error: String(e) }; note('no-answer', String(e)); } } await pause(1500); } })();
const UP = ['Ana', 'Ben', 'Cal', 'Dee', 'Eli'], DOWN = ['Eve', 'Fin', 'Gus', 'Hal', 'Ida'], ALL = [...UP, ...DOWN];
const TOP = 'walk:eden-tower-house/part-top', DOOR = 'walk:eden-tower-house/part-entrance', LOOP_S = Number(process.env.LOOP_S ?? 480);
try {
  for (const n of ALL) { await cli(n, 'register', base); const c = await cli(n, 'create', n); note('create', { n, ok: c.created ?? false, err: c.error }); }
  await Promise.all(ALL.map(n => act(n, 'walk:eden-tower-house')));          // everyone at the tower
  const loopEnd = Date.now() + LOOP_S * 1000; note('loop', { seconds: LOOP_S });
  // each Soul goes up and down on its own until the loop time is over: UP starts upward, DOWN starts upward 15 s later,
  // so the two flows meet on the stair; no Soul waits for another
  const loop = async (n, delay) => { await pause(delay); for (let k = 0; Date.now() < loopEnd && !halted; k++) await act(n, k % 2 ? DOOR : TOP, 180); };
  await Promise.all([...UP.map(n => loop(n, 0)), ...DOWN.map(n => loop(n, 15000))]);
  await pause(5000);
} finally {
  running = false; await poll;
  const h = await fetch(`${base}/healthz`).then(r => r.json()).catch(e => ({ error: String(e) }));
  try { process.kill(pid); } catch { /* gone */ }
  await pause(1000);
  const strandLines = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(l => l.startsWith('[strand')) : [];
  const glitchLines = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(l => l.includes('[world] glitch')).map(l => l.replace(/bodies=.*/, 'bodies=<n>')) : [];
  writeFileSync(`${out}/run.json`, JSON.stringify({ arm, commit, startedAt, endedAt: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, halted, finalHealth: h, maxTickMs, lastTick, glitches: h.glitches ?? lastGlitches, glitchLines, strandLines, acts, log }, null, 1));
  note('done', { seconds: (Date.now() - t0) / 1000 });
}
