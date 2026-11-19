// `stats` (Engine v2 R10, #2702): what each achieved intent cost the agent, from the local trace (`trace.mjs`).
// An achieved intent is an act that ended completed; its cost is everything since the one before: the commands run,
// the bytes they printed into the model's context, and how its first send was answered, by cause. R11 is scored from
// these numbers.
//
// Model turns and tokens are the harness's, never guessed from gaps between commands. They are read from the
// harness's transcript only when the owner opts in, by naming it in the home's config.json:
//   { "stats": { "transcript": "<a transcript .jsonl, or the folder of them; the newest is read>" } }
// The transcript is read as Claude Code writes it (assistant lines with `message.id`, `message.usage` and a
// `timestamp`), the way tools/playtest/eval/measure.mjs `seatStats` reads an eval seat's. Without it, tokens are the
// printed bytes divided by 4, marked `estimate: true`, and turns are not given. Nothing here touches the network.
//
//   node v2/client/src/stats/stats.mjs --home <.souls> --soul <id>      the same answer, without the daemon

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeOf } from '../home/home.mjs';
import { openTrace, SCHEMA } from './trace.mjs';

export const CAUSES = ['accepted-first', 'accepted-rank-unstated', 'stopped-locally', 'refused-stale', 'refused-never', 'refused-load', 'expired'];
const SHOWN = 10;

/** The owner's opted-in transcript lines, or null: config.json's `stats.transcript`, a file or the newest in a folder. */
export function transcriptOf(home) {
  let named;
  try { named = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).stats?.transcript; } catch { return null; }
  if (typeof named !== 'string' || !named) return null;
  let file = resolve(home, named);
  try {
    if (statSync(file).isDirectory()) {
      const newest = readdirSync(file).filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f: join(file, f), m: statSync(join(file, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
      if (!newest) return null;
      file = newest.f;
    }
    if (!existsSync(file)) return null;
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { return null; }
}

/** Model turns and tokens in the transcript between wall times `from` (exclusive) and `to` (inclusive). */
function harness(transcript, from, to) {
  const seen = new Set();
  let tokensIn = 0, tokensOut = 0;
  for (const e of transcript) {
    const t = Date.parse(e.timestamp);
    if (e.type !== 'assistant' || !(t > from && t <= to) || !e.message?.usage) continue;
    const id = e.message.id ?? `${t}:${seen.size}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const u = e.message.usage;
    tokensIn += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    tokensOut += u.output_tokens ?? 0;
  }
  return { turns: seen.size, tokens: { in: tokensIn, out: tokensOut } };
}

/** The `stats` answer from trace `records` and, if the owner opted in, the harness's `transcript` lines. */
export function stats(records, { transcript = null } = {}) {
  const intents = [], first = new Map(), ranked = new Map();
  let since = { t: -Infinity, commands: 0, bytes: 0, sends: [] };
  for (const r of records) {
    if (r.k === 'cmd') { since.commands++; since.bytes += r.bytes ?? 0; }
    if (r.k === 'send') { since.sends.push(r.seq); ranked.set(r.seq, r.ranked ?? 1); if (r.cause) first.set(r.seq, r.cause); }
    if (r.k === 'answer' && !first.has(r.seq)) first.set(r.seq, r.cause);
    if (r.k === 'answer' && r.achieved) {
      const one = { commands: since.commands, bytes: since.bytes, sends: since.sends.length, firstSend: since.sends.length ? since.sends[0] : r.seq, from: since.t, to: r.t };
      intents.push(one);
      since = { t: r.t, commands: 0, bytes: 0, sends: [] };
    }
  }
  const byCause = Object.fromEntries(CAUSES.map((c) => [c, 0]));
  for (const one of intents) {
    one.firstSend = first.get(one.firstSend) ?? 'unanswered';
    byCause[one.firstSend] = (byCause[one.firstSend] ?? 0) + 1;
    if (transcript) Object.assign(one, harness(transcript, one.from, one.to));
    else one.tokens = { in: Math.round(one.bytes / 4), estimate: true };
    delete one.from; delete one.to;
  }
  const n = intents.length, sum = (k) => intents.reduce((s, x) => s + x[k], 0);
  const mean = (v) => (n ? Math.round((v / n) * 10) / 10 : null);
  return {
    ok: true,
    schema: SCHEMA,
    achieved: n,
    perIntent: { commands: mean(sum('commands')), bytes: mean(sum('bytes')),
      ...(transcript ? { turns: mean(sum('turns')), tokensIn: mean(intents.reduce((s, x) => s + x.tokens.in, 0)) }
        : { tokensIn: mean(intents.reduce((s, x) => s + x.tokens.in, 0)), estimate: true }) },
    firstSend: byCause,
    harness: transcript ? 'transcript (opted in)' : 'not opted in: turns not given, tokens estimated as bytes / 4',
    last: intents.slice(-SHOWN),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n) => { const k = process.argv.indexOf(n); return k > 0 ? process.argv[k + 1] : undefined; };
  const home = arg('--home'), soul = arg('--soul');
  process.stdout.write(JSON.stringify(stats(openTrace(runtimeOf(home, soul).dir).read(), { transcript: transcriptOf(home) })) + '\n');
}
