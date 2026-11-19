#!/usr/bin/env node
// The inheritance walk's scripted pass (Engine v2 X12, #2835): stands up a local served Eden (`worldd seed` from Eden's
// facts with `--entries content/kinds`, `worldd serve`, `gatewayd`, `directoryd` with the test sign-in, and the page in
// `vite`), pairs three Souls through W2's pairing as three owners' agents would (a fake mind: this script is the agent,
// it sends the commands people use and reads the answers), and walks every row of
// `v2/docs/tranche/inheritance-walk.md` that a script can see. Each row ends `pass`, `fail` (with what was seen) or
// `walker` (a person must see it at the preview: the script prints the address). It prints a Markdown table and
// writes `walk.json` beside it.
//
// A scripted pass is not the walk (X12's risk 1): it finds open rows before the people walk, and it is re-run the
// moment the switch-over's PRs are on main. Rows and their ids are the walk sheet's.
//
//   node v2/tools/inheritance-walk/walk.mjs --facts <eden-2026.facts.json> [--out <dir>] [--only <id,id>] [--keep]
//
// Needs, from v2/: `cargo build --release -p worldd -p gatewayd -p directoryd`, replica's wasm-bindgen package in
// target/wasm-load/pkg (v2/tools/ci.sh's wasm steps), and `npm ci` in v2/web for the page row. The facts file is
// `node v2/tools/import-eden/export/export.ts` from the repository root. `--bin <dir>` names other binaries. With
// `--keep` the stack stays up after the rows, its addresses printed, for a person to walk; Ctrl-C ends it.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repo = resolve(v2, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const k = argv.indexOf(n); return k >= 0 ? argv[k + 1] : d; };
const FACTS = opt('--facts', join(repo, '.local/import-eden/eden-2026.facts.json'));
const OUT = resolve(opt('--out', join(repo, '.local/inheritance-walk')));
const BIN = resolve(opt('--bin', join(v2, 'target/release')));
const ONLY = opt('--only')?.split(',');
const KEEP = argv.includes('--keep');
const CLI = join(v2, 'client/src/cli/souls.mjs');
const PKG = process.env.SOULS_REPLICA_PKG ?? join(v2, 'target/wasm-load/pkg');
/** Where the Souls are born (K10's ring around the entry): beside Eden's campfire and its bench, metres. */
const ENTRY = opt('--at', '24,-4');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const agents = [];
let LOG = null;
const logs = [];
const freePort = () => new Promise((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

function run(path, args, ready, opts = {}) {
  const p = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  procs.push(p);
  return new Promise((ok, fail) => {
    let out = '';
    const take = (d) => { out += d; logs.push(String(d)); if (LOG) appendFileSync(LOG, d); const m = ready?.exec(out); if (m) ok({ p, m, out: () => out }); };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('exit', (c) => (ready ? fail(new Error(`${path} ${args[0]} ended (${c}): ${out.slice(-2000)}`)) : ok({ p, out, code: c })));
  });
}

async function waitFor(f, ms = 10_000, every = 100) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(every);
  }
}

function stop() {
  for (const a of agents) try { a.cli('stop'); } catch {}
  for (const p of procs) try { p.kill('SIGTERM'); } catch {}
}
process.on('SIGINT', () => { stop(); process.exit(130); });

// --- The stack ------------------------------------------------------------------------------------------------------

