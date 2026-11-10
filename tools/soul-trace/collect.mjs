#!/usr/bin/env node
// collect.mjs (#1773): gather one Soul session into a folder another agent can read. It takes the client's full record
// (.eden-record/, switched on by .eden-record-on), the serve log, the agent harness's own session transcripts for that
// folder and time (the agent's reasoning, its tool calls, the owner's chat), the end state of every receipt and owner
// message the record names, the versions in use and a manifest. Each file is copied as it is, with one change: any token
// this home or folder holds is replaced wherever it appears, and the manifest counts each replacement.
//
//   node tools/soul-trace/collect.mjs <folder> --out <dir> [--soul <name|id>] [--since <time>] [--until <time>]
//        [--transcript <file>]... [--claude-dir <dir>]... [--no-fetch]
//
// <folder> is the folder the agent ran in: a Soul's folder (.eden-agent.json) or a Souls home's folder (.souls/).
// A bundle is PRIVATE: it holds chat text, reasoning and local paths. It is written only to --out and sent nowhere.
//
// Transcripts: only a Claude Code transcript recorded with a working directory exactly equal to <folder>, and only one
// within the session's window, is taken by itself. collect opens only that folder's own project directory under each
// harness config (CLAUDE_CONFIG_DIR, ~/.claude or --claude-dir) and never lists or reads any other project's. Codex keeps
// sessions by date, not by folder, so a Codex transcript (or any other) is taken only when named with --transcript, and
// only if its recorded working directory is <folder>.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLE_SCHEMA = 'soul-session-bundle/1';
const WINDOW_BEFORE_MS = 30 * 60_000, WINDOW_AFTER_MS = 10 * 60_000, MAX_FETCH = 400;

const usage = 'usage: node tools/soul-trace/collect.mjs <folder> --out <dir> [--soul <name|id>] [--since <time>] [--until <time>] [--transcript <file>]... [--claude-dir <dir>]... [--no-fetch]';
export function parseArgs(argv) {
  const o = { transcripts: [], claudeDirs: [], fetch: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${a} needs a value\n${usage}`); return x; };
    if (a === '--out') o.out = v(); else if (a === '--soul') o.soul = v(); else if (a === '--since') o.since = when(v()); else if (a === '--until') o.until = when(v());
    else if (a === '--transcript') o.transcripts.push(v()); else if (a === '--claude-dir') o.claudeDirs.push(v()); else if (a === '--no-fetch') o.fetch = false;
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}\n${usage}`); else if (o.folder) throw new Error(`one folder only\n${usage}`); else o.folder = a;
  }
  if (!o.folder) throw new Error(usage);
  if (!o.out) throw new Error(`Say where the bundle goes: --out <dir>. It holds chat text and reasoning, so it is written only where you say.\n${usage}`);
  return o;
}
function when(v) { const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v); if (!Number.isFinite(n)) throw new Error(`not a time: ${v}`); return n; }
const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** The Soul being collected: where its record is, its state (world, token) and every secret to keep out. */
export function locate(folder, soulSel) {
  const root = realpathSync(resolve(folder));
  if (existsSync(join(root, '.eden-agent.json')) && !existsSync(join(root, '.souls'))) {
    const s = readJson(join(root, '.eden-agent.json'), {});
    return { root, kind: 'folder', runtime: root, world: s.world, soul: s.soul, token: s.token, secrets: secretsOf(s) };
  }
  const home = join(root, '.souls');
  if (!existsSync(join(home, 'config.json'))) throw new Error(`${folder} is neither a Soul's folder (.eden-agent.json) nor a Souls home (.souls/)`);
  const cfg = readJson(join(home, 'config.json'), {}), creds = readJson(join(home, 'credentials.json'), {});
  const ids = Object.keys(cfg.souls ?? {}).filter((id) => existsSync(join(home, 'souls', id, 'runtime')));
  const recording = ids.filter((id) => existsSync(join(home, 'souls', id, 'runtime', '.eden-record')));
  const norm = (x) => String(x ?? '').toLowerCase();
  const id = soulSel ? ids.find((x) => x === soulSel || norm(cfg.souls[x]?.name) === norm(soulSel)) : recording.length === 1 ? recording[0] : null;
  if (!id) throw new Error(soulSel ? `no Soul ${soulSel} in this home` : `${recording.length} Souls in this home have a record; say which: --soul <name>`);
  const runtime = join(home, 'souls', id, 'runtime'), s = readJson(join(runtime, 'state.json'), {});
  const worldKey = Object.keys(cfg.worlds ?? {}).find((k) => cfg.worlds[k].url === s.world);
  return { root, kind: 'home', runtime, world: s.world, soul: s.soul ?? id, name: cfg.souls[id]?.name, token: creds.souls?.[id]?.[worldKey]?.token, secrets: secretsOf(creds) };
}
/** Every credential-shaped string in a state or credentials file, longest first. */
function secretsOf(o, out = new Set()) {
  if (typeof o === 'string') { if (o.length >= 8) out.add(o); return out; }
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (typeof v !== 'string' || /token|secret|identity|key|password/i.test(k)) secretsOf(v, out);
  return out;
}
export function scrubText(text, secrets) {
  let n = 0;
  for (const t of [...secrets].sort((a, b) => b.length - a.length)) { const parts = text.split(t); if (parts.length > 1) { n += parts.length - 1; text = parts.join('[omitted]'); } }
  return { text, n };
}

