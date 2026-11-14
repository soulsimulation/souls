// Replay-compatibility corpus recorder (#1395). Fake minds, a temporary database, nothing live or production.
//
//   node apps/server/test/fixtures/replay-corpus/record.ts <name> --recipe <toy|god-greenfield|mars-campus>
//       records a NEW entry: runs the recipe with this tree's engine and boot chain, writes <name>.log.json.br (frozen
//       from then on) and <name>.pins.json. Refuses a name that exists: history is never re-recorded.
//   node apps/server/test/fixtures/replay-corpus/record.ts --write <name|all>
//       re-pins an existing entry by refolding its frozen log with this tree's engine. Only for a deliberate change, in
//       its own commit with its reason (the same rule as the walk and bundle baselines).
//   node apps/server/test/fixtures/replay-corpus/record.ts --check   prints each entry's pins against this tree.
// A new boot-adopted runtime policy adds an entry recorded after it (a new name); older entries and their pins stay.
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { kernelHash } from '@souls/kernel';
import { coreRef } from '@souls/world-compiler';
import { Db } from '../../../src/db.ts';
import { WorldHost } from '../../../src/world.ts';
import { optionsFor } from '../../../src/deck.ts';
import { adoptBootRuntimePoliciesV1 } from '../../../src/edge-runtime-rules.ts';
import { GodMode } from '../../../src/god/god.ts';
import { installEngineBridge } from '../../../src/god/engine-bridge.ts';
import { EdgeLedger } from '../../../src/edge/ledger/ledger.ts';
import { BODY_PRESETS } from '../../../src/edge/body/routes.ts';
import { adoptedPolicies, bootHead, entries, logPath, readerFactory, readLog, readPins, refoldAt, writeLog, writePins, type Log, type Pin, type Pins, type Reader } from './corpus.ts';

type Rec = { host: WorldHost; db: Db; pin: (note?: string) => void; settle: <T>(p: Promise<T>) => Promise<T>; ticks: (n: number, every?: (i: number) => void) => void; decide: (salt: number) => void };
type Recipe = { reader: Reader; worldId: string; seed: string; run: (r: Rec) => Promise<void> };

const born = (host: WorldHost, names: string[]) => names.forEach((n) => void host.enqueue('birth', 'test', { soulId: `s_${n}`, entityId: `h_${n}`, name: n, description: 'corpus soul', owner: 'corpus' }));

