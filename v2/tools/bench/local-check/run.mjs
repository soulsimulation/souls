// The local check's bench (Engine v2 R8, #2703): 1,000 scripted intents, each decided on a copy 8 s old in a
// contested room, checked at send time on a current copy with the client's own code (`client/src/check/check.mjs`)
// and R2's form rules in replica's WASM build, and decided by the world with the same rules on the world's state when
// it commits. A shadow arm sends every intent, the stopped ones too, so a stop the world would have accepted is seen.
//
// Declared before the run (#2703):
// - **The room**: 6 lamps and 4 seats (R2's kinds, `crates/replica/cases/kinds/`), one acting body within reach of
//   all. The others in the room change things: each thing changes on average every 10 s (a Poisson process), so over
//   the 8 s a model thinks, 55 % of the things change at least once. A change sets a lamp's `lit`, `level` or plug,
//   rarely its owner-only `wired`; it fills or frees a seat's place or its shelf.
// - **An intent**: at t0 the model picks, at random, a form on a thing (with its arguments) that its copy at t0 did not
//   refuse (yes or unknown). It is sent at t = t0 + 8 s. The daemon checks it at t on the copy, current at t (its age
//   is under the declared bound, no gap). The world decides it at t + d, d uniform in 40..265 ms (the issue's
//   planning estimate between check and commit), on the state then, seeing every audience.
// - **Visible refusal**: the world refuses, and the client, deciding on the world's state at commit, also gets a
//   definite `no` for a reason a copy holds (`SEEN_ALL`): a refusal for a reason the client can see.
// - **Two repeats** (seeds 1 and 2), 1,000 intents each.
//
//   node v2/tools/bench/local-check/run.mjs <replica wasm-bindgen pkg> [intents] [seeds...]
// Prints one JSON line per repeat; exits 1 if a repeat misses A1 (95 %) or A2 (no accepted intent stopped).

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SEEN_ALL, judge, sift } from '../../../client/src/check/check.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pkg = resolve(process.argv[2] ?? join(v2, 'target/wasm-load/pkg'));
const N = Number(process.argv[3] ?? 1000);
const SEEDS = process.argv.length > 4 ? process.argv.slice(4).map(Number) : [1, 2];
const THINK_MS = 8000, MEAN_CHANGE_MS = 10_000, COMMIT_MS = [40, 265], SPACING_MS = 250;

const r = await import(pathToFileURL(join(pkg, 'replica.js')).href);
r.initSync({ module: readFileSync(join(pkg, 'replica_bg.wasm')) });
const entry = (f) => JSON.parse(readFileSync(join(v2, 'crates/replica/cases/kinds', f), 'utf8'));
const LAMP = entry('lamp.json'), SEAT = entry('seat.json');
const kinds = { [LAMP.kind]: LAMP, [SEAT.kind]: SEAT };
const CLIENT = { sees: [] }, WORLD = { sees: 'all' };

/** A small seeded generator (mulberry32), so a repeat is the same run. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
}

const LAMPS = Array.from({ length: 6 }, (_, k) => `l${k}`), SEATS = Array.from({ length: 4 }, (_, k) => `s${k}`);
const ACTS = [
  ...LAMPS.flatMap((l) => ['switch_on', 'switch_off', 'dim', 'plug_in', 'unplug'].map((form) => ({ this: l, form }))),
  ...SEATS.flatMap((s) => [{ this: s, form: 'sit', args: { seat: 'left' } }, { this: s, form: 'sit', args: { seat: 'right' } }, { this: s, form: 'stow' }]),
];

function initial() {
  const nodes = { me: { effector_mm: [0, 0, 300] } };
  for (const l of LAMPS) nodes[l] = { kind: LAMP.kind, fields: { lit: false, wired: true, level: 500 }, links: { plugged: ['w'] } };
  for (const s of SEATS) nodes[s] = { kind: SEAT.kind, slots: { left: [], right: [], shelf: [] } };
  return { actor: 'me', nodes, moves: { press: { reach_mm: 300 }, lower: { reach_mm: 1000 } } };
}

/** One change by someone else in the room, to thing `id`. */
function change(state, id, rand) {
  const n = state.nodes[id], x = rand();
  if (n.kind === LAMP.kind) {
    if (x < 0.4) n.fields.lit = !n.fields.lit;
    else if (x < 0.7) n.fields.level = [0, 500, 1000][Math.floor(rand() * 3)];
    else if (x < 0.95) n.links.plugged = n.links.plugged.length ? [] : ['w'];
    else n.fields.wired = !n.fields.wired;
  } else {
    const slot = x < 0.4 ? 'left' : x < 0.8 ? 'right' : 'shelf', most = slot === 'shelf' ? 2 : 1;
    n.slots[slot] = n.slots[slot].length >= most ? [] : [...n.slots[slot], 'other'];
  }
}

