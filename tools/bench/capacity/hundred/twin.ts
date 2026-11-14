// #2301 A2: the twin. A world's state at tick T computed straight through: from genesis, every tick stepped, the world's
// own log folded in at its ticks (fold.ts replayFromGenesis), no jump. Run with the world's own environment (the
// launcher's command for it, DATA_DIR at a copy of its files) instead of main.ts; prints one JSON line.
//
//   node tools/bench/capacity/hundred/twin.ts <T>      → {"tick": T, "stateHash": "…", "events": n, "ms": …}
import { join } from 'node:path';
import { config } from '../../../../apps/server/src/config.ts';
import { Db } from '../../../../apps/server/src/db.ts';
import { replayFromGenesis } from '../../../../apps/server/src/fold.ts';
import { loadGroundRecipes } from '../../../../apps/server/src/god/ground-host.ts';
import { plainWorldFactory } from '../../../../apps/server/src/world-factory.ts';

const until = Number(process.argv[2]);
if (!Number.isInteger(until) || until < 0) throw new Error('usage: twin.ts <tick>');
const t0 = performance.now(), db = new Db(join(config.dataDir, 'sim.db'));
if (config.worldEngine) loadGroundRecipes(db, config.worldId);
const factory = await plainWorldFactory(config, process.env);
const events = db.events(config.worldId), seed = (db.world(config.worldId) as { seed?: string } | undefined)?.seed ?? config.worldSeed;
const r = replayFromGenesis(factory as never, seed, events, until);
console.log(JSON.stringify({ tick: r.engine.world.tick, stateHash: r.engine.stateHash(), events: events.filter((e) => e.tick <= until).length, ms: Math.round(performance.now() - t0) }));
db.close();
process.exit(0);
