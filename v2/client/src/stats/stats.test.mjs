// The client's trace and `stats` (Engine v2 R10, #2702). The daemon's own trace, against the real gateway, is
// checked in ../daemon/daemon.test.mjs.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stats, transcriptOf } from './stats.mjs';
import { achievedOf, causeOf, openTrace } from './trace.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'souls-r10-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// Two achieved intents: the first refused as stale once and sent again, the second a ranked list taken at once.
const T = Date.parse('2026-11-18T10:00:00Z');
const records = [
  { t: T + 100, k: 'cmd', op: 'look', bytes: 800 },
  { t: T + 200, k: 'send', seq: 1, ranked: 1 },
  { t: T + 210, k: 'cmd', op: 'act', bytes: 300 },
  { t: T + 250, k: 'answer', seq: 1, cause: 'refused-stale', achieved: false },
  { t: T + 300, k: 'cmd', op: 'look', bytes: 700 },
  { t: T + 400, k: 'send', seq: 2, ranked: 1 },
  { t: T + 410, k: 'cmd', op: 'act', bytes: 300 },
  { t: T + 450, k: 'answer', seq: 2, cause: 'accepted-first', achieved: true },
  { t: T + 500, k: 'send', seq: 3, ranked: 2 },
  { t: T + 510, k: 'cmd', op: 'act', bytes: 320 },
  { t: T + 550, k: 'answer', seq: 3, cause: 'accepted-rank-unstated', achieved: true },
];

test('A3: per achieved intent, the commands, the bytes printed and the first send\'s result by cause', () => {
  const s = stats(records);
  assert.equal(s.achieved, 2);
  assert.deepEqual(s.last.map(({ commands, bytes, sends, firstSend }) => ({ commands, bytes, sends, firstSend })), [
    { commands: 4, bytes: 2100, sends: 2, firstSend: 'refused-stale' },
    { commands: 1, bytes: 320, sends: 1, firstSend: 'accepted-rank-unstated' },
  ]);
  assert.equal(s.firstSend['refused-stale'], 1);
  assert.equal(s.firstSend['accepted-rank-unstated'], 1);
  assert.equal(s.firstSend['accepted-first'], 0);
  assert.deepEqual([s.perIntent.commands, s.perIntent.bytes], [2.5, 1210]);
});

test('A3: an answer\'s kind and reason make its cause, and a receipt is achieved', () => {
  assert.equal(causeOf(1, '-', 1), 'accepted-first');
  assert.equal(causeOf(1, '-', 3), 'accepted-rank-unstated');
  assert.equal(causeOf(2, 'basis-stale'), 'refused-stale');
  assert.equal(causeOf(2, 'world.restarting'), 'refused-load');
  assert.equal(causeOf(2, 'intent-expired'), 'expired');
  assert.equal(causeOf(2, 'intent-not-granted'), 'refused-never');
  assert.equal(causeOf(5, 'not-canonical'), 'refused-never');
  assert.equal(achievedOf(1, '-'), true);
  assert.equal(achievedOf(2, 'basis-stale'), false);
  assert.equal(achievedOf(4, 'completed'), true);
  assert.equal(achievedOf(4, 'missed'), false);
});

