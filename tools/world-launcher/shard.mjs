#!/usr/bin/env node
// #2444 (docs/design/world-cost.md B5): the shard, one program holding up to `size` worlds, the modules loaded once and
// shared; built from the trial's tools/bench/capacity/colocate/host.mjs. Off unless the launcher's SIM_SHARDS is set.
//
// The program (run as `node tools/world-launcher/shard.mjs`, forked by ShardSet with an IPC channel):
//   {op:'load', id, env}  boots one world: startWorld(loadConfig(env)) with its own env (never process.env), inside
//                         renderWorld (host-render-slot.ts), so its log lines and render slots are known as its own
//   {op:'stop', id}       stops that world as SIGTERM stops a world process (snapshot saved); the others go on
//   {op:'quit'}           the launcher has no world here any more: exit
//   {op:'look', id}       {op:'looked', id, tick, stateHash, day, level}: one world as this program holds it (tests, B6)
// It answers {op:'exit', id, code} when a world ends by itself or by a stop, and {op:'fault', id} before it ends itself.
// One watchdog thread watches every world (load/watchdog.ts shareWatchdog). A fault ends the whole program: a fault storm,
// a clock stopped by a fault or a boot that throws (exit 70), the watchdog's hang or heap rule (SIGKILL). The launcher then
// reloads each of its worlds in another program; they replay their logs and catch their clocks up (#2235), exactly as a
// world process does after a crash. No state goes from one world to the next: the shard is gone.
//
// The launcher side (ShardSet): ChildPool.launch asks it for a world instead of spawning a process. The world comes back
// as a handle shaped like the ChildProcess the pool already drives (pid, stdout/stderr, kill, 'exit'), so crash restarts,
// stops, the guard and the boot watch are the pool's own. Where a program would end one world process (SIGKILL), the
// shard ends: its other worlds exit as a planned restart (75: at once, not a failure) and the world that ended it as the
// crash it was, which the breaker counts. That world's next load is in a program of its own.
// A world still loading is not ended that way (its boot cannot be cut short inside the program): a SIGKILL drops it. It
// is stopped the moment its boot ends, and only if that takes longer than dropGraceMs is its program ended. One writer
// per data dir: a world's next load is sent only once its previous one has exited.
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format } from 'node:util';

export const SHARD_SCRIPT = 'tools/world-launcher/shard.mjs';
/** The world process's entry point: only a world it would start goes into a shard (not a fork, not a standby). */
const WORLD_SCRIPT = 'apps/server/src/main.ts';
/** A world's own settings, read only from its config (apps/server/src/world-config-reads.test.ts). Every other setting is
 *  the program's: worlds share a shard only when all of theirs are equal, so no world runs under another's settings. */
export const PER_WORLD = Object.freeze(['WORLD_KEY', 'WORLD_ID', 'WORLD_SLUG', 'WORLD_NAME', 'WORLD_PATH', 'WORLD_OWNER_ID', 'WORLD_TIME_ZONE',
  'PORT', 'PUBLIC_URL', 'DATA_DIR', 'GENESIS_FILE', 'SIM_HEALTH_PORT', 'SIM_LOAD_BASELINE_MS', 'SIM_LOAD_DRILL_LEVEL', 'EDGE_EYES', 'SIM_FAULT_INJECT']);
const FAULT_EXIT = 70, PLANNED_EXIT = 75;   // load/watchdog.ts FAULT_EXIT; children.mjs PLANNED_EXIT
const MARK = '\u001e';
/** How long a world dropped while it loads may take to end its boot and stop before its program is ended. */
export const DROP_GRACE_MS = 3_000;   // a world's output line: MARK id MARK ' ' text

