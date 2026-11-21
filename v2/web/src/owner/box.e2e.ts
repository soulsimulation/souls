// The owner's box end to end (Engine v2 W10, #2802), against the real directory (`directoryd`: the test sign-in, view
// tokens, R13's mailbox), the real gateway (`gatewayd --mailbox --view-key`), the world's end of it (`worldd
// gateway-link`, its log, text store and V1 stream under `--www`) and the Soul's own daemon (R13's `--for`). The page's
// half is the page's own code: `exchange`, `SocketSource` and `OwnerBox`.
//
// Run from v2/ after `cargo build -p gatewayd -p worldd -p directoryd --locked`, with replica's wasm-bindgen package
// in target/wasm-load/pkg: `node --test web/src/owner/box.e2e.ts`. W10_REPORT=1 prints the delays, for the PR.
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decode } from 'cborg';
import { SocketSource, exchange } from '../source/socket.ts';
import { OwnerBox, line, type BoxSocket, type Message } from './box.ts';
import { MailSocket } from './mail-socket.ts';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = (n: string) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
// The Soul's daemon (R7, R13), loaded by path: plain JavaScript outside this package.
const client = await import(join(v2, 'client/src/daemon/client.mjs'));
const { runtimeOf } = await import(join(v2, 'client/src/home/home.mjs'));
const PKG = process.env.SOULS_REPLICA_PKG ?? client.DEFAULT_PKG;
const SOUL = 's_w10test';
const WORLD_SCOPE = '2b'.repeat(16);
const LAMP = `${WORLD_SCOPE}-3`; // the Soul's own lamp (R13's mail.test.mjs)
const GRANT = `soul-${WORLD_SCOPE}-2`, FOLLOW = `${WORLD_SCOPE}.2`;
const OTHER = `soul-${WORLD_SCOPE}-4`, OTHER_FOLLOW = `${WORLD_SCOPE}.4`;
const CREATOR_SCOPE = 'c3'.repeat(16), CREATOR = `creator-${CREATOR_SCOPE}-1`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-w10-'));
const home = join(dir, '.souls');
const token = `${GRANT}.${randomBytes(32).toString('hex')}`;
const ctoken = `${CREATOR}.${randomBytes(32).toString('hex')}`;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const procs: ChildProcess[] = [];
const logs: Record<string, string> = { gatewayd: '', directoryd: '', worldd: '' };
const report: Record<string, unknown> = {};
let directory = '', gateway = '';
let rt: { socket: string };

function run(name: string, args: string[], ready: RegExp): Promise<RegExpExecArray> {
  const p = spawn(bin(name), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return new Promise((ok, fail) => {
    let out = '';
    const take = (d: Buffer) => { out += d; logs[name] += d; const m = ready.exec(out); if (m) ok(m); };
    p.stdout!.on('data', take);
    p.stderr!.on('data', take);
    p.on('exit', (c) => fail(new Error(`${name} ended (${c}): ${out}`)));
  });
}

async function waitFor<T>(f: () => T | Promise<T>, ms = 5000): Promise<NonNullable<T>> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(10);
  }
}

const ask = (req: object, ms = 5000) => client.request(rt.socket, req, ms);

/** A signed-in page: its view socket and its box, and every text frame it was sent. */
type Page = { near: (SocketSource | MailSocket) & BoxSocket; box: OwnerBox; texts: string[]; states: string[] };
/** An owner's page (V13's socket, following their Soul), or with `creator` the creator's panel (a box-only socket). */
async function page(name: string, creator = false): Promise<Page> {
  const session = { testName: name };
  const g = await exchange(`http://${directory}`, session);
  const o = { url: `ws://${gateway}/v2/ws`, token: g.token, expires: g.expires, renew: () => exchange(`http://${directory}`, session) };
  const near = creator ? new MailSocket(o) : new SocketSource({ ...o, follow: g.owned[0].follow! });
  const box = new OwnerBox();
  const p: Page = { near, box, texts: [], states: [] };
  near.onText = (t) => (p.texts.push(t), box.text(t));
  box.onChange = () => p.states.push(box.messages.map((m) => `${m.state}:${line(m)}`).join(' | '));
  if (near instanceof MailSocket) near.start();
  else near.start({ pointer: () => {}, part: () => {}, error: () => {} });
  await waitFor(() => near.sendText('ping'), 5000); // signed in: a text that is not a put is ignored
  return p;
}

