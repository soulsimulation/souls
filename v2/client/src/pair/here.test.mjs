// N13: `pair` waits in the foreground for the person's answer and leaves nothing running; `pair --wait` resumes the
// same request; a second pair, a pair --wait with none, and a start before approval are refused by name. Against a
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
    const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, SOULS_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; for (const l of String(d).split('\n')) if (l.startsWith('{')) onLine(JSON.parse(l)); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (status) => ok({ status, lines: out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)), err, pid: p.pid }));
  });
}
const running = (home) => spawnSync('ps', ['-Ao', 'command='], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(home));

test('pair waits here for the answer: the link and code first, then approved, exit 0, and nothing is left running', async () => {
  const d = await directory(), home = join(dir, 'approved', '.souls');
  const r = await cli(home, ['pair', d.url, '--name', 'Fern'], (l) => { if (l.step === 'approve') setTimeout(() => { d.state.answer = 'approved'; }, 1500); });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.lines.map((l) => l.step), ['approve', 'approved']);
  const [asked, done] = r.lines;
  assert.equal(asked.code, 'BCDF-GHJ1');
  assert.match(r.err, /Approve this Soul: open this link[\s\S]*Waiting here up to 90 s for the answer on the page \(code BCDF-GHJ1\)/);
  assert.equal(done.soul, `s_${'ab'.repeat(16)}-0`);
  assert.equal(done.next, 'start');
  // The person is told what `start` will run before it does: in the background, what it does, where it writes, how to stop.
  assert.match(done.say, /Approved: Fern is yours\. The Soul's client is not running yet\. Before you run `node eden.mjs start`, tell your user/);
  assert.match(done.say, /in the background on this computer.*carries your `node eden.mjs` commands.*writes only in this folder's `\.souls`.*`node eden.mjs quit`.*Disconnect on Fern's card/);
  assert.ok(d.state.polls.length >= 2, 'it polled while waiting');
  assert.equal(statSync(join(home, 'credentials.json')).mode & 0o777, 0o600);
  assert.ok(!existsSync(join(home, 'pairing.json')), 'nothing is left waiting');
  assert.deepEqual(running(home), [], 'no process of this home runs after pair ends');
  const secret = d.state.polls[0];
  assert.ok(!JSON.stringify(r.lines).includes(secret) && !r.err.includes(secret), 'the secret is never printed');
});

test('after its bound pair says how to wait again; pair --wait waits for the same request, and start waits for approval', async () => {
  const d = await directory(), home = join(dir, 'bound', '.souls');
  const r = await cli(home, ['pair', d.url, '--name', 'Fern', '--within', '0']);
  assert.equal(r.status, 2, r.err);
  assert.deepEqual(r.lines.map((l) => l.step), ['approve', 'waiting']);
  assert.match(r.lines[1].say, /No answer yet after 0 s\. Nothing is running now\..*`node eden.mjs pair --wait`/);
  assert.equal(statSync(join(home, 'pairing.json')).mode & 0o777, 0o600);
  assert.deepEqual(running(home), []);

  // Not approved yet: start starts nothing, and look says where the pairing stands.
  const early = await cli(home, ['start']);
  assert.deepEqual([early.status, early.lines[0].code], [1, 'pairing-waiting']);
  assert.match((await cli(home, ['look'])).lines[0].say, /waiting for your owner to approve.*BCDF-GHJ1.*pair --wait/);

  // The same world again within ten minutes: the same request, its code, no second card.
  const again = await cli(home, ['pair', d.url, '--name', 'Fern', '--within', '0']);
  assert.deepEqual([again.status, again.lines[0].code, again.lines[0].resumed, d.state.requests.length], [2, 'BCDF-GHJ1', true, 1]);

  // While one waits, a second is refused by name; then the first gets its answer.
  const waiting = cli(home, ['pair', '--wait', '--within', '30'], (l) => { if (l.step === 'approve') setTimeout(() => { d.state.answer = 'approved'; }, 1500); });
  await new Promise((r) => setTimeout(r, 700));
  const second = await cli(home, ['pair', '--wait']);
  assert.deepEqual([second.status, second.lines[0].code], [1, 'pairing-busy']);
  const w = await waiting;
  assert.equal(w.status, 0, w.err);
  assert.deepEqual(w.lines.map((l) => l.step), ['approve', 'approved']);
  assert.deepEqual([w.lines[0].code, w.lines[1].name], ['BCDF-GHJ1', 'Fern']);
  assert.equal(new Set(d.state.polls).size, 1, 'every poll is the one request\'s');
  assert.equal(d.state.requests.length, 1);
  // Once approved nothing waits: pair --wait says so, and what comes next.
  const after = await cli(home, ['pair', '--wait']);
  assert.deepEqual([after.status, after.lines[0].step, after.lines[0].already], [0, 'approved', true]);
});

test('a refusal ends pair with exit 1, nothing joined; pair --wait with no request waiting is refused pairing-none', async () => {
  const d = await directory(), home = join(dir, 'refused', '.souls');
  const none = await cli(home, ['pair', '--wait']);
  assert.deepEqual([none.status, none.lines[0].code], [1, 'pairing-none']);
  d.state.answer = 'soul-connected';
  const r = await cli(home, ['pair', d.url, '--name', 'Fern']);
  assert.equal(r.status, 1, r.err);
  assert.deepEqual([r.lines.at(-1).step, r.lines.at(-1).code], ['refused', 'soul-connected']);
  assert.match(r.lines.at(-1).say, /nothing joined the world and nothing is running/);
  assert.ok(!existsSync(join(home, 'pairing.json')) && !existsSync(join(home, 'credentials.json')));
  assert.match(readFileSync(join(home, 'pairing.log'), 'utf8'), /"code":"soul-connected"/);
});