const RECIPES: Record<string, Recipe> = {
  // A toy world: births, dense decisions cut mid-flight, a retire.
  toy: {
    reader: { engine: 'toy', worldKey: 'toy', worldEngine: false }, worldId: 'corpus-toy', seed: 'corpus-toy',
    async run({ host, pin, ticks, decide }) {
      born(host, ['ada', 'bo', 'cy', 'di']);
      ticks(1200, (i) => { if (i % 170 === 7) decide(i); }); pin('decisions');
      host.saveSnapshot();
      ticks(900, (i) => { if (i % 170 === 7) decide(i * 3); });
      void host.enqueue('retire', 'test', { soulId: 's_cy', entityId: 'h_cy' });
      ticks(900, (i) => { if (i % 170 === 7) decide(i * 5); }); pin('after the retire');
    },
  },
  // A green-field god world as a server boots one (the boot runtime-policy chain), two Souls, god world-edits.
  'god-greenfield': {
    reader: { engine: 'mars', worldKey: 'corpus-green', worldEngine: true }, worldId: 'corpus-green', seed: 'corpus-green',
    async run({ host, db, pin, settle, ticks, decide }) {
      await settle(adoptBootRuntimePoliciesV1(host, { edge: true, worldKey: 'corpus-green' }));
      const god = new GodMode(db, { worldId: host.worldId, ownerId: 'dev:corpus', tick: () => host.engine.world.tick, emit: () => {} });
      installEngineBridge({ host, god, edge: new EdgeLedger(host, db), log: () => {} });
      born(host, ['ada', 'bo']);
      ticks(200); pin('born');
      const wall = { def: coreRef('wall'), params: { w: 4, h: 2.6, d: 0.5 } };
      const act = async (ops: unknown) => { const r = god.act({ ops } as never) as { accepted: boolean }; if (!r.accepted) throw Error('corpus: god edit refused ' + JSON.stringify(r)); for (let i = 0; i < 4; i++) { host.tickOnce(); await setImmediate(); host.drainInputs(); } };
      await act([{ op: 'place', ...wall, name: 'north-wall', p: [0, 14] }]);
      await act([{ op: 'place', ...wall, name: 'east-wall', p: [12, 4] }]);
      ticks(400, (i) => { if (i % 170 === 7) decide(i); }); pin('walls');
      host.saveSnapshot();
      await act([{ op: 'remove', id: god.model.get('east-wall')!.id }]);
      ticks(600, (i) => { if (i % 170 === 7) decide(i * 3); }); pin('a wall removed');
    },
  },
  // A Mars campus world: decisions under the history's original rules, then the boot runtime-policy chain adopted
  // mid-history (so pins sit before and after it), a body assignment and a retire.
  'mars-campus': {
    reader: { engine: 'mars', worldKey: 'mars', worldEngine: false }, worldId: 'corpus-mars', seed: 'corpus-mars',
    async run({ host, pin, settle, ticks, decide }) {
      born(host, ['ada', 'bo', 'cy']);
      // a body assignment, as the body route makes one: only on a body standing free (the engine's own check, read only)
      const preset = BODY_PRESETS.find((p) => p.body && (p.body as { family?: string }).family === 'floater')!;
      const swap = (host.engine as unknown as { bodySwapProblemV1(id: string, b: unknown): unknown }).bodySwapProblemV1.bind(host.engine);
      ticks(20);
      for (let i = 0; swap('h_bo', preset.body); i++) { if (i > 400) throw Error('corpus: Bo never stood free: ' + String(swap('h_bo', preset.body))); host.tickOnce(); }
      await settle(host.enqueue('body-assignment-v1', 'world:body', { contract: 'body-assignment/1', worldId: host.worldId, soulId: 's_bo', entityId: 'h_bo', body: structuredClone(preset.body) }));
      ticks(900, (i) => { if (i % 170 === 7) decide(i); }); pin('a body, decisions, before the boot policies');
      await settle(adoptBootRuntimePoliciesV1(host, { edge: false, worldKey: 'mars' }));
      ticks(600, (i) => { if (i % 170 === 7) decide(i * 3); }); pin('after the boot policies');
      host.saveSnapshot();
      void host.enqueue('retire', 'test', { soulId: 's_cy', entityId: 'h_cy' });
      ticks(600, (i) => { if (i % 170 === 7) decide(i * 7); }); pin('after a retire');
    },
  },
};

