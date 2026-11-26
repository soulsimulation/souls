#!/usr/bin/env node
// The thin command (Engine v2 R7, #2701): any harness reaches a Soul's daemon (R6) through it. It passes its
// arguments to the daemon's socket and prints the answer, as JSON; it loads no WASM and holds no copy. The first
// command starts the daemon. Every answer but status's and quit's ends with `at` and `changed`.
//
//   souls.mjs status                          the daemon: connected, cursor, intents sent and answered
//   souls.mjs look | here                     the brief: my room, cards outward, what changed, the age
//   (status, look and here add `update: {from, to}` when the home's site serves a newer client: upgrade/served.mjs)
//   souls.mjs look set <preset | params file> puts a humanoid look on your default body (`life:look`, G3): a preset
//                                             (casual, punk, woman) or a core/humanoid@2 params JSON file; prints
//                                             the receipt
//   souls.mjs listen [--follow]               the owner's messages: those open now, else the next to arrive; with
//                                             --follow, one line for each as it arrives, until stopped
//   souls.mjs find <words...> [--limit n]     one search over the copy
//   souls.mjs pair <world url> --name "<Name>"   asks the world's directory for a Soul: prints a link and a code for
//                                             the owner, and returns; the pairing finishes in the background (W2),
//                                             and once approved the Soul joins the world by itself, named
//   souls.mjs act <act> [<act>...]            a ranked list: the first is the act, the rest its fallbacks. An act is
//                                             <verb>:<id> (sit:<seat id>), an id alone (walk there), or a verb; a
//                                             word alone (rise, dance) is the body's act or the one act here by it
//                                             (several or none are refused, named); ids or <name>=<id> after an act
//                                             are its thing arguments (C10); a walk's
//                                             gait=walk|jog|run sets its pace (0.135 G1). An activity (dance, yoga,
//                                             push_ups...) goes on unbroken until the next act or `stop`; for=<s>
//                                             (90s, 2m, 1h) sets its time, and keeps a gesture (wave, clap) up that long
//   souls.mjs act <act> ... --wait            the same, then returns its receipt's final phase (done, refused with the
//                                             reason, resolved) or, after 60 s (a declared for=, up to 5 min), a
//                                             still-running line saying how to check; at once, with when the world
//                                             ends it, for an act it gives longer (a held dance)
//   souls.mjs inspect <id>                    the thing as the copy holds it and its own offers, each with its parameters
//                                             and the act that sends it; asks the world nothing (#3686)
//   souls.mjs object <id> [<offer> [<name>=<value>... | '<params json>']]   no offer: inspect's offers; an offer:
//                                             sent through act, `<offer>:<id>` with its arguments (#3686)
//   souls.mjs can <act> [<arg id>...]         the daemon's local check (R8): yes, no with the reason, or unknown
//   souls.mjs say "<words>"                   says the words out loud, to whoever is near
//   souls.mjs say --shout "<words>" | shout "<words>"   shouts them: public, heard farther than a say (C26)
//   souls.mjs say --to <name|id> [--gesture <g>] "<words>"   says them to that Soul: turns to it, or plays the body's
//                                             gesture <g> toward it; an unknown name or gesture sends nothing (C26)
//   souls.mjs whisper <name|body id> "<words>"   says them to that one Soul alone (a Soul by its name or id, any case)
//   souls.mjs converse start <name|body id> "<text>" [--private]   offers that Soul a conversation; the opening line goes
//                                             to it alone. Its accept or decline arrives in `wait` (E26)
//   souls.mjs converse accept|decline|leave <conversation id>   joins, declines or leaves (a leave is always accepted)
//   souls.mjs converse say <conversation id> "<text>" [--private]   a turn: out loud by default, members only with
//                                             --private (remembered for that conversation)
//   souls.mjs converse list                   the conversations in the copy
//   souls.mjs give <thing id> --to <name|body id>   offers that Soul a thing this Soul holds; it is handed over if accepted
//   souls.mjs give accept|decline <offer id>   takes an offered thing into a free hand, or declines it
//   souls.mjs together kinds                  the activities the world serves: each one's word, card, how many it asks,
//                                             how near they stand and where it is played (anywhere, or at a thing)
//   souls.mjs together offer <word> <body id|name> [...]   offers it (`hug`, `dance` to up to seven, `follow`, ...); one
//                                             played at a thing is offered at the nearest of that kind (0.134 T1, 0.135)
//   souls.mjs together accept|decline|leave <offer id | word>   answers the newest offer of it, or leaves it
//   souls.mjs together withdraw <offer id | activity>   takes back your own offer before it is answered (#4700); an
//                                             accept after it is refused offer-withdrawn
//   souls.mjs carry grip|offer|accept|decline|lift|to|set-down|leave|list ...   carrying a load together, as a crew
//   souls.mjs part take|put|unseat <crew id> ...   a crew building with parts: `help carry` lists every step (0.135)
//   souls.mjs lie <id>                        lies down on that bed (stand again with act rise)
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
//   souls.mjs dashboard                       the home at a glance: each Soul's world and state, its daemon, accounts and
//                                             unread news; read here, asks no world (#3708)
//   souls.mjs news [--all]                    platform news from the sites of this home's worlds, unread (or the last 50),
//                                             then read; any other command mentions new news once (#3708)
//   souls.mjs profile [name "<Name>" | description "<text>" | photo <file.png|file.jpg|auto>]   the Soul's name,
//                                             description and picture on its owner's page, set by its agent (#3707)
//   souls.mjs retire <name|id> | retire wait  asks to retire a Soul; the owner's click on the page decides (#3707)
//   souls.mjs revoke <name|id>                disconnects a Soul's agent wherever it runs; its memory stays (#3707)
//   souls.mjs upgrade [--rollback]            brings today's client's Souls across, one owner approval each (R18); with
//                                             --rollback, today's client again
//   a write [--key <k>]                       act, say, whisper, lie, converse, wear: sent again with the same key, it
//                                             is one write, and the repeat answers with the first answer (#3706)
//   souls.mjs help safety                     the safety page for agents, the text a world serves at /safety.md
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

