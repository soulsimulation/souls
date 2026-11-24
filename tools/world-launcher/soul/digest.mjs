// digest.mjs: a short update for a Soul's owner, composed from its own memory log on the owner's machine. It reads the log
// and nothing else: no request, no model call, nothing sent. Every line names the records it came from (`--refs`): a line
// with no source would be a memory fault. Words other Souls said are quoted and marked as theirs.
//
// Edit this file, then run `node tools/world-launcher/soul/inline.mjs`: worlds serve eden.mjs as one file.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DIGEST_WORDS = 200;
const NAMES = 4, HEARD = 2, SAID_WORDS = 20;
const flat = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
const count = (t) => t.split(" ").filter(Boolean).length;
const clipWords = (t, n) => { const w = flat(t).split(" "); return w.length > n ? `${w.slice(0, n).join(" ")}…` : w.join(" "); };
/** Their words, inside quotes they cannot close. */
const quote = (t) => `"${clipWords(t, SAID_WORDS).replace(/["“”]/g, "'")}"`;
const listed = (names) => {
  const shown = names.slice(0, NAMES), more = names.length - shown.length;
  if (more) return `${shown.join(", ")} and ${more} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0];
};
const nameOf = (e, id) => flat(e.seen?.[id]) || id;

/** The Soul's memory log, oldest first. A line torn by a writer mid-append is skipped; the rest stands. */
export function readLog(soulDir) {
  let text = "";
  try { text = readFileSync(join(soulDir, "memory", "log", "memory-events.jsonl"), "utf8"); } catch { return []; }
  return text.split("\n").flatMap((line) => {
    try { const r = JSON.parse(line); return r?.value && typeof r.value.at === "string" ? [r] : []; } catch { return []; }
  });
}

/** What happened after `since` (an ISO time, or null for all of memory) up to `until`, as at most DIGEST_WORDS words of
 *  lines `{text, refs}`. Goals and open promises are standing, so they are read up to `until` whatever `since` says. */
export function digest(records, { since = null, until }) {
  const inPeriod = (v) => (since === null || v.at > since) && v.at <= until;
  const met = new Map(), went = new Map(), heard = [], done = new Map(), failed = new Map(), promised = [], kept = [];
  const goals = new Map(), promises = new Map(), keptIds = new Set();
  const person = (e, id, name) => {
    const key = `${e.world ?? "here"}/${id}`;
    if (!met.has(key)) met.set(key, { name: flat(name) || id, refs: [key] });
  };
  for (const { kind, value: e } of records) {
    if (e.at > until) continue;
    if (kind === "remember") { if (e.goal) goals.set(e.goal, { ...e, fresh: inPeriod(e) || goals.get(e.goal)?.fresh === true }); continue; }
    if (e.type === "commitment") promises.set(e.id, e);
    if (e.type === "commitment.kept") keptIds.add(e.commitmentId);
    if (!inPeriod(e)) continue;
    switch (e.type) {
      case "meet": person(e, e.person.id, e.person.name); break;
      case "arrival": if (!went.has(e.placeId)) went.set(e.placeId, { name: nameOf(e, e.placeId), refs: [e.id] }); break;
      case "speech": heard.push({ text: `${nameOf(e, e.personId)} said, in their own words: ${quote(e.text)}`, refs: [e.id] }); break;
      case "outcome": {
        if (e.act === "owner-message") break;   // a report to the owner, who has it already
        for (const p of e.met ?? []) person(e, p.id, p.name);
        const into = e.phase === "completed" ? done : e.phase === "failed" ? failed : null;
        if (into) { const row = into.get(e.act) ?? { name: flat(e.act), refs: [] }; row.refs.push(e.receiptId); into.set(e.act, row); }
        break;
      }
      case "commitment": promised.push({ text: e.by === "me" ? `I promised ${nameOf(e, e.personId)}: ${flat(e.what)}.` : `${nameOf(e, e.personId)} promised me: ${flat(e.what)}.`, refs: [e.id] }); break;
      case "commitment.kept": {
        const c = promises.get(e.commitmentId);
        if (c) kept.push({ text: c.by === "me" ? `I kept my promise to ${nameOf(c, c.personId)}.` : `${nameOf(c, c.personId)} kept their promise to me.`, refs: [e.commitmentId, e.evidence] });
        break;
      }
    }
  }
  const group = (map, say) => (map.size ? [{ text: say(listed([...map.values()].map((r) => r.name))), refs: [...map.values()].flatMap((r) => r.refs) }] : []);
  const goalLines = [...goals.values()].map((g) => ({ text: `${g.fresh ? "I worked on my goal" : "Nothing new toward my goal"}: ${flat(g.note)}.`, refs: [g.goal], fresh: g.fresh }));
  const lines = [...group(met, (n) => `I met ${n}.`), ...group(went, (n) => `I went to ${n}.`), ...heard.slice(-HEARD), ...group(done, (n) => `I did ${n}.`),
    ...group(failed, (n) => `${n} did not work.`), ...goalLines, ...promised, ...kept];
  if (!lines.some((l) => l.fresh !== false)) {
    const text = `Nothing recorded since ${since ?? "my memory began"}.`;
    return { since, until, words: count(text), lines: [{ text, refs: [] }] };
  }
  const open = [...promises.values()].filter((c) => c.by === "me" && !keptIds.has(c.id));
  const next = [...[...goals.values()].filter((g) => flat(g.next)).map((g) => ({ text: flat(g.next), ref: g.goal })), ...open.map((c) => ({ text: `keep my promise to ${nameOf(c, c.personId)}`, ref: c.id }))];
  const shown = next.slice(0, NAMES), more = next.length - shown.length;
  const nextLine = next.length ? { text: `Next: ${shown.map((n) => n.text).join("; ")}${more ? `; and ${more} more` : ""}.`, refs: shown.map((n) => n.ref) } : null, display = [...lines, ...(nextLine ? [nextLine] : [])];
  // Within the word budget, what is owed and what is next go first, what others said last.
  const rank = (l) => (l === nextLine ? 0 : promised.includes(l) || kept.includes(l) ? 1 : goalLines.includes(l) ? 2 : heard.includes(l) ? 4 : 3);
  let words = 0;
  const keep = new Set();
  for (const line of [...display].sort((a, b) => rank(a) - rank(b))) { const n = count(line.text); if (words + n <= DIGEST_WORDS) { keep.add(line); words += n; } }
  return { since, until, words, lines: display.filter((l) => keep.has(l)).map(({ text, refs }) => ({ text, refs })) };
}

/** Plain lines for the owner's agent to read; with `refs`, each ends with the records it came from. */
export function renderDigest(d, { refs = false } = {}) {
  return d.lines.map((l) => (refs && l.refs.length ? `${l.text} [${l.refs.join(", ")}]` : l.text)).join("\n") + "\n";
}