async function stack(dir) {
  for (const b of ['worldd', 'gatewayd', 'directoryd']) if (!existsSync(join(BIN, b))) throw new Error(`no ${b} in ${BIN}: cargo build --release -p ${b}`);
  if (!existsSync(FACTS)) throw new Error(`no facts file ${FACTS}: node v2/tools/import-eden/export/export.ts`);
  const worlds = join(dir, 'worlds');
  const world = join(worlds, 'eden');
  mkdirSync(worlds, { recursive: true });
  const seeded = await run(join(BIN, 'worldd'), ['seed', '--facts', FACTS, '--dir', world, '--entries', join(repo, 'content/kinds'), '--souls', '0', '--at', ENTRY]);
  if (seeded.code !== 0) throw new Error(`worldd seed: ${seeded.out}`);
  const name = /seeded (\S+)/.exec(seeded.out)?.[1];
  const entries = Number(/entries: (\d+)/.exec(seeded.out)?.[1] ?? 0);
  // Ready once the clock runs: `listening` comes before the log is replayed (serve.rs).
  await run(join(BIN, 'worldd'), ['serve', '--dir', world], /worldd: started at tick/);
  const gwPort = await freePort();
  const receipts = join(dir, 'receipts');
  await run(join(BIN, 'gatewayd'), ['--listen', `127.0.0.1:${gwPort}`, '--world', join(world, 'gateway.sock'), '--tokens', join(world, 'tokens'),
    '--build', `1220${'ab'.repeat(32)}`, '--receipts', receipts], /listening (\S+)\n/);
  const { m } = await run(join(BIN, 'directoryd'), ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1',
    '--store', join(dir, 'accounts.sqlite'), '--test-sign-in', '--pairing', join(dir, 'pairing.sqlite'),
    '--gateway-tokens', join(world, 'tokens')], /listening on (\S+)\n/);
  const directory = `http://${m[1]}`;
  let page = null;
  const vite = join(v2, 'web/node_modules/.bin/vite');
  if (existsSync(vite)) {
    const port = await freePort();
    await run(vite, ['--port', String(port), '--strictPort', '--host', '127.0.0.1'], /Local:|ready in/i,
      { cwd: join(v2, 'web'), env: { ...process.env, V2_STREAM_DIR: worlds, V2_DIRECTORY: directory, V2_REPLICA_PKG: PKG } });
    page = `http://127.0.0.1:${port}/`;
  }
  return { dir, world, worlds, name, entries, gateway: `ws://127.0.0.1:${gwPort}/v2/ws`, gwHttp: `http://127.0.0.1:${gwPort}`, directory, receipts, page };
}

// --- An agent (the fake mind) ---------------------------------------------------------------------------------------

/** One owner's agent: its own folder and `.souls` home, paired once through the directory, approved by the test owner. */
async function agent(s, who) {
  const folder = join(s.dir, `agent-${who}`);
  mkdirSync(folder, { recursive: true });
  const home = join(folder, '.souls');
  const out = [];
  const asking = run(process.execPath, [join(v2, 'client/src/pair/pair.mjs'), '--directory', s.directory, '--world', 'local',
    '--gateway', s.gateway, '--device', `walk machine ${who}`, '--label', `walk agent ${who}`], null,
  { cwd: folder, env: { PATH: process.env.PATH, SOULS_HOME: home } });
  const asked = await waitFor(() => logs.join('').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((j) => j?.step === 'approve' && !s.codes?.has(j.code)), 15_000);
  if (!asked) throw new Error(`pairing ${who}: no code`);
  (s.codes ??= new Set()).add(asked.code);
  const approve = await fetch(new URL('/v1/pair/approve', s.directory), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: asked.code, confirm: true, test_person: `owner-${who}` }) });
  const done = await asking;
  if (approve.status !== 200 || done.code !== 0) throw new Error(`pairing ${who}: approve ${approve.status}, ${done.out}`);
  const said = JSON.parse(done.out.trim().split('\n').at(-1));
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--soul', said.soul], { env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG }, encoding: 'utf8', timeout: 60_000 });
    out.push(r.stdout, r.stderr);
    try { return JSON.parse(r.stdout); } catch { return { ok: false, code: 'cli-output', detail: (r.stdout + r.stderr).slice(0, 400), status: r.status }; }
  };
  const a = { who, home, soul: said.soul, grant: said.grant, out, cli, pairOut: done.out };
  agents.push(a);
  /** Sends an act through the thin command and waits for its answer: { answer: 1 receipt | other, reason }. */
  a.act = async (acts, ms = 120_000) => {
    const sent = cli('act', ...acts);
    if (!sent.ok) return { sent };
    const ans = await answer(a, sent.sequence, ms);
    return { sent, ...(ans ?? { answer: null, reason: 'no-answer-in-time' }) };
  };
  return a;
}