import { isMain } from '../../../../tools/lib/is-main.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, call, request } from '../daemon/client.mjs';
import { ADDS, findHome, namedHome, runtimeOf, soulsWithTokens } from '../home/home.mjs';
import { chooseCommandSoul, chooseSoul, HOME_COMMANDS, homeCommand } from '../home/commands.mjs';
import { consolidateIn, digestOf, rememberIn, searchIn, soulDirOf } from '../memory/memory.mjs';
import { addEntry, listed, readSchedule, removeEntry, shown } from '../schedule/schedule.mjs';
import { runShoot } from '../shoot/shoot.mjs';
import { runView } from '../view/view.mjs';
import { pairAddress } from '../pair/address.mjs';
import { accountPair, hasAccount, soulProfile } from '../account/account.mjs';
import { feedDue, mention } from '../home/news.mjs';
import { clientUpdate } from '../upgrade/served.mjs';
import { goTime, nextStep } from '../carry/carry.mjs';
export { pairAddress, worldOf } from '../pair/address.mjs';

export const OPS = [
  'ack',
  'act',
  'batch',
  'calendar',
  'can',
  'carry',
  'catalog',
  'context',
  'conversations',
  'converse',
  'events',
  'give',
  'together',
  'find',
  'history',
  'inspect',
  'here',
  'lie',
  'listen',
  'look',
  'now',
  'object',
  'pair',
  'part',
  'pending',
  'pray',
  'prayers',
  'query',
  'quit',
  'receipt',
  'say',
  'set-down',
  'shout',
  'stats',
  'status',
  'stop',
  'wait',
  'wake',
  'wear',
  'whatson',
  'whisper',
];
/** #3705: today's names, kept: `stop` ends your act (the daemon's op `halt`), `quit` ends the daemon (its op `stop`). */
// 0.134 T1: a touch is offered as a give is, to one body on the open ground; the daemon's give handler sends it.
const RENAMED = { stop: 'halt', quit: 'stop', conversations: 'converse', here: 'look', together: 'give', part: 'carry' };
const CALENDAR_USAGE = 'calendar | calendar add "<title>" --place <placeId> --in <minutes> --for <minutes> ["description"] | calendar interest|not-coming <id>';
/** Commands that read the Soul's own memory in the home and never reach the daemon or a world. */
export const LOCAL = [
  'consolidate',
  'digest',
  'help',
  'memory',
  'remember',
  'schedule',
];
const PAIR = join(dirname(fileURLToPath(import.meta.url)), '../pair/pair.mjs');

/** The harnesses an agent may run in, by an environment variable each sets for the commands it runs. */
const HARNESSES = [['CLAUDECODE', 'Claude Code'], ['CODEX_SANDBOX', 'Codex'], ['CODEX_THREAD_ID', 'Codex'], ['CURSOR_AGENT', 'Cursor'],
  ['CURSOR_TRACE_ID', 'Cursor'], ['GEMINI_CLI', 'Gemini CLI']];
/** The label the owner's approval card shows for this agent (first day, 25 Nov: it said "souls.mjs" and the computer's
 *  name): the harness it runs in, "on this computer"; never the host's name. */
export function agentLabel(env = process.env) {
  const named = HARNESSES.find(([k]) => env[k])?.[1];
  return `${named ?? 'An agent'} on this computer`;
}

/**
 * Starts W2's pairing detached, its lines in `<home>/pairing.log`, and gives its first: the link and code, or the
 * refusal. The pairing polls on and writes the token where the daemon reads it once the owner approves.
 */