const lines = (text) => text.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const recordFiles = (dir) => existsSync(dir) ? readdirSync(dir).filter((f) => /^record(-\d+-[0-9a-f]+)?\.jsonl$/.test(f)).sort((a, b) => (a === 'record.jsonl') - (b === 'record.jsonl') || Number(a.split('-')[1]) - Number(b.split('-')[1])) : [];

/** Claude Code names a project's folder after its working directory with every other character a dash. */
export const claudeProject = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');
const stampOf = (row) => { const t = Date.parse(row?.timestamp ?? row?.ts ?? ''); return Number.isFinite(t) ? t : null; };
/** A transcript's recorded working directory (Claude Code: `cwd` on its entries; Codex: session_meta's payload.cwd) and time span. */
export function transcriptFacts(text) {
  let cwd = null, first = null, last = null, harness = null;
  for (const row of lines(text)) {
    const c = row.cwd ?? (row.type === 'session_meta' ? row.payload?.cwd : null);
    if (c && !cwd) { cwd = c; harness = row.type === 'session_meta' ? 'codex' : 'claude-code'; }
    const t = stampOf(row); if (t !== null) { first ??= t; last = t; }
  }
  return { cwd, first, last, harness };
}
/** The working directory a transcript was recorded in, read from its first lines only (at most 256 KB). */
export function transcriptCwd(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024), n = readSync(fd, buf, 0, buf.length, 0), head = buf.subarray(0, n).toString('utf8');
    for (const line of head.split('\n')) { let row; try { row = JSON.parse(line); } catch { continue; } const c = row.cwd ?? (row.type === 'session_meta' ? row.payload?.cwd : null); if (c) return c; }
    return null;
  } finally { closeSync(fd); }
}
export function findTranscripts({ cwd, since, until, claudeDirs, named }) {
  const found = [], skipped = [], searched = [];
  const take = (file, origin) => {
    // another folder's transcript (another project whose folder name reads the same) is not read past the line that
    // says where it was recorded, and is left unnamed
    if (transcriptCwd(file) !== cwd) { if (origin === 'named') skipped.push({ file, why: 'its recorded working directory is not the collected folder' }); return false; }
    const text = readFileSync(file, 'utf8'), f = transcriptFacts(text);
    if (f.last === null || f.last < since || f.first > until) { if (origin === 'named') skipped.push({ file, why: 'nothing in it falls within the session\'s window (--since/--until widen it)' }); return false; }
    found.push({ file, origin, ...f });
    return true;
  };
  for (const file of named) { if (existsSync(resolve(file))) take(resolve(file), 'named'); else skipped.push({ file, why: 'no such file (give the path to the harness\'s session .jsonl)' }); }
  for (const dir of claudeDirs) {
    const project = join(dir, 'projects', claudeProject(cwd));
    searched.push(project);
    if (!existsSync(project)) continue;
    for (const f of readdirSync(project)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = join(project, f);
      if (statSync(file).mtimeMs < since) continue;   // last written before the session began
      // a matched session's subagent transcripts sit in a folder named after it, each checked the same way
      const sub = join(project, f.replace(/\.jsonl$/, ''), 'subagents');
      if (take(file, 'claude-code') && existsSync(sub)) for (const s of readdirSync(sub)) if (s.endsWith('.jsonl')) take(join(sub, s), 'claude-code subagent');
    }
  }
  return { found, skipped, searched };
}

