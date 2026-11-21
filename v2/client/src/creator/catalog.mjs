// The library of kinds, searched on this machine (#3696, parity row 54): `catalog`, `find`, `recommend` and
// `taxonomy`, as today's eden-god has them, read from the world's kind entries the pairing keeps in the home
// (`<home>/kinds/*.json`, souls-entry/1, #3760). Nothing is asked of a server: no words resolver, no catalogue route.
//
// A kind's words are its own: its name, its card's text, category and synonyms (keys into its `text`), and its
// look's tags. What it offers is what Souls can do with it: its slots (by name and posture), forms, point roles and
// state fields, which `--has` filters by (`slot:sit`, `form:open`, `point:grip`, `state:lit`, `owner:place`).
//
// Search scores as today's (apps/server/src/god/assets.ts `searchDefs`): the whole query as the kind's name, or as
// one of its synonyms, 100; per word (and its singular), a name 100 alone or 40 in a phrase, a name token 40, a
// synonym 45, a tag 16, a name substring 14, a category 10, a card word 4, a tag prefix 6, a card substring 1.
// Every word must match something, unless no kind matches them all. Ties: the shorter name first.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kindsIn } from '../check/state.mjs';

/** Words that name nothing on their own (today's recommend's stop list). */
const STOP = new Set('a an the and or with of to in on at by for from near next some few many lots little big small large tiny huge my our its this that it is are be place put build make add want need there here very cosy cozy nice old new two three four five six seven eight nine ten one both each other into onto beside outside inside around along across under over'.split(' '));
const words = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const singular = (w) => (w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 4 && /(ches|shes|xes|ses)$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const said = (e, key) => (typeof e.text?.[key] === 'string' ? e.text[key] : key);

/**
 * The entries a world's creator reads: those the pairing fetched for `world` (its mark file lists them), else every
 * entry in the home's kinds folder.
 */
export function libraryOf(home, world) {
  const dir = join(home, 'kinds');
  const all = kindsIn(dir);
  const mark = world && join(dir, `.entries-${encodeURIComponent(world)}.json`);
  if (!mark || !existsSync(mark)) return Object.values(all);
  let files = [];
  try { files = JSON.parse(readFileSync(mark, 'utf8')).files ?? []; } catch { return Object.values(all); }
  const mine = new Set(files.map((f) => f.replace(/\.json$/, '')));
  return Object.values(all).filter((e) => mine.has(e.kind.replaceAll(':', '.')));
}

/** One kind as a row: what `catalog` and `find` print, and what `--json` gives. */
export function rowOf(e) {
  const card = e.card ?? {};
  const slots = Object.entries(e.slots ?? {});
  return {
    kind: e.kind,
    name: e.kind.split(':').pop().split('@')[0],
    owner: e.owner,
    category: card.category ?? null,
    ...(card.synonyms?.length ? { synonyms: card.synonyms.map((s) => said(e, s)) } : {}),
    ...(e.geometry?.bounds_mm ? { size_mm: e.geometry.bounds_mm } : {}),
    ...(slots.length ? { slots: slots.map(([n, s]) => (s.posture ? `${n}:${s.posture}` : n)) } : {}),
    ...(Object.keys(e.forms ?? {}).length ? { forms: Object.keys(e.forms) } : {}),
    ...(Object.keys(e.state ?? {}).length ? { state: Object.keys(e.state) } : {}),
    card: card.text ? said(e, card.text) : '',
  };
}

/** What a kind offers, as `--has` names it. */
function offers(e) {
  const has = new Set([`owner:${e.owner}`]);
  for (const [n, s] of Object.entries(e.slots ?? {})) { has.add(`slot:${n}`); if (s.posture) has.add(`slot:${s.posture}`); }
  for (const n of Object.keys(e.forms ?? {})) has.add(`form:${n}`);
  for (const p of Object.values(e.points ?? {})) if (p?.role) has.add(`point:${p.role}`);
  for (const n of Object.keys(e.state ?? {})) has.add(`state:${n}`);
  return has;
}

/** The entries in `category` (by key or its words) that offer every `has`. */
export function facet(entries, { category, has } = {}) {
  const want = [].concat(has ?? []).filter(Boolean).map((h) => String(h).toLowerCase());
  return entries.filter((e) => (!category || e.card?.category === category || said(e, e.card?.category) === category)
    && want.every((h) => offers(e).has(h)));
}

/** Every kind (filtered by `category` and `has`), sorted by category then name. */
export function catalog(entries, opts = {}) {
  const rows = facet(entries, opts).map(rowOf);
  rows.sort((a, b) => String(a.category).localeCompare(String(b.category)) || a.name.localeCompare(b.name));
  return { count: rows.length, rows };
}

/** The kinds that match `q`, best first, each with why: `[{row, score, why}]`. */
export function search(entries, q, { category, has, limit = 25 } = {}) {
  const pool = facet(entries, { category, has });
  const qw = words(q);
  if (!qw.length) return pool.slice(0, limit).map((e) => ({ row: rowOf(e), score: 0, why: [] }));
  const whole = qw.join('_');
  const scored = pool.map((e) => {
    const row = rowOf(e), name = row.name, ntoks = name.split(/[-._]+/);
    const syns = (e.card?.synonyms ?? []).flatMap((s) => [s, said(e, s)]).map((s) => s.toLowerCase().replace(/[\s-]+/g, '_'));
    const tags = (e.looks?.shape?.tags ?? e.looks?.tags ?? []).map((t) => String(t).toLowerCase());
    const cat = e.card?.category ? [e.card.category, said(e, e.card.category)].map((c) => c.toLowerCase()) : [];
    const card = row.card.toLowerCase(), cwords = new Set(words(card).map(singular));
    const why = []; let score = 0, matched = 0;
    if (name === whole || name === singular(whole)) { score += 100; why.push('name'); }
    else if (qw.length > 1 && (syns.includes(whole) || syns.includes(singular(whole)))) { score += 100; matched = qw.length; why.push(`aka=${whole}`); }
    for (const w of qw) {
      let best = 0, bestWhy = '';
      for (const [v, wgt] of [[w, 1], [singular(w), 0.95]]) {
        const cand = [];
        if (name === v) cand.push([qw.length > 1 ? 40 : 100, `name=${v}`]);
        if (ntoks.includes(v)) cand.push([40, `name~${v}`]); else if (v.length >= 3 && name.includes(v)) cand.push([14, `name*${v}`]);
        if (syns.includes(v) || syns.some((s) => s.split('_').includes(v))) cand.push([45, `aka=${v}`]);
        if (tags.includes(v)) cand.push([16, `tag=${v}`]); else if (v.length >= 4 && tags.some((t) => t.startsWith(v))) cand.push([6, `tag*${v}`]);
        if (cat.includes(v)) cand.push([10, `cat=${v}`]);
        if (cwords.has(v)) cand.push([4, `card=${v}`]); else if (v.length >= 4 && card.includes(v)) cand.push([1, `card*${v}`]);
        for (const [c, label] of cand) if (c * wgt > best) { best = c * wgt; bestWhy = label; }
      }
      if (best > 0) { matched = Math.min(qw.length, matched + 1); score += best; why.push(bestWhy); }
    }
    return { row, score, matched, why };
  }).filter((r) => r.score > 0);
  const all = scored.filter((r) => r.matched === qw.length);
  return (all.length ? all : scored)
    .sort((a, b) => b.score - a.score || a.row.name.length - b.row.name.length || a.row.name.localeCompare(b.row.name))
    .slice(0, limit)
    .map(({ row, score, why }) => ({ row, score: Math.round(score * 10) / 10, why }));
}

/**
 * What to place for a purpose, per need (two-word phrases first, then single words), with the first pick of each as
 * an example batch for `souls-god batch`, every place in `root`; and the words no kind answers.
 */
export function recommend(entries, intent, { per = 3, root = '<id of the room or place>' } = {}) {
  const qw = words(intent);
  const needs = [], used = new Set();
  const pick = (h) => ({ kind: h.row.kind, category: h.row.category, score: h.score, why: h.why });
  for (let i = 0; i + 1 < qw.length; i++) {
    if (STOP.has(qw[i]) || STOP.has(qw[i + 1])) continue;
    const phrase = `${qw[i]} ${qw[i + 1]}`;
    const strong = search(entries, phrase, { limit: per }).filter((h) => h.score >= 40 && (h.why.length >= 2 || h.why.some((w) => w === 'name' || w.startsWith('aka='))));
    if (strong.length) { needs.push({ for: phrase, picks: strong.map(pick) }); used.add(i); used.add(i + 1); i++; }
  }
  for (let i = 0; i < qw.length; i++) {
    const w = qw[i];
    if (used.has(i) || STOP.has(w) || w.length < 3 || /^\d+$/.test(w)) continue;
    const hits = search(entries, w, { limit: per }).filter((h) => h.score >= 12 || h.why.every((y) => y.startsWith('cat=')));
    if (hits.length) needs.push({ for: w, picks: hits.map(pick) });
  }
  const seen = new Set();
  const firsts = needs.map((n) => n.picks[0].kind).filter((k) => !seen.has(k) && seen.add(k));
  const ops = firsts.map((kind, i) => ({ op: 'place', name: i + 1, kind, in: root }));
  const unmatched = qw.filter((w, i) => !used.has(i) && !STOP.has(w) && w.length >= 3 && !/^\d+$/.test(w) && !needs.some((n) => n.for === w));
  return { intent, needs, example: ops, unmatched };
}

/** The library's shape: categories with counts and a few kinds each, and what kinds offer (`--has` names) with counts. */
export function taxonomy(entries) {
  const cats = new Map(), has = new Map();
  for (const e of entries) {
    const c = e.card?.category ?? '(none)';
    const at = cats.get(c) ?? { category: c, label: e.card?.category ? said(e, c) : '(none)', count: 0, kinds: [] };
    at.count++; if (at.kinds.length < 6) at.kinds.push(rowOf(e).name);
    cats.set(c, at);
    for (const h of offers(e)) has.set(h, (has.get(h) ?? 0) + 1);
  }
  const by = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]);
  const group = (p) => Object.fromEntries([...has].filter(([h]) => h.startsWith(p)).sort(by));
  return {
    kinds: entries.length,
    categories: [...cats.values()].sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
    has: { owner: group('owner:'), slot: group('slot:'), form: group('form:'), point: group('point:'), state: group('state:') },
  };
}

