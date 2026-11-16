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
// world process does after a crash. No state goes from one world to the next: the shard is gone. #2469: the reloads go
// into fresh programs only (the culprit's of its own, the others' together), never into a shard that runs: a boot holds
// its program's thread, so a reload booted beside running worlds stalled them (#2451, about 2.7 s).
//
// The launcher side (ShardSet): ChildPool.launch asks it for a world instead of spawning a process. The world comes back
// as a handle shaped like the ChildProcess the pool already drives (pid, stdout/stderr, kill, 'exit'), so crash restarts,
// stops, the guard and the boot watch are the pool's own. Where a program would end one world process (SIGKILL), the
// shard ends: its other worlds exit as a planned restart (75: at once, not a failure) and the world that ended it as the
// crash it was, which the breaker counts. That world's next load is in a program of its own.
// A world still loading is not ended that way (its boot cannot be cut short inside the program): a SIGKILL drops it. Its
// boot's open wait (the initial projection) ends at once, and it stops the moment its boot ends. #2469: a drop never ends
// its program, however long that boot takes. One writer per data dir: a world's next load is sent only once its previous
// one has exited.
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
  'PORT', 'PUBLIC_URL', 'DATA_DIR', 'GENESIS_FILE', 'SIM_HEALTH_PORT', 'SIM_LOAD_BASELINE_MS', 'SIM_LOAD_DRILL_LEVEL', 'EDGE_EYES', 'SIM_FAULT_INJECT', 'SIM_SHARD_BOOT_HOLD_MS']);
const FAULT_EXIT = 70, PLANNED_EXIT = 75;   // load/watchdog.ts FAULT_EXIT; children.mjs PLANNED_EXIT
const MARK = '\u001e';   // a world's output line: MARK id MARK ' ' text
/** #2469: how long the fresh program a failed shard's worlds reload into waits for all of them (to load or exit) before
 *  it takes other worlds too. */
export const RELOAD_HOLD_MS = 60_000;