async function fetchJson(url, token, timeoutMs = 15_000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 2000) }; }
    return { status: r.status, ms: Date.now() - t0, body };
  } catch (e) { return { status: 0, ms: Date.now() - t0, error: String(e?.message ?? e) }; }
}

const README = (m) => `# A recorded Soul session (private)

This folder holds one Soul session as separate records, each copied untouched apart from any token, which is replaced
with \`[omitted]\`. It is **private**: it holds the owner's chat, the agent's reasoning and local paths. Do not attach
it, or anything quoted from it, to an issue, a pull request or a proof. Write findings in your own words.
A transcript may also hold single-use pairing or window codes the owner typed; they are not replaced. When the folder is
a Souls home, its transcripts cover every Soul the agent drove there in the window, not only this one.

Soul: ${m.soul.name ?? m.soul.id} in world ${m.soul.world ?? 'unknown'}, collected from the folder the agent ran in
(\`folder\` in the manifest) at ${m.collectedAt}. Window searched for transcripts: ${new Date(m.window.since).toISOString()}
to ${new Date(m.window.until).toISOString()}${m.window.padded ? ' (the record\'s first and last entries, widened by 30 minutes before and 10 after)' : ' (as given)'}.

## Files

${m.files.map((f) => `- \`${f.path}\`: ${f.what} Clock: ${f.clock}.`).join('\n')}

## How they join

${m.joins.map((j) => `- ${j}`).join('\n')}

## Reading the client record (\`client/record*.jsonl\`, schema soul-trace/2)

One JSON object per line. \`proc\` names a process (a CLI command, or the long-lived \`serve\`); \`seq\` orders its
records. Kinds:
- \`proc.start\`: \`command\`, \`argv\` (left out, with \`quiet: true\`, for commands that handle codes or tokens).
- \`proc.end\`: \`exitCode\`, \`wallStart\` (when the command began), \`ms\` (how long it ran), and what it printed:
  \`stdout\`, \`stderr\` (a value cut at 64 KB is \`{cut, bytes, head}\`).
- \`http\`: a call a command made, as the command saw it: \`method\`, \`path\` (with query), \`req\` (body sent), \`status\`,
  \`res\` (answer), \`ms\` (client time, including a hop through serve when \`via\` is \`serve\`), \`server.world\` and
  \`server.queue\` (the world's own time, from Server-Timing), \`load\`, \`retryAfterMs\`, \`key\` (idempotency key) and
  \`ids\` (\`receipts\`, \`messages\`, \`clientRef\`).
- \`wire\`: a call a process made itself. In \`serve\`: the owner's inbox (\`/v1/edge/inbox/listen\`), the stream
  (\`/v1/edge/wait\`), receipt polls, plan steps and reflexes. With \`proxied: true\` it is the wire time of a command's
  call that serve carried (its content is on the command's \`http\` record). Catalog, live picture and the classified
  stream keep only time and status.
- \`wait\`: the client waited before trying again (\`why\`: the world's code, or \`unanswered\`; \`waitMs\`).
- \`limit\`: the record dropped its oldest files to stay under its cap.

A refusal is an \`http\` record with \`res.accepted: false\` (or a 4xx status) and \`res.code\`/\`res.reason\`; an
\`alternatives\` list is what the world offered instead. A slow call is one with a large \`ms\`: compare it with
\`server.world\` to see whether the time was spent in the world or on the way.

## Reading the transcripts (\`transcripts/\`)

${m.transcripts.found.length ? 'The agent harness\'s own session files, one JSON object per line. In Claude Code\'s: `type: "user"` entries whose `message.content` is text are what the owner typed in chat; `type: "assistant"` entries hold the agent\'s reasoning (`thinking`), its words (`text`) and its tool calls (`tool_use`, with the shell command in `input.command`); the following `user` entry with `tool_result` holds what the command printed. Every entry has an ISO `timestamp`. In Codex\'s: `response_item` payloads of type `message` (role `user` or `assistant`), `reasoning` and `function_call`/`function_call_output`.' : '**No transcript was found**, so this bundle has no reasoning and none of the owner\'s chat. ' + m.transcripts.note}

## End states (\`world/end-states.json\`)

Each receipt and owner message the record names, fetched once at collection time: \`receipts[id]\` is the world's
answer to \`GET /v1/edge/receipts/<id>\` and \`messages[id]\` to \`GET /v1/edge/inbox/<id>\`.
`;

