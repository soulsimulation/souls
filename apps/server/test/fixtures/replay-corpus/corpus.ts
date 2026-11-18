// Replay-compatibility corpus (#1395): frozen event logs from fake-mind worlds, each with the state and kernel hashes the
// engine gave it at a set of ticks. replay-corpus.test.ts refolds every log with the current engine and compares; a
// change that moves a pin either ships a logged rules fact (so old history keeps its old meaning) or is a deliberate,
// reviewed re-pin (`record.ts --write`, in its own commit). record.ts adds logs. docs/testing.md#replay-corpus.
//
// Per entry, two files: `<name>.log.json` (the world row, every logged event and one snapshot; never rewritten) and
// `<name>.pins.json` (how to read it and the pinned hashes; changes only with --write).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineFactory } from '@souls/engine-contract';
import type { LogEvent } from '@souls/protocol';
import { kernelHash, sweep } from '@souls/kernel';
import { config } from '../../../src/config.ts';
import { Db } from '../../../src/db.ts';
import { replayFromGenesis } from '../../../src/fold.ts';
import { WorldHost } from '../../../src/world.ts';
import { plainWorldFactory } from '../../../src/world-factory.ts';

export const CORPUS_DIR = new URL('.', import.meta.url).pathname;

/** How a world process reads this log: plainWorldFactory with this config (no Eden core). */
export type Reader = { engine: 'toy' | 'mars'; worldKey: string; worldEngine: boolean };
export type Pin = { tick: number; state: string; kernel: string; note?: string };
export type Pins = {
  name: string; recipe: string; recordedAt: string; reader: Reader; worldId: string; seed: string;
  /** The runtime policies the log adopts (its `rules` events' policy names, in order); everything else postdates it. */
  adopted: string[];
  /** Pins from genesis at these ticks (the engine stepped to the tick, the inputs logged at it not yet folded). */
  pins: Pin[];
  /** The head as a boot leaves it (from genesis and from the snapshot): the last event's tick, its inputs folded. */
  head: Pin & { seq: number };
  snapshot: { tick: number; seq: number };
};
export type Log = {
  world: { id: string; seed: string; rules_version: string };
  events: LogEvent[];
  snapshot: { tick: number; seq: number; stateHash: string; rulesVersion: string; text: string };
};

export const logPath = (name: string) => join(CORPUS_DIR, `${name}.log.json`);
export const pinsPath = (name: string) => join(CORPUS_DIR, `${name}.pins.json`);
export const entries = (): string[] => readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.pins.json')).map((f) => f.slice(0, -'.pins.json'.length)).sort();
export const readPins = (name: string): Pins => JSON.parse(readFileSync(pinsPath(name), 'utf8'));
export const writePins = (p: Pins) => writeFileSync(pinsPath(p.name), JSON.stringify(p, null, 1) + '\n');
export const readLog = (name: string): Log => JSON.parse(readFileSync(logPath(name), 'utf8'));
/** Plain text, one event per line, so a review reads what history the corpus holds. */
export const formatLog = (log: Log) => `{"world":${JSON.stringify(log.world)},\n"snapshot":${JSON.stringify(log.snapshot)},\n"events":[\n${log.events.map((e) => JSON.stringify(e)).join(',\n')}\n]}\n`;
export function writeLog(name: string, log: Log) {
  if (existsSync(logPath(name))) throw Error(`replay-corpus: ${name} is frozen history; record a new entry instead`);
  writeFileSync(logPath(name), formatLog(log));
}

export const readerFactory = (r: Reader): Promise<EngineFactory> =>
  plainWorldFactory({ ...config, engine: r.engine, worldKey: r.worldKey, worldEngine: r.worldEngine } as typeof config, {});

/** The policy names a log's rules events adopt, in order (`climbSpacingV1: true` → climbSpacingV1). */
export function adoptedPolicies(events: LogEvent[]): string[] {
  const seen: string[] = [];
  for (const e of events) {
    if (e.kind !== 'rules') continue;
    const p = e.payload as Record<string, unknown> | null;
    const names = [...Object.entries((p?.runtimePolicy as Record<string, unknown>) ?? {}).filter(([, v]) => v === true).map(([k]) => k),
      ...Object.keys(p ?? {}).filter((k) => /V\d+$/.test(k) && k !== 'runtimePolicy')];
    for (const n of names) if (!seen.includes(n)) seen.push(n);
  }
  return seen;
}

/** Refold from genesis to `tick`, as the pins were taken. */
export function refoldAt(factory: EngineFactory, log: Log, tick: number): { state: string; kernel: string } {
  const r = replayFromGenesis(factory as never, log.world.seed, log.events, tick);
  return { state: r.engine.stateHash(), kernel: kernelHash(r.kernel) };
}

/** Boot a world host on a fresh database holding this log (and its snapshot, or not), as a restarting server does. */
export function bootHead(factory: EngineFactory, log: Log, worldId: string, path: string, withSnapshot: boolean) {
  const db = new Db(path);
  try {
    db.createWorld({ id: worldId, schema: 'pending', rules_version: log.world.rules_version, dt: 1 / 20, seed: log.world.seed });
    for (const e of log.events) db.appendEvent(worldId, e);
    if (withSnapshot) db.saveSnapshotSerialized(worldId, { ...log.snapshot, physicalHash: '' }, log.snapshot.text);
    const host = new WorldHost(db, factory, log.world.seed, 1e9, worldId);
    const boot = host.boot();
    host.kernel.tick = host.engine.world.tick; sweep(host.kernel);
    return { from: boot.from, tick: host.engine.world.tick, seq: host.seq, state: host.engine.stateHash(), kernel: kernelHash(host.kernel) };
  } finally { db.close(); }
}
