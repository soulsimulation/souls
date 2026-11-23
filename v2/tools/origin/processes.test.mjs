// The origin's several processes on one port (#4018 follow-up): how many it starts, that each serves and is counted
// in ORIGIN_STATS, that one which ends is started again while the rest serve, and the summed `stats` line at exit.
// The start test needs SO_REUSEPORT (Linux, Node 22.12 or later) and is skipped elsewhere; CI runs it.
// Run: node --test v2/tools/origin/processes.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { endStats, processCount } from './origin.mjs';

test('processCount: the cores less the worlds\' two by default, the setting when given, one where a port cannot be shared', () => {
  assert.equal(processCount({}, 8, 'linux', '22.18.0'), 6);
  assert.equal(processCount({ ORIGIN_RESERVE_CORES: '3' }, 8, 'linux', '22.18.0'), 5);
  assert.equal(processCount({}, 2, 'linux', '22.18.0'), 1);
  assert.equal(processCount({}, 48, 'darwin', '22.18.0'), 1);
  assert.equal(processCount({}, 48, 'linux', '22.11.0'), 1);
  assert.equal(processCount({ ORIGIN_PROCESSES: '3' }, 48, 'linux', '24.1.0'), 3);
  assert.equal(processCount({ ORIGIN_PROCESSES: '1' }, 48, 'darwin', '22.18.0'), 1);
  assert.throws(() => processCount({ ORIGIN_PROCESSES: '3' }, 8, 'darwin', '22.18.0'), /needs Linux/);
  assert.throws(() => processCount({ ORIGIN_PROCESSES: '0' }, 8, 'linux', '22.18.0'), /at least 1/);
  assert.throws(() => processCount({ ORIGIN_PROCESSES: 'two' }, 8, 'linux', '22.18.0'), /at least 1/);
});

test('endStats sums processes, and a part served by two counts once with both requests', () => {
  const s = endStats([
    { pointer: 2, immutable: 3, miss: 1, parts: { 'w/s/7': 2, 'w/s/8': 1 }, cpuSeconds: 0.5 },
    { pointer: 1, immutable: 1, miss: 0, parts: { 'w/s/7': 1 }, cpuSeconds: 0.25 },
  ]);
  assert.deepEqual(s, { pointer: 3, immutable: 4, miss: 1, parts: 2, perPartMax: 3, perPartMean: 2, cpuSeconds: 0.75 });
});

const [major, minor] = process.versions.node.split('.').map(Number);
const shares = process.platform === 'linux' && (major > 22 || (major === 22 && minor >= 12));

const fetchOnce = (port, path) => new Promise((ok, fail) => {
  get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => ok({ status: res.statusCode, body: Buffer.concat(chunks) }));
  }).on('error', fail);
});
const until = async (what, check, ms = 10_000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 50))) {
    const v = check();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('three processes share one port, each counted; one killed is started again while the others serve', { skip: !shares && 'needs SO_REUSEPORT (Linux, Node 22.12+)' }, async () => {
  const scratch = fileURLToPath(new URL('../../../.local/', import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'v2-origin-procs-'));
  const part = Buffer.alloc(1000, 7);
  mkdirSync(join(dir, 'w1', 's'), { recursive: true });
  writeFileSync(join(dir, 'w1', 's', '7'), part);
  const statsFile = join(dir, 'origin-stats.json');
  const proc = spawn(process.execPath, [fileURLToPath(new URL('./origin.mjs', import.meta.url)), dir, '0'], {
    env: { ...process.env, ORIGIN_PROCESSES: '3', ORIGIN_STATS: statsFile, ORIGIN_STATS_MS: '100' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => proc.on('exit', (code) => r(code)));
  try {
    const port = Number(await until('origin <port>', () => /origin (\d+)\n/.exec(out)?.[1]));
    const read = () => { try { return JSON.parse(readFileSync(statsFile, 'utf8')); } catch { return null; } };
    const N = 90;
    for (let i = 0; i < N; i++) {
      const r = await fetchOnce(port, '/w1/s/7'); // a new connection each: the kernel picks a process for each
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, part);
    }
    let s = await until('every request in ORIGIN_STATS', () => { const v = read(); return v?.processes?.reduce((a, p) => a + (p.immutable ?? 0), 0) === N && v; });
    assert.equal(s.processes.length, 3);
    assert.equal(new Set(s.processes.map((p) => p.pid)).size, 3);
    assert.ok(!s.processes.some((p) => p.pid === proc.pid), 'the supervisor serves nothing itself');
    assert.ok(s.processes.filter((p) => p.immutable > 0).length >= 2, `connections spread: ${s.processes.map((p) => p.immutable)}`);
    for (const p of s.processes) assert.ok(p.rss_bytes > 0 && p.cpu_s > 0 && p.restarts === 0 && (p.bytes.w1 ?? 0) === p.immutable * part.length);
    assert.equal(s.bytes.w1, N * part.length);

    const victim = s.processes.find((p) => p.immutable > 0);
    process.kill(victim.pid, 'SIGKILL');
    await until('the victim to end', () => !alive(victim.pid));
    for (let i = 0; i < 30; i++) assert.equal((await fetchOnce(port, '/w1/s/7')).status, 200); // the other two serve
    s = await until('the victim started again', () => { const v = read(); const p = v?.processes?.[victim.index]; return p?.restarts === 1 && p.pid && p.pid !== victim.pid && v; });
    assert.ok(s.bytes.w1 >= (N + 30) * part.length, 'an ended process\'s bytes stay counted');
    for (let i = 0; i < 30; i++) assert.equal((await fetchOnce(port, '/w1/s/7')).status, 200);
    const pids = s.processes.map((p) => p.pid);

    proc.kill('SIGTERM');
    assert.equal(await exited, 0);
    const line = JSON.parse(/stats (\{.*\})\n/.exec(out)[1]);
    assert.equal(line.processes, 3);
    assert.equal(line.restarts, 1);
    assert.ok(line.immutable >= 60 && line.parts === 1, JSON.stringify(line)); // the killed process's own count went with it
    await until('every process ended', () => pids.every((p) => !alive(p)));
  } finally {
    if (proc.exitCode === null) proc.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
