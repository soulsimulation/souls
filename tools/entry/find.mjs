#!/usr/bin/env node
// The find gate (Soul Actions SA-P7, #2935): does a real model, told only a goal, find a new entry's thing and finish it?
//
//   node tools/entry/find.mjs <family> --world <address> --kind <name> --form <form> --goal "<goal>"
//        [--repeats 2] [--arms card,no-card] [--model sonnet] [--max-wall 300] [--god <dir>] [--out <dir>]
//   pnpm entry find <family> ... (the same)
//
// Per arm and repeat: a fresh Soul is made in a fresh seat folder (the playtest seat, tools/playtest/arena/seat.mjs,
// `claude -p` on the signed-in login in CLAUDE_CONFIG_DIR, or SEAT_CONFIG_DIR when set); the creator places one thing of
// the kind beside it with the fields of the form's met case (run.mjs's transport); the seat gets one turn that says the
// goal and nothing about the entry. The run has finished when the thing's fields read as the form's `set` changes, read
// from outside as an agent reads them, at any point in the turn. Counted from the seat's own tool calls:
// - reads: Soul CLI commands that only look (here, look, find, inspect, how, can, query, ...);
// - acts: act and plan;
// - refusals: acts the world refused, or whose receipt failed, by code.
//
// The arms. `card`: the card reaches the agent where the client's `find` and `here` read a purpose (`catalog.cards`,
// SA-C1); today's worlds send it only inside the entry (`catalog.entries`, SA-C3), which `find` does not read, so this
// gate writes it into the Soul's copy of the catalog as Engine v2 E1/E19 will send it. `no-card`: the card is removed
// from the Soul's copy, from `cards` and from the entry alike. Everything else is the same.
//
// Prints one JSON verdict (also <out>/verdict.json): a row per run, the table per arm. Exits 0 when every run of the
// first arm finished, 1 when one did not, 2 on a bad argument or a world that could not be reached. Local worlds only:
// the Soul is made with the world's dev sign-in. Spend: each run's seat is held to its own world budget ($1 at most).
import { isMain } from '../lib/is-main.mjs';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {casesFor, todayTransport} from './run.mjs';
import {load as loadPlan} from './load.mjs';
import {createSeat} from '../playtest/arena/seat.mjs';
import {toolCalls} from '../playtest/arena/adapters/claude-headless.mjs';
import {prepareFolder, runtimeDir, cli} from '../playtest/eval/episode.mjs';
import {cliCommand} from '../playtest/eval/measure.mjs';
import {readJsonl, writeJson} from '../playtest/lib/jsonl.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const READS = new Set(['look', 'find', 'query', 'here', 'inspect', 'around', 'view', 'catalog', 'map', 'how', 'can', 'receipt', 'status', 'help', 'memory', 'schema', 'now', 'whoami', 'resolve', 'caps']);
const ACTS = new Set(['act', 'plan']);
const NAMES = ['Wren', 'Ash', 'Moss', 'Fern', 'Rowan', 'Hazel', 'Linden', 'Sorrel', 'Briar', 'Tansy', 'Juniper', 'Alder', 'Bryony', 'Cedar', 'Yarrow', 'Teasel'];
const CODE = /\b([a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+)\b/;

export const goalText = (name, goal) => `Your Soul ${name} lives in this folder; it is already set up and \`serve\` is running. Your guide is skill.md in this folder: read it first. Then, with ${name}: ${goal} Work it out from what the world shows you, do it, and stop when it is done or when you are sure it cannot be done.`;

/** What the form's met case starts from, and what its `set` changes read as when it has finished. Pure. */
export function goalOf(entry, kind, form, cases) {
  const f = entry.forms?.[form];
  if (!f) throw new Error(`${kind} has no form ${form}`);
  const done = Object.fromEntries((f.effects ?? []).filter(e => e.change === 'set' && e.to !== undefined).map(e => [e.field, e.to]));
  if (!Object.keys(done).length) throw new Error(`${kind} ${form} sets no field to a value, so finishing cannot be read from outside`);
  const met = cases.find(r => r.type === 'rule' && r.kind === kind && r.form === form && r.case.expect.verdict === 'yes')?.case;
  const start = met ? {...(met.state.nodes[met.act.this]?.fields ?? {})} : {};
  return {done, start};
}

/** The card as the client's `find` reads it (`{purpose, category, synonyms}`), from the entry's own card and text. */
export function cardOf(entry) {
  const c = entry.card; if (!c) return null;
  const t = k => entry.text?.[k] ?? k;
  return {purpose: t(c.text), ...(c.category ? {category: t(c.category)} : {}), ...(c.synonyms?.length ? {synonyms: c.synonyms.map(t)} : {})};
}

/** Puts the arm's card into (or takes every card out of) the Soul's copy of the catalog; true when the file changed. */
export function cardCopy(file, kind, card) {
  let j; try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { return false; }
  const cat = j.catalog; if (!cat) return false;
  const before = JSON.stringify(cat);
  if (card) cat.cards = {...(cat.cards ?? {}), [kind]: card};
  else {
    if (cat.cards) delete cat.cards[kind];
    const e = cat.entries?.[kind];
    if (e?.card) { if (e.text) delete e.text[e.card.text]; delete e.card; }
  }
  if (JSON.stringify(cat) === before) return false;
  writeFileSync(file, JSON.stringify(j));
  return true;
}

/** The seat's tool calls as reads, acts and refusals. Pure. */
export function countCalls(calls) {
  const out = {reads: 0, acts: 0, refusals: 0, other: 0, otherTools: 0, refused: {}, sent: [], readsBy: {}};
  for (const c of calls) {
    let cmd = c.name === 'Bash' ? cliCommand(c.cmd) : null;
    if (!cmd) { out.otherTools++; continue; }
    // `object <id>` reads a thing; `object <id> <action>` sends that action, as act does
    if (cmd === 'object') cmd = /eden\.mjs\s+object\s+\S+\s+[a-z]/.test(c.cmd) ? 'act' : 'inspect';
    if (READS.has(cmd)) { out.reads++; out.readsBy[cmd] = (out.readsBy[cmd] ?? 0) + 1; continue; }
    if (!ACTS.has(cmd)) { out.other++; continue; }
    out.acts++;
    out.sent.push(String(c.cmd).replace(/^.*?eden\.mjs\s+/, '').slice(0, 120));
    const code = refusalOf(c.result, c.isError);
    if (code) { out.refusals++; out.refused[code] = (out.refused[code] ?? 0) + 1; }
  }
  return out;
}
/** The refusal one act's output carries: `accepted: false`, a receipt that failed, or an error's code; else null. */
function refusalOf(text, isError) {
  const s = String(text ?? ''), i = s.indexOf('{');
  let d = null; if (i >= 0) { try { d = JSON.parse(s.slice(i)); } catch { /* not one object */ } }
  if (d?.accepted === false) return d.code ?? 'refused';
  const rc = d?.receipt;
  if (rc && ['failed', 'refused'].includes(rc.phase)) return rc.code ?? rc.reason ?? rc.phase;
  if (isError || (!d && /^error|refused/im.test(s))) return CODE.exec(s.replace(/^Exit code \d+\s*/, ''))?.[1] ?? 'error';
  return null;
}

/** One run: a fresh Soul, the thing beside it, one turn with the goal. */
async function runOnce({t, entry, kind, done, start, card, goal, world, dir, model, maxWall, name, log}) {
  const seat = createSeat({runDir: dir, seat: {adapter: 'claude-headless', model, id: 'soul'}, worldBase: world, rails: {maxTurnWallSec: maxWall, worldBudgetUsd: 1, turnBudgetUsd: 0.6}});
  let id = null;
  try {
    delete process.env.SOULS_HOME;   // the new Soul lives in its seat folder, and the transport's Soul CLI reads it from there
    const setup = await prepareFolder(seat, {name});
    process.chdir(seat.folder);
    id = await t.place(kind, entry);
    if (Object.keys(start).length) await t.set(id, start);
    await cli(seat.folder, ['look']);   // the copy now holds the thing
    const copy = join(runtimeDir(seat.folder, setup.soulId), 'world-catalog.json');
    let rewrites = 0; if (cardCopy(copy, kind, card)) rewrites++;
    const before = await t.fields(id);
    log(`${kind} ${id} placed, ${JSON.stringify(before)}; the seat starts`);
    const t0 = Date.now();
    let finishedMs = null, turnDone = false;
    const turn = seat.chat(goalText(name, goal)).finally(() => { turnDone = true; });
    while (!turnDone) {
      await sleep(1000);
      if (cardCopy(copy, kind, card)) rewrites++;   // the client fetched its catalog again: the arm's card as before
      if (finishedMs == null) { const f = await t.fields(id).catch(() => null); if (f && Object.entries(done).every(([k, v]) => f[k] === v)) finishedMs = Date.now() - t0; }
    }
    const rec = await turn;
    const after = await t.fields(id);
    if (finishedMs == null && Object.entries(done).every(([k, v]) => after?.[k] === v)) finishedMs = Date.now() - t0;
    const calls = toolCalls(readJsonl(join(seat.dir, 'transcript.jsonl')));
    const n = countCalls(calls);
    return {finished: finishedMs != null, finishedMs, ...n, before, after, wallMs: Date.now() - t0, timedOut: !!rec?.timedOut, costUsd: rec?.usage?.costUsd ?? null,
      refusedTurn: rec?.refused ?? null, cardRewrites: rewrites, said: String(rec?.finalText ?? '').slice(0, 400)};
  } finally {
    process.chdir(ROOT);
    await seat.stop().catch(() => {});
    await cli(seat.folder, ['serve', '--stop']).catch(() => {});
    if (id) await t.remove(id).catch(() => {});
    await seat.retire().catch(() => {});   // the name is free again and the world keeps no idle Soul
  }
}

export async function find(target, {world, kind, form, goal, repeats = 2, arms = ['card', 'no-card'], model = 'sonnet', maxWall = 300, god, out, log = () => {}} = {}) {
  const rows = (await loadPlan(target, {plan: true})).filter(r => r.kind).map(r => ({...r, entry: JSON.parse(readFileSync(join(ROOT, r.file), 'utf8'))}));
  const fullKind = rows.find(r => r.kind === kind || r.kind.split(':')[1] === kind)?.kind;
  if (!fullKind) throw new Error(`${target} has no kind ${kind}`);
  const entry = rows.find(r => r.kind === fullKind).entry;
  const {done, start} = goalOf(entry, fullKind, form, casesFor(rows));
  const card = cardOf(entry);
  if (arms.includes('card') && !card) throw new Error(`${fullKind} has no card`);
  if (process.env.SEAT_CONFIG_DIR) process.env.CLAUDE_CONFIG_DIR = process.env.SEAT_CONFIG_DIR;
  const t = todayTransport({world, god: resolve(god ?? '.')});
  await t.start(rows);
  const v = {target, kind: fullKind, form, goal, done, start, world: '<local world>', model, repeats, arms, runs: [], startedAt: new Date().toISOString()};
  for (const arm of arms) for (let r = 1; r <= repeats; r++) {
    const dir = join(out, `${fullKind.split(':')[1]}-${arm}-${r}`);
    log(`${arm} ${r}/${repeats}`);
    let row;
    const name = NAMES[(Date.now() + v.runs.length) % NAMES.length];   // a Soul's name is unique in its world
    try { row = await runOnce({t, entry, kind: fullKind, done, start, card: arm === 'card' ? card : null, goal, world, dir, model, maxWall, name, log}); }
    catch (e) { row = {error: String(e.message ?? e).split(ROOT).join('')}; }
    v.runs.push({arm, repeat: r, ...row});
    log(`${arm} ${r}: ${row.error ?? `finished ${row.finished}, reads ${row.reads}, acts ${row.acts}, refusals ${row.refusals}`}`);
  }
  v.table = Object.fromEntries(arms.map(a => {
    const rs = v.runs.filter(x => x.arm === a && !x.error), sum = k => rs.reduce((s, x) => s + (x[k] ?? 0), 0);
    return [a, {runs: rs.length, finished: rs.filter(x => x.finished).length, reads: sum('reads'), acts: sum('acts'), refusals: sum('refusals'), errors: v.runs.filter(x => x.arm === a && x.error).length}];
  }));
  v.ok = v.runs.filter(x => x.arm === arms[0]).every(x => x.finished);
  v.endedAt = new Date().toISOString();
  return v;
}

export async function main(argv) {
  const args = argv[0] === 'find' ? argv.slice(1) : argv;
  const flag = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const target = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  const usage = 'usage: node tools/entry/find.mjs <family> --world <address> --kind <name> --form <form> --goal "<goal>" [--repeats 2] [--arms card,no-card] [--model sonnet] [--max-wall 300] [--god <dir>] [--out <dir>]';
  if (!target || !flag('world') || !flag('kind') || !flag('form') || !flag('goal')) { console.log(JSON.stringify({error: usage})); return 2; }
  const repeats = Number(flag('repeats') ?? 2), maxWall = Number(flag('max-wall') ?? 300);
  if (!Number.isInteger(repeats) || repeats < 1 || !(maxWall > 0)) { console.log(JSON.stringify({error: '--repeats takes a whole number of at least 1, --max-wall seconds'})); return 2; }
  const arms = (flag('arms') ?? 'card,no-card').split(',').filter(Boolean);
  if (!arms.length || arms.some(a => !['card', 'no-card'].includes(a))) { console.log(JSON.stringify({error: '--arms: card, no-card or both'})); return 2; }
  // A live seat's folder must sit outside any checkout (tools/playtest/arena/seat-home.mjs): the default is the system's temp folder
  const out = resolve(flag('out') ?? join(tmpdir(), `entry-find-${Date.now()}`));
  mkdirSync(out, {recursive: true});
  let v;
  try { v = await find(target, {world: flag('world'), kind: flag('kind'), form: flag('form'), goal: flag('goal'), repeats, arms, model: flag('model') ?? 'sonnet', maxWall, god: flag('god'), out, log: s => process.stderr.write(`[entry find] ${s}\n`)}); }
  catch (e) { console.log(JSON.stringify({error: String(e.message ?? e).split(ROOT).join('')})); return 2; }
  writeJson(join(out, 'verdict.json'), v);
  console.log(JSON.stringify(v, null, 1));
  return v.ok ? 0 : 1;
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
