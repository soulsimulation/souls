// 0.133 R3: a world the new engine runs, in the old page's talk panel (the dialogue dock), its ticker and its radios.
// Pure; the bridge hands each part's records here and the hook puts what comes back where the old socket put it.
//
// - Public speech already reaches the dock as edge `speech` messages (take-speech.ts).
// - A private turn: the public stream carries who spoke, when, in which conversation and among whom (`souls:said-
//   privately`, #3775), never the words. The dock shows it as the old page showed a sealed conversation to anyone not
//   in it: its members, and a `…` line for each turn (dialogue-threads.ts `conversation.talking`). Its words, which the
//   old page showed its members, are not in any stream a page reads today.
// - The ticker: what the Souls did, as one line each (`<name> sat down`), from the stream's move records and the named
//   events on bodies. The old ticker was the world's own director model; the new engine runs no mind, so its lines are
//   the record's.

import type { Said } from './take-speech.ts';

/** A private turn's public record, as the reader posts it (v2/web/src/source/source.ts SaidRec `private`). */
type Private = { conversation: string; members: string[] };
type Who = { soulId: string; name: string };

/** The dock's edge messages for private turn `s` (taken once per turn by its own key): the conversation's members, then
 *  a `…` line from its speaker. Null for a public said. `who` names a node as the page does (its Soul id and name). */
export function privateTurnOf(s: Said, tick: number, at: number, who: (node: string) => Who | null) {
  const p = s.private as Private | undefined;
  if (!p?.conversation) return null;
  const from = who(s.speaker);
  if (!from) return null;
  const conversation = `v2:${p.conversation}`;
  const members = p.members.map(who).filter((m): m is Who => !!m);
  return [
    ...members.map((m) => ({ type: 'edge' as const, kind: 'conversation.member', conversation, soul: m, change: 'joined', tick, at })),
    { type: 'edge' as const, kind: 'conversation.talking', conversation, from, tick, at },
  ];
}

/** Words for what a body did, by move or event name (its local part): what the ticker says after the Soul's name. */
const DID: Readonly<Record<string, string>> = {
  sit: 'sat down', sit_down: 'sat down', sat_down: 'sat down', lie: 'lay down', lie_down: 'lay down', rise: 'stood up', stand: 'stood up',
  stood_up: 'stood up', walk: 'set off walking', wave: 'waved', bow: 'bowed', clap: 'clapped', nod: 'nodded', shake_head: 'shook their head',
  cheer: 'cheered', point: 'pointed', dance: 'danced', jump: 'jumped', stretch: 'stretched', shrug: 'shrugged', taken: 'picked something up',
  put: 'put something down', set_down: 'set something down', idle: 'went idle', asleep: 'fell asleep', awake: 'woke up',
};
const local = (name: string) => name.slice(name.indexOf(':') + 1).split('@')[0];

/** The ticker's words for a move or event `name`, or null for one it does not tell. */
export const didOf = (name: string): string | null => DID[local(name)] ?? null;

/** One ticker line (@souls/protocol TickerLine) for body `name` doing `what` at take tick `tick`; null for what the ticker
 *  does not tell. */
export function tickerOf(tick: number, name: string, what: string): { tick: number; text: string } | null {
  const did = didOf(what);
  return did ? { tick, text: `${name} ${did}` } : null;
}