// ---------------------------------------------------------------- the program
async function runShard() {
  const root = fileURLToPath(new URL('../../', import.meta.url)), src = (f) => pathToFileURL(join(root, 'apps/server/src', f)).href;
  const [{ loadConfig }, { startWorld }, { shareWatchdog }, { renderWorld, releaseWorldRenderSlots }, { worldDayOf }, { liveOf }] = await Promise.all(
    [import(src('config.ts')), import(src('world-main.ts')), import(src('load/watchdog.ts')), import(src('god/host-render-slot.ts')), import(src('god/poster-boards.ts')), import(src('load/shared.ts'))]);
  const send = (m, then) => { try { process.send(m, then); } catch { then?.(); } };
  const dog = shareWatchdog();
  // each line goes out tagged with the world it was logged for, so the launcher writes it to that world's log
  for (const [name, out] of [['log', process.stdout], ['info', process.stdout], ['debug', process.stdout], ['warn', process.stderr], ['error', process.stderr]]) {
    console[name] = (...args) => { const id = renderWorld.getStore(), text = format(...args); out.write(id === undefined ? `${text}\n` : text.split('\n').map((l) => `${MARK}${id}${MARK} ${l}\n`).join('')); };
  }
  const worlds = new Map();   // id → { dataDir, started, stop, exited }
  let ending = false;
  const ended = (id, code) => {
    const w = worlds.get(id); if (!w || w.exited) return; w.exited = true; worlds.delete(id);
    dog.remove(w.dataDir); releaseWorldRenderSlots(id);
    send({ op: 'exit', id, code });
  };
  const fault = (id, error) => {
    if (ending) return; ending = true;
    renderWorld.run(id, () => console.error(`[shard] world ${id} failed outside its own handling; ending the shard so its worlds reload: ${error?.stack ?? error}`));
    send({ op: 'fault', id }, () => process.exit(FAULT_EXIT));
  };
  const stop = (id, w) => { w.stop ??= w.started.then((s) => renderWorld.run(id, () => s.shutdown('SIGTERM'))).catch(() => {}); return w.stop; };
  const stopAll = async () => { await Promise.all([...worlds].map(([id, w]) => stop(id, w))); process.exit(0); };
  // an uncaught error is noted by the world whose code it came from (its own fault guard, world-main.ts `mine`), never by
  // its neighbours. One from a world still loading (no guard yet) is its boot failing: the fault a world process would
  // crash on. One from no world (this program's own code) is logged and counted against none
  const stray = (kind) => (e) => {
    const id = renderWorld.getStore(), w = id === undefined ? null : worlds.get(id);
    if (w && !w.serving && !w.exited) fault(id, e);
    else if (!w) console.error(`[shard] ${kind} ${id === undefined ? 'outside any world' : `from world ${id}, which has stopped`}: ${e?.stack ?? e}`);
  };
  process.on('uncaughtException', stray('uncaught error')); process.on('unhandledRejection', stray('unhandled rejection'));
  process.on('message', (m) => {
    if (m?.op === 'load' && !worlds.has(m.id) && !ending) {
      const w = { dataDir: m.env.DATA_DIR, exited: false, stop: null };
      worlds.set(m.id, w);
      w.started = renderWorld.run(m.id, () => startWorld(loadConfig(m.env), { signals: false, exit: (code) => ended(m.id, code), mine: () => renderWorld.getStore() === m.id }));
      w.started.then((s) => s.listening).then(() => { w.serving = true; send({ op: 'loaded', id: m.id }); }, (e) => { if (!w.exited) fault(m.id, e); });
    } else if (m?.op === 'stop') { const w = worlds.get(m.id); if (w) void stop(m.id, w); }
    else if (m?.op === 'quit' && worlds.size === 0) process.exit(0);
    else if (m?.op === 'look') {
      const w = worlds.get(m.id);
      void (w ? w.started : Promise.reject(new Error('no such world'))).then(({ host, load }) => send({ op: 'looked', id: m.id, tick: host.engine.world.tick, stateHash: host.engine.stateHash(), day: worldDayOf(host), living: host.living ? { dayTicks: host.living.dayTicks, origin: host.living.origin } : null, level: liveOf(load.shared, process.pid, Date.now()).level }),
        (e) => send({ op: 'looked', id: m.id, error: String(e?.message ?? e) }));
    }
  });
  // the launcher is gone, or the program is asked to end: every world saves its snapshot first
  process.on('disconnect', () => void stopAll());
  process.on('SIGTERM', () => void stopAll());
  process.on('SIGINT', () => void stopAll());
  send({ op: 'ready' });
}