// ---------------------------------------------------------------- the program
async function runShard() {
  const root = fileURLToPath(new URL('../../', import.meta.url)), src = (f) => pathToFileURL(join(root, 'apps/server/src', f)).href;
  const [{ loadConfig }, { startWorld }, { shareWatchdog }, { renderWorld }, { worldDayOf }, { liveOf }] = await Promise.all(
    [import(src('config.ts')), import(src('world-main.ts')), import(src('load/watchdog.ts')), import(src('god/host-render-slot.ts')), import(src('god/poster-boards.ts')), import(src('load/shared.ts'))]);
  const send = (m, then) => { try { process.send(m, then); } catch { then?.(); } };
  const dog = shareWatchdog();
  // each line goes out tagged with the world it was logged for, so the launcher writes it to that world's log
  for (const [name, out] of [['log', process.stdout], ['info', process.stdout], ['debug', process.stdout], ['warn', process.stderr], ['error', process.stderr]]) {
    console[name] = (...args) => { const id = renderWorld.getStore(), text = format(...args); out.write(id === undefined ? `${text}\n` : text.split('\n').map((l) => `${MARK}${id}${MARK} ${l}\n`).join('')); };
  }
  const worlds = new Map();   // id → { dataDir, started, stop, exited, serving, boot }
  let ending = false;
  const ended = (id, code) => {
    const w = worlds.get(id); if (!w || w.exited) return; w.exited = true; worlds.delete(id);
    // (#2469: its render slots are not freed here: each is freed by its own render's end, which its stop brings about)
    dog.remove(w.dataDir);
    send({ op: 'exit', id, code });
  };
  const fault = (id, error) => {
    if (ending) return; ending = true;
    renderWorld.run(id, () => console.error(`[shard] world ${id} failed outside its own handling; ending the shard so its worlds reload: ${error?.stack ?? error}`));
    send({ op: 'fault', id }, () => process.exit(FAULT_EXIT));
  };
  // a stop while it loads ends the boot's open wait at once (its projection; startWorld `abort`), else it stops once booted
  const stop = (id, w) => { if (!w.serving) w.boot.abort(); w.stop ??= w.started.then((s) => renderWorld.run(id, () => s.shutdown('SIGTERM'))).catch(() => {}); return w.stop; };
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
      const w = { dataDir: m.env.DATA_DIR, exited: false, stop: null, boot: new AbortController() };
      worlds.set(m.id, w);
      // (tests only, with SIM_FAULT_INJECT: SIM_SHARD_BOOT_HOLD_MS holds the boot that long first, a step a stop cannot cut)
      const hold = m.env.SIM_FAULT_INJECT === '1' ? Number(m.env.SIM_SHARD_BOOT_HOLD_MS) || 0 : 0;
      w.started = renderWorld.run(m.id, async () => { if (hold) await new Promise((r) => setTimeout(r, hold));
        return startWorld(loadConfig(m.env), { signals: false, exit: (code) => ended(m.id, code), mine: () => renderWorld.getStore() === m.id, abort: w.boot.signal }); });
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
    // a world still loading is dropped: stopped as soon as its boot ends; its program runs on (#2469)
    if (signal === 'SIGKILL' && !this.loaded) { this.drop(); return true; }
    // a world that has to be ended at once ends its program: the thread is the program's
    if (signal === 'SIGKILL') { this.end(); return true; }
    if (signal === 'SIGSTOP') throw new Error(`world ${this.slug} shares its program: it is not frozen alone`);
    return true;   // SIGCONT, SIGUSR2 (no report of one world), 0
  }
  end() { this.shard.set.blame(this.shard, this.slug); this.shard.child.kill('SIGKILL'); }
  drop() { if (this.dropping) return; this.dropping = true; this.shard.send({ op: 'stop', id: this.slug }); }
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
  /** @param {{ root: string, size: number, logDir: string, log?: (line: string) => void }} o */
  constructor(o) {
    this.o = o; this.shards = new Set(); this.n = 0; this.alone = new Set(); this.log = o.log ?? (() => {});
    this.fresh = new Map();   // #2469: slug → the reload group of the failed shard it was in (it reloads into the group's program)
    this.writers = new Map();   // data dir → the world handles that may still have it open (one writer per data dir)
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
    const dir = command.env.DATA_DIR, h = new ShardWorld(null, slug, dir), alive = (x) => x.exitCode === null && x.signalCode === null;
    const live = this.writers.get(dir) ?? new Set(), before = [...live].filter(alive);
    this.writers.set(dir, live); live.add(h);
    h.once('exit', () => { live.delete(h); if (!live.size && this.writers.get(dir) === live) this.writers.delete(dir); });
    // its earlier loads (dropped, stopping, or themselves waiting) may still have the data open: this one is sent only once
    // every one of them has exited
    const go = () => { if (alive(h)) this.place(h, slug, p, command.env); };
    let left = before.length;
    if (!left) go(); else for (const x of before) x.once('exit', () => { if (--left === 0) go(); });
    return h;
  }
  place(h, slug, p, env) {
    const alone = this.alone.delete(slug);   // it ended its last shard: this load is in a program of its own
    // #2469: a world of a failed shard reloads only into its group's fresh program, and a program held for a group takes
    // no other world until every world of the group has loaded (or exited), or RELOAD_HOLD_MS has passed
    const group = this.fresh.get(slug); this.fresh.delete(slug);
    const open = (s) => s.key === p.key && !s.alone && !s.closing && s.worlds.size < this.o.size && this.shards.has(s);
    const held = (s) => s.held && s.held.pending.size > 0 && Date.now() < s.held.until;
    let shard = alone ? null : group ? (group.shard && open(group.shard) ? group.shard : null) : [...this.shards].find((s) => open(s) && !held(s));
    shard ??= this.start(p, alone);
    if (group && !alone) { if (group.shard !== shard) { group.shard = shard; shard.held = group; } h.group = group; h.once('exit', () => group.pending.delete(slug)); }
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
      } else if (m?.op === 'loaded') { const h = shard.worlds.get(m.id); if (h) { h.loaded = true; h.group?.pending.delete(m.id); } }
      else if (m?.op === 'fault') shard.blamed.add(m.id);
    });
    child.once('exit', (code, signal) => {
      this.shards.delete(shard); shard.closing = true;
      const left = [...shard.worlds.values()], blamed = left.filter((h) => shard.blamed.has(h.slug) || endedTheShard(h, child.pid));
      if (left.length) this.log(`shard ${n} ended (${code ?? signal})${blamed.length ? ` by ${blamed.map((h) => h.slug).join(', ')}` : ''}: its ${left.length} world(s) reload`);
      log.end(`--- exit ${code ?? signal}${blamed.length ? ` (ended by ${blamed.map((h) => h.slug).join(', ')})` : ''}\n`);
      // #2469: the rest reload together, into a fresh program held for them (place)
      const group = { from: n, shard: null, pending: new Set(), until: Date.now() + RELOAD_HOLD_MS };
      for (const h of left) {
        // the world that ended it exits as it did; the rest as a planned restart. With no world to blame (the kernel's
        // OOM killer, a native abort) every world exits as the crash it was
        const own = blamed.includes(h) || !blamed.length;
        if (own) this.alone.add(h.slug); else { this.fresh.set(h.slug, group); group.pending.add(h.slug); }
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
