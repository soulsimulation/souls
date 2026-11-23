// Stage 4 (#4175): what a v2 Soul says, as the old page shows speech. The v2 reader hands on each part's `souls:said`
// events (v2/web/src/source/source.ts SaidRec); the old page's speech layer and its dialogue dock read `talk` lines
// (@souls/protocol TalkLine), and a take's events carry them as marks. Pure: the bridge keeps the lines, once each.

/** One `souls:said` as the reader posts it (only the fields read here). A private turn carries no words. */
export type Said = { speaker: string; at: number; length: number; reach?: number; ref: string; words: string | null; private?: unknown };
/** @souls/protocol TalkLine, as the old socket sends it. */
export type Talk = { id: number; tick: number; at: number; from: string; to: string; fromName: string; toName: string; act: string; text: string; place: string | null };

/** A said with words the public may read: never a private turn, never one whose words the part's text file lacks. */
export const isPublic = (s: Said) => !s.private && typeof s.words === 'string' && s.words.length > 0;

/** The key a said is kept once by: its speaker, time and words' reference. */
export const saidKey = (s: Said) => `${s.speaker}|${s.at}|${s.ref}`;

/**
 * The talk line for `s`: `id` the page's order (ascending), `from` the speaker's public Soul id and `name` its name,
 * `tick` the world tick it was said on (TICK_US µs a tick), `at` the wall time (ms) the page draws that tick.
 */
export function talkOf(s: Said, id: number, from: string, name: string, tickUs: number, wallAt: number): Talk {
  return { id, tick: Math.floor(s.at / tickUs), at: wallAt, from, to: '', fromName: name, toName: '', act: 'say', text: s.words ?? '', place: null };
}

/** The take's event for a said in a chunk starting at tick `fromTick`: a mark at its tick, carrying the talk line. */
export const markOf = (t: Talk, fromTick: number) => ({ t: t.tick - fromTick, type: 'mark' as const, name: 'said', data: { from: t.from, text: t.text } });

/** The old page's edge viewer message for a public `say` (EDGE-CONTRACT-v1 §7 `speech`, as the dialogue dock and the
 *  speech layer read it): said aloud, heard within its reach. Not a talk line, which the old page shows as a private
 *  pairwise exchange. `reach` mm; `id` keeps it once. */
export function speechOf(t: Talk, reach: number) {
  return { type: 'edge' as const, kind: 'speech', id: `v2:${t.id}`, tick: t.tick, at: t.at, from: { soulId: t.from, name: t.fromName }, text: t.text,
    channel: { kind: 'earshot', radius: reach > 0 ? reach / 1000 : 12 } };
}