/**
 * The creator's agent, as a bare socket (G7's client is not on main): signed in with the creator's token, it reads
 * each message it is given, sends one act for it and closes it with that act's outcome, as R13's daemon does.
 */
async function creatorAgent(ctoken: string) {
  const r = await import(join(PKG, 'replica.js'));
  r.initSync({ module: readFileSync(join(PKG, 'replica_bg.wasm')) });
  const ws = new WebSocket(`ws://${gateway}/v2/ws`);
  ws.binaryType = 'arraybuffer';
  const got: string[] = [];
  let step = 0, seq = 0;
  const answers = new Map<number, string>(); // sequence → `<kind> <name>`
  ws.onopen = () => ws.send(r.wireHello());
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') return void got.push(ev.data);
    if (step++ === 0) return void ws.send(r.wireSignIn(ctoken, new Uint8Array(0)));
    const m = decode(new Uint8Array(ev.data as ArrayBuffer), { useMaps: true }) as Map<number, unknown>;
    const a = m.get(2);
    if (a instanceof Map && a.get(3) !== 3) answers.set(Number(a.get(2)), `${a.get(3)} ${a.get(4) instanceof Uint8Array ? '' : a.get(4) ?? ''}`);
  };
  await waitFor(() => step >= 2, 5000);
  return {
    got,
    /** Acts once for the message `id` and closes it with the answer: the creator's act on a lamp. */
    async serve(id: string) {
      seq++;
      const soul = r.wireIntent(Buffer.from(CREATOR_SCOPE, 'hex'), 1n, 'r2:switch_on', BigInt(seq), new Uint8Array(0),
        BigInt(Date.now()) * 1000n + 30_000_000n, `${WORLD_SCOPE}-5`) as Uint8Array; // another body's lamp: refused, out of reach
      // The same intent, its actor the creator: `{1: {1: 2, 2: id}}` where a Soul's is `{1: {1: 1, 2: id}}`, driving a
      // world body (key 11, the last, so appended; the map's header counts one more).
      const at = soul.findIndex((_, i) => soul[i] === 0x01 && soul[i + 1] === 0xa2 && soul[i + 2] === 0x01 && soul[i + 3] === 0x01);
      soul[at + 3] = 0x02;
      const intent = Uint8Array.from([...soul, 0x0b, 0x82, 0x50, ...Buffer.from(WORLD_SCOPE, 'hex'), 0x08]);
      intent[0]++;
      ws.send(intent);
      const [kind, name] = (await waitFor(() => answers.get(seq), 5000)).split(' ');
      const state = kind === '1' || kind === '4' ? 'done' : 'failed';
      ws.send(JSON.stringify({ close: { id, state, outcome: name || ['', 'receipt', 'refused', '', 'resolved'][Number(kind)] } }));
    },
    close: () => ws.close(),
  };
}

/** Puts `words` from `p` to `grant`; the message as the box holds it. */
function put(p: Page, grant: string, words: string): Message {
  const frame = p.box.put(grant, words);
  assert.ok(frame && p.near.sendText(frame));
  return p.box.messages.at(-1)!;
}

let ada: Page, bo: Page, cy: Page;

before(async () => {
  const world = join(dir, 'w.sock'), tokens = join(dir, 'tokens.txt'), key = join(dir, 'mailbox.key'), viewKey = join(dir, 'view.key');
  writeFileSync(tokens, `${GRANT} ${sha(token)}\n${CREATOR} ${sha(ctoken)}\n`);
  writeFileSync(key, randomBytes(32).toString('hex'), { mode: 0o600 });
  writeFileSync(viewKey, randomBytes(32).toString('hex'), { mode: 0o600 });
  mkdirSync(join(dir, 'world', 'receipts'), { recursive: true });
  const wl = spawn(bin('worldd'), ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1',
    '--log', join(dir, 'world', 'world.log'), '--www', join(dir, 'world', 'www'), '--creator', `${CREATOR_SCOPE}-1`,
    '--arrivals', join(dir, 'world', 'arrivals.txt'), '--roots', join(dir, 'world', 'roots.txt'), '--rooms', '1', '--bodies', '4'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  wl.stderr!.on('data', (d) => (logs.worldd += d));
  procs.push(wl);
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } }, 10_000);
  [, directory] = await run('directoryd', ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1',
    '--store', join(dir, 'accounts.db'), '--test-sign-in', '--mailbox-key', key, '--view-key', viewKey,
    '--test-own', `Ada=${GRANT}@${FOLLOW}`, '--test-own', `Bo=${OTHER}@${OTHER_FOLLOW}`, '--test-own', `Cy=${CREATOR}`],
  /listening on (\S+)\n/);
  [, gateway] = await run('gatewayd', ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens,
    '--build', `1220${'ab'.repeat(32)}`, '--receipts', join(dir, 'world', 'receipts'), '--mailbox', directory, '--mailbox-key', key,
    '--view-key', viewKey], /listening (\S+)\n/);
  mkdirSync(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway: `ws://${gateway}/v2/ws` } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [SOUL]: { local: { token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  rt = runtimeOf(home, SOUL);
  await client.call(home, SOUL, { op: 'status' }, { pkg: PKG });
  await waitFor(async () => (await ask({ op: 'status' })).connected, 10_000);
  [ada, bo, cy] = [await page('Ada'), await page('Bo'), await page('Cy', true)];
});