async function record(name: string, recipeName: string) {
  const recipe = RECIPES[recipeName];
  if (!recipe) throw Error(`replay-corpus: no recipe ${recipeName} (${Object.keys(RECIPES).join(', ')})`);
  if (existsSync(logPath(name))) throw Error(`replay-corpus: ${name} exists; history is never re-recorded (pick a new name, or --write ${name} to re-pin)`);
  const factory = await readerFactory(recipe.reader);
  const dir = mkdtempSync(join(tmpdir(), 'replay-corpus-'));
  const db = new Db(join(dir, 'world.db')), host = new WorldHost(db, factory, recipe.seed, 1e9, recipe.worldId);
  try {
    host.boot();
    const live: Pin[] = [];
    const rec: Rec = {
      host, db,
      pin: (note) => live.push({ tick: host.engine.world.tick, state: host.engine.stateHash(), kernel: kernelHash(host.kernel), ...(note ? { note } : {}) }),
      async settle(p) { let done = false; p.then(() => { done = true; }, () => { done = true; }); while (!done) { host.tickOnce(); await setImmediate(); host.drainInputs(); } return p; },
      ticks(n, every) { for (let i = 0; i < n; i++) { every?.(i); host.tickOnce(); } },
      decide(salt) {
        for (const m of host.minds.values()) {
          const opts = optionsFor(host, m); if (!opts.length) continue; const o = opts[(salt + m.name.length) % opts.length];
          void host.enqueue('decision', 'test', { soulId: m.soulId, entityId: m.entityId, option: o.id, label: o.label, steps: o.steps, reevalTicks: 600, fallback: false, trigger: 'test', card: o.card, target: o.cardTarget, manner: 'warmly', approachLen: o.approachLen });
        }
      },
    };
    await recipe.run(rec);
    host.drainInputs();
    const w = db.world(recipe.worldId)!, snap = db.latestSnapshotText(recipe.worldId);
    if (!snap) throw Error('replay-corpus: the recipe took no snapshot');
    const log: Log = { world: { id: w.id, seed: w.seed, rules_version: w.rules_version }, events: db.events(recipe.worldId), snapshot: { tick: snap.tick, seq: snap.seq, stateHash: snap.stateHash, rulesVersion: snap.rulesVersion, text: snap.text } };
    // The pins are what the live world was; a refold that disagrees already now is not a corpus entry.
    for (const p of live) { const r = refoldAt(factory, log, p.tick); if (r.state !== p.state || r.kernel !== p.kernel) throw Error(`replay-corpus: refold at tick ${p.tick} (${p.note}) differs from the live world`); }
    const pins: Pins = { name, recipe: recipeName, recordedAt: new Date().toISOString().slice(0, 10), reader: recipe.reader, worldId: recipe.worldId, seed: recipe.seed, adopted: adoptedPolicies(log.events), pins: live, head: { tick: 0, seq: 0, state: '', kernel: '' }, snapshot: { tick: snap.tick, seq: snap.seq } };
    pins.head = headOf(factory, log, pins, dir);
    writeLog(name, log); writePins(pins);
    console.log(`recorded ${name}: ${log.events.length} events, head tick ${pins.head.tick}, ${pins.adopted.length} policies adopted`);
  } finally { host.stop?.(); if (db.db.isOpen) db.close(); rmSync(dir, { recursive: true, force: true }); }
}

function headOf(factory: Awaited<ReturnType<typeof readerFactory>>, log: Log, pins: Pins, dir: string): Pins['head'] {
  const g = bootHead(factory, log, pins.worldId, join(dir, 'genesis.db'), false), s = bootHead(factory, log, pins.worldId, join(dir, 'snapshot.db'), true);
  if (g.from !== 'genesis' || s.from !== 'snapshot') throw Error(`replay-corpus: boots came from ${g.from} and ${s.from}`);
  if (g.state !== s.state || g.kernel !== s.kernel || g.tick !== s.tick) throw Error('replay-corpus: the boot from genesis and the boot from the snapshot differ');
  return { tick: g.tick, seq: g.seq, state: g.state, kernel: g.kernel, note: 'boot head' };
}

async function repin(name: string) {
  const pins = readPins(name), log = readLog(name), factory = await readerFactory(pins.reader);
  const dir = mkdtempSync(join(tmpdir(), 'replay-corpus-'));
  try {
    const next: Pins = { ...pins, pins: pins.pins.map((p) => ({ ...p, ...refoldAt(factory, log, p.tick) })), head: headOf(factory, log, pins, dir) };
    const moved = next.pins.filter((p, i) => p.state !== pins.pins[i].state || p.kernel !== pins.pins[i].kernel).length + (next.head.state !== pins.head.state || next.head.kernel !== pins.head.kernel ? 1 : 0);
    if (write) writePins(next);
    console.log(`${name}: ${moved} of ${next.pins.length + 1} pins ${write ? 'rewritten' : 'differ'}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const argv = process.argv.slice(2), write = argv[0] === '--write';
if (write || argv[0] === '--check') for (const n of !argv[1] || argv[1] === 'all' ? entries() : [argv[1]]) await repin(n);
else if (argv[0] && argv[1] === '--recipe' && argv[2]) await record(argv[0], argv[2]);
else { console.error('usage: record.ts <name> --recipe <' + Object.keys(RECIPES).join('|') + '> | --write <name|all> | --check'); process.exitCode = 2; }
