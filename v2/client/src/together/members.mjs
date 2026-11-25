// What a Soul is told of the activities it is in (0.135, the audit of #4700): who is in each, read from the copy's
// activity nodes (`../brief/copy.mjs` rows' `members`), and the world's words of them, which the view tier addresses
// to every member wherever it stands (`replica::activity::TO_MEMBERS`): a join, the start, a leave, the end, an expiry
// and a carry's set-down. Each is a plain function of the copy's rows, so it is read and tested on its own.
//
// An event as `wait` and `events` show it names the activity by its word (`dance`, `handshake`, `carry`), the Souls
// by name (`you` for this Soul), and keeps the ids beside them: `{"kind":"together","what":"joined","touch":"dance",
// "activity":"<id>","who":"Bo"}`, `{"kind":"carry","what":"set-down","activity":"<crew>","load":"rack beam 3",
// "why":"partner-left"}`.

import { touchOf } from './together.mjs';
import { isCrew } from '../carry/carry.mjs';
import { decode, idText } from '../brief/copy.mjs';

/** The member events, by name: what each means for a member. */
export const MEMBER_EVENTS = Object.freeze({
  'souls:activity-joined': 'joined', 'souls:activity-started': 'started', 'souls:activity-left': 'left',
  'souls:activity-ended': 'ended', 'souls:activity-expired': 'expired', 'souls:carry-set-down': 'set-down',
});
const ID = /^[0-9a-f]{32}-\d+$/;
const local = (v) => String(v).replace(/^[^:]*:/, '');
/** An event's list of ids as `wireEntry` gives it (a list it cannot write as JSON comes as its CBOR, in hex). */
export function idsOf(v) {
  if (Array.isArray(v)) return v;
  if (ID.test(String(v))) return [v];
  try { const d = decode(Buffer.from(String(v), 'hex')); return Array.isArray(d) ? d.map(idText) : []; } catch { return []; }
}

/** An activity's word from its kind: `conversation`, `give`, `carry`, a touch (`handshake`) or another activity's word
 *  (`group-jumping-jacks`); null for a kind that is no activity. */
export function activityWord(kind) {
  const plain = String(kind ?? '').split('@')[0];
  if (plain === 'souls:conversation') return 'conversation';
  if (plain === 'souls:give') return 'give';
  if (isCrew(plain)) return 'carry';
  return touchOf(plain);
}

/** The event kind an activity's word goes by: its own command's (`converse`, `give`, `carry`), else `together`. */
const kindOfWord = (word) => (['conversation', 'give', 'carry'].includes(word) ? word : 'together');
/** The command that leaves an activity of that word. */
export const leaveOf = (word, id) => `${word === 'conversation' ? 'converse' : word === 'carry' ? 'carry' : 'together'} leave ${id}`;

/**
 * The member events of an entry (`wireEntry`'s JSON) as raw notes for `wait`, ids unnamed: `{kind: "activity", what,
 * activity, who?, why?, load?}`. `mine`: the ids that are this Soul (its Soul's, its body's). Its own join is left out
 * (its accept's receipt says it); a leave that removes the activity is its end.
 */
export function memberNotes(entry, mine) {
  const out = [];
  for (const ev of entry.events ?? []) {
    let what = MEMBER_EVENTS[ev.name];
    if (!what) continue;
    const f = ev.fields ?? {}, activity = ID.test(String(f[1] ?? '')) ? f[1] : entry.node, who = entry.actor ?? null;
    if (what === 'joined' && mine.includes(who)) continue;
    if (what === 'left' && entry.removed?.includes(activity)) what = 'ended';
    const why = what === 'set-down' ? f[3] : what === 'ended' ? f[2] : undefined;
    out.push({
      kind: 'activity', what, activity,
      ...(who && (what === 'joined' || what === 'left') ? { who } : {}),
      ...(typeof why === 'string' ? { why: local(why) } : {}),
      ...(what === 'set-down' && ID.test(String(f[2] ?? '')) ? { load: f[2] } : {}),
    });
  }
  return out;
}

/** A Soul's or a thing's name in the copy: `you` for this Soul; a Soul by its body's name; else the id itself. */
export function nameIn(rows, id, mine = []) {
  if (mine.includes(id)) return 'you';
  return rows.get(id)?.name ?? [...rows.values()].find((r) => r.soul === id)?.name ?? id;
}

/**
 * An event as `wait` shows it (`kinds`: activity ids to their kinds, kept from copies before this one, for one that
 * has gone): an offer's `from` by name (`from_id` its body); an answer to this Soul's offer, or a member event, under
 * its activity's own kind and word; who and what by name. Every other event as it is.
 */
export function shownEvent(rows, e, { mine = [], kinds = new Map() } = {}) {
  const kindOf = (id) => rows.get(id)?.kind ?? kinds.get(id);
  const named = (id) => nameIn(rows, id, mine);
  if (e.what === 'offered' || e.what === 'invited') return e.from ? { ...e, from: named(e.from), from_id: e.from } : e;
  // An answer to an offer of this Soul's, or the lapse of one it was asked (`from`, and `word` from that offer's own
  // event): the conversation's id names any offer (`../converse/converse.mjs`).
  const answer = e.kind === 'conversation' && (e.what === 'declined' || e.what === 'lapsed');
  if (e.kind !== 'activity' && !answer) return e;
  const id = answer ? e.conversation : e.activity, word = activityWord(kindOf(id)) ?? e.word ?? null;
  const kind = word ? kindOfWord(word) : e.kind;
  const { kind: _, conversation: __, activity: ___, word: ____, ...rest } = e;
  const from = e.from ? named(e.from) : null, who = e.who !== undefined ? idsOf(e.who).map(named).join(', ') : null;
  return {
    kind, ...rest, ...(kind === 'conversation' ? { conversation: id } : { activity: id }),
    ...(kind === 'together' ? { touch: word } : {}),
    ...(from ? { from, from_id: e.from } : {}),
    ...(who !== null ? { who } : {}),
    ...(e.load ? { load: named(e.load), load_id: e.load } : {}),
    ...noteOf(e, { word: word ?? 'activity', id, from, who, still: inIt(rows, id, mine), others: othersIn(rows, id, [...mine, ...(e.who !== undefined ? idsOf(e.who) : [])]) }),
  };
}