after(async () => {
  await ask({ op: 'stop' }).catch(() => {});
  for (const p of [ada, bo, cy]) p?.near.stop();
  for (const p of procs) p.kill();
  if (process.env.W10_REPORT) console.log(JSON.stringify(report));
  rmSync(dir, { recursive: true, force: true });
});

const MARKER = `the heron counts ${randomBytes(6).toString('hex')} stones`;
const CREATOR_MARKER = `the kiln is cold ${randomBytes(6).toString('hex')} tonight`;

test('A1, A2: the box\'s message reaches a waiting agent within 2 s, twice; the box shows thinking, the act\'s phase, the result', async () => {
  const ms: number[] = [];
  const shown: string[][] = [];
  for (const [k, words] of [MARKER, 'switch it on again'].entries()) {
    await sleep(300);
    await ask({ op: 'wait', seconds: 0 }); // what happened before (sign-in, the last act's answer), taken
    const reader = ask({ op: 'wait', seconds: 30 }, 35_000);
    await sleep(200);
    const t0 = performance.now();
    const m = put(ada, GRANT, words);
    const got = await reader;
    ms.push(Math.round(performance.now() - t0));
    const mail = got.events?.find((e: { kind: string }) => e.kind === 'mail');
    assert.ok(mail, JSON.stringify(got));
    assert.equal(mail.text, words);
    assert.equal(mail.id, m.id, 'the box knows its message by the id the agent got');
    // Picked up: thinking, before any act.
    await waitFor(() => m.state === 'thinking');
    // The agent acts for it (the mind is the agent's; the page has no such button). The first is taken; the second
    // is refused (the lamp is on already).
    const from = ada.states.length;
    assert.equal((await ask({ op: 'act', verb: 'r2:switch_on', target: LAMP, for: m.id })).ok, true);
    await waitFor(() => m.state === 'done' || m.state === 'failed');
    shown.push(ada.states.slice(from).map((s) => s.split(' | ')[k]));
    assert.equal(m.state, k === 0 ? 'done' : 'failed');
    assert.ok(shown[k].some((s) => s.startsWith('doing:r2:switch_on ')), `the act under way: ${shown[k]}`);
  }
  report.reachMs = ms;
  report.shown = shown;
  for (const t of ms) assert.ok(t < 2000, `${t} ms`);
});

test('A1, A2 (the creator\'s box): the panel\'s message reaches the creator\'s agent within 2 s, twice; thinking, phase, result', async () => {
  const agent = await creatorAgent(ctoken);
  const ms: number[] = [];
  const shown: string[][] = [];
  for (const [k, words] of [CREATOR_MARKER, 'and once more'].entries()) {
    const t0 = performance.now();
    const m = put(cy, CREATOR, words);
    const frame = await waitFor(() => agent.got.find((t) => t.includes(JSON.stringify(words))), 5000);
    ms.push(Math.round(performance.now() - t0));
    const mail = JSON.parse(frame).mail;
    await waitFor(() => m.state === 'thinking' && m.id === mail.id);
    const from = cy.states.length;
    await agent.serve(mail.id);
    await waitFor(() => m.state === 'done' || m.state === 'failed');
    shown.push(cy.states.slice(from).map((s) => s.split(' | ')[k]));
    assert.ok(shown[k].some((s) => s.startsWith('doing:r2:switch_on ')), `the act under way: ${shown[k]}`);
  }
  agent.close();
  report.creatorReachMs = ms;
  report.creatorShown = shown;
  for (const t of ms) assert.ok(t < 2000, `${t} ms`);
});