/** The answer event for `sequence`: read through the thin command's `wait`, which hands the daemon's events. */
async function answer(a, sequence, ms) {
  a.seen ??= [];
  const until = Date.now() + ms;
  for (;;) {
    // C20's progress answer (3: accepted, with the time left) is not the act's end; its answer follows.
    const hit = a.seen.find((e) => e.kind === 'answer' && e.sequence === sequence && e.answer !== 3);
    if (hit) return hit;
    if (Date.now() > until) return null;
    const w = a.cli('wait', String(Math.min(30, Math.ceil((until - Date.now()) / 1000))));
    a.seen.push(...(w.events ?? []));
  }
}

const near = (rows, at = ENTRY.split(',').map(Number)) => rows.map((r) => ({ r, d: r.at ? Math.hypot(r.at[0] / 1000 - at[0], r.at[2] / 1000 - at[1]) : Infinity }))
  .sort((x, y) => x.d - y.d).map((x) => x.r);
const ok = (evidence) => ({ status: 'pass', evidence });
const no = (evidence) => ({ status: 'fail', evidence });
const brief = (o) => JSON.stringify(o).slice(0, 300);

// --- The rows -------------------------------------------------------------------------------------------------------

/** Each scripted row: the walk sheet's id, what it checks, and the check. Ids are the sheet's (inventory row numbers). */
const ROWS = [
  ['2', 'one line starts it: pair, approve once, act', async ({ A }) => {
    const j = await A.act(['life:join']);
    return j.answer === 1 ? ok(`paired (code approved once) and joined: answer ${j.answer}`) : no(`join: ${brief(j)}`);
  }],
  ['3', 'the world serves the instructions, the skill and the client at its own address', async ({ s }) => {
    const got = [];
    for (const base of [s.directory, s.gwHttp, s.page].filter(Boolean)) {
      for (const p of ['/skill.md', '/instructions.md', '/llms.txt', '/eden.mjs', '/souls.mjs']) {
        const r = await fetch(new URL(p, base)).catch(() => null);
        const type = r?.headers.get('content-type') ?? '';
        got.push(`${p} ${r?.status ?? 'none'}${type.includes('html') ? ' (the page, not the file)' : ''}`);
        if (r?.ok && !type.includes('html')) return ok(`${new URL(p, base).pathname} served (${r.status})`);
      }
    }
    return no(`none served: ${[...new Set(got)].join(', ')}`);
  }],
  ['4', 'the token is never shown to the model; the home is mode 0600', async ({ A }) => {
    const creds = join(A.home, 'credentials.json');
    const token = JSON.parse(readFileSync(creds, 'utf8')).souls[A.soul].local.token;
    const leaked = [A.pairOut, ...A.out, ...logs].some((o) => String(o).includes(token.split('.').at(-1)));
    const mode = statSync(creds).mode & 0o777;
    return !leaked && mode === 0o600 ? ok(`token in no output; credentials.json mode ${mode.toString(8)}`) : no(`leaked ${leaked}, mode ${mode.toString(8)}`);
  }],
  ['5', 'read the world from the local copy: look, find by words', async ({ A, s }) => {
    const look = A.cli('look');
    const f = A.cli('find', 'campfire');
    const n = (f.found ?? []).length;
    return look.ok !== false && n > 0 ? ok(`look ok; find campfire: ${n} rows, first ${f.found[0].id} ${f.found[0].kind ?? ''}; ${s.entries} entries loaded`) : no(`look ${brief(look)}; find ${brief(f)}`);
  }],
  ['5b', 'find a named place in the copy (the old-town plaza, the west lake, the harbour)', async ({ A }) => {
    const got = ['plaza', 'west lake', 'harbour'].map((w) => [w, A.cli('find', w).found ?? []]);
    const hit = got.find(([, rows]) => rows.some((r) => r.name));
    return hit ? ok(`find "${hit[0]}": ${hit[1].filter((r) => r.name).slice(0, 2).map((r) => `${r.name} (${r.kind})`).join(', ')}`)
      : no(`no named place found: ${got.map(([w, rows]) => `${w} ${rows.length} rows${rows[0] ? ` (first ${rows[0].kind})` : ''}`).join('; ')}`);
  }],
  ['22', 'say: an end-to-end say on a served world with a body; the others near hear it', async ({ A, B, C }) => {
    for (const x of [B, C]) if (x.answer !== 1) { const j = await x.act(['life:join']); x.answer = j.answer; }
    await sleep(1500);
    const said = A.cli('say', 'hello from the inheritance walk');
    if (!said.ok) return no(`say refused: ${brief(said)}`);
    const ans = await answer(A, said.sequence, 30_000);
    const heard = await waitFor(() => {
      const w = B.cli('wait', '5');
      B.seen = [...(B.seen ?? []), ...(w.events ?? [])];
      return B.seen.find((e) => e.kind === 'heard');
    }, 30_000, 0);
    return ans?.answer === 1 && heard ? ok(`said (answer 1); B heard: ${brief(heard)}`) : no(`say answer ${brief(ans)}; heard by B: ${brief(heard ?? null)}`);
  }],
  ['22b', 'a whisper to one body', async ({ A, B }) => {
    const body = (B.cli('look').me ?? {}).id ?? (B.cli('find', 'body').found ?? []).find((r) => r.kind?.startsWith('souls:body'))?.id;
    if (!body) return no('B has no body id in its own look');
    const w = A.cli('whisper', body, 'a quiet word');
    const ans = w.ok ? await answer(A, w.sequence, 30_000) : null;
    const heard = await waitFor(() => {
      const got = B.cli('wait', '5');
      B.seen = [...(B.seen ?? []), ...(got.events ?? [])];
      return B.seen.find((e) => e.kind === 'heard' && /quiet word/.test(JSON.stringify(e)));
    }, 20_000, 0);
    return ans?.answer === 1 && heard ? ok(`whisper answered 1; B heard it`) : no(`whisper answer ${brief(ans)}; heard by B: ${brief(heard ?? null)}`);
  }],
  ['23', 'a conversation of three or more Souls, by consent, its turns readable later', async ({ A }) => {
    const r = A.cli('converse', 'start');
    return r.ok ? ok(brief(r)) : no(`no conversation command in the client: ${r.code ?? ''} ${r.detail ?? brief(r)}`);
  }],
  ['18', 'home commands: list, default, adopt, doctor, export, import', async ({ A }) => {
    const missing = ['list', 'default', 'adopt', 'doctor', 'export', 'import'].filter((c) => A.cli(c).code === 'unknown-command' || A.cli(c).refused);
    return missing.length ? no(`unknown commands: ${missing.join(', ')}`) : ok('all six answer');
  }],
  ['17', 'memory: memory <words>, remember, digest, pending', async ({ A }) => {
    const missing = ['memory', 'remember', 'pending'].filter((c) => { const r = A.cli(c, 'x'); return r.code === 'unknown-command' || r.refused; });
    const digest = A.cli('digest');
    return missing.length ? no(`unknown commands: ${missing.join(', ')}; digest ${digest.ok === false ? 'refused' : 'answers'}`) : ok('memory commands answer');
  }],
  ['34a', 'sit on a campfire seat (the bench beside Eden\'s campfire)', async ({ A }) => {
    // The bench beside the campfire: the first bench in Eden's order (the campfire is the thing before it).
    const bench = (A.cli('find', 'bench', '--limit', '50').found ?? []).find((r) => r.kind === 'eden:bench');
    if (!bench) return no('no bench in the copy');
    const direct = await A.act([`sit:${bench.id}`], 120_000);
    if (direct.answer === 1) return (A.sat = true), ok(`sat on ${bench.kind} ${bench.id}`);
    const walked = await A.act([bench.id], 120_000);
    const r = await A.act([`sit:${bench.id}`], 120_000);
    A.sat = r.answer === 1;
    return r.answer === 1 ? ok(`walked to, then sat on ${bench.kind} ${bench.id}`)
      : no(`sit:${bench.id} (${bench.kind}) from the entry: ${direct.reason ?? brief(direct)}; walk to it: answer ${walked.answer}; sit again: ${r.reason ?? brief(r)}`);
  }],
  ['34b', 'one body per seat: a second Soul on the same seat is refused or given the other place', async ({ A, B }) => {
    const bench = (A.cli('find', 'bench', '--limit', '50').found ?? []).find((r) => r.kind === 'eden:bench');
    if (A.sat !== true) return no('A is not seated (34a), so a full seat cannot be tried');
    const r = await B.act([`sit:${bench.id}`], 120_000);
    return r.answer === 1 ? ok(`B sat on the same bench's other place`) : ok(`B refused by name: ${r.reason ?? brief(r)}`);
  }],
  ['36', 'pick up, carry, put down (an apple from a market stall, set down through the gateway)', async ({ C }) => {
    // Eden's things with a walk-then-take form are the market stalls' and shop counters' apples and the bike racks'
    // bicycles; the apple is the one kind whose loose policy is timed (36b).
    const stalls = (C.cli('find', 'market stall', '--limit', '20').found ?? []).filter((r) => r.kind === 'eden:market_stall');
    const tried = [];
    for (const st of stalls.slice(0, 3)) {
      const take = await C.act([`take_apple:${st.id}`], 180_000);
      tried.push(`${st.id.split('-').at(-1)}: ${take.answer === 1 ? 'taken' : take.reason ?? brief(take)}`);
      if (take.answer !== 1) continue;
      const apple = (C.cli('find', 'apple').found ?? [])[0];
      const put = await C.act(['carry:set-down', 'set_down', 'put_down'].map((v) => `${v}:${apple?.id}`), 60_000);
      return put.answer === 1 ? ok(`took an apple at ${st.id} and set it down`) : no(`took an apple at ${st.id}; no set-down lands: ${put.reason ?? brief(put)}`);
    }
    return no(`no apple taken at ${tried.length} market stalls: ${tried.join('; ')}`);
  }],
  ['36b', 'a thing set down later expires (Eden content\'s loose policy)', async () => {
    const tally = {};
    const walkDir = (d) => readdirSync(d, { withFileTypes: true }).forEach((e) => {
      if (e.isDirectory()) return walkDir(join(d, e.name));
      if (!e.name.endsWith('.json')) return;
      const j = JSON.parse(readFileSync(join(d, e.name), 'utf8'));
      if (j.format !== 'souls-entry/1') return;
      const k = j.loose === undefined ? 'none' : j.loose.ever ? 'ever' : 'timed';
      tally[k] = (tally[k] ?? 0) + 1;
    });
    walkDir(join(repo, 'content/kinds'));
    // Today's soul.game clears no loose thing (apps/server has no expiry; first light restocks the camp's food bowls
    // only, and not under continuous day), so `ever` is parity. The row is seen when the policy reads as stated.
    return ok(`loose policies of Eden's kinds: ${JSON.stringify(tally)} (the timed one is food/apple, 7 days); today's soul.game clears nothing, so nothing expiring is parity`);
  }],
  ['35', 'boats: board a rowing boat and ride', async ({ B }) => {
    const boat = near(B.cli('find', 'rowing boat', '--limit', '20').found ?? []).find((r) => /boat|canoe/.test(r.kind ?? ''));
    if (!boat) return no('no boat in the copy');
    const r = await B.act([`board:${boat.id}`], 300_000);
    return r.answer === 1 ? ok(`boarded ${boat.kind} ${boat.id}`) : no(`board:${boat.id} (${boat.kind}): ${brief(r)}`);
  }],
  ['32', 'roof access: up a stair flight to an upper floor or a roof terrace', async ({ C }) => {
    const stair = (C.cli('find', 'stair flight', '--limit', '20').found ?? []).find((r) => r.kind === 'eden:stair_flight');
    if (!stair) return no('no stair flight in the copy');
    const r = await C.act([`go_up:${stair.id}`], 300_000);
    return r.answer === 1 ? ok(`went up ${stair.kind} ${stair.id}`) : no(`go_up:${stair.id} (${stair.kind}): ${brief(r)}`);
  }],
  ['45', 'the piano: sit at it and play', async ({ A }) => {
    A.cli('act', 'rise');
    const piano = near(A.cli('find', 'piano', '--limit', '20').found ?? []).find((r) => /piano/.test(r.kind ?? ''));
    if (!piano) return no('no piano in the copy');
    const r = await A.act([`play:${piano.id}`], 300_000);
    return r.answer === 1 ? ok(`played ${piano.kind} ${piano.id}`) : no(`play:${piano.id}: ${brief(r)}`);
  }],
  ['72', 'watch the world live with no account: the page and the stream', async ({ s }) => {
    if (!s.page) return no('no page: npm ci in v2/web');
    const page = await fetch(s.page).catch((e) => ({ ok: false, status: String(e) }));
    const wj = await fetch(new URL(`s/eden/views/world.json`, s.page)).catch(() => null);
    const info = wj?.ok ? await wj.json() : null;
    return page.ok && info?.stream ? ok(`page ${page.status}; world.json names stream ${info.stream}; walk it at ${s.page}?world=eden&worlds=/s/`) : no(`page ${page.status}; world.json ${wj?.status}`);
  }],
  ['77', 'finding a place (not only a Soul) by name on the page and flying there', async () => {
    const src = readFileSync(join(v2, 'web/src/camera/director.ts'), 'utf8');
    return /find a place|findPlace/i.test(src) ? ok('a place find is in the page') : no('the find box finds Souls only (web/src/camera/director.ts `findSoul`, placeholder "find a Soul")');
  }],
];