test('A4: turns and tokens come from the transcript only when the owner opted in; otherwise tokens are an estimate', () => {
  const home = join(dir, 'home-a4');
  mkdirSync(home, { recursive: true });
  // Not opted in: no turns, and tokens marked as an estimate (bytes / 4).
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: {} }));
  assert.equal(transcriptOf(home), null);
  const plain = stats(records, { transcript: transcriptOf(home) });
  assert.equal(plain.last[0].turns, undefined);
  assert.deepEqual(plain.last[0].tokens, { in: 525, estimate: true });
  assert.equal(plain.perIntent.estimate, true);
  // Opted in, naming the folder of transcripts: the newest is read. Two model turns fall in the first intent (one
  // message written twice, as a harness streams it), one in the second.
  const folder = join(home, 'transcripts');
  mkdirSync(folder);
  const line = (ms, id, i, o) => JSON.stringify({ type: 'assistant', timestamp: new Date(T + ms).toISOString(), message: { id, usage: { input_tokens: i, cache_read_input_tokens: 1000, output_tokens: o } } });
  writeFileSync(join(folder, 'old.jsonl'), line(150, 'x', 9, 9) + '\n');
  utimesSync(join(folder, 'old.jsonl'), new Date(0), new Date(0));
  writeFileSync(join(folder, 'now.jsonl'), [line(150, 'a', 10, 5), line(160, 'a', 10, 5), JSON.stringify({ type: 'user', timestamp: new Date(T + 170).toISOString() }),
    line(320, 'b', 20, 7), line(520, 'c', 30, 9)].join('\n') + '\n');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: {}, stats: { transcript: 'transcripts' } }));
  const opted = stats(records, { transcript: transcriptOf(home) });
  assert.deepEqual(opted.last.map((x) => [x.turns, x.tokens]), [[2, { in: 2030, out: 12 }], [1, { in: 1030, out: 9 }]]);
  assert.equal(opted.perIntent.estimate, undefined);
  assert.equal(opted.perIntent.turns, 1.5);
});

test('A5: the trace is a local file, and with the network refused it is written and read, and stats answers', () => {
  const home = join(dir, 'home-a5');
  mkdirSync(home, { recursive: true });
  const refuse = join(dir, 'refuse.mjs');
  // Every way out of the process throws, and says so on stderr.
  writeFileSync(refuse, `
    import net from 'node:net'; import http from 'node:http'; import https from 'node:https'; import dns from 'node:dns'; import dgram from 'node:dgram';
    const no = (what) => () => { process.stderr.write('network: ' + what + '\\n'); throw new Error('network refused: ' + what); };
    net.Socket.prototype.connect = no('net.connect'); net.connect = net.createConnection = no('net.connect');
    http.request = http.get = no('http'); https.request = https.get = no('https'); dns.lookup = no('dns'); dgram.createSocket = no('udp');
    globalThis.fetch = no('fetch'); globalThis.WebSocket = class { constructor() { no('WebSocket')(); } };
  `);
  const child = `
    import { openTrace } from ${JSON.stringify(join(here, 'trace.mjs'))};
    import { runtimeOf } from ${JSON.stringify(join(here, '../home/home.mjs'))};
    const tr = openTrace(runtimeOf(${JSON.stringify(home)}, 's_r10').dir);
    for (const r of ${JSON.stringify(records)}) { const { t, ...rest } = r; tr.write(rest); }
  `;
  const w = spawnSync(process.execPath, ['--import', refuse, '--input-type=module', '-e', child], { encoding: 'utf8' });
  assert.equal(w.status, 0, w.stderr);
  const s = spawnSync(process.execPath, ['--import', refuse, join(here, 'stats.mjs'), '--home', home, '--soul', 's_r10'], { encoding: 'utf8' });
  assert.equal(s.status, 0, s.stderr);
  assert.equal(s.stderr, '', 'nothing tried the network');
  assert.equal(JSON.parse(s.stdout).achieved, 2);
  const file = join(home, 'souls/s_r10/runtime/trace.jsonl');
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, records.length);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // The trace and stats modules import no network code at all.
  for (const f of ['trace.mjs', 'stats.mjs']) {
    assert.doesNotMatch(readFileSync(join(here, f), 'utf8'), /from 'node:(net|http|https|dns|dgram|tls)'|fetch\(|WebSocket/);
  }
});

test('the trace keeps to its size: past it, one older file is kept', () => {
  const rt = join(dir, 'rot');
  mkdirSync(rt);
  const tr = openTrace(rt, { most: 200 });
  for (let k = 0; k < 20; k++) tr.write({ k: 'cmd', op: 'look', bytes: k });
  assert.ok(statSync(join(rt, 'trace.jsonl')).size <= 200 + 80);
  const kept = tr.read();
  assert.ok(kept.length < 20 && kept.at(-1).bytes === 19);
});
