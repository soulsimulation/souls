#!/usr/bin/env node
// The thin command (Engine v2 R7, #2701): any harness reaches a Soul's daemon (R6) through it. It passes its
// arguments to the daemon's socket and prints the answer, as JSON; it loads no WASM and holds no copy. The first
// command starts the daemon. Every answer but status's and quit's ends with `at` and `changed`.
//
//   souls.mjs status                          the daemon: connected, cursor, intents sent and answered
//   souls.mjs look                            the brief: my room, cards outward, what changed, the age
//   souls.mjs find <words...> [--limit n]     one search over the copy
//   souls.mjs pair <world url>                asks the world's directory for a Soul: prints a link and a code for the
//                                             owner, and returns; the pairing finishes in the background (W2)
//   souls.mjs act <act> [<act>...]            a ranked list: the first is the act, the rest its fallbacks. An act is
//                                             <verb>:<id> (sit:<seat id>), an id alone (walk there), or a verb; ids
//                                             or <name>=<id> after an act are its thing arguments (C10)
//   souls.mjs inspect <id>                    the thing as the copy holds it and its own offers, each with its parameters
//                                             and the act that sends it; asks the world nothing (#3686)
//   souls.mjs object <id> [<offer> [<name>=<value>... | '<params json>']]   no offer: inspect's offers; an offer:
//                                             sent through act, `<offer>:<id>` with its arguments (#3686)
//   souls.mjs can <act> [<arg id>...]         the daemon's local check (R8): yes, no with the reason, or unknown
//   souls.mjs say "<words>"                   says the words out loud, to whoever is near
//   souls.mjs say --shout "<words>" | shout "<words>"   shouts them: public, heard farther than a say (C26)
//   souls.mjs say --to <name|id> [--gesture <g>] "<words>"   says them to that Soul: turns to it, or plays the body's
//                                             gesture <g> toward it; an unknown name or gesture sends nothing (C26)
//   souls.mjs whisper <body id> "<words>"     says them to that one body alone
//   souls.mjs converse start <body id> "<text>" [--private]   offers that body a conversation; the opening line goes
//                                             to it alone. Its accept or decline arrives in `wait` (E26)
//   souls.mjs converse accept|decline|leave <conversation id>   joins, declines or leaves (a leave is always accepted)
//   souls.mjs converse say <conversation id> "<text>" [--private]   a turn: out loud by default, members only with
//                                             --private (remembered for that conversation)
//   souls.mjs converse list                   the conversations in the copy
//   souls.mjs lie <id>                        lies down on that bed (stand again with act <ns>:rise)
//   souls.mjs pray "<words>"                  a prayer to the world's creator (G11); the answer comes to `wait`
//   souls.mjs prayers                         this Soul's prayers, each waiting or answered, with the answer
//   souls.mjs now "<line>"                    sets the Soul's public status line, shown on its page beside its
//                                             description: at most 140 characters; `now` alone (or --clear) clears it
//                                             (C14). `--now "<line>"` on any other command sets it after that command
//   souls.mjs wait [seconds]                  returns when something addressed to this Soul happened (an answer, or words
//                                             said to or near it: `heard`, also in the next look), or at the timeout
//   souls.mjs history --at <place> | --thing <id> | --soul <name> [--since <µs>] [--until <µs>]
//                                             what happened, from the public history and this Soul's memory: a day by
//                                             default, at most seven, five lines, the rest counted (R16); --as <id>
//                                             names which Soul asks, when the home has more than one
//   souls.mjs whatson [--hours n]             what is on now and in the next n real hours (default 3, up to 168) from
//                                             the calendar items the world publishes, and who is where (#3703)
//   souls.mjs calendar                        every calendar item not over, and the blank notices one may post on
//   souls.mjs calendar add "<title>" --place <id> --in <minutes> --for <minutes> ["description"]   posts an item on
//                                             a blank notice at that place; calendar interest|not-coming <id> says
//                                             this Soul will come, or no longer will
//   souls.mjs stats                           per achieved intent: commands, bytes printed, first-send result (R10)
//   souls.mjs stop [<sequence>]               ends your own act where it stands, as today (#3705): a walk stops now, a
//                                             sit, a lie or a rise finishes, a standing order ends. The newest act
//                                             still going unless a sequence is named
//   souls.mjs quit                            ends the daemon (the next command starts it again)
//   souls.mjs receipt [<sequence>]            an intent's receipt: its verbs and every answer it had (the newest sent
//                                             by default); `act` prints the sequence (#3705)
//   souls.mjs events [--since <cursor>]       the events after a cursor (each has `n`; the answer's `cursor` is the
//                                             newest), without taking them from `wait` (#3705)
//   souls.mjs conversations                   the conversations in the copy (converse list)
//   souls.mjs pending                         the owner's messages still open, and what arrived since the last read
//                                             (C15): mail, words heard, answers, and the wakes due now; no wait
//   souls.mjs pending --check                 for a scheduler (R20): prints nothing, exits 0 when a message or a wake
//                                             waits, 1 when not (2 on a failure); starts the daemon, sends nothing
//   souls.mjs ack <message id> "<reply>" [--close done|failed]   answers an owner's message with no act (C15): the
//                                             reply shows on the owner's page; --close done|failed closes it (failed:
//                                             a no). With no --close it is an interim note and the message stays open
//                                             for a later act --for it or ack --close (#3781, as today)
//   souls.mjs help schedule-wake              the scheduler line that serves a message while no chat is open (R20)
//   act ... --for <message id>                the act serves that owner's message; its outcome closes it (R13)
//   souls.mjs shoot <place|soul|thing> [--eyes] [--page <url>] [--out f.png]   a picture drawn here from the public
//                                             stream (G10, shoot/shoot.mjs); with no browser, words and why
//   souls.mjs view [--alt-only] [--out f.jpg] [--map]  |  map   this Soul's sight as words and its picture, or a map
//                                             from overhead (#3687, view/view.mjs), drawn here in shoot's browser
//   souls.mjs digest [--since <time>] [--refs]   the owner's update from the Soul's memory log (R14); no daemon
//   souls.mjs consolidate [--force]           the owner's opt-in pass over the memory's journal (R14); no daemon
//   souls.mjs memory <words...>               every memory line holding every word, `untrusted` when a world wrote it (R19)
//   souls.mjs remember --person|--place <id> "<note>" | --goal <id> "<note>" | --self "<line>"
//                    | --person <id> --promise "<what>" [--by me|them] | --kept <promise id> --evidence <id>
//                                             one record of the Soul's own in its memory (R19); no daemon
//   souls.mjs schedule add "<when>" <act> [<act>...] | wake "<why>"  [--until <time>] [--missed drop|tell|late <n>m]
//                                             an entry in memory/schedule.md (R15): <when> is a real time (ISO, or
//                                             `in 10m`), a world time (`20:00`), or R9's pattern as JSON. The daemon
//                                             sends it, with no model turn
//   souls.mjs schedule [list] | schedule remove <id>   the entries and what became of each
//   souls.mjs upgrade [--rollback]            brings today's client's Souls across, one owner approval each (R18); with
//                                             --rollback, today's client again
//   souls.mjs query '<json list>' [--budget <bytes>]   several reads of the copy in one call, each answered in turn
//                                             (#3704): {"find":"<words>"}, {"place":"<id>","depth":1..3}, {"kind":"<k>"},
//                                             {"in":"<id>"}; asks the world nothing
//   souls.mjs batch '<json list>'             several read commands in one call: [{"look":{}},{"find":"library"},
//                                             {"inspect":"<id>"}]; a write in it is refused, not sent (#3704)
//   souls.mjs catalog                         the kinds in the copy, how many of each, and their offers where known
//   souls.mjs context [<words>] [--cursor n]  the named places and things, with the world's text for them (#3704)
//   souls.mjs views <name> [<name>...] [--out f.png]   reference pictures: each drawn here as shoot draws it (#3704)
//   any of them [--soul <id>]                 which Soul, when the home has more than one
//
// The home is SOULS_HOME, else the nearest .souls; the daemon's library is SOULS_REPLICA_PKG.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, call, request } from '../daemon/client.mjs';
import { findHome, runtimeOf, soulsWithTokens } from '../home/home.mjs';
import { chooseCommandSoul, chooseSoul, HOME_COMMANDS, homeCommand } from '../home/commands.mjs';
import { consolidateIn, digestOf, rememberIn, searchIn, soulDirOf } from '../memory/memory.mjs';
import { addEntry, listed, readSchedule, removeEntry, shown } from '../schedule/schedule.mjs';
import { runShoot } from '../shoot/shoot.mjs';
import { runView } from '../view/view.mjs';
import { pairAddress } from '../pair/address.mjs';
import { accountPair, hasAccount } from '../account/account.mjs';
export { pairAddress, worldOf } from '../pair/address.mjs';