function repeat(seed) {
  const rand = rng(seed);
  // The others' changes over the whole run, and the times each intent is looked at.
  const end = N * SPACING_MS + THINK_MS + 1000, things = [...LAMPS, ...SEATS], changes = [];
  for (const id of things) for (let t = 0; ;) { t += -Math.log(1 - rand()) * MEAN_CHANGE_MS; if (t > end) break; changes.push({ t, id }); }
  changes.sort((a, b) => a.t - b.t);
  const intents = Array.from({ length: N }, (_, k) => {
    const t0 = 1000 + k * SPACING_MS;
    return { k, t0, t: t0 + THINK_MS, commit: t0 + THINK_MS + COMMIT_MS[0] + rand() * (COMMIT_MS[1] - COMMIT_MS[0]) };
  });
  const asks = intents.flatMap((i) => [['t0', i], ['t', i], ['commit', i]]).sort((a, b) => a[1][a[0]] - b[1][b[0]]);
  // Sweep time: apply the changes up to each ask, and copy the state there.
  const state = initial(), at = new Map();
  let c = 0;
  for (const [when, i] of asks) {
    while (c < changes.length && changes[c].t <= i[when]) change(state, changes[c++].id, rand);
    at.set(`${i.k}/${when}`, structuredClone(state));
  }
  const decide = (input) => r.rules_decide(input);
  const out = { seed, intents: N, unknownAtSend: 0, worldRefused: 0, visibleRefused: 0, stopped: 0, stoppedOfVisible: 0,
    stoppedButAccepted: { sameState: 0, changedBeforeCommit: 0 }, sentWithCheck: 0, acceptedWithCheck: 0, acceptedWithout: 0, stoppedBy: {} };
  for (const i of intents) {
    // The model's pick, on its copy at t0: a form its copy did not refuse.
    const copy0 = at.get(`${i.k}/t0`);
    const open = ACTS.filter((a) => judge(decide, { verb: 'v', ...a }, { kinds, state: copy0, asker: CLIENT, seen: SEEN_ALL }).verdict !== 'no');
    const pick = { verb: 'v', ...open[Math.floor(rand() * open.length)] };
    // The daemon's check at send time, on a current copy.
    const local = judge(decide, pick, { kinds, state: at.get(`${i.k}/t`), asker: CLIENT, seen: SEEN_ALL });
    const { keep } = sift([pick], [local], true);
    if (local.verdict === 'unknown') out.unknownAtSend++;
    // The world, at commit, seeing everything; and whether the client could see its refusal.
    const world = judge(decide, pick, { kinds, state: at.get(`${i.k}/commit`), asker: WORLD, seen: new Set([...SEEN_ALL, 'out_of_reach', 'no_free_hand', 'not_holding_kind', 'not_held']) });
    const seenByClient = judge(decide, pick, { kinds, state: at.get(`${i.k}/commit`), asker: CLIENT, seen: SEEN_ALL });
    const accepted = world.verdict === 'yes';
    if (accepted) out.acceptedWithout++;
    else out.worldRefused++;
    const visible = !accepted && seenByClient.verdict === 'no';
    if (visible) out.visibleRefused++;
    if (keep.length === 0) {
      out.stopped++;
      out.stoppedBy[local.reason] = (out.stoppedBy[local.reason] ?? 0) + 1;
      if (visible) out.stoppedOfVisible++;
      if (accepted) {
        const sameState = judge(decide, pick, { kinds, state: at.get(`${i.k}/t`), asker: WORLD, seen: SEEN_ALL }).verdict === 'yes';
        out.stoppedButAccepted[sameState ? 'sameState' : 'changedBeforeCommit']++;
      }
    } else {
      out.sentWithCheck++;
      if (accepted) out.acceptedWithCheck++;
    }
  }
  out.a1StoppedPct = Math.round((1000 * out.stoppedOfVisible) / Math.max(out.visibleRefused, 1)) / 10;
  out.firstSendAcceptedPct = { without: Math.round((1000 * out.acceptedWithout) / N) / 10, with: Math.round((1000 * out.acceptedWithCheck) / Math.max(out.sentWithCheck, 1)) / 10 };
  return out;
}

let missed = false;
for (const seed of SEEDS) {
  const o = repeat(seed);
  console.log(JSON.stringify(o));
  if (o.a1StoppedPct < 95 || o.stoppedButAccepted.sameState + o.stoppedButAccepted.changedBeforeCommit > 0) missed = true;
}
process.exit(missed ? 1 : 0);
