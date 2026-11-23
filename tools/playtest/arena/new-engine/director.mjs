// The directed session's parts on the new engine (0.135 P2): what `playtest.mjs direct <cast> --engine v2` hands
// director/swarm/run.mjs in place of the old world's (its `modules` hook), each with the same calls:
//
//   provision  the cast's genesis, a committed template, served by v2/tools/dev/run.sh (world.mjs), its owner's mailbox on
//   seat       a scripted-owner seat: paired as v2/client/served/e2e pairs one, named and joined; it reads its owner's
//              messages with the new client (`pending`), answers each by its script's rule, and closes it (`ack`)
//   owner      the cast's owners: a message to a Soul goes to the directory's mailbox (`/v1/mailbox/put`, the dev
//              sign-in's test person), and its card is the mailbox's own record of it (`/v1/mailbox/read`)
//   swarmTruth what the world shows: each Soul's body in the public stream (observer/new-engine/stream.mjs), where it
//              is (its frames' place names) and what it said
//
// Only model-free seats: a cast with a live seat is refused (no model runs on this path). The scripts' words are the
// cast's own; a step in the old client's words is read in the new client's (`newWords`).
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startWorld as startV2, stopWorld as stopV2, healthz as healthV2 } from './world.mjs';
import { pairSeat } from './seat.mjs';
import { streamViewer, closeViewers } from '../../observer/new-engine/stream.mjs';
import { matchRule, stepArgs, stepOptions, bindPrev } from '../adapters/scripted-owner.mjs';
import { sleep } from '../../lib/clock.mjs';

/** The directory's key for a client's Soul id (`s_<hex>-<n>` → `soul-<hex>-<n>`). */
export const mailboxSoul = (soul) => String(soul).replace(/^s_/, 'soul-');

/** An old-client step in the new client's words: `act "walk to <words>"` or `act walk:<id>` → `act ?<words>` (found in
 *  the Soul's copy); `--wait <n>` → `--wait`. Anything else is passed as it is. */
export function newWords(step) {
  const w = [...step];
  if (w[0] === 'act' && typeof w[1] === 'string') {
    const to = /^walk to (.+)$/i.exec(w[1]) ?? /^walk:(.+)$/.exec(w[1]);
    if (to) w[1] = `?${to[1].replace(/\/.*$/, '')}`;
  }
  const i = w.indexOf('--wait');
  if (i >= 0 && /^\d+$/.test(w[i + 1] ?? '')) w.splice(i + 1, 1);
  return w;
}

/** A place path from a node's frames: the place names of its parents, innermost first. */
export function placePathOf(nodes, id) {
  const out = [];
  for (let n = nodes.get(id), d = 0; n && d < 32; n = n.parent ? nodes.get(n.parent) : null, d++) if (n.id !== id && n.placeName) out.push(n.placeName);
  return out;
}

/** Where "walk to <words>" goes in a Soul's own copy: the first thing found for the words (not a body); a building is
 *  gone into, to its first room (a walk to a building's id ends at its door, outside). */
export async function placeIn(v2, words) {
  const found = ((await v2.cli('find', ...words.split(/\s+/))).found ?? []).filter((r) => !r.kind?.startsWith('souls:body'));
  const there = found[0] ?? null;
  if (!there?.name) return there;
  const rooms = ((await v2.cli('find', 'room', '--limit', '80')).found ?? []).filter((r) => r.kind?.endsWith(':room') && String(r.in ?? '').split(', ').includes(there.name));
  return rooms[0] ?? there;
}