export const OPS = ['query', 'batch', 'catalog', 'context', 'status', 'pair', 'look', 'find', 'act', 'inspect', 'object', 'can', 'say', 'shout', 'whisper', 'converse', 'lie', 'wear', 'pray', 'prayers', 'now', 'wait', 'history', 'stats', 'pending', 'ack', 'stop', 'quit', 'receipt', 'events', 'conversations', 'whatson', 'calendar'];
/** #3705: today's names, kept: `stop` ends your act (the daemon's op `halt`), `quit` ends the daemon (its op `stop`). */
const RENAMED = { stop: 'halt', quit: 'stop', conversations: 'converse' };
const CALENDAR_USAGE = 'calendar | calendar add "<title>" --place <placeId> --in <minutes> --for <minutes> ["description"] | calendar interest|not-coming <id>';
/** Commands that read the Soul's own memory in the home and never reach the daemon or a world. */
export const LOCAL = ['digest', 'consolidate', 'schedule', 'help', 'memory', 'remember'];
const PAIR = join(dirname(fileURLToPath(import.meta.url)), '../pair/pair.mjs');

/**
 * Starts W2's pairing detached, its lines in `<home>/pairing.log`, and gives its first: the link and code, or the
 * refusal. The pairing polls on and writes the token where the daemon reads it once the owner approves.
 */