// ---------------------------------------------------------------- the launcher side
/** A world in a shard, shaped like the ChildProcess children.mjs drives. */
class ShardWorld extends EventEmitter {
  constructor(shard, slug, dataDir) {
    super(); this.shard = shard; this.slug = slug; this.dataDir = dataDir; this.loadedAt = Date.now();
    this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.exitCode = null; this.signalCode = null; this.script = SHARD_SCRIPT;
    this.loaded = false; this.dropping = false;   // (shard null: waiting for the world's previous load to exit)
  }
  get pid() { return this.shard?.child.pid; }
  /** How many worlds share this one's program (children.mjs memUse splits the program's Pss between them). */
  share() { return Math.max(1, this.shard?.worlds.size ?? 1); }
  kill(signal = 'SIGTERM') {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    // not yet sent to a program (its previous load has not exited): it never runs
    if (!this.shard) { if (['SIGTERM', 'SIGINT', 'SIGKILL'].includes(signal)) this.exit(null, signal); return true; }
    if (signal === 'SIGTERM' || signal === 'SIGINT') { this.shard.send({ op: 'stop', id: this.slug }); return true; }
    // a world still loading is dropped: stopped as soon as its boot ends, its program ended only after dropGraceMs
    if (signal === 'SIGKILL' && !this.loaded) { this.drop(); return true; }
    // a world that has to be ended at once ends its program: the thread is the program's
    if (signal === 'SIGKILL') { this.end(); return true; }
    if (signal === 'SIGSTOP') throw new Error(`world ${this.slug} shares its program: it is not frozen alone`);
    return true;   // SIGCONT, SIGUSR2 (no report of one world), 0
  }
  end() { this.shard.set.blame(this.shard, this.slug); this.shard.child.kill('SIGKILL'); }
  drop() {
    if (this.dropping) return; this.dropping = true;
    this.shard.send({ op: 'stop', id: this.slug });
    const t = setTimeout(() => { if (this.exitCode === null && this.signalCode === null) { this.shard.set.log(`world ${this.slug} still loading ${this.shard.set.dropGraceMs / 1000} s after it was dropped: ending shard ${this.shard.n}`); this.end(); } }, this.shard.set.dropGraceMs);
    t.unref?.(); this.once('exit', () => clearTimeout(t));
  }
  exit(code, signal) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code; this.signalCode = signal;
    this.stdout.end(); this.stderr.end();
    setImmediate(() => this.emit('exit', code, signal));
  }
}

/** Did this world end its program? Its watchdog verdict (live.json `killed` by the program's pid) or its fault record
 *  (<DATA_DIR>/fault-exit.json, written since it was loaded). */
function endedTheShard(h, pid) {
  try { const live = JSON.parse(readFileSync(join(h.dataDir, 'live.json'), 'utf8')); if (live?.pid === pid && live.killed) return true; } catch { /* none */ }
  try { const f = JSON.parse(readFileSync(join(h.dataDir, 'fault-exit.json'), 'utf8')); if (Number(f?.at) >= h.loadedAt) return true; } catch { /* none */ }
  return false;
}

