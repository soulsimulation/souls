// A live agent seat on the new engine (0.133 Q1): a real Claude Code agent (`claude -p`, arena/adapters/claude-headless)
// drives one Soul through the new client, as an owner's own agent would. Live seats run on the existing Claude login
// (`SEAT_CONFIG_DIR`, default `$HOME/.claude`); this is for measuring the models only, everything else stays fake.
//
//   battery seat  `liveSeat`: the Soul is paired as arena/new-engine/seat.mjs pairs one, and the agent's folder gets
//                 `eden.mjs` (a wrapper that runs the new client's thin command for this home and logs each command
//                 and its answer to the seat's `commands.jsonl`, as seat.mjs's own `cli` does) and `skill.md` (the
//                 served skill, v2/client/skill/SKILL.md). Each owner message is one turn: the kickoff, then the
//                 message as `listen --follow` prints it.
//   world intents `intentsOf(commands)`: each command that asks the world for something (an act, words, a touch, a
//                 calendar write) and how it ended: done, sent, or refused with its cause.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { turn } from '../adapters/claude-headless.mjs';
import { pairSeat, CLI, REPLICA_PKG, lastJson } from './seat.mjs';
import { REPO_ROOT } from '../../../lib/paths.mjs';

export const SKILL = join(REPO_ROOT, 'v2/client/skill/SKILL.md');
/** The agent's shell verbs: the client, `node` and `cd` (what an owner approves on the first prompt), and plain reads
 *  and writes in its own folder (claude-headless DEFAULT_ALLOWED, trimmed). */
export const LIVE_ALLOWED = ['Bash(node eden.mjs:*)', 'Bash(node:*)', 'Bash(cd:*)', 'Bash(curl:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(pwd:*)', 'Bash(head:*)', 'Bash(tail:*)',
  'Bash(grep:*)', 'Bash(sleep:*)', 'Bash(echo:*)', 'Bash(mkdir:*)', 'Read(./**)', 'Write(./**)', 'Edit(./**)'];

/** The live seats' Claude login: SEAT_CONFIG_DIR, else the existing one. */
export function useSeatLogin(env = process.env) {
  env.CLAUDE_CONFIG_DIR = env.SEAT_CONFIG_DIR || join(env.HOME, '.claude');
  delete env.ANTHROPIC_API_KEY;   // the subscription's login, never a key from the launcher's environment
  return env.CLAUDE_CONFIG_DIR;
}

/** `eden.mjs` for a seat folder: the new client's thin command for this home, each call logged as seat.mjs logs one. */
export const wrapperSource = ({ cli = CLI, pkg = REPLICA_PKG, log }) => `#!/usr/bin/env node
// The Soul client for this folder (a playtest seat): runs the new client's command and passes its answer through.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const t = Date.now(), words = process.argv.slice(2);
const env = { ...process.env, SOULS_HOME: new URL('./.souls', import.meta.url).pathname, SOULS_REPLICA_PKG: ${JSON.stringify(pkg)}, BRAIN_MODE: 'fake' };
const r = spawnSync(process.execPath, [${JSON.stringify(cli)}, ...words], { env, encoding: 'utf8', maxBuffer: 64 << 20 });
process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? '');
let answer = null;
for (const l of String(r.stdout ?? '').trim().split('\\n').reverse()) { try { answer = JSON.parse(l); break; } catch {} }
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ at: t, ms: Date.now() - t, words, answer: answer ?? { ok: false, raw: String((r.stdout ?? '') + (r.stderr ?? '')).slice(-500) }, by: 'agent' }) + '\\n');
process.exit(r.status ?? 1);
`;

/** The kickoff, as the old live eval gives it (eval/episode.mjs kickoffText), in the new client's words. */
export const kickoffText = (name) => `Your Soul ${name} lives in this folder; it is already set up and joined. Your guide is skill.md in this folder: read it.`;
/** An owner's message as `listen --follow` prints it, handed over as a finished background task's output. */
export const messageText = (m) => `[background task] node eden.mjs listen --follow printed:\n${JSON.stringify({ kind: 'owner-message', id: m.id, text: m.text })}`;

/** The commands that write: to the world (an act, words, a touch, a give, a calendar entry) or to the owner (`ack`). */
const WRITES = new Set(['act', 'say', 'shout', 'whisper', 'converse', 'together', 'give', 'set-down', 'stop', 'pray', 'now', 'ack']);
export function isIntent(words) {
  const [w0, w1] = words;
  if (WRITES.has(w0)) return !(w0 === 'converse' && ['list'].includes(w1));
  if (w0 === 'calendar') return ['add', 'interest', 'not-coming'].includes(w1);
  return false;
}
/** How one intent ended: `done` (the world's end), `sent` (taken, not waited for), or `refused` with its cause. */
export function outcomeOf(answer) {
  // a reply a client said it sent to a message already closed never reached the owner (0.133 Q1 review): refused
  if (answer?.already === true) return { end: 'refused', cause: 'mail-closed' };
  if (!answer || answer.ok === false || answer.phase === 'refused' || answer.phase === 'failed') {
    let code = answer?.code ?? answer?.receipt?.code ?? answer?.refused ?? (answer?.raw ? 'no-answer' : 'unknown');
    // the world's own word for a refusal the client passes on as `refused` (`intent.text-not-a-name: wave`)
    if (code === 'refused' && /^[a-z][\w.-]+:/.test(String(answer?.detail ?? ''))) code = String(answer.detail).split(':')[0];
    return { end: 'refused', cause: String(code) };
  }
  if (answer.phase === 'done') return { end: 'done', cause: null };
  return { end: 'sent', cause: null };
}
/** [{at, words, end, cause}] for a command log's world intents. */
export const intentsOf = (commands) => commands.filter((c) => isIntent(c.words ?? [])).map((c) => ({ at: c.at, words: c.words, ...outcomeOf(c.answer) }));

