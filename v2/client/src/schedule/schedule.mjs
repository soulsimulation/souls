// The Soul's own schedule (Engine v2 R15, #2757): every "when" is kept on the agent's side, never by the world. The
// world holds no order that waits for a time or a condition (T10); it only publishes its clocks, calendars and
// timetables (E7). The owner's machine keeps the schedule, and a routine does not run while that machine is off.
//
// **One file**, `<home>/souls/<soul>/memory/schedule.md`, the owner's to read and edit (the file today's client
// already keeps; this gives it a form the daemon runs). Each entry is one list line:
//
//   - <id> · <when> · <do> [· until <real time>] [· missed drop|tell|late <n>s|m|h]
//
//   <when>  a real time, ISO with its zone (`2026-11-19T20:00:00Z`); a change, R9's pattern as JSON
//           (`{"event":"eden:light-changed","fields":{"70":"dusk"}}`); or a world time (`world 20:00`), which waits
//           for the copy's world clock (R15b, #3517) and fires nothing until then
//   <do>    `act <act> [<act> ...]`, a ranked list as `souls.mjs act` takes it, sent with no model turn and checked
//           at send (R8); or `wake <why>`, a wake through R13's budget, which costs a turn
//
// Any other line (a heading, a note) is left alone. A list line that does not parse is named in `schedule list` and
// is inert. Entries are one-off: each fires at most once.
//
// - **On time** is within ON_TIME_MS of its moment. A real time passed by more than that (the daemon was off, or the
//   lid was closed) never fires late unasked: its `missed` rule says what happens. `tell` (the default) lists it in
//   the daemon's next answer, `drop` only counts it, `late <d>` fires it if it is no later than that, else tells.
// - **Once each.** An occurrence is keyed by its id and its line, and marked on disk before its intent is sent with
//   its reserved sequence number, so a crash never sends it twice.
//
// `now` is the caller's clock in ms; this module reads none.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Refused, matches, parseWhen } from '../match/match.mjs';

export const ON_TIME_MS = 5000;
export const ACTS_MOST = 5;
const SEP = ' · ';
const ID = /^s\d{1,6}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const WORLD = /^world (\d{2}):(\d{2})$/;
const DURATION = /^(\d{1,6})(s|m|h)$/;
const UNIT = { s: 1000, m: 60_000, h: 3_600_000 };
const HEADER = '# Schedule\n\nEach entry: `- <id> · <when> · <do> [· until <time>] [· missed drop|tell|late <n>m]`. '
  + 'Written by `souls.mjs schedule add`; yours to edit.\n\n';

const realTime = (text, code) => {
  if (!ISO.test(text) || Number.isNaN(Date.parse(text))) throw new Refused(code, `${text.slice(0, 40)}: an ISO time with its zone`);
  return Date.parse(text);
};

/** The `when` of an entry, as written: `{real}`, `{change}` or `{world}`. Refuses by name. */
export function parseTrigger(text) {
  const t = text.trim();
  if (t.startsWith('{')) {
    let p;
    try { p = JSON.parse(t); } catch { throw new Refused('when-not-json', 'a change is R9\'s pattern, as JSON'); }
    return { change: parseWhen(p) };
  }
  const w = WORLD.exec(t);
  if (w) {
    if (Number(w[1]) > 23 || Number(w[2]) > 59) throw new Refused('when-not-a-time', t);
    return { world: `${w[1]}:${w[2]}` };
  }
  return { real: realTime(t, 'when-not-a-time') };
}

/** The `do` of an entry: `{acts}` or `{wake}`. Refuses by name. */
export function parseDo(text) {
  const [verb, ...rest] = text.trim().split(/\s+/);
  if (verb === 'wake') {
    const why = text.trim().slice(4).trim();
    if (!why || why.length > 200) throw new Refused('do-wake-why', 'wake <why>, one line');
    return { wake: why };
  }
  if (verb !== 'act' || rest.length === 0 || rest.length > ACTS_MOST) throw new Refused('do-not-an-act', `act <act> [...] (1 to ${ACTS_MOST}), or wake <why>`);
  return { acts: rest };
}

/** One list line as an entry, or null if it is not a list line. Refuses by name. */
export function parseLine(line) {
  if (!line.startsWith('- ')) return null;
  const parts = line.slice(2).split(SEP).map((s) => s.trim());
  const [id, when, does, ...opts] = parts;
  if (!ID.test(id ?? '')) throw new Refused('entry-id', 'an entry starts with its id, s<n>');
  if (!when || !does) throw new Refused('entry-parts', '<id> · <when> · <do>');
  const e = { id, ...parseTrigger(when), ...parseDo(does), until: null, missed: { rule: 'tell' } };
  for (const o of opts) {
    if (o.startsWith('until ')) e.until = realTime(o.slice(6).trim(), 'until-not-a-time');
    else if (o === 'missed drop' || o === 'missed tell') e.missed = { rule: o.slice(7) };
    else if (o.startsWith('missed late ')) {
      const d = DURATION.exec(o.slice(12).trim());
      if (!d) throw new Refused('missed-late', 'missed late <n>s|m|h');
      e.missed = { rule: 'late', ms: Number(d[1]) * UNIT[d[2]] };
    } else throw new Refused('entry-option', `${o.slice(0, 40)}: until <time> or missed drop|tell|late <n>m`);
  }
  e.key = `${id}@${createHash('sha256').update(line).digest('hex').slice(0, 12)}`;
  e.line = line;
  return e;
}