export async function collect(o) {
  const at = locate(o.folder, o.soul), out = resolve(o.out), cwd = at.root;
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${o.out} is not empty; name a new folder`);
  const recDir = join(at.runtime, '.eden-record'), files = recordFiles(recDir);
  if (!files.length) throw new Error(`No session record in ${at.kind === 'home' ? 'this Soul\'s runtime folder' : o.folder}. Put an empty file named .eden-record-on in ${at.kind === 'home' ? 'the home\'s .souls/ folder or the Soul\'s runtime folder' : 'the Soul\'s folder'} before the session.`);
  const rows = files.flatMap((f) => lines(readFileSync(join(recDir, f), 'utf8')));
  const span = (list) => list.reduce(([lo, hi], r) => (Number.isFinite(r.at) ? [Math.min(lo, r.at), Math.max(hi, r.at)] : [lo, hi]), [Infinity, -Infinity]);
  const [first, last] = span(rows);
  const since = o.since ?? first - WINDOW_BEFORE_MS, until = o.until ?? last + WINDOW_AFTER_MS;
  mkdirSync(out, { recursive: true, mode: 0o700 });
  for (const d of ['client', 'transcripts', 'world']) mkdirSync(join(out, d), { mode: 0o700 });
  writeFileSync(join(out, '.gitignore'), '*\n');
  const manifestFiles = [], secrets = at.secrets;
  const keep = (rel, src, what, clock, extra = {}) => {
    const { text, n } = scrubText(readFileSync(src, 'utf8'), secrets);
    writeFileSync(join(out, rel), text, { mode: 0o600 });
    manifestFiles.push({ path: rel, what, clock, bytes: Buffer.byteLength(text), sha256: sha(text), ...(n ? { secretsReplaced: n } : {}), ...extra });
  };
  const write = (rel, value, what, clock) => {
    const { text, n } = scrubText(typeof value === 'string' ? value : JSON.stringify(value, null, 1) + '\n', secrets);
    writeFileSync(join(out, rel), text, { mode: 0o600 });
    manifestFiles.push({ path: rel, what, clock, bytes: Buffer.byteLength(text), sha256: sha(text), ...(n ? { secretsReplaced: n } : {}) });
  };
  // the record files that reach into the window, whole
  for (const f of files) {
    const [lo, hi] = span(lines(readFileSync(join(recDir, f), 'utf8')));
    if (Number.isFinite(lo) && (hi < since || lo > until)) continue;
    keep(`client/${f}`, join(recDir, f), 'The client\'s full record (soul-trace/2): commands, their output, world calls with request and answer, serve\'s own calls, waits.', '`at` and `wallStart` local wall ms; `mono` ms since the process began; `sentAt` world wall ms; ticks world ticks');
  }
  if (existsSync(join(at.runtime, '.eden-serve.log'))) keep('client/serve.log', join(at.runtime, '.eden-serve.log'), 'The serve process\'s own log: one line per thing it noticed or did, each with an ISO time.', 'ISO local wall time at the start of each line');
  if (existsSync(join(at.runtime, '.eden-report.jsonl'))) keep('client/report.jsonl', join(at.runtime, '.eden-report.jsonl'), 'The lighter experience report (soul-trace/1), when that switch was on too; `note` records are the agent\'s own.', 'as the client record');
  // transcripts
  const claudeDirs = [...o.claudeDirs, ...(o.claudeDirs.length ? [] : [process.env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude')].filter(Boolean))];
  const t = findTranscripts({ cwd, since, until, claudeDirs: [...new Set(claudeDirs.map((d) => resolve(d)))], named: o.transcripts });
  t.found.forEach((x, i) => keep(`transcripts/${String(i + 1).padStart(2, '0')}-${x.harness ?? 'harness'}-${basename(x.file)}`, x.file, `The agent harness's own session transcript (${x.origin}): the owner's chat, the agent's reasoning and tool calls, and what each command printed.`, 'ISO `timestamp` on each entry (local wall time, UTC)', { from: x.origin, first: x.first && new Date(x.first).toISOString(), last: x.last && new Date(x.last).toISOString() }));
  const tNote = t.found.length ? '' : `No transcript recorded in ${cwd} between ${new Date(since).toISOString()} and ${new Date(until).toISOString()} was found${t.searched.length ? ' in the Claude Code project folder for it' : ''}. If the agent ran in this folder under another harness (Codex keeps sessions by date) or another config folder, name its file: --transcript <file>${t.searched.length ? '' : ', or --claude-dir <dir>'}.`;
  if (tNote) process.stderr.write(tNote + '\n');
  for (const s of t.skipped) process.stderr.write(`not taken: ${s.file}: ${s.why}\n`);
  // end states, versions
  const receipts = new Set(), messages = new Set(), versions = new Set();
  for (const r of rows) {
    for (const id of r.ids?.receipts ?? []) receipts.add(id);
    for (const id of r.ids?.messages ?? []) messages.add(id);
    if (r.kind === 'proc.start' && r.version) versions.add(r.version);
  }
  const ends = { fetchedAt: new Date().toISOString(), receipts: {}, messages: {} };
  let config = null;
  if (o.fetch && at.world) {
    config = await fetchJson(`${at.world}/v1/config`, null);
    for (const id of [...receipts].slice(0, MAX_FETCH)) ends.receipts[id] = await fetchJson(`${at.world}/v1/edge/receipts/${encodeURIComponent(id)}`, at.token);
    for (const id of [...messages].slice(0, MAX_FETCH)) ends.messages[id] = await fetchJson(`${at.world}/v1/edge/inbox/${encodeURIComponent(id)}`, at.token);
    if (receipts.size > MAX_FETCH || messages.size > MAX_FETCH) ends.note = `only the first ${MAX_FETCH} of each were fetched`;
  } else ends.note = o.fetch ? 'no world in this folder' : 'not fetched (--no-fetch)';
  write('world/end-states.json', ends, 'The end state of every receipt and owner message named in the client record, fetched once when collected.', '`fetchedAt` local wall time; world times inside are world wall ms and ticks');
  if (config) write('world/config.json', config, 'The world\'s /v1/config at collection time: its build and the client it serves.', 'collection time');
  const catalog = readJson(join(at.runtime, 'world-catalog.json'));
  // the skill as the agent found it: a project skill, or the served file beside the client
  const skillFiles = [...[join(cwd, '.claude', 'skills'), join(cwd, '.agents', 'skills')].flatMap((d) => existsSync(d) ? readdirSync(d).map((s) => join(d, s, 'SKILL.md')) : []), join(cwd, 'skill.md'), join(cwd, 'SKILL.md')];
  const inodes = new Set(), skills = skillFiles.filter((f) => { if (!existsSync(f)) return false; const k = `${statSync(f).dev}:${statSync(f).ino}`; return !inodes.has(k) && inodes.add(k); }).map((f) => { const b = readFileSync(f); return { path: f.slice(cwd.length + 1), sha256: sha(b), version: /version[:\s"]+([0-9]+\.[0-9]+\.[0-9]+)/i.exec(b.toString('utf8'))?.[1] ?? null }; });
  const clientFile = [join(cwd, 'eden.mjs'), join(cwd, '.souls', 'bin', 'eden.mjs')].find((f) => existsSync(f));
  const versionsOut = {
    client: { recorded: [...versions], file: clientFile ? { path: clientFile.slice(cwd.length + 1), sha256: sha(readFileSync(clientFile)), version: /^const VERSION = "([0-9.]+)";$/m.exec(readFileSync(clientFile, 'utf8'))?.[1] ?? null } : null },
    skill: skills, catalog: catalog ? { etag: catalog.etag ?? null, fetchedAt: catalog.fetchedAt ?? null, contract: catalog.catalog?.contract ?? null, worldId: catalog.catalog?.worldId ?? null, version: catalog.catalog?.version ?? null } : null,
    world: config?.body ? { build: config.body.build ?? config.body.version ?? config.body.release ?? null, soulClient: config.body.soulClient ? { version: config.body.soulClient.version, sha256: config.body.soulClient.sha256 } : null } : null,
  };
  write('versions.json', versionsOut, 'Versions in use: the client (as recorded and as on disk), the skill files, the local catalog copy, the world\'s build.', 'collection time');
  const manifest = {
    schema: BUNDLE_SCHEMA, private: true,
    privateNote: 'Holds the owner\'s chat, the agent\'s reasoning and local paths. Never attach it, or text quoted from it, to an issue, a pull request or a proof.',
    collectedAt: new Date().toISOString(), folder: cwd, soul: { id: at.soul, name: at.name ?? null, world: at.world ?? null },
    window: { padded: o.since === undefined && o.until === undefined, since, until, sinceIso: new Date(since).toISOString(), untilIso: new Date(until).toISOString() },
    files: manifestFiles,
    joins: [
      'By time: every file carries local wall time (client record `at`/`wallStart` in ms; serve log and transcripts as ISO). They share one machine clock.',
      'A command in a transcript (a tool call running `node eden.mjs …`) is the client record\'s `proc.start` with the same `command` and `argv`, a few ms after the tool call\'s timestamp; its `proc.end.stdout` is what the tool result shows.',
      'An owner message: its id is in `ids.messages` on the inbox calls that delivered it (`/v1/edge/inbox/listen`), on `ack`/`result` paths, and in `act --for <id>` (argv and `req.for`); its text is in the transcript where the agent read it, and its end state in world/end-states.json `messages`.',
      'A receipt: `ids.receipts` on the act that started it and on the stream (`/v1/edge/wait`) and receipt polls that followed it; its end in world/end-states.json `receipts`.',
      'An idempotency key (`key`) is the same on every try and rerun of one write; a plan step\'s key is its `clientRef`.',
    ],
    transcripts: { found: t.found.map((x) => ({ harness: x.harness, from: x.origin, first: x.first && new Date(x.first).toISOString(), last: x.last && new Date(x.last).toISOString() })), searched: t.searched.length, note: tNote || null },
    secrets: { replaced: manifestFiles.reduce((n, f) => n + (f.secretsReplaced ?? 0), 0), how: 'every token and credential this folder or home holds, replaced by [omitted] wherever it appeared' },
  };
  write('README.md', README(manifest), 'How to read this bundle, for an analysing agent.', 'none');
  manifest.files = manifestFiles;
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n', { mode: 0o600 });
  return { out, files: manifestFiles.length + 1, records: rows.length, transcripts: t.found.length, receipts: receipts.size, messages: messages.size, secretsReplaced: manifest.secrets.replaced, private: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await collect(parseArgs(process.argv.slice(2))), null, 1) + '\n'); }
  catch (e) { process.stderr.write(`error: ${e.message}\n`); process.exit(1); }
}