export function newEngineModules({ log = () => {} } = {}) {
  let world = null, viewer = null;
  const sent = new Map(); // soul → [message ids], newest last
  const bodies = new Map(); // soul → its body's client id, as its own copy has it

  const provision = {
    async startWorld({ genesis, dataDir, log: logFile, onSpawn }) {
      world = await startV2({ template: genesis, dir: join(dataDir, 'v2'), log: logFile });
      onSpawn?.({ pid: world.pid });
      viewer = await streamViewer({ world });
      log(`new engine: ${world.page}`);
      return { kind: 'v2', base: world.page.replace(/\/$/, ''), pid: world.pid, build: null, page: world.page, directory: world.directory };
    },
    describeWorld: async () => ({}),
    healthz: async () => (world ? healthV2(world) : { ok: false }),
    async stopWorld() { closeViewers(); if (world) await stopV2(world); return { stopped: true }; },
  };

  const owner = {
    async sendCard({ soulId, identity, text }) {
      const r = await fetch(new URL('/v1/mailbox/put', world.directory), { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ soul: mailboxSoul(soulId), text, test_person: identity }) });
      const b = await r.json().catch(() => null);
      if (!r.ok || !b?.id) throw Object.assign(new Error(`mailbox put → ${r.status} ${b?.refused ?? ''}`), { status: r.status });
      sent.set(soulId, [...(sent.get(soulId) ?? []), b.id]);
      return { messageId: b.id, sentAt: new Date().toISOString(), state: 'sent', inbox: null };
    },
    async cardView({ soulId, identity }) {
      const messages = [];
      for (const id of (sent.get(soulId) ?? []).slice(-5)) {
        const r = await fetch(new URL('/v1/mailbox/read', world.directory), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, test_person: identity }) });
        const m = await r.json().catch(() => null);
        if (m?.id) messages.push({ id: m.id, text: m.text, state: m.state ?? null, outcome: m.outcome ?? null, result: m.state === 'done' || m.state === 'failed' ? (m.outcome ?? m.state) : null });
      }
      return { latest: messages.at(-1) ?? null, messages };
    },
  };

  const seat = {
    async createSeat({ runDir, seat: s }) {
      if (s.adapter !== 'scripted-owner') throw new Error(`seat ${s.id}: only scripted-owner seats run on the new engine here (no model runs); ${s.adapter ?? 'a live seat'} is refused`);
      const dir = join(runDir, 'seats', s.id);
      mkdirSync(dir, { recursive: true });
      const info = { id: s.id, soulName: s.soulName ?? s.id, adapter: s.adapter, soulId: null, ownerIdentity: s.id, body: null };
      let v2 = null, looping = false, stopped = false;
      const handled = new Set(), transcript = join(dir, 'turns.jsonl');
      const note = (rec) => appendFileSync(transcript, JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n');
      /** One owner's message, answered by the script's first matching rule. */
      async function serve(m) {
        const rule = matchRule(s.script, m.text);
        note({ message: m.id, text: m.text, rule: rule?.match ?? null });
        if (!rule) { await v2.cli('ack', m.id, s.script.unmatched ?? 'no scripted response', '--close', 'failed'); return; }
        await v2.cli('ack', m.id, rule.ack ?? 'On it.');
        let ok = true, prev = null;
        for (const step of rule.do ?? []) {
          let words = newWords(stepArgs(step));
          const bound = bindPrev(words, prev);
          if (bound.error) { ok = false; note({ message: m.id, step: words, error: bound.error }); break; }
          words = await Promise.all(bound.args.map(async (w) => (w.startsWith('?') ? (await placeIn(v2, w.slice(1)))?.id ?? w : w)));
          const r = await v2.cli(...words);
          prev = r;
          const refused = r?.ok === false || r?.phase === 'refused';
          note({ message: m.id, step: words, answer: r });
          if (refused && (stepOptions(step)?.onRefused ?? 'fail') !== 'continue') { ok = false; break; }
        }
        if (rule.close !== 'open') await v2.cli('ack', m.id, (rule.result ?? (ok ? 'Done' : 'Could not')).slice(0, 140), '--close', ok ? 'done' : 'failed');
      }
      const self = {
        info, dir, rails: null, budgetRefused: null,
        async onboard() {
          v2 = await pairSeat({ world, dir, label: s.id, owner: s.id, name: info.soulName });
          info.body = (await v2.join()).body; info.soulId = v2.soul; bodies.set(v2.soul, info.body);
          note({ onboard: true, soul: v2.soul, body: info.body });
          return { ok: !!info.body, soulId: v2.soul, soulName: info.soulName };
        },
        wakeLoop() {
          if (looping) return; looping = true;
          (async () => {
            while (!stopped) {
              const p = await v2.cli('pending').catch(() => null);
              for (const m of p?.open ?? []) if (!handled.has(m.id)) { handled.add(m.id); await serve(m).catch((e) => note({ message: m.id, error: e.message })); }
              await sleep(1500);
            }
          })();
        },
        chat: async () => ({ ok: true, skipped: 'a scripted seat takes its owner\'s messages only' }),
        status: async () => ({ ok: true, data: { paired: !!info.soulId } }),
        save() {},
        async stop() { stopped = true; await v2?.stop(); },
      };
      return self;
    },
  };

  const swarmTruth = () => ({
    async soul(soulId) {
      if (!viewer) return { soulId, ok: false };
      const body = bodies.has(soulId) ? viewer.node(bodies.get(soulId)) : null;
      if (!body) return { soulId, ok: false };
      const placePath = placePathOf(viewer.nodes, body.id);
      const speech = viewer.said().filter((x) => x.speaker === bodies.get(soulId) && !x.private && x.words)
        .map((x) => ({ atMs: Math.round(x.at / 1000), tick: null, text: x.words, channel: 'say', pos: null, posSource: null }));
      return { soulId, ok: true, place: placePath[0] ?? null, placePath, posture: body.slot != null ? 'seated' : 'standing', activity: null, speech, pos: [body.pos[0] / 1e6, body.pos[2] / 1e6], posSource: 'stream' };
    },
  });

  return { provision, seat, owner, swarmTruth, truth: null, browser: null };
}