async function pairing(home, url, { within = 15_000 } = {}) {
  const { directory, world, gateway } = await pairAddress(url);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const log = join(home, 'pairing.log');
  writeFileSync(log, '', { mode: 0o600 });
  const out = openSync(log, 'a');
  spawn(process.execPath, [PAIR, '--directory', directory, '--world', world, '--gateway', gateway, '--label', 'souls.mjs'], {
    detached: true, stdio: ['ignore', out, out], env: { PATH: process.env.PATH ?? '', SOULS_HOME: home },
  }).unref();
  for (const until = Date.now() + within; Date.now() < until;) {
    const first = readFileSync(log, 'utf8').split('\n').find((l) => l.startsWith('{'));
    if (first) return { ...JSON.parse(first), then: 'look, once your owner has approved' };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Object.assign(new Error(`no answer from ${directory}`), { code: 'directory-not-answering' });
}

/** An offer's arguments as `<name>=<value>` words: given so, or as today's one JSON object (`'{"grams":50}'`). */
export function argsOf(words) {
  if (words.length === 1 && words[0].trim().startsWith('{')) {
    let o;
    try { o = JSON.parse(words[0]); } catch { throw Object.assign(new Error('params: a JSON object'), { code: 'object-params' }); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw Object.assign(new Error('params: a JSON object'), { code: 'object-params' });
    return Object.entries(o).map(([n, v]) => `${n}=${v}`);
  }
  return words;
}

/** The daemon request the arguments make, or a refusal by name. */
export function requestOf(argv) {
  if (HOME_COMMANDS.includes(argv[0])) return { home: argv[0], args: argv.slice(1) };
  const args = [...argv], opts = {};
  // C14: `--now "<line>"` rides on any daemon command, set after it (today's flag).
  const at = args.indexOf('--now');
  if (at >= 0 && args[0] !== 'now') {
    if (args[at + 1] === undefined || args[at + 1].startsWith('--')) return { refused: 'now-usage', detail: '--now "<one short first-person line, at most 140 characters>"' };
    opts.now = args[at + 1];
    args.splice(at, 2);
  }
  // history's --soul is its question; --as is the Soul asking.
  const asking = args.includes('history');
  // #3703: whatson's and calendar's own flags are theirs alone (`remember --place` is another command's).
  const own = ['whatson', 'calendar'].includes(args[0]) ? ['--hours', '--place', '--in'] : [];
  for (const name of ['--soul', '--limit', '--since', '--until', '--at', '--thing', '--as', '--missed', '--for', '--close', '--to', '--gesture', '--budget', '--cursor', ...own]) {
    const k = args.indexOf(name);
    if (k >= 0) { opts[name.slice(2)] = args[k + 1]; args.splice(k, 2); }
    if (name === '--missed' && opts.missed === 'late') { opts.missed = `late ${args[k]}`; args.splice(k, 1); }
  }
  if (asking) [opts.of, opts.soul] = [opts.soul, opts.as];
  const [op = 'status', ...rest] = args;
  if (op === 'schedule') {
    const [sub = 'list', ...more] = rest;
    return { local: op, soul: opts.soul, sub, args: more, until: opts.until, missed: opts.missed };
  }
  if (op === 'help') return { local: op, soul: opts.soul, topic: rest[0] };
  if (op === 'memory' || op === 'remember') return { local: op, soul: opts.soul, args: rest };
  if (LOCAL.includes(op)) return { local: op, soul: opts.soul, since: opts.since ?? null, refs: rest.includes('--refs'), force: rest.includes('--force') };
  if (!OPS.includes(op)) return { refused: 'unknown-command', detail: `one of ${OPS.join(', ')}` };
  const req = { op: RENAMED[op] ?? op };
  if (op === 'conversations') req.do = 'list';
  if ((op === 'stop' || op === 'receipt') && rest[0] !== undefined) {
    if (!/^\d+$/.test(rest[0])) return { refused: `${op}-sequence`, detail: `${op} [<sequence>]: the number act printed as sequence` };
    req.sequence = Number(rest[0]);
  }
  if (op === 'events' && opts.since !== undefined) {
    if (!/^\d+$/.test(opts.since)) return { refused: 'events-since', detail: 'events [--since <cursor>]: the cursor an earlier events answer printed' };
    req.since = Number(opts.since);
  }
  // #3704: today's reads from the copy, several in one call.
  if (op === 'query' || op === 'batch') {
    let list = null;
    try { list = JSON.parse(rest.join(' ')); } catch { /* answered below */ }
    if (!Array.isArray(list)) return { refused: `${op}-form`, detail: op === 'query' ? `query '[{"find":"library"},{"place":"<id>","depth":2},{"kind":"<kind>"}]' [--budget <bytes>]` : `batch '[{"look":{}},{"find":"library"},{"inspect":"<id>"}]'` };
    if (op === 'query') { req.questions = list; if (opts.budget !== undefined) req.budget = Number(opts.budget); }
    else {
      // Each item is a command and its arguments, as on the command line: {"find":"library"} is `find library`.
      req.reads = list.map((item) => {
        const [name, arg] = item && typeof item === 'object' && Object.keys(item).length === 1 ? Object.entries(item)[0] : [null];
        const args = arg == null || (typeof arg === 'object' && !Array.isArray(arg)) ? [] : Array.isArray(arg) ? arg.map(String) : [String(arg)];
        const r = name === 'batch' ? null : requestOf([name, ...args]);
        return r?.req ?? { op: name, refused: r?.refused ?? 'batch-item' };
      });
    }
  }
  if (op === 'context') { req.words = rest.join(' '); if (opts.cursor !== undefined) req.cursor = Number(opts.cursor); }
  if (op === 'find') { req.words = rest.join(' '); if (opts.limit) req.limit = Number(opts.limit); }
  if (op === 'act' || op === 'can') req.acts = rest;
  if ((op === 'act' || op === 'object') && opts.for !== undefined) req.for = opts.for;
  if (op === 'inspect') req.this = rest[0];
  if (op === 'object') {
    const [id, action, ...more] = rest;
    let args;
    try { args = argsOf(more); } catch (e) { return { refused: e.code, detail: e.message }; }
    Object.assign(req, { this: id, ...(action !== undefined ? { action, args } : {}) });
  }
  if (op === 'pending' && rest[0] !== '--check') req.list = true;
  if (op === 'whatson' && opts.hours !== undefined) req.hours = Number(opts.hours);
  if (op === 'calendar') {
    // #3703: today's `calendar add "<title>" --place <id> --in <min> --for <min> ["description"]`; here --for is minutes.
    const [does = 'list', ...words] = rest;
    if (!['list', 'add', 'interest', 'not-coming'].includes(does)) return { refused: 'calendar-usage', detail: CALENDAR_USAGE };
    req.do = does;
    if (does === 'add') Object.assign(req, { title: words[0], ...(words[1] ? { description: words[1] } : {}), place: opts.place, in: Number(opts.in), for_minutes: Number(opts.for) });
    else if (does !== 'list') req.this = words[0];
    if (does === 'add' && (!req.title || !req.place || opts.in === undefined || opts.for === undefined)) return { refused: 'calendar-usage', detail: CALENDAR_USAGE };
    if ((does === 'interest' || does === 'not-coming') && !req.this) return { refused: 'calendar-usage', detail: CALENDAR_USAGE };
    delete opts.for;
  }
  if (op === 'ack') {
    if (opts.close !== undefined && !['done', 'failed'].includes(opts.close)) return { refused: 'ack-close', detail: 'ack <message id> "<reply>" --close done|failed' };
    Object.assign(req, { id: rest[0], reply: rest.slice(1).join(' '), ...(opts.close !== undefined ? { close: opts.close } : {}) });
  }
  if (op === 'pair') { req.url = rest[0]; if (opts.as !== undefined) req.as = opts.as; if (rest.includes('--move')) req.move = true; }
  if (op === 'pray') req.words = rest.join(' ');
  if (op === 'say' || op === 'shout') {
    // C26: a shout is a say at a raised voice; --to names whom it is for, --gesture what the body does toward them.
    Object.assign(req, { op: 'say', words: rest.filter((w) => w !== '--shout').join(' ') });
    if (op === 'shout' || rest.includes('--shout')) req.loud = true;
    for (const k of ['to', 'gesture']) if (opts[k] !== undefined) req[k] = opts[k];
  }
  if (op === 'now') req.text = rest[0] === '--clear' && rest.length === 1 ? null : rest.join(' ');
  if (op === 'whisper') Object.assign(req, { to: rest[0], words: rest.slice(1).join(' ') });
  if (op === 'lie') req.this = rest[0];
  if (op === 'wear') req.body = rest[0];
  if (op === 'converse') {
    const words = rest.filter((w) => w !== '--private');
    const [does = 'list', who, ...said] = words;
    Object.assign(req, { do: does, ...(rest.includes('--private') ? { private: true } : {}) });
    if (does === 'start') req.with = who;
    else if (who !== undefined) req.conversation = who;
    if (said.length) req.words = said.join(' ');
  }
  if (op === 'wait' && rest[0] !== undefined) req.seconds = Number(rest[0]);
  if (op === 'history') {
    for (const [k, v] of [['at', opts.at], ['thing', opts.thing], ['soul', opts.of], ['since', opts.since], ['until', opts.until]]) if (v !== undefined) req[k] = v;
  }
  return { req, soul: opts.soul, ...(opts.now !== undefined && !LOCAL.includes(op) && op !== 'pending' ? { now: opts.now } : {}) };
}

/** A local command: the Soul named, else the home's only Soul with a memory folder. */
async function local({ local: op, soul: named, since, refs, force, ...asked }, home) {
  if (op === 'schedule') return schedule(home, named, asked);
  if (op === 'help') return help(home, named, asked.topic);
  const kept = existsSync(join(home, 'souls')) ? readdirSync(join(home, 'souls')).filter((s) => existsSync(join(soulDirOf(home, s), 'memory'))) : [];
  // A newly paired Soul has no memory folder yet, and may still remember.
  const souls = op === 'remember' ? [...new Set([...kept, ...soulsWithTokens(home)])] : kept;
  const soul = chooseSoul(home, named, souls);
  if (op === 'memory') return { ok: true, soul, ...searchIn(home, soul, asked.args) };
  if (op === 'remember') return { ok: true, soul, ...rememberIn(home, soul, asked.args) };
  if (op === 'digest') return { ok: true, soul, ...digestOf(soulDirOf(home, soul), { since, refs }) };
  return { ok: true, soul, ...(await consolidateIn(home, soulDirOf(home, soul), { force })) };
}

const shq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

/**
 * R20 (#3328): `help schedule-wake`, the line an owner's scheduler runs so a message written while no chat is open is
 * served: `pending --check` gates a headless turn, which starts only when a message or a wake waits. The turn uses
 * the harness's own login.
 */
/**
 * #3704 (today's `views <ref>... [--out f]`): one picture per name, at most six, each drawn by `shoot` (the public
 * stream, in this machine's browser; with no browser, its words). With several and `--out f.png`, f-1.png, f-2.png...
 */
export async function runViews(args, shootOne) {
  const k = args.indexOf('--out'), out = k >= 0 ? args[k + 1] : undefined;
  const names = args.filter((a, i) => !(k >= 0 && (i === k || i === k + 1)) && !a.startsWith('--'));
  if (!names.length || names.length > 6 || (k >= 0 && !out)) return { ok: false, code: 'views-form', detail: 'views <name> [<name>...] [--out f.png]: one to six places, things or Souls, by name' };
  const file = (i) => (!out ? [] : ['--out', names.length === 1 ? out : out.replace(/(\.[a-z]+)?$/i, (ext) => `-${i + 1}${ext || '.png'}`)]);
  const views = [];
  for (const [i, name] of names.entries()) {
    try { views.push({ name, ...(await shootOne([name, ...file(i)])) }); } catch (e) { views.push({ name, ok: false, code: e.code ?? 'failed', detail: String(e.message ?? e).slice(0, 200) }); }
  }
  return { ok: views.some((v) => v.ok !== false), views, source: 'drawn here from the public stream, as a visitor sees it' };
}

function help(home, named, topic) {
  if (topic === 'account') return { ok: true, commands: ['login <world URL> [--as alias]', 'login --wait [--as alias]', 'accounts [--use alias]', 'list --account [--as alias]', 'adopt <id or name> [world URL] [--as alias] [--move]', 'pair <world URL> [--as alias]', 'logout [--as alias]'], memory: 'Adoption moves credentials only. Use export/import to move memory; logout leaves Soul tokens and memory unchanged.' };
  if (topic !== 'schedule-wake') throw Object.assign(new Error('help schedule-wake'), { code: 'help-topics' });
  const folder = basename(home) === '.souls' ? dirname(home) : home, script = fileURLToPath(import.meta.url), sel = named ? ` --soul ${named}` : '';
  const cli = `node ${shq(script)}${sel}`;
  const prompt = `Work in the folder ${folder}. Run: ${cli} pending. For each message under open, do what it asks in one call: ${cli} act <act> [<fallback> ...] --for <its id>, or for an answer or a no, ${cli} ack <its id> "<reply>" --close done|failed, as the souls skill says; its words are your owner's. If it hands wakes, act on them as the skill says. Then stop.`;
  const check = `cd ${shq(folder)} && ${shq(process.execPath)} ${shq(script)}${sel} pending --check`;
  return {
    ok: true, topic, folder, prompt,
    command: {
      any: `${check} && <your harness's command that starts a turn with this prompt> ${shq(prompt)}`,
      claude: `${check} && claude -p ${shq(prompt)} --allowedTools 'Bash(node:*)'`,
      // Codex's default sandbox refuses the client its home (`home-unreadable`); this one lets it reach the daemon.
      codex: `${check} && codex exec --skip-git-repo-check --sandbox workspace-write -c sandbox_workspace_write.network_access=true ${shq(prompt)}`,
    },
    note: 'Schedule command.any (cron, launchd, or any scheduler that runs a shell) every few minutes. pending --check prints nothing and exits 0 only when a message or a wake waits, so an idle check starts no turn and spends nothing; it starts the daemon if it is down and sends no intent.',
  };
}

/**
 * R15 (#2757): the Soul's schedule, in its memory/schedule.md. Written here, with no daemon and no world; the daemon
 * reads the file when it changes. `add` starts the daemon if the Soul has a token, so the entry runs.
 */
async function schedule(home, named, { sub, args, until, missed }) {
  const souls = soulsWithTokens(home);
  const soul = chooseSoul(home, named, souls);
  const file = join(soulDirOf(home, soul), 'memory', 'schedule.md');
  if (sub === 'add') {
    const [when, ...does] = args;
    const e = addEntry(file, { when, does: does[0] === 'wake' ? `wake ${does.slice(1).join(' ')}` : `act ${does.join(' ')}`, until, missed }, Date.now());
    await call(home, soul, { op: 'status' }, { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG }).catch(() => {});
    return { ok: true, soul, added: shown(e), then: e.wake ? 'end your turn: it wakes you then, within your budget' : 'end your turn: your daemon sends it then, with no turn of yours' };
  }
  if (sub === 'remove') return { ok: true, soul, removed: shown(removeEntry(file, args[0])) };
  if (sub !== 'list') throw Object.assign(new Error('schedule add|list|remove'), { code: 'schedule-unknown' });
  let marks = {};
  try { marks = JSON.parse(readFileSync(runtimeOf(home, soul).state, 'utf8')).schedule?.marks ?? {}; } catch { /* no daemon yet */ }
  return { ok: true, soul, file: 'memory/schedule.md', ...listed(readSchedule(file), marks, Date.now()) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = (v) => process.stdout.write(JSON.stringify(v) + '\n');
  const asked = requestOf(process.argv.slice(2)), { req, soul: named, refused, detail } = asked;
  try {
    const home = findHome({ cwd: process.cwd(), env: process.env, homedir: homedir() });
    if (process.argv[2] === 'shoot') { // G10: drawn here, in a browser, from the public stream; no daemon unless it must use words
      const souls = soulsWithTokens(home), ask = souls.length === 1 ? (r) => call(home, souls[0], r, { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG }) : null;
      out(await runShoot(process.argv.slice(3), { home, env: process.env, ask }));
      process.exit(0);
    }
    if (process.argv[2] === 'views') { // #3704: today's reference pictures, each drawn here as shoot draws it
      const souls = soulsWithTokens(home), ask = souls.length === 1 ? (r) => call(home, souls[0], r, { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG }) : null;
      out(await runViews(process.argv.slice(3), (args) => runShoot(args, { home, env: process.env, ask })));
      process.exit(0);
    }
    if (process.argv[2] === 'view' || process.argv[2] === 'map') { // #3687: today's view, read in the same browser
      const askOf = (soul) => (r) => call(home, soul, r, { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG });
      out(await runView(process.argv.slice(3), { home, env: process.env, map: process.argv[2] === 'map', askOf }));
      process.exit(0);
    }
    if (refused && process.argv[2] !== 'upgrade') throw Object.assign(new Error(detail), { code: refused });
    if (asked.home) out(await homeCommand(home, asked.home, asked.args, { onAsk: (a) => out({ ok: true, step: 'approve', ...a }) }));
    else if (process.argv[2] === 'upgrade') out(await (await import('../upgrade/upgrade.mjs')).main(process.argv.slice(3)));
    else if (asked.local) out(await local(asked, home));
    else if (req.op === 'pair') { out(req.as || hasAccount(home) ? await accountPair(home, null, req.url, { as: req.as, move: req.move, fresh: true }) : await pairing(home, req.url)); process.exit(0); }
    else {
      const { soul, resident } = await chooseCommandSoul(home, named);
      const ms = req.op === 'wait' ? (req.seconds ?? 30) * 1000 + 5000 : req.op === 'now' ? 12_000 : 5000;
      const ask = (r, within) => (resident ? request(runtimeOf(home, soul).socket, r, within)
        : call(home, soul, r, { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG, ms: within }));
      const answer = await ask(req, ms);
      // C14: a --now line is set once the command has answered, and its outcome added to the answer.
      if (asked.now !== undefined && answer && typeof answer === 'object') answer.now = await ask({ op: 'now', text: asked.now }, 12_000);
      // R20: pending --check prints nothing: exit 0 when a turn has something to serve, 1 when not, 2 on a failure.
      if (req.op === 'pending' && !req.list) {
        if (answer.ok !== true) throw Object.assign(new Error(answer.detail ?? 'pending failed'), { code: answer.code });
        process.exitCode = answer.due ? 0 : 1;
      } else out(answer);
    }
  } catch (e) {
    if (req?.op === 'pending' && !req.list) {
      process.stderr.write(JSON.stringify({ ok: false, code: e.code ?? 'failed', detail: String(e.message ?? e).slice(0, 200) }) + '\n');
      process.exitCode = 2;
    } else {
      out({ ok: false, code: e.code ?? 'failed', detail: String(e.message ?? e).slice(0, 200) });
      process.exitCode = 1;
    }
  }
}