/** The file's entries, and the list lines that do not parse (named, inert). A missing file has none. */
export function readSchedule(file) {
  const entries = [], bad = [];
  if (!existsSync(file)) return { entries, bad };
  readFileSync(file, 'utf8').split('\n').forEach((line, k) => {
    try {
      const e = parseLine(line.trimEnd());
      if (e) entries.push(e);
    } catch (err) {
      bad.push({ line: k + 1, text: line.slice(0, 120), code: err.code ?? 'entry-bad', detail: err.message });
    }
  });
  return { entries, bad };
}

const writeAtomic = (file, text) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
};

/**
 * `schedule add`: one entry appended. `when` is a real time, `in <n>s|m|h`, a world time (`world 20:00`, or
 * `at 20:00`, `20:00`), or a pattern as JSON; `does` the words after it. A real time already passed is refused.
 */
export function addEntry(file, { when, does, until, missed }, now) {
  let w = String(when ?? '').trim();
  const rel = /^in (\d{1,6})(s|m|h)$/.exec(w);
  if (rel) w = new Date(now + Number(rel[1]) * UNIT[rel[2]]).toISOString();
  const clock = /^(?:at )?(\d{1,2})(?::(\d{2}))?$/.exec(w);
  if (clock) w = `world ${clock[1].padStart(2, '0')}:${clock[2] ?? '00'}`;
  if (w.startsWith('{')) { try { w = JSON.stringify(JSON.parse(w)); } catch { /* refused below, by name */ } }
  const text = readSchedule(file).entries.map((e) => Number(e.id.slice(1)));
  const id = `s${Math.max(0, ...text) + 1}`;
  let line = `- ${id}${SEP}${w}${SEP}${does}`;
  if (until) line += `${SEP}until ${until}`;
  if (missed) line += `${SEP}missed ${missed}`;
  const e = parseLine(line);
  if (e.real !== undefined && e.real < now - 1000) throw new Refused('when-passed', `${w} has passed: a passed time never fires`);
  const old = existsSync(file) ? readFileSync(file, 'utf8') : HEADER;
  writeAtomic(file, `${old}${old.endsWith('\n') || old === '' ? '' : '\n'}${line}\n`);
  return e;
}

/** `schedule remove <id>`: its line taken out; the rest of the file as it was. */
export function removeEntry(file, id) {
  const { entries } = readSchedule(file);
  const e = entries.find((x) => x.id === id);
  if (!e) throw new Refused('entry-not-found', `no entry ${String(id).slice(0, 20)}: schedule list shows them`);
  const lines = readFileSync(file, 'utf8').split('\n');
  writeAtomic(file, lines.filter((l) => l.trimEnd() !== e.line).join('\n'));
  return e;
}

/** An entry as an answer shows it. */
export const shown = (e) => ({
  id: e.id, ...(e.real !== undefined ? { at: new Date(e.real).toISOString() } : {}), ...(e.change ? { when: e.change } : {}),
  ...(e.world ? { world: e.world } : {}), ...(e.acts ? { acts: e.acts } : { wake: e.wake }),
  ...(e.until !== null ? { until: new Date(e.until).toISOString() } : {}), missed: e.missed.rule,
});

/** Each entry with what became of it, from the daemon's marks. */
export function listed({ entries, bad }, marks = {}, now) {
  return {
    entries: entries.map((e) => {
      const m = marks[e.key];
      const status = m ? (m.missed ? 'missed' : 'sent') : e.until !== null && now > e.until ? 'ended'
        : e.world ? 'waits-for-world-clock' : 'waiting';
      return { ...shown(e), status, ...(m?.sequence ? { sequence: m.sequence } : {}), ...(m?.at ? { firedAt: new Date(m.at).toISOString() } : {}) };
    }),
    ...(bad.length ? { bad } : {}),
  };
}

/**
 * What is due at `now` among the unmarked entries: `fire` (send now) and `missed` (its rule applied: `told` lists
 * it, a dropped one is counted). A real time is due when it has come; on time if no more than ON_TIME_MS late.
 * `off` is the last span the daemon was not beating, `[from, to]` in ms, if any: a missed entry inside it says so.
 */
export function due(entries, marks, now, off = null) {
  const fire = [], missed = [];
  for (const e of entries) {
    if (marks[e.key] || e.real === undefined || e.real > now) continue;
    if (e.until !== null && now > e.until) continue;
    const late = now - e.real;
    if (late <= ON_TIME_MS || (e.missed.rule === 'late' && late <= e.missed.ms)) { fire.push({ e, late }); continue; }
    missed.push({ e, late, told: e.missed.rule !== 'drop', ...(off && e.real >= off[0] && e.real <= off[1] ? { off } : {}) });
  }
  return { fire, missed };
}

/** The unmarked change entries an event fires, for the Soul `self` (R9's matcher: never on its own acts). */
export function onEvent(entries, marks, event, self, now) {
  return entries.filter((e) => e.change && !marks[e.key] && (e.until === null || now <= e.until) && matches(e.change, event, self));
}