/** A command log from a turn's stream (the served client, run by the agent itself): each `node eden.mjs …` Bash call and
 *  the last JSON line of its output. Compound lines count each `node eden.mjs` part only when it is the whole call. */
export function commandsFromStream(toolCalls) {
  const out = [];
  for (const c of toolCalls) {
    if (c.name !== 'Bash') continue;
    const m = /^\s*(?:cd [^&;]+&&\s*)?node\s+(?:\S*\/)?eden\.mjs\s+(.*)$/s.exec(String(c.cmd ?? ''));
    if (!m) continue;
    out.push({ at: null, words: splitWords(m[1]), answer: c.isError && !lastJson(c.result) ? { ok: false, code: 'shell-error', raw: String(c.result).slice(0, 300) } : lastJson(c.result) ?? { ok: false, raw: String(c.result ?? '').slice(0, 300) } });
  }
  return out;
}
/** Shell words, quotes removed (enough for the client's arguments). */
export function splitWords(s) {
  const out = []; let cur = '', q = null, any = false;
  for (const ch of String(s).replace(/\s+2>&1\s*$/, '')) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    if ('|;&>'.includes(ch)) break;
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

/** Refusals per 1,000 intents, by cause: {intents, refused, per1000, causes: [{cause, n, per1000}]}. */
export function refusalRate(intents) {
  const n = intents.length, causes = new Map();
  for (const i of intents) if (i.end === 'refused') causes.set(i.cause, (causes.get(i.cause) ?? 0) + 1);
  const r = (k) => (n ? Math.round((k / n) * 10000) / 10 : null);
  const refused = [...causes.values()].reduce((a, b) => a + b, 0);
  return { intents: n, refused, per1000: r(refused), causes: [...causes].sort((a, b) => b[1] - a[1]).map(([cause, k]) => ({ cause, n: k, per1000: r(k) })) };
}

/** A live battery seat: the interface battery.mjs's episode uses (onboard, deliver, commands, skipped, cli, stop). */
export async function liveSeat({ world, dir, label = 'wren', name = 'Wren', model = 'sonnet', effort = null, maxWallSec = 300, log = () => {} }) {
  const seatDir = join(dir, 'seats', label);
  mkdirSync(seatDir, { recursive: true });
  let v2 = null, sessionId = randomUUID(), turns = 0;
  const transcript = join(seatDir, 'turns.jsonl'), skipped = [], usage = { turns: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, wallMs: 0, denied: 0 };
  const note = (rec) => appendFileSync(transcript, JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n');
  let running = null;
  const self = {
    info: { id: label, soulName: name, adapter: 'claude-headless', model }, dir: seatDir, skipped, usage,
    commands: () => join(seatDir, 'commands.jsonl'),
    cli: (...words) => v2.cli(...words),
    async onboard() {
      v2 = await pairSeat({ world, dir: join(dir, 'seats'), label, owner: label, name });
      const j = await v2.join();
      const folder = v2.folder;
      writeFileSync(join(folder, 'eden.mjs'), wrapperSource({ log: self.commands() }));
      copyFileSync(SKILL, join(folder, 'skill.md'));
      self.folder = folder;
      note({ onboard: true, soul: v2.soul, body: j.body });
      return { ok: !!j.body, soulId: v2.soul, soulName: name, body: j.body };
    },
    /** One owner message: one turn (the kickoff first, in the same prompt, on the session's first turn). */
    deliver(m) {
      const text = (turns === 0 ? `${kickoffText(name)}\n\n` : '') + messageText(m);
      const resume = turns++ > 0;
      running = turn({ cwd: self.folder, sessionId, resume, model, effort, text, allowedTools: LIVE_ALLOWED, maxWallSec, ctxMax: 0 }).then((r) => {
        sessionId = r.sessionId ?? sessionId;
        usage.turns++; usage.costUsd = r.usage?.costUsd ?? usage.costUsd; usage.wallMs += r.wallMs ?? 0;
        usage.tokensIn += (r.usage?.inputTokens ?? 0) + (r.usage?.cachedTokens ?? 0) + (r.usage?.cacheCreationTokens ?? 0); usage.tokensOut += r.usage?.outputTokens ?? 0;
        usage.denied += r.stream.filter((e) => e.type === 'user').flatMap((e) => e.message?.content ?? []).filter((c) => c.type === 'tool_result' && /requires approval|permission/i.test(String(c.content ?? ''))).length;
        writeFileSync(join(seatDir, `turn-${usage.turns}.jsonl`), r.stream.map((e) => JSON.stringify(e)).join('\n') + '\n');
        note({ turn: usage.turns, message: m.id, wallMs: r.wallMs, exit: r.exit, timedOut: r.timedOut, final: String(r.finalText ?? '').slice(0, 600), tools: r.toolCalls.map((c) => c.cmd ?? c.name) });
        log(`${label}: turn ${usage.turns} ended in ${Math.round((r.wallMs ?? 0) / 1000)} s (${r.toolCalls.length} tools)`);
        return r;
      }).catch((e) => { note({ turn: turns, error: e.message }); return null; });
      return running;
    },
    wakeLoop() {},
    settle: () => running ?? Promise.resolve(null),
    async stop() { await running?.catch?.(() => {}); await v2?.stop(); },
  };
  return self;
}

export const readJsonl = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