test('#3781: an ack with no --close shows its note under the open message; the act --for it closes it once', async () => {
  await ask({ op: 'wait', seconds: 0 });
  const reader = ask({ op: 'wait', seconds: 30 }, 35_000);
  await sleep(200);
  const m = put(ada, GRANT, 'turn the lamp off when you can');
  const got = await reader;
  assert.ok(got.events?.some((e: { kind: string; id: string }) => e.kind === 'mail' && e.id === m.id), JSON.stringify(got));
  await waitFor(() => m.state === 'thinking');
  const a = await ask({ op: 'ack', id: m.id, reply: 'on it, in a moment' });
  assert.deepEqual([a.ok, a.acked, a.open, a.closed], [true, m.id, true, undefined], JSON.stringify(a));
  await waitFor(() => m.notes?.length === 1);
  assert.deepEqual([m.state, m.notes, m.reply ?? null], ['thinking', ['on it, in a moment'], null], 'a note: still open');
  const mailRead = (id: string) => fetch(`http://${directory}/v1/mailbox/read`, { method: 'POST', body: JSON.stringify({ id }) }).then((r) => r.json());
  await sleep(1200); // past a mailbox read: the directory still has it open
  assert.equal((await mailRead(m.id!)).state, 'open');
  const listed = await ask({ op: 'pending', list: true });
  assert.ok(listed.open.some((o: { id: string }) => o.id === m.id), 'the daemon still lists it open');
  assert.equal((await ask({ op: 'act', verb: 'r2:switch_off', target: LAMP, for: m.id })).ok, true);
  await waitFor(() => m.state === 'done' || m.state === 'failed');
  const closed = await mailRead(m.id!);
  assert.equal(closed.state, m.state, 'closed once, by the act');
  assert.notEqual(closed.outcome, 'replied');
  assert.equal(ada.texts.filter((t) => t.includes('"close"') && t.includes(m.id!)).length, 1, 'one close');
  assert.equal((await ask({ op: 'ack', id: m.id, reply: 'done now' })).code, 'mail-not-found', 'closed: nothing more to note');
  report.note = { state: m.state, notes: m.notes };
});

test('A3: another signed-in account can neither send to the Soul nor read its messages', async () => {
  const before = bo.texts.length;
  const m = put(bo, GRANT, 'come here');
  await waitFor(() => m.state === 'refused');
  assert.equal(m.outcome, 'not-yours');
  const c = put(bo, CREATOR, 'build a wall');
  await waitFor(() => c.state === 'refused');
  assert.equal(c.outcome, 'not-yours', 'nor to the creator\'s agent');
  // Bo's socket was told nothing of Ada's or the creator's messages: no id, no words, no act, no close.
  const ids = [...ada.box.messages, ...cy.box.messages].map((x) => x.id!);
  const seen = bo.texts.join('\n');
  for (const id of ids) assert.ok(!seen.includes(id), `Bo saw ${id}`);
  assert.ok(!/"doing"|"close"|"picked"|"note"/.test(seen), seen);
  assert.equal(bo.texts.length - before, 2, 'only his own refusals');
  // Nor does Ada see the creator's, or the creator Ada's.
  assert.ok(!cy.box.messages.some((x) => ada.texts.join().includes(x.id!)) && !ada.box.messages.some((x) => cy.texts.join().includes(x.id!)));
  report.otherAccount = { refused: [m.outcome, c.outcome], framesSeenOfOthers: 0 };
  // Nor, with no token of Ada's, by the directory: its open list and its put take the gateway's key alone.
  const open = await fetch(`http://${directory}/v1/mailbox/open`);
  assert.equal(open.status, 401);
});

test('A4: the marker sentence is in no log byte, stream part or world file', async () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  walk(join(dir, 'world'));
  const parts = files.filter((f) => f.includes(`${'/www/'}`));
  assert.ok(parts.length > 0, 'the stream was written');
  assert.ok(files.some((f) => f.endsWith('world.log')), 'the world log');
  const hits = files.filter((f) => [MARKER, CREATOR_MARKER].some((w) => readFileSync(f).includes(Buffer.from(w))));
  for (const [name, text] of Object.entries(logs)) if (text.includes(MARKER) || text.includes(CREATOR_MARKER)) hits.push(`${name} output`);
  report.scanned = { worldFiles: files.length, streamFiles: parts.length, processLogs: Object.keys(logs).length, hits: hits.length };
  assert.deepEqual(hits, []);
  assert.ok(readFileSync(join(dir, 'world', 'arrivals.txt'), 'utf8').trim().split('\n').length >= 2, 'the acts reached the world');
});