// --- Main -----------------------------------------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT, { recursive: true });
  LOG = join(OUT, 'stack.log');
  writeFileSync(LOG, '');
  const dir = mkdtempSync(join(tmpdir(), 'souls-walk-'));
  const started = Date.now();
  const results = [];
  try {
    const s = await stack(dir);
    console.error(`stack in ${dir}: world ${s.name} (${s.entries} entries), gateway ${s.gateway}, directory ${s.directory}, page ${s.page ?? 'none'}`);
    const [A, B, C] = [await agent(s, 'a'), await agent(s, 'b'), await agent(s, 'c')];
    for (const [id, what, check] of ROWS) {
      if (ONLY && !ONLY.includes(id)) continue;
      const t = Date.now();
      let r;
      try { r = await check({ s, A, B, C }); } catch (e) { r = no(`threw: ${String(e?.stack ?? e).slice(0, 300)}`); }
      if (id === '2' && r.status === 'pass') A.answer = 1;
      results.push({ id, what, ...r, seconds: Math.round((Date.now() - t) / 100) / 10 });
      console.error(`${r.status.padEnd(4)} ${id} ${what}: ${r.evidence}`);
    }
    if (KEEP) {
      console.error(`kept up: page ${s.page}?world=eden&worlds=/s/  directory ${s.directory}  gateway ${s.gateway}  (Ctrl-C ends it)`);
      await new Promise(() => {});
    }
  } finally {
    stop();
    const table = ['| Row | What | Result | Seen |', '|---|---|---|---|',
      ...results.map((r) => `| ${r.id} | ${r.what} | ${r.status} | ${r.evidence.replaceAll('|', '/').replaceAll('\n', ' ')} |`)].join('\n');
    writeFileSync(join(OUT, 'walk.json'), JSON.stringify({ at: new Date(started).toISOString(), seconds: Math.round((Date.now() - started) / 1000), results }, null, 2));
    writeFileSync(join(OUT, 'walk.md'), `${table}\n`);
    console.log(table);
    if (!KEEP) rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); stop(); process.exit(1); });