/** The members of activity `id` the copy holds now, by name, but those in `not` (this Soul, and one who just left). */
/** Whether the copy shows this Soul still in activity `id` (an event may be read long after it came). */
const inIt = (rows, id, mine) => Boolean(rows.get(id)?.members?.some((m) => mine.includes(m.body) || mine.includes(m.soul)));
/** Only a `together` activity's roles claim the body; a conversation's or a give's claim a voice, a crew's its hands. */
const holds = (word) => (kindOfWord(word) === 'together' ? ', and it holds you (other acts are refused) until you leave' : '; leave');
const othersIn = (rows, id, not) => (rows.get(id)?.members ?? []).filter((m) => !not.includes(m.body) && !not.includes(m.soul)).map((m) => nameIn(rows, m.body));

/** What happened and what this Soul can do next, in plain words, for a lapse of an offer it was asked and for another
 *  member's leave; nothing for the rest, whose fields say it. */
function noteOf(e, { word, id, from, who, still, others }) {
  if (e.what === 'lapsed' && from) {
    return { note: e.pair
      ? `you accepted ${from}'s ${word}, but it never started before it ran out: it is over, nothing to leave`
      : `${from}'s ${word} offer ran out before you answered: it is gone, so accept would be refused; ask ${from} yourself if you still want to` };
  }
  if (e.what === 'left' && who && who !== 'you') {
    if (!still) return { note: `${who} left the ${word}` };
    return { note: `${who} left the ${word}; ${others.length ? `you are still in it with ${others.join(', ')}` : 'you are the only one left in it'}${holds(word)}: ${leaveOf(word, id)}` };
  }
  return {};
}

/** The activities the copy shows this Soul in (`mine`: its Soul's id and its body's): `[{id, word, started, role,
 *  with: [{name, role, body}]}]`. */
export function activitiesOf(rows, mine) {
  const out = [];
  for (const r of rows.values()) {
    const me = r.members?.find((m) => mine.includes(m.body) || mine.includes(m.soul));
    if (!me) continue;
    const others = r.members.filter((m) => m !== me).map((m) => ({ name: nameIn(rows, m.body, mine), role: local(m.role), body: m.body }));
    out.push({ id: r.id, word: activityWord(r.kind) ?? r.name, started: Boolean(r.started), role: local(me.role), with: others });
  }
  return out;
}

/** `look`'s lines for them: "you are in dance with Bo (started); leave: together leave <id>". Alone in one, the line
 *  says plainly why and what to do: an offer of this Soul's no one has taken yet, or one the others have left. */
export function doingLines(rows, mine) {
  return activitiesOf(rows, mine).map((a) => {
    const leave = leaveOf(a.word, a.id);
    if (!a.with.length) {
      return a.started
        ? `you are alone in ${a.word}: the others left${holds(a.word)}: ${leave}`
        : `you offered ${a.word} and no one has accepted yet: wait for an answer, or take it back: ${leave}`;
    }
    return `you are in ${a.word} with ${a.with.map((m) => m.name).join(', ')} (${a.started ? 'started' : 'not started yet'}); leave: ${leave}`;
  });
}

/** `inspect` of an activity: its word, state, members with their roles, and the act that leaves it. */
export function activityCard(rows, row, mine) {
  if (!row?.members) return null;
  const word = activityWord(row.kind) ?? row.name;
  return {
    activity: word, started: Boolean(row.started),
    members: row.members.map((m) => ({ name: nameIn(rows, m.body, mine), role: local(m.role), body: m.body })),
    leave: leaveOf(word, row.id),
  };
}

/**
 * `inspect` of a thing whose entry has slots for things (a rack bay): each slot, what fills it (by name and id) or
 * what it takes, and how many are left to fill. `slotOf(id)`: a node's slot number (from 1, as the entry lists them).
 * Null for a thing with no such slots.
 */
export function slotsCard(rows, row, entry, slotOf) {
  const names = Object.keys(entry?.slots ?? {});
  if (!names.some((n) => entry.slots[n]?.admits === 'thing')) return null;
  const inside = [...rows.values()].filter((r) => r.parent === row.id);
  const slots = names.map((name, k) => {
    const s = entry.slots[name], held = inside.filter((r) => slotOf(r.id) === k + 1);
    const takes = (s.kinds ?? []).map((kd) => local(kd).replace(/_/g, ' '));
    return { slot: name, ...(held.length ? { holds: held.map((h) => `${h.name} (${h.id})`).join(', ') } : { empty: true, ...(takes.length ? { takes: takes.join(' or ') } : {}) }) };
  });
  const left = slots.filter((s) => s.empty);
  return { slots, built: `${slots.length - left.length} of ${slots.length} slots filled`, ...(left.length ? { left: left.map((s) => `${s.slot}${s.takes ? `: a ${s.takes}` : ''}`) } : {}) };
}
