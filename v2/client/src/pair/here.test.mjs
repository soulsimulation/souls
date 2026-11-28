// N13: `pair` asks and returns, leaving nothing running; `start` waits in the foreground for the person's answer and
// only then starts the Soul's client; a second pair or start while one waits, and a start with nothing, are refused. Against a
// stand-in directory (the real one's poll rules: interval from the request, slow_down sooner), the client's own CLI.

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../cli/souls.mjs');
const dir = mkdtempSync(join(tmpdir(), 'souls-n13-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const grant = `soul-${'ab'.repeat(16)}-0`;

/** A directory whose next poll answer is `state.answer` ('pending', 'approved' or a refusal name). */
async function directory() {
  const state = { answer: 'pending', requests: [], polls: [] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/pair/request') { state.requests.push(JSON.parse(body)); return res.end(JSON.stringify({ code: `BCDF-GHJ${state.requests.length}`, link: `http://127.0.0.1/pair?code=${state.requests.length}`, interval: 1 })); }
      if (req.url === '/v1/pair/poll') {
        state.polls.push(JSON.parse(body).secret);
        const a = state.answer;
        return res.end(JSON.stringify(a === 'pending' ? { pending: 'authorization_pending' } : a === 'approved' ? { token: `${grant}.${'cd'.repeat(32)}`, grant } : { refused: a }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  after(() => server.close());
  return { state, url: `http://127.0.0.1:${server.address().port}/w?gateway=ws://127.0.0.1:1/v2/ws` };
}

/** The CLI run to its end: its JSON lines, stderr and exit code; `onLine` sees each line as it comes. */
function cli(home, args, onLine = () => {}) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, SOULS_HOME: home, ...(process.env.SOULS_REPLICA_PKG ? { SOULS_REPLICA_PKG: process.env.SOULS_REPLICA_PKG } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; for (const l of String(d).split('\n')) if (l.startsWith('{')) onLine(JSON.parse(l)); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (status) => ok({ status, lines: out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)), err, pid: p.pid }));
  });
}
const running = (home) => spawnSync('ps', ['-Ao', 'command='], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(home));

test('pair asks and returns at once, nothing running; start waits for the answer, then starts the client', async () => {
  const d = await directory(), home = join(dir, 'approved', '.souls');
  const r = await cli(home, ['pair', d.url, '--name', 'Fern']);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.lines.map((l) => l.step), ['approve']);
  const [asked] = r.lines;
  assert.equal(asked.code, 'BCDF-GHJ1');
  assert.match(r.err, /^Approve this Soul: open this link while signed in/);
  // What comes next is told before it runs: start waits, then the client in the background, what it does, how to stop.
  assert.match(asked.say, /^Waiting for your user's approval on the page; nothing is running\./);
  assert.match(asked.say, /`node eden.mjs start` waits for their answer; once they approve, it starts Fern's client in the background on this computer.*carries your `node eden.mjs` commands.*writes only in this folder's `\.souls`.*`node eden.mjs quit`.*Disconnect on Fern's card/);
  assert.equal(d.state.polls.length, 0, 'pair does not wait');
  assert.equal(statSync(join(home, 'pairing.json')).mode & 0o777, 0o600);
  assert.deepEqual(running(home), [], 'nothing of this home runs after pair');
  // Not approved yet, look says where the pairing stands.
  assert.match((await cli(home, ['look'])).lines[0].say, /waiting for your owner to approve.*BCDF-GHJ1.*`node eden.mjs start`/);

  // start waits here for the answer; a pair or a second start meanwhile is refused by name.
  const waiting = cli(home, ['start', '--within', '30']);
  await new Promise((ok) => setTimeout(ok, 700));
  assert.deepEqual((await cli(home, ['start'])).lines[0].code, 'pairing-busy');
  assert.deepEqual((await cli(home, ['pair', d.url, '--name', 'Fern'])).lines[0].code, 'pairing-busy');
  d.state.answer = 'approved';
  const w = await waiting;
  assert.match(w.err, /Waiting here up to 30 s for the answer on the page \(code BCDF-GHJ1\)/);
  // No gateway here: the client is started (the daemon), and start says what it is, whatever it then reaches. Where the
  // daemon's library is not built (SOULS_REPLICA_PKG unset, no v2/target), it says plainly that the client did not start.
  const started = w.lines.at(-1);
  assert.deepEqual([started.approved, started.soul, started.name], [true, `s_${'ab'.repeat(16)}-0`, 'Fern'], w.err);
  if (started.step === 'started') assert.match(started.say, /^Approved: Fern is your user's\. Started: Fern's client runs in the background on this computer\..*`node eden.mjs quit`/);
  else assert.deepEqual([started.step, w.status, /`node eden.mjs start` tries again/.test(started.say)], ['not-started', 1, true], JSON.stringify(started));
  assert.equal(statSync(join(home, 'credentials.json')).mode & 0o777, 0o600);
  assert.ok(!existsSync(join(home, 'pairing.json')), 'nothing is left waiting');
  assert.equal(new Set(d.state.polls).size, 1, 'every poll is the one request\'s');
  const secret = d.state.polls[0];
  assert.ok(![...r.lines, ...w.lines].some((l) => JSON.stringify(l).includes(secret)) && !w.err.includes(secret), 'the secret is never printed');
  if (started.step === 'started') { const quit = await cli(home, ['quit']); assert.equal(quit.status, 0, JSON.stringify(quit.lines)); }
});

test('past its bound start says to run it again, and waits for the same request; pair again gives the same code', async () => {
  const d = await directory(), home = join(dir, 'bound', '.souls');
  assert.equal((await cli(home, ['pair', d.url, '--name', 'Fern'])).status, 0);
  const r = await cli(home, ['start', '--within', '2']);
  assert.equal(r.status, 2, r.err);
  assert.deepEqual([r.lines[0].step, r.lines[0].code], ['waiting', 'BCDF-GHJ1']);
  assert.match(r.lines[0].say, /No answer yet after 2 s; nothing is running\..*run `node eden.mjs start` again/);
  assert.ok(d.state.polls.length >= 1, 'it polled while waiting');
  assert.deepEqual(running(home), []);
  // The same world again within ten minutes: the same request, its code, no second card.
  const again = await cli(home, ['pair', d.url, '--name', 'Fern']);
  assert.deepEqual([again.status, again.lines[0].code, again.lines[0].resumed, d.state.requests.length], [0, 'BCDF-GHJ1', true, 1]);
  d.state.answer = 'soul-connected';
  const refused = await cli(home, ['start', '--within', '30']);
  assert.equal(refused.status, 1, refused.err);
  assert.deepEqual([refused.lines[0].step, refused.lines[0].code], ['refused', 'soul-connected']);
  assert.match(refused.lines[0].say, /nothing joined the world and nothing is running/);
  assert.ok(!existsSync(join(home, 'pairing.json')) && !existsSync(join(home, 'credentials.json')));
  assert.match(readFileSync(join(home, 'pairing.log'), 'utf8'), /"code":"soul-connected"/);
  assert.equal(new Set(d.state.polls).size, 1);
});

test('start with no request waiting and no Soul is refused pairing-none', async () => {
  const none = await cli(join(dir, 'none', '.souls'), ['start']);
  assert.deepEqual([none.status, none.lines[0].code], [1, 'pairing-none']);
});
