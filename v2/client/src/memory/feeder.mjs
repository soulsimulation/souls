// The feeder (Engine v2 R14, #2754): T6's named events (v2/docs/effects.md rule 4), as the client receives them,
// become the memory records the shipping line writes, once each. It hands them to the shipping line's own
// `openSoulMemory(...).sawEvents` (tools/world-launcher/soul/memory.mjs), so the record, the dedup key, people, the
// journal and the presence file are what they were; only where the facts come from is new.
//
// An entry as the client holds it, decoded:
//
//   { sequence, at /* world µs */, actor /* a Soul id, or null for the world */, events: [{ name, fields: {n: v} }] }
//
// The names it reads, and their fields. Ids are as the world gives them; human text is never in the log (T8): a field
// that holds words holds a reference, which `textOf(ref)` resolves (null when it can't, or the words were removed).
//
//   souls:act-ended   the actor's act ended    {1: receipt id, 2: act, 3: phase (completed|failed|replaced),
//                                               4: summary ref, 5: place id, 6: place name ref}
//   souls:arrived     the actor arrived        {1: place id, 2: place name ref}
//   souls:approached  the actor came near 1    {1: Soul id it came near, 2: actor's name ref, 3: place id, 4: place name ref}
//   souls:said        the actor said a line    {1: text ref, 2: actor's name ref, 3: place id, 4: place name ref,
//                                               5: conversation id}
//
// Only what concerns this Soul is written: its own acts and arrivals, a Soul that came near it, a line someone else
// said where it could hear. Everything a world said stays marked UNTRUSTED, as the record format requires.

import { openSoulMemory, readAliases, soulDirOf } from './memory.mjs';

const ENDED = 'souls:act-ended', ARRIVED = 'souls:arrived', APPROACHED = 'souls:approached', SAID = 'souls:said';
const PHASES = new Set(['completed', 'failed', 'replaced']);
const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * A feeder for Soul `soul` in the home `home`, in the world the home calls `world`. `realOf(entry)` gives the real
 * time an entry was seen (ms), `textOf(ref)` a reference's words. Returns `feed(entries)`, the number of entries it
 * read; a record already in the log is not written again.
 */
export function feederFor(home, soul, { world, name = null, textOf = () => null, realOf = () => Date.now(), now } = {}) {
  const aliases = readAliases(home);
  // A new id with an alias is written as its old one: whoever and wherever this Soul knew before keeps one file.
  const old = (id) => (str(id) ? aliases.toOld.get(id) ?? id : null);
  const memory = openSoulMemory(soulDirOf(home, soul), { world, soul, name, ...(now ? { now } : {}) });
  const words = (ref) => { const t = str(ref) ? textOf(ref) : null; return typeof t === 'string' && t.trim() ? t : null; };

  /** The shipping line's wire event for one named event, or null when it isn't this Soul's to remember. */
  function wireOf(entry, ev, i) {
    const f = ev.fields ?? {}, me = entry.actor === soul, base = { at: realOf(entry), tick: entry.sequence };
    switch (ev.name) {
      case ENDED:
        if (!me || !str(f[1]) || !PHASES.has(f[3])) return null;
        return {
          ...base, kind: 'receipt',
          receipt: {
            id: f[1], capability: str(f[2]) ?? 'act', phase: f[3], outcome: { summary: words(f[4]) },
            ...(str(f[5]) ? { endedAt: { place: old(f[5]), placePath: [words(f[6])] } } : {}),
          },
        };
      case ARRIVED:
        return me && str(f[1]) ? { ...base, kind: 'arrive', where: { placeId: old(f[1]), place: words(f[2]) } } : null;
      case APPROACHED:
        if (f[1] !== soul || me || !str(entry.actor)) return null;
        return { ...base, kind: 'approach', from: { soulId: old(entry.actor), name: words(f[2]) }, where: { placeId: old(f[3]), place: words(f[4]) } };
      case SAID: {
        const text = words(f[1]);
        if (me || !str(entry.actor) || !text) return null;
        const conversation = str(f[5]);
        return {
          ...base, kind: conversation ? 'conversation.turn' : 'speech', id: `v2-${entry.sequence}-${i}`, text,
          from: { soulId: old(entry.actor), name: words(f[2]) }, where: { placeId: old(f[3]), place: words(f[4]) },
          ...(conversation ? { conversation } : {}),
        };
      }
      default: return null;
    }
  }

  return {
    feed(entries) {
      const wire = entries.flatMap((entry) => (entry.events ?? []).map((ev, i) => wireOf(entry, ev, i)).filter(Boolean));
      if (wire.length) memory.sawEvents(wire);
      return entries.length;
    },
    memory,
  };
}
