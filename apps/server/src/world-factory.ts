// The engine factory a world process reads its history with, chosen from its config and environment. One place, so the
// server (main.ts) and the boot rehearsal (tools/world-launcher/deploy/boot-rehearsal.mjs) read a world the same way.
import type {EngineFactory} from '@souls/engine-contract';
import {KNOWN_WORLD_KEYS, type config as Config} from './config.ts';
import {edenCoreRequested, edenHistoryFactory} from './eden-bootstrap.ts';
import {recordedToyFactory} from './toy-takes.ts';
import type {Db} from './db.ts';

type Cfg = typeof Config;
/** #1323: every Mars world reads its history with and without the repair rules; `SIM_SOULS_REPAIR=0` adopts nothing. */
export async function repairReader(cfg: Cfg, inner: EngineFactory, env: NodeJS.ProcessEnv = process.env): Promise<EngineFactory> {
  if (cfg.engine !== 'mars') return inner;
  const mars = await import('@souls/engine-mars');
  return mars.soulsRepairReaderV1(inner, {adopt: env.SIM_SOULS_REPAIR !== '0'});
}
/** A world's engine factory when it is not Eden core (that one reads its history from the database). */
export async function plainWorldFactory(cfg: Cfg, env: NodeJS.ProcessEnv = process.env): Promise<EngineFactory> {
  const mars = cfg.engine === 'mars' ? await import('@souls/engine-mars') : null;
  const accountLifecycle = cfg.worldEngine && !edenCoreRequested(cfg, env) && env.SOUL_LIFECYCLE === '1';
  const f = mars ? await repairReader(cfg, await mars.marsFactory(cfg.worldKey === 'littlemartians' ? mars.LITTLE_MARTIANS_WORLD : cfg.worldKey === 'eden' || !KNOWN_WORLD_KEYS.includes(cfg.worldKey as never) ? (accountLifecycle ? {...mars.GREEN_FIELD_WORLD, safeCrewRemoval: true} : mars.GREEN_FIELD_WORLD) : undefined), env) : recordedToyFactory;
  return f === recordedToyFactory ? f : describedFactoryV1(f, {kind: 'plain', cfg: {engine: cfg.engine, worldKey: cfg.worldKey, worldEngine: cfg.worldEngine}, env: {ENABLE_EDEN_CORE: env.ENABLE_EDEN_CORE, SOUL_LIFECYCLE: env.SOUL_LIFECYCLE, SIM_SOULS_REPAIR: env.SIM_SOULS_REPAIR}});
}
/** #2140: plain data another thread rebuilds the same factory from (god/edit-preview-worker.ts). `plain`: this file's
 *  plainWorldFactory with the config and environment it read; `mars`: marsFactory(world) as is. Eden core is not
 *  described (its factory reads the database's history). */
export type FactoryDescriptorV1 =
  | {kind: 'plain'; cfg: Pick<Cfg, 'engine' | 'worldKey' | 'worldEngine'>; env: Record<string, string | undefined>}
  | {kind: 'mars'; world: Record<string, unknown>};
const DESCRIPTOR = Symbol.for('souls.factory-descriptor/1');
/** Attach `d` to `f` (not enumerable; the factory itself is unchanged). */
export function describedFactoryV1<F extends object>(f: F, d: FactoryDescriptorV1): F { Object.defineProperty(f, DESCRIPTOR, {value: d, configurable: true}); return f; }
export function factoryDescriptorV1(f: object): FactoryDescriptorV1 | null { return (f as {[DESCRIPTOR]?: FactoryDescriptorV1})[DESCRIPTOR] ?? null; }
export async function factoryFromDescriptorV1(d: FactoryDescriptorV1): Promise<EngineFactory> {
  if (d.kind === 'plain') return plainWorldFactory(d.cfg as Cfg, d.env as NodeJS.ProcessEnv);
  const mars = await import('@souls/engine-mars');
  return mars.marsFactory(d.world as never);
}
/** The readers Eden core opts into (main.ts checks their combinations before it boots). */
export function edenReaderOptions(env: NodeJS.ProcessEnv = process.env) {
  const lifeV1 = env.ENABLE_EDEN_LIFE === '1';
  return {lifeV1, newcomerResourcesV1: env.ENABLE_EDEN_NEWCOMER_READER === '1', sleepSnapshotV1: env.ENABLE_NATIVE_SLEEP_SNAPSHOT_READER === '1', lectureV1: env.ENABLE_EDEN_LECTURE_READER === '1', groundV1: env.ENABLE_EDEN_EXPANSION_GROUND_READER === '1'};
}
/** The factory for this world: Eden core reads its history from the database; every other world uses its plain factory. */
export async function worldFactory(db: Db, cfg: Cfg, env: NodeJS.ProcessEnv = process.env): Promise<EngineFactory> {
  return edenCoreRequested(cfg, env) ? repairReader(cfg, await edenHistoryFactory(db, cfg.worldId, edenReaderOptions(env)), env) : plainWorldFactory(cfg, env);
}