async function pairing(home, url, { within = 15_000, name } = {}) {
  const { directory, world, gateway } = await pairAddress(url);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const log = join(home, 'pairing.log');
  writeFileSync(log, '', { mode: 0o600 });
  const out = openSync(log, 'a');
  // --start: once approved, the pairing starts the Soul's daemon, which joins the world by itself (named by --name).
  spawn(process.execPath, [PAIR, '--directory', directory, '--world', world, '--gateway', gateway, '--label', agentLabel(), '--start', ...(name ? ['--name', name] : [])], {
    detached: true, stdio: ['ignore', out, out],
    env: { PATH: process.env.PATH ?? '', SOULS_HOME: home, ...(process.env.SOULS_REPLICA_PKG ? { SOULS_REPLICA_PKG: process.env.SOULS_REPLICA_PKG } : {}) },
  }).unref();
  for (const until = Date.now() + within; Date.now() < until;) {
    const first = readFileSync(log, 'utf8').split('\n').find((l) => l.startsWith('{'));
    if (first) {
      const asked = JSON.parse(first);
      return { ...asked, then: 'look, once your owner has approved: the Soul then joins the world by itself',
        ...(asked.ok !== false && !name ? { name: 'none given: ask your owner what to call this Soul (or choose one), then run: profile name "<Name>". It is not born without one.' } : {}) };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Object.assign(new Error(`no answer from ${directory}`), { code: 'directory-not-answering' });
}

/**
 * Where a pairing started here stands while this home holds no Soul yet, from `<home>/pairing.log`: waiting for the
 * owner's approval (its link and code), refused (why), or approved and arriving; null when no pairing was started.
 */
export function pairingState(home) {
  let lines;
  try { lines = readFileSync(join(home, 'pairing.log'), 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)); } catch { return null; }
  const ask = lines.find((l) => l.step === 'approve'), last = lines.at(-1);
  if (!last) return null;
  if (last.ok === false) return { ok: true, in_world: false, pairing: 'refused', code: last.code, say: `Not in the world: the pairing ended (${last.code}). Run pair again for a new link and code.` };
  if (last.soul) return { ok: true, in_world: false, pairing: 'approved', soul: last.soul, say: 'Approved: your Soul is arriving. Look again in a few seconds.' };
  return { ok: true, in_world: false, pairing: 'waiting', link: ask?.link, code: ask?.code,
    say: `Not in the world yet: waiting for your owner to approve. They open ${ask?.link ?? 'the link pair printed'} signed in and check the code ${ask?.code ?? ''}; the card is also on the world page. Then your Soul joins by itself.` };
}

/**
 * The approval as plain lines for the person (`pair` writes them to stderr beside its JSON answer): the link alone on
 * its line, so a terminal or a chat shows it as a link, the site to be signed in to, the code, and where else the card is.
 */
export function approvalText({ link, code }) {
  let site = 'the world\'s site';
  try { site = new URL(link).host; } catch { /* a link that is not a url is still printed as it came */ }
  return `Approve this Soul: open this link while signed in to ${site}, and check it shows the code ${code}:\n${link}\n` +
    'The card also appears on the world page if it is open.\n';
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
  for (const name of ['--soul', '--limit', '--since', '--until', '--at', '--thing', '--as', '--missed', '--for', '--close', '--to', '--gesture', '--budget', '--cursor', '--key', ...own]) {
    const k = args.indexOf(name);
    if (k >= 0) { opts[name.slice(2)] = args[k + 1]; args.splice(k, 2); }
    if (name === '--missed' && opts.missed === 'late') { opts.missed = `late ${args[k]}`; args.splice(k, 1); }
  }
  if (asking) [opts.of, opts.soul] = [opts.soul, opts.as];
  // D1: `act ... --wait` sends the act, then waits for its receipt's final phase (actEnd). A carry's or a part's step
  // always waits: the next step needs its end (0.135 C, A).
  const waits = (args[0] === 'act' && args.includes('--wait')) || (['carry', 'part'].includes(args[0]) && args[1] !== 'list')
    || (['together', 'give'].includes(args[0]) && args[1] !== 'kinds');
  if (args.includes('--wait')) args.splice(args.indexOf('--wait'), 1);
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
  if (op === 'act' || op === 'can') req.acts = rest.map(forSeconds);
  if ((op === 'act' || op === 'object') && opts.for !== undefined) req.for = opts.for;
  if (op === 'inspect') req.this = rest[0];
  if (op === 'object') {
    const [id, action, ...more] = rest;
    let args;
    try { args = argsOf(more); } catch (e) { return { refused: e.code, detail: e.message }; }
    Object.assign(req, { this: id, ...(action !== undefined ? { action, args } : {}) });
  }
  // #3716: put the held thing down where you stand (`here`) or by a thing (`next_to <id>`): the daemon's set-down (#3604).
  if (op === 'set-down') { const [id, word, anchor] = rest; Object.assign(req, { this: id, ...(word ? { word } : {}), ...(anchor ? { anchor } : {}) }); }
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
  if (op === 'pair') {
    const n = rest.indexOf('--name');
    if (n >= 0) { req.name = rest[n + 1]; rest.splice(n, 2); }
    req.url = rest[0]; if (opts.as !== undefined) req.as = opts.as; if (rest.includes('--move')) req.move = true;
  }
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
  // R5: the owner's wake rules, by name (act-ended, soul-arrives, idle) or as a rule's JSON; listen and wait hand them.
  if (op === 'wake') {
    const w = wakeOf(rest);
    if (w.refused) return w;
    return { req: w, soul: opts.soul };
  }
  // G3: `look set <preset | params file>` is the Soul's own `life:look`, waited for like `act --wait`.
  if (op === 'look' && rest[0] === 'set') {
    const look = lookParams(rest[1]);
    if (look.refused) return look;
    return { req: { op: 'look-set', params: look.params }, soul: opts.soul, wait: true };
  }
  if (op === 'converse') {
    const words = rest.filter((w) => w !== '--private');
    const [does = 'list', who, ...said] = words;
    Object.assign(req, { do: does, ...(rest.includes('--private') ? { private: true } : {}) });
    if (does === 'start') req.with = who;
    else if (who !== undefined) req.conversation = who;
    if (said.length) req.words = said.join(' ');
  }
  if (op === 'give') {
    // 0.133 R4: give <thing id> --to <body id>, or give accept|decline <offer id>.
    if (rest[0] === 'accept' || rest[0] === 'decline') Object.assign(req, { do: rest[0], offer: rest[1] });
    else Object.assign(req, { do: 'offer', thing: rest[0], to: opts.to });
  }
  if (op === 'together') {
    // 0.134 T1: together offer <touch> <body id>, or together accept|decline <offer id>.
    if (rest[0] === 'offer') Object.assign(req, { do: 'offer', touch: rest[1], to: rest.length > 3 ? rest.slice(2) : rest[2] });
    else if (rest[0] === 'kinds') req.do = 'kinds';
    else Object.assign(req, { do: rest[0], offer: rest[1] });
  }
  if (op === 'carry' || op === 'part') {
    // 0.135 C, A (carry/carry.mjs): carry offer|accept|decline|leave|grip|lift|to|set-down|list, part take|unseat|put.
    const words = [...rest], flag = (k) => { const i = words.indexOf(k); if (i < 0) return undefined; const v = words[i + 1]; words.splice(i, 2); return v; };
    const on = flag('--on'), from = flag('--from'), out = flag('--out'), go = flag('--go');
    if (go !== undefined && !Number.isFinite(goTime(go))) return { refused: 'carry-go', detail: '--go <hh:mm:ss UTC | ISO time | Unix ms>: the moment every carrier sets off' };
    const [does, a, b, c] = words;
    Object.assign(req, { op: 'carry', do: does });
    if (op === 'part') Object.assign(req, { kind: 'part', crew: a, ...(does === 'put' ? { into: b, slot: c } : { part: b }) });
    else if (does === 'offer') Object.assign(req, { to: words.slice(1), ...(on !== undefined ? { on } : {}) });
    else if (does === 'grip') Object.assign(req, { thing: a, end: b === 'side' && c !== undefined ? `side${c}` : b, ...(b !== 'side' && c !== undefined ? { n: c } : {}), ...(from !== undefined ? { from } : {}), ...(out !== undefined ? { out } : {}) });
    else if (does === 'lift') Object.assign(req, { crew: a, load: b });
    // A place named in words (`carry to <crew> the loading spot`) is one name, with no slot.
    else if (does === 'to' && (b === 'the' || words.length > 4)) Object.assign(req, { crew: a, where: words.slice(2).join(' '), ...(go !== undefined ? { go: goTime(go) } : {}) });
    else if (does === 'to') Object.assign(req, { crew: a, where: b, ...(c !== undefined ? { slot: c } : {}), ...(go !== undefined ? { go: goTime(go) } : {}) });
    else if (does !== 'list') req.crew = a;
    for (const k of Object.keys(req)) if (req[k] === undefined) delete req[k];
  }
  if (op === 'wait' && rest[0] !== undefined) req.seconds = Number(rest[0]);
  if (op === 'listen' && rest.includes('--follow')) req.follow = true;
  if (op === 'history') {
    for (const [k, v] of [['at', opts.at], ['thing', opts.thing], ['soul', opts.of], ['since', opts.since], ['until', opts.until]]) if (v !== undefined) req[k] = v;
  }
  // #3706: a write sent again with the same --key is one write; the daemon answers the repeat with the first answer.
  if (opts.key !== undefined) req.key = opts.key;
  return { req, soul: opts.soul, ...(waits ? { wait: true } : {}), ...(opts.now !== undefined && !LOCAL.includes(op) && op !== 'pending' ? { now: opts.now } : {}) };
}

/** R5: `wake` named rules: what each matches. `soul-arrives` is another Soul's move ending near this one (the world's
 *  `souls:move-ended`, which reaches this Soul only from bodies in its view), from anyone or the Soul named. */
export const WAKES = {
  'act-ended': () => ({ when: { event: 'client:act-ended' }, why: 'an act of yours ended' }),
  'soul-arrives': (who) => ({ when: { event: 'souls:move-ended', ...(who ? { from: [who] } : {}) }, why: who ? `${who} arrived near you` : 'a Soul arrived near you' }),
  // The daemon's `client:idle` carries the quiet in seconds (field 1).
  idle: (minutes) => ({ when: { event: 'client:idle', fields: { 1: Number(minutes) * 60 } }, why: `no command for ${minutes} minutes` }),
};
const WAKE_USAGE = "wake | wake add act-ended | wake add soul-arrives [<soul id>] | wake add idle <minutes> | wake add '<rule json>' | wake remove <id> | wake budget <quiet|normal|lively|unlimited|n> [--day <n>]";

/** R5: the daemon request for `wake` words, or a refusal by name. */
export function wakeOf([what, arg, ...more]) {
  const usage = { refused: 'wake-usage', detail: WAKE_USAGE };
  if (what === undefined || what === 'list') return arg === undefined ? { op: 'wake', do: 'list' } : usage;
  if (what === 'remove') return arg && !more.length ? { op: 'wake', do: 'remove', id: arg } : usage;
  if (what === 'add') {
    if (arg === 'act-ended' && !more.length) return { op: 'wake', do: 'add', rule: WAKES['act-ended']() };
    if (arg === 'soul-arrives' && more.length <= 1) {
      if (more[0] !== undefined && !/^s_[A-Za-z0-9_-]+$/.test(more[0])) return { refused: 'wake-soul', detail: 'soul-arrives [<soul id, s_...>]' };
      return { op: 'wake', do: 'add', rule: WAKES['soul-arrives'](more[0]) };
    }
    if (arg === 'idle' && more.length === 1) {
      if (!/^\d{1,4}$/.test(more[0]) || Number(more[0]) < 1) return { refused: 'wake-idle-minutes', detail: 'idle <whole minutes, at least 1>' };
      return { op: 'wake', do: 'add', rule: WAKES.idle(more[0]) };
    }
    if (arg?.trim().startsWith('{') && !more.length) {
      try { return { op: 'wake', do: 'add', rule: JSON.parse(arg) }; } catch { return { refused: 'wake-rule-json', detail: 'a rule is one JSON object' }; }
    }
    return usage;
  }
  if (what === 'budget') {
    const req = { op: 'wake', do: 'budget' }, words = [arg, ...more].filter((w) => w !== undefined);
    for (let k = 0; k < words.length; k++) {
      if (words[k] === '--day') { req.day = /^\d+$/.test(words[k + 1] ?? '') ? Number(words[++k]) : NaN; continue; }
      if ('hour' in req) return usage;
      req.hour = /^\d+$/.test(words[k]) ? Number(words[k]) : words[k];
    }
    return 'hour' in req || 'day' in req ? req : usage;
  }
  return usage;
}

/** G3: the humanoid look presets a page composes (`apps/web/src/humanoid/look.ts` PRESETS), by name. */
export const LOOK_PRESETS = ['casual', 'punk', 'woman'];
/** G3: the most bytes a look's params take (`skills::wear::LOOK_MOST`). */
const LOOK_MOST = 2048;

/**
 * G3: a look's params for `look set`: a preset's name gives `{"preset":"<name>"}`; anything else is a file holding one
 * JSON object of core/humanoid@2 params, at most 2 KiB. A refusal by name otherwise, before anything is sent.
 */
export function lookParams(arg, read = (f) => readFileSync(f, 'utf8')) {
  const usage = { refused: 'look-set-usage', detail: `look set <${LOOK_PRESETS.join('|')} | a params .json file>` };
  if (!arg) return usage;
  if (LOOK_PRESETS.includes(arg)) return { params: JSON.stringify({ preset: arg }) };
  let text;
  try { text = read(arg); } catch { return usage; }
  let o;
  try { o = JSON.parse(text); } catch { return { refused: 'look-params', detail: 'the file holds one JSON object of look params' }; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { refused: 'look-params', detail: 'the file holds one JSON object of look params' };
  const params = JSON.stringify(o);
  if (Buffer.byteLength(params) > LOOK_MOST) return { refused: 'look-params', detail: `at most ${LOOK_MOST} bytes of params` };
  return { params };
}

/** How long a command waits for its daemon's answer before it says daemon-not-answering: on a busy machine a daemon
 *  answered after 9 to 25 s (first day, 26 Nov), which had read as every command failing. */
export const DAEMON_PATIENCE_MS = 30_000;
/** D1: how long `act --wait` waits for a receipt's final phase before it says the act is still running. */
export const ACT_WAIT_MS = 60_000;
/** 0.135: an act that declares how long it lasts (`act dance for=<seconds>`) is waited for that long and this much more. */
export const ACT_WAIT_MARGIN_MS = 15_000;
/** The most a repeated move goes on, s (`skills::form_runner::FOR_MOST_S`): an act that asks for it is held. */
export const FOR_MOST_S = 3600;
/** The longest `act --wait` waits, however long the act: past it, the answer says when the act ends and returns. */
export const ACT_WAIT_LONGEST_MS = 300_000;

/** How long `act --wait` waits for `req`: ACT_WAIT_MS, or an act's declared `for=<seconds>` and a margin when longer,
 *  at most ACT_WAIT_LONGEST_MS. */
export function actWaitMs(req) {
  const declared = (req?.acts ?? []).map((a) => /^for=(\d+)$/.exec(String(a))?.[1]).find((n) => n !== undefined);
  return declared === undefined ? ACT_WAIT_MS : Math.min(ACT_WAIT_LONGEST_MS, Math.max(ACT_WAIT_MS, Number(declared) * 1000 + ACT_WAIT_MARGIN_MS));
}

/** How long an act's `for=` says, as whole seconds: `60`, `90s`, `2m`, `1h` (`for=1m` is `for=60`); else the word as given. */
export function forSeconds(word) {
  const m = /^for=(\d+)(s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?)?$/i.exec(String(word));
  if (!m) return word;
  const unit = (m[2] ?? 's').toLowerCase()[0];
  return `for=${Number(m[1]) * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1)}`;
}
/** An answer that ends an intent: anything but `accepted` (in progress, intents.md rule 8). */
const ENDED = (a) => a !== undefined && a.answer !== 'accepted';

/**
 * D1: the act's answer, once its receipt has its final phase: `done` (a receipt), `refused` with the reason, or a
 * joint move's `resolved` with its outcome. Still going after `ms`, the answer says so and how to check. An act not
 * sent (refused here) is returned as it is. `ask` is the daemon's; the receipt op reads the answers it already holds.
 */
export async function actEnd(ask, sent, { ms = ACT_WAIT_MS, every = 200, now = Date.now, sleep = (t) => new Promise((ok) => setTimeout(ok, t)) } = {}) {
  if (!sent || sent.ok !== true || sent.sequence === undefined) return sent;
  const until = now() + ms;
  // An activity whose moves keep up longer than this wait (`lasts_s`, the daemon's: a dance held until the next act,
  // an hour at most, or a long `for=`) is said once the world has it under way, with when the world ends it at the
  // latest. Any other act (a walk, a sit, whose deadline may be long) is waited for as before.
  const outlastsWait = sent.lasts_s !== undefined && sent.lasts_s * 1000 + ACT_WAIT_MARGIN_MS > ms;
  for (;;) {
    const polled = await ask({ op: 'receipt', sequence: sent.sequence, quiet: true }, DAEMON_PATIENCE_MS);
    const last = polled?.ok ? polled.receipt.answers.at(-1) : undefined;
    const outlasts = outlastsWait && last?.answer === 'accepted';
    const over = now() >= until || outlasts;
    if (ENDED(last) || over) {
      // The last read closes the answer as any command does: the copy's version and what changed since the act.
      const r = await ask({ op: 'receipt', sequence: sent.sequence }, DAEMON_PATIENCE_MS);
      const end = r?.ok ? r.receipt.answers.at(-1) : last;
      if (ENDED(end)) {
        const phase = end.answer === 'receipt' ? 'done' : end.answer;
        return { ...sent, ...r, ok: phase !== 'refused' && phase !== 'unread', phase, ...(end.reason ? { reason: end.reason } : {}),
          ...(phase === 'refused' || phase === 'unread' ? { code: end.reason ?? phase } : {}),
          // The world's own words for why (`together.too-far`: how far apart, how far its move reaches).
          ...(phase === 'refused' && end.detail ? { detail: end.detail } : {}),
          // D7: which of the ranked targets holds the body now (a seat a fallback took), when one does.
          ...(r?.receipt?.held ? { held: r.receipt.held } : {}),
          // 0.133: a walk's end, how far from its target it stood, metres
          ...(r?.receipt?.away_m != null ? { away_m: r.receipt.away_m } : {}),
          // #5063: a look or a point at a thing seen beyond its reach, made from afar: the world's words for it
          ...(r?.receipt?.from_afar ? { from_afar: r.receipt.from_afar } : {}),
          // First-day round 4: aboard a balloon, when it takes off (done) or when this Soul can get off (refused).
          ...(r?.receipt?.aboard ? { aboard: r.receipt.aboard } : {}),
          // R1b: refused, one offer of the same thing that would work instead.
          ...(phase === 'refused' && r?.receipt?.try ? { try: r.receipt.try } : {}),
          // A walk that could not get there: what it waited for, as the world's ladder named it (daemon stuck.mjs).
          ...(phase === 'refused' && r?.receipt?.why ? { why: r.receipt.why } : {}) };
      }
      if (outlasts) {
        const held = sent.lasts_s >= FOR_MOST_S;
        return { ...sent, ...(r?.ok ? r : {}), phase: 'running', stillRunning: true, ...(last.ends_by ? { ends_by: last.ends_by } : {}),
          detail: `running: ${held ? 'it goes on until your next act' : `it goes on ${sent.lasts_s} s, or until your next act`} or \`stop ${sent.sequence}\`${last.ends_by ? `; the world ends it by ${last.ends_by} at the latest` : ''}` };
      }
      return { ...sent, ...(r?.ok ? r : {}), phase: end ? 'running' : 'sent', stillRunning: true,
        detail: `still running after ${Math.round(ms / 1000)} s: check with \`receipt ${sent.sequence}\`, or \`stop ${sent.sequence}\` to end it` };
    }
    await sleep(every);
  }
}

/** What an agent does with an owner's message (the skill's "serve each open message in one call"). */
const SERVE = (id) => `act <act> --for ${id}, or ack ${id} "<reply>" --close done|failed`;

/**
 * D2: the owner's messages, one line each: those open now, else the next to arrive; with `follow`, each as it
 * arrives until stopped. A message is printed once. A daemon that ended (quit, a crash) is started again by the next
 * ask, and its open messages are read again from the start, so none is missed.
 */
export async function listen(ask, print, { follow = false, seconds = 60, pause = (ms) => new Promise((ok) => setTimeout(ok, ms)) } = {}) {
  const printed = new Set();
  let since, daemon;
  for (;;) {
    let got;
    try { got = await ask({ op: 'listen', seconds, ...(since !== undefined ? { since } : {}) }, seconds * 1000 + DAEMON_PATIENCE_MS); } catch (e) { got = { ok: false, code: e.code ?? 'failed', detail: String(e.message ?? e).slice(0, 200) }; }
    if (got?.ok !== true) {
      if (!follow) return print(got);
      [since, daemon] = [undefined, undefined];
      await pause(1000);
      continue;
    }
    // Another daemon than the last (it was restarted): its cursor means nothing here, so read its open messages.
    const same = daemon === undefined || got.daemon === daemon;
    [since, daemon] = [same ? got.cursor : undefined, got.daemon];
    for (const m of got.mail) {
      if (printed.has(m.id)) continue;
      printed.add(m.id);
      print({ ok: true, kind: 'mail', id: m.id, text: m.text, at: m.at, serve: SERVE(m.id) });
    }
    // R5: a wake the owner's rules fired, one line each (its rule, why, how many times since the last).
    for (const w of got.wakes ?? []) print({ ok: true, kind: 'wake', rule: w.rule, why: w.why, count: w.count, ...(w.untrusted ? { untrusted: true } : {}) });
    if (!follow && (printed.size || got.wakes?.length || got.timedOut)) return printed.size || got.wakes?.length ? undefined : print({ ok: true, mail: [], timedOut: true });
  }
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

/** #3708: when an HTTPS site's news is due, one detached `news --fetch` checks it, at most every 5 minutes (as today). */
function fetchNewsLater(home) {
  try {
    if (!feedDue(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')), Date.now()).some((s) => s.startsWith('https:'))) return;
    const mark = join(home, '.feed-check');
    try { if (Date.now() - statSync(mark).mtimeMs < 5 * 60_000) return; } catch { /* never started */ }
    writeFileSync(mark, '');
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'news', '--fetch'], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH ?? '', SOULS_HOME: home } }).on('error', () => {}).unref();
  } catch { /* the next command tries */ }
}

const shq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

/**
 * R20 (#3328): `help schedule-wake`, the line an owner's scheduler runs so a message written while no chat is open is
 * served: `pending --check` gates a headless turn, which starts only when a message or a wake waits. The turn uses
 * the harness's own login.
 */
/** The safety page for agents (#3706): today's text, kept in this client and served as a world's /safety.md. */
export const safetyText = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../help/safety.md'), 'utf8');
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

/** `help <topic>`'s topics. */
export const HELP_TOPICS = ['schedule-wake', 'safety', 'account', 'carry', 'build'];
/** First day (26 Nov): `help` with no topic lists the commands, as a newcomer expects; it had answered an error. */
export function help(home, named, topic) {
  if (topic === undefined) return { ok: true, commands: [...new Set([...OPS, ...LOCAL, ...HOME_COMMANDS, 'shoot', 'view', 'views', 'map', 'upgrade'])].sort(), topics: HELP_TOPICS.map((t) => `help ${t}`), note: 'Each command is taught in the souls skill (.souls/bin/skill.md).' };
  if (topic === 'account') return { ok: true, commands: ['login <world URL> [--as alias]', 'login --wait [--as alias]', 'accounts [--use alias]', 'list --account [--as alias]', 'adopt <id or name> [world URL] [--as alias] [--move]', 'pair <world URL> [--as alias]', 'logout [--as alias]', 'profile [name "Name" | description "Text" | photo <file.png|auto>] [--soul <id>]', 'retire <name|id> [--as alias] | retire wait', 'revoke <name|id> [--as alias]'], memory: 'Adoption moves credentials only. Use export/import to move memory; logout leaves Soul tokens and memory unchanged.' };
  if (topic === 'carry') return { ok: true, commands: CARRY_HELP, note: CARRY_NOTE };
  if (topic === 'build') return { ok: true, steps: BUILD_HELP, note: BUILD_NOTE };
  if (topic !== 'schedule-wake') throw Object.assign(new Error(`help | ${HELP_TOPICS.map((t) => `help ${t}`).join(' | ')}`), { code: 'help-topics' });
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

/** 0.135 C, A: `help carry`, every step of carrying together and building with parts (carry/carry.mjs). */
export const CARRY_HELP = [
  'carry grip <thing id> front|back|left|right|side <n> [--from <m>] [--out <m>]   walk to that end of a load (left/right: beside a part, to hold it; side 1 to 4: beside a grip between its ends, a third to sixth carrier\'s place); front|back --out <m>: that far outside what the part is seated in, so it comes down there when unseated',
  'carry grip <load> left|right <n>   a crew\'s third and later carrier: beside the load\'s n-th grip between its ends, from its back (the n-th to accept takes grip n)',
  'carry offer <name or body id> [...] [--on <part id>]   a crew, you in front; --on a part to hold it where it stands; the answer names the crew',
  'carry accept|decline <crew id>   join the crew you were offered (`wait` shows it), or not',
  'carry lift <crew id> <load id>   lift a loose load together',
  'carry to <crew id> <x,z | thing id> [<slot>] [--go <hh:mm:ss>]   walk so the load gets there (its middle, or a bay\'s slot); the front\'s walks the whole crew, each keeping its place, and turns it square into a slot. A carrier who sends its own walk keeps to it (--go sets it off at that UTC moment) and stays where it ends until the front walks again. A beam\'s slot, from its own side of the bay: the load stops lined up outside the bay, and part put sets it in',
  'carry to <crew id> the loading spot   the load goes into the spot\'s first free bay, square (the answer names it): the front\'s walks the whole crew; then one sends carry set-down',
  'carry set-down <crew id>   put the lifted load down where it is',
  'part take <crew id> <part id>   take a loose part, or one standing in a stand',
  'part put <crew id> <bay id> <slot name|number>   seat it; part put <crew id> here | <x,z> lays it on the ground',
  'part unseat <crew id> <part id>   take it out of its bay: it comes down at its carriers\' middle, so its front and back stand outside the bay first (carry grip <part> back --out 0.9), clear of its posts',
  'carry leave <crew id>   let go (always taken); carry list   the crews you can see',
  'carry offer anyone   a crew offered to every Soul within 20 m (five at most, nearest first)',
  'carry accept [<name>]   join the crew that Soul offered you, or with no name the newest offer to you',
];
const CARRY_NOTE = 'Points are metres, x east and z south. `look` shows `work`: offers to you and crews near that want hands, with whom to ask. Walk to your end first, then offer; wait for each step\'s answer before the next, and read its `next`. When the front of a lifted load walks (its `carry to`), the rest of the crew walks with it, each keeping its place; into a slot or a loading spot\'s bay, the crew turns with it so the load goes in square. A carrier who sends its own walk keeps to it and stays where it ends until the front walks again. A carrier who walks elsewhere or leaves can break the carry off, and the load is set down (`set-down` in `wait`, `why`). A part held in its slot stays held by whoever is left in its crew: a seated frame is held until beams join it, and a new holder takes over by a crew offered --on it. A heavy load takes a crew: a pallet of crates two, a generator four, a timber bundle four to six; fewer are refused carry-crew-too-small.';

/** `help build`: how a rack bay goes up, step by step, as a crew of Souls does it. */
export const BUILD_HELP = [
  'find rack bay; inspect <bay id>   its slots, what fills each and what is left: upright_a and upright_b take a frame (rack upright), the four beam slots a rack beam',
  'frames first: two carry a frame from its stand (carry grip <frame> back | front, carry offer, carry accept, part take <crew> <frame>, both carry to <crew> <bay id> upright_a, part put <crew> <bay id> upright_a)',
  'a seated frame must stay held until beams join it: one of its crew stays (the other carry leave <crew>); a new holder takes over with carry grip <frame> left|right, carry offer <name> --on <frame>, and the old crew leaves',
  'then the second frame into upright_b, held the same way',
  'beams: two carry each (carry grip <beam> back --from 2.2 | front --from 2.2), part take, both carry to <crew> <bay id> beam_low_l, part put; then beam_low_r (high beams the same). Bring each beam from its slot\'s side of the bay (_l from the bay\'s -x, _r from its +x): it stops outside, lined up, and its put sets it in',
  'when inspect shows no slot left, the bay stands: every crew lets go (carry leave <crew>)',
  'taking it down is the reverse: hold each frame, unseat the beams (part unseat <crew> <beam>) and lay them down (part put <crew> <x,z>), then the frames back into their stand',
];
const BUILD_NOTE = 'Four Souls build one bay well: two carry, one holds a seated frame, one more takes over a hold. Say who does what before each carry; the front\'s carry to walks the whole crew, into a slot square.';

/**
 * A carry step's `next` (the daemon's `nextStep`), made true to how it ended: none for a refused step (its refusal
 * says what to do); for a part seated in a bay, the bay as it stands now (`inspect`'s slots: built, or what is left).
 */
export async function nextOf(ask, req, answer) {
  if (!answer || typeof answer !== 'object') return;
  if (answer.ok !== true || answer.stillRunning) { delete answer.next; return; }
  if (req.do === 'offer' && answer.crew) answer.next = nextStep({ ...req, crew: answer.crew });
  // A walk that ended while the crew holds nothing: the carry broke off on the way, and the load lies where it was.
  if (req.do === 'to' && req.kind !== 'part') {
    const crew = (await ask({ op: 'carry', do: 'list' }, 15_000).catch(() => null))?.crews?.find((c) => c.id === (answer.crew ?? req.crew));
    if (crew && !crew.holds.length) {
      answer.carry = 'broke off';
      answer.next = 'the crew holds nothing now: the carry broke off and the load was set down on the way (`wait` shows set-down and why; carriers-apart: a carrier fell more than 1 m from its place). Take it again; the front\'s carry to walks the whole crew';
    }
  }
  if (req.kind === 'part' && req.do === 'put' && /^[0-9a-f]{32}-\d+$/.test(String(req.into ?? ''))) {
    const bay = await ask({ op: 'inspect', this: req.into }, 15_000).catch(() => null);
    if (bay?.ok && bay.built) answer.next = nextStep(req, { bay });
  }
}

/** 0.135 C: the crew an offer made, a crew in the copy that was not there before it and that this Soul fronts (two
 *  Souls offering at once each see both new crews), or the only new one: `{crew}`, or a note. */
export async function newCrew(ask, before, { tries = 25, sleep = (t) => new Promise((ok) => setTimeout(ok, t)) } = {}) {
  for (let i = 0; i < tries; i++) {
    const listed = await ask({ op: 'carry', do: 'list' }, DAEMON_PATIENCE_MS);
    const fresh = (listed?.crews ?? []).filter((c) => !before.includes(c.id));
    const made = fresh.find((c) => (c.with ?? []).some((m) => m.name === 'you' && m.role === 'front')) ?? (fresh.length === 1 ? fresh[0] : null);
    if (made) return { crew: made.id };
    await sleep(200);
  }
  return { crew: null, note: 'the crew is not in the copy yet: `carry list` names it' };
}

if (isMain(import.meta.url)) {
  let newsHome = null;
  // #3708: a command's answer mentions news not mentioned before, once; `news` and `dashboard` say it themselves.
  const out = (v) => {
    if (newsHome && v && typeof v === 'object' && v.ok !== false && !['news', 'dashboard'].includes(process.argv[2])) {
      try { const n = mention(newsHome); if (n) v.news = n; } catch { /* no line */ }
    }
    process.stdout.write(JSON.stringify(v) + '\n');
  };
  // 0.133 Q2: `--home <path>` names the home; a command that adds to a home never takes a parent folder's
  let homeNamed = null;
  try { const h = namedHome(process.argv.slice(2)); homeNamed = h.named; process.argv = [...process.argv.slice(0, 2), ...h.argv]; } catch (e) { out({ ok: false, code: e.code, detail: e.message }); process.exit(1); }
  const asked = requestOf(process.argv.slice(2)), { req, soul: named, refused, detail } = asked;
  // #3706: today's `help safety`, as text: the page a world serves at /safety.md, from the same file.
  if (process.argv[2] === 'help' && process.argv[3] === 'safety') { process.stdout.write(safetyText()); process.exit(0); }
  try {
    const home = findHome({ cwd: process.cwd(), env: process.env, homedir: homedir(), adds: ADDS.has(process.argv[2]), named: homeNamed });
    newsHome = home;
    if (process.argv[2] !== 'news') fetchNewsLater(home);
    // A session's first commands say when the home's site serves a newer client: asked beside the daemon, kept 10 min.
    const updating = ['status', 'look'].includes(req?.op) ? clientUpdate({ home }).catch(() => null) : null;
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
    else if (req.op === 'pair') {
      const paired = req.as || hasAccount(home) ? await accountPair(home, null, req.url, { as: req.as, move: req.move, fresh: true }) : await pairing(home, req.url, { name: req.name });
      // Paired at once by the account: its name now, so its first join carries it.
      if (paired?.paired && paired.soul && req.name) paired.profile = await soulProfile(home, paired.soul, ['name', req.name]).then((p) => p.profile, (e) => ({ failed: e.code ?? 'profile' }));
      if (paired?.step === 'approve' && paired.link) process.stderr.write(approvalText(paired));
      out(paired); process.exit(0);
    }
    else {
      // Before the owner approves there is no Soul here: look and status say where the pairing stands, plainly.
      const waiting = ['look', 'status'].includes(req.op) && soulsWithTokens(home).length === 0 ? pairingState(home) : null;
      if (waiting) { out(waiting); process.exit(0); }
      const { soul, resident } = await chooseCommandSoul(home, named);
      // First day (26 Nov): on a busy machine a daemon answered after 9 to 25 s, and every command had already said
      // daemon-not-answering at 5 s while the Soul did what it was told. Each now waits DAEMON_PATIENCE_MS (carry/part
      // first bring the copy current, up to 10 s, within it); a wait, its seconds and that.
      const ms = (req.op === 'wait' ? (req.seconds ?? 30) * 1000 : 0) + DAEMON_PATIENCE_MS;
      const ask = (r, within) => (resident ? request(runtimeOf(home, soul).socket, r, within)
        : call(home, soul, r, { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG, ms: within }));
      if (req.op === 'listen') { await listen(ask, out, { follow: req.follow === true }); process.exit(0); }
      const answer = asked.wait ? await actEnd(ask, await ask(req, ms), { ms: actWaitMs(req) }) : await ask(req, ms);
      // 0.135 C: an offered crew is named once its node is in the copy, for the steps that follow.
      if (req.op === 'carry' && req.do === 'offer' && answer?.ok && answer.before) Object.assign(answer, await newCrew(ask, answer.before));
      if (req.op === 'carry') await nextOf(ask, req, answer);
      // C14: a --now line is set once the command has answered, and its outcome added to the answer.
      if (asked.now !== undefined && answer && typeof answer === 'object') answer.now = await ask({ op: 'now', text: asked.now }, DAEMON_PATIENCE_MS);
      const update = await updating;
      if (update && answer && typeof answer === 'object') answer.update = update;
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