/** The launcher's shards: places each world in a shard of its settings with room, or starts one. */
export class ShardSet {
  /** @param {{ root: string, size: number, logDir: string, log?: (line: string) => void, dropGraceMs?: number }} o */
  constructor(o) {
    this.o = o; this.shards = new Set(); this.n = 0; this.alone = new Set(); this.log = o.log ?? (() => {}); this.dropGraceMs = o.dropGraceMs ?? DROP_GRACE_MS;
    this.writers = new Map();   // data dir → the world handle that may still have it open (one writer per data dir)
  }
  /** The program's part of a world's command (null: the world does not go into a shard). */
  programOf({ cmd, args, env }) {
    // (read workers are threads of the world's own program, on its own ports: not in a shard yet)
    if (args.at(-1) !== WORLD_SCRIPT || env.SIM_STANDBY === '1' || env.SIM_READ_WORKER === '1') return null;
    const own = Object.fromEntries(Object.entries(env).filter(([k]) => !PER_WORLD.includes(k)).sort(([a], [b]) => (a < b ? -1 : 1)));
    return { cmd, execArgv: args.slice(0, -1), env: own, key: JSON.stringify([cmd, args.slice(0, -1), own]) };
  }
  /** A world's handle in a shard, or null when its command cannot run in one. */
  spawn(slug, command) {
    const p = this.programOf(command); if (!p) return null;
    const dir = command.env.DATA_DIR, h = new ShardWorld(null, slug, dir), prev = this.writers.get(dir);
    this.writers.set(dir, h); h.once('exit', () => { if (this.writers.get(dir) === h) this.writers.delete(dir); });
    // its previous load (dropped, or stopping) still has the data open: this one is sent once that has exited
    if (prev && prev.exitCode === null && prev.signalCode === null) prev.once('exit', () => { if (h.exitCode === null && h.signalCode === null) this.place(h, slug, p, command.env); });
    else this.place(h, slug, p, command.env);
    return h;
  }
  place(h, slug, p, env) {
    const alone = this.alone.delete(slug);   // it ended its last shard: this load is in a program of its own
    let shard = alone ? null : [...this.shards].find((s) => s.key === p.key && !s.alone && !s.closing && s.worlds.size < this.o.size);
    shard ??= this.start(p, alone);
    h.shard = shard; h.loadedAt = Date.now();
    shard.worlds.set(slug, h);
    shard.send({ op: 'load', id: slug, env });
  }
  blame(shard, slug) { shard.blamed.add(slug); }
  /** One world as its shard holds it: { tick, stateHash, day, level } (tests and measurement). */
  look(slug) {
    const shard = [...this.shards].find((s) => s.worlds.has(slug));
    if (!shard) return Promise.reject(new Error(`world ${slug} is in no shard`));
    return new Promise((yes, no) => { const on = (m) => { if (m?.op !== 'looked' || m.id !== slug) return; shard.child.off('message', on); if (m.error) no(new Error(m.error)); else yes(m); }; shard.child.on('message', on); shard.send({ op: 'look', id: slug }); });
  }
  start(p, alone) {
    const n = ++this.n, env = { ...p.env };
    // the program's heap holds its worlds: a world's cap times the shard's size
    const heap = /--max-old-space-size=(\d+)/.exec(env.NODE_OPTIONS ?? '');
    if (heap) env.NODE_OPTIONS = env.NODE_OPTIONS.replace(heap[0], `--max-old-space-size=${Number(heap[1]) * (alone ? 1 : this.o.size)}`);
    const child = fork(join(this.o.root, SHARD_SCRIPT), [], { cwd: this.o.root, env, execPath: p.cmd, execArgv: p.execArgv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const shard = { n, key: p.key, alone, child, worlds: new Map(), blamed: new Set(), closing: false, set: this,
      send: (m) => { try { child.send(m); } catch { /* ending: its exit reports every world */ } } };
    this.shards.add(shard);
    const log = createWriteStream(join(this.o.logDir, `shard-${n}.log`), { flags: 'a' });
    log.write(`\n--- ${new Date().toISOString()} shard ${n} pid ${child.pid}${alone ? ' (one world)' : ''}\n`);
    for (const [from, to] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      createInterface({ input: from, crlfDelay: Infinity }).on('line', (line) => {
        const m = line.startsWith(MARK) ? line.indexOf(MARK, 1) : -1, h = m > 0 ? shard.worlds.get(line.slice(1, m)) : null;
        if (h) h[to].write(`${line.slice(m + 2)}\n`); else log.write(`${line}\n`);
      });
    }
    child.on('message', (m) => {
      if (m?.op === 'exit') {
        const h = shard.worlds.get(m.id); if (!h) return;
        shard.worlds.delete(m.id); h.exit(m.code, null);
        if (shard.worlds.size === 0) { shard.closing = true; shard.send({ op: 'quit' }); }
      } else if (m?.op === 'loaded') { const h = shard.worlds.get(m.id); if (h) h.loaded = true; }
      else if (m?.op === 'fault') shard.blamed.add(m.id);
    });
    child.once('exit', (code, signal) => {
      this.shards.delete(shard); shard.closing = true;
      const left = [...shard.worlds.values()], blamed = left.filter((h) => shard.blamed.has(h.slug) || endedTheShard(h, child.pid));
      if (left.length) this.log(`shard ${n} ended (${code ?? signal})${blamed.length ? ` by ${blamed.map((h) => h.slug).join(', ')}` : ''}: its ${left.length} world(s) reload`);
      log.end(`--- exit ${code ?? signal}${blamed.length ? ` (ended by ${blamed.map((h) => h.slug).join(', ')})` : ''}\n`);
      for (const h of left) {
        // the world that ended it exits as it did; the rest as a planned restart. With no world to blame (the kernel's
        // OOM killer, a native abort) every world exits as the crash it was
        const own = blamed.includes(h) || !blamed.length;
        if (own) this.alone.add(h.slug);
        h.stderr.write(`[shard] shard ${n} ended (${code ?? signal})${own ? '' : `, by ${blamed.map((x) => x.slug).join(', ')}: a planned reload`}\n`);
        h.exit(own ? code : PLANNED_EXIT, own ? signal : null);
      }
      shard.worlds.clear();
    });
    child.once('error', (e) => log.write(`--- spawn error ${e.message}\n`));
    return shard;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runShard();