const metres = (mm) => mm.map((v) => (v / 1000).toFixed(2).replace(/\.?0+$/, '')).join('x');
const line = (r) => `${r.kind} [${r.category ?? '-'}] ${r.size_mm ? `${metres(r.size_mm)} m` : r.owner}${r.slots ? ` {${r.slots.join(',')}}` : ''}${r.forms ? ` (${r.forms.join(',')})` : ''}${r.synonyms ? ` aka ${r.synonyms.join(', ')}` : ''}${r.card ? ` - ${r.card}` : ''}`;

/** The four verbs' words, answered from `entries`: JSON, or with `--lines` the lines today's eden-god prints. */
export function answer(verb, args, entries) {
  const a = [...args];
  const opt = (n) => { const k = a.indexOf(n); if (k < 0) return undefined; const v = a[k + 1]; a.splice(k, 2); return v; };
  const flag = (n) => { const k = a.indexOf(n); if (k < 0) return false; a.splice(k, 1); return true; };
  const json = !flag('--lines'), every = flag('--all');
  const category = opt('--category'), per = opt('--per');
  const has = []; for (let h; (h = opt('--has')) !== undefined;) has.push(h);
  const q = a.join(' ').trim();
  if (!entries.length) return { ok: false, code: 'no-library', detail: 'no kind entries in this home', fix: 'pair with the world first (souls-god.mjs pair): the pairing keeps its kinds' };
  if (verb === 'catalog') {
    const d = catalog(entries, { category, has });
    return json ? { ok: true, ...d } : `${d.count} kinds${category ? ` in ${category}` : ''}. Line: kind [category] size {slots} (forms) aka synonyms - card. Place one by its kind.\n${d.rows.map(line).join('\n')}`;
  }
  if (verb === 'find') {
    if (!q && !category && !has.length) return { ok: false, code: 'usage', detail: 'find <words> [--category c] [--has slot:sit|form:open|point:grip|state:lit] [--all]' };
    const hits = search(entries, q, { category, has, limit: every ? 500 : 25 });
    if (json) return { ok: true, matches: hits.map((h) => ({ ...h.row, score: h.score, why: h.why })) };
    if (!hits.length) return `nothing matches${q ? ` "${q}"` : ''}${category ? ` in ${category}` : ''}${has.length ? ` with ${has.join(', ')}` : ''}. Try \`recommend <what you want>\` or \`taxonomy\`.`;
    return [`${hits.length} match${q ? ` "${q}"` : ''}:`, ...hits.map((h) => `${line(h.row)}${h.why.length ? `  <${h.why.join(' ')}>` : ''}`)].join('\n');
  }
  if (verb === 'recommend') {
    if (!q) return { ok: false, code: 'usage', detail: 'recommend <what you want to make>, e.g. recommend a camp with a fire and chairs' };
    const d = recommend(entries, q, { per: Math.min(8, Math.max(1, Number(per ?? 3) || 3)) });
    if (json) return { ok: true, ...d };
    return [
      `for "${q}":`,
      ...d.needs.map((n) => `- ${n.for}: ${n.picks.map((p) => `${p.kind} [${p.category ?? '-'}]`).join(', ')}`),
      ...(d.unmatched.length ? [`not in the library: ${d.unmatched.join(', ')} (see taxonomy)`] : []),
      `example batch (the first pick of each need; put the room or place id in "in" and add "at"): souls-god.mjs batch '${JSON.stringify(d.example)}'`,
    ].join('\n');
  }
  if (verb === 'taxonomy') {
    const d = taxonomy(entries);
    if (json) return { ok: true, ...d };
    const list = (o) => { const e = Object.entries(o); return e.slice(0, 24).map(([h, n]) => `${h} ${n}`).join(', ') + (e.length > 24 ? `, and ${e.length - 24} more (without --lines, all)` : ''); };
    return [
      `${d.kinds} kinds. Categories (count; find one with \`find --category <category>\`):`,
      ...d.categories.map((c) => `  ${c.category}${c.label !== c.category ? ` (${c.label})` : ''}: ${c.count} - ${c.kinds.join(', ')}${c.count > c.kinds.length ? ', ...' : ''}`),
      'What kinds offer (filter with `--has <name>`):',
      ...Object.entries(d.has).map(([g, o]) => `  ${g}: ${list(o)}`),
    ].join('\n');
  }
  return { ok: false, code: 'usage', detail: 'catalog, find, recommend or taxonomy' };
}
