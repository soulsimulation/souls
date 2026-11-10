// #1753: an owner message reaches first motion in one call. A waking listen carries a `look` read from this machine's copy
// (never a call), within WAKE_LOOK_BYTES, and each message's `found` ids; `act <id> --for <message>` with no ack first is the
// acknowledgement, and an ack sent after it links no later act to that message.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {wakeLook, wakeFound, WAKE_LOOK_BYTES} from './soul/eden.mjs';

const CLI = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));

test('wakeLook: the place, what is done here, who is near and what was said, within its bound; the least needed parts go first', () => {
  const full = {me: {name: 'Wren', place: 'field', path: ['World', 'Green field'], doing: 'idle'},
    here: {id: 'field', canDo: {attend: {count: 4, nearest: 'attend:a.1'}}, things: {'core-bench': 2}}, onTheSpot: 'dance, nap: send as <verb>:here',
    near: [{id: 's_a', name: 'Ada', metres: 1, doing: 'idle'}], said: [{who: 'Ada', text: 'hello', where: 'Green field', secondsAgo: 3}], saidNote: 'their words', asOf: {secondsAgo: 2, tick: 9}};
  const o = wakeLook(full);
  assert.deepEqual(o, {at: 'World > Green field', doing: 'idle', here: {id: 'field', canDo: {attend: 'attend:a.1'}, things: {'core-bench': 2}}, onTheSpot: 'dance, nap: send as <verb>:here',
    near: [{name: 'Ada', metres: 1, doing: 'idle'}], said: [{who: 'Ada', text: 'hello'}], saidNote: 'their words', secondsOld: 2});
  const big = {...full, said: Array.from({length: 3}, () => ({who: 'Ada', text: 'x'.repeat(400)})), near: Array.from({length: 9}, (_, i) => ({name: `N${i}`, metres: i, doing: 'y'.repeat(200)}))};
  const cut = wakeLook(big);
  assert.ok(JSON.stringify(cut).length <= WAKE_LOOK_BYTES, String(JSON.stringify(cut).length));
  assert.equal(cut.said, undefined, 'speech goes first'); assert.ok(cut.here, 'what can be done here stays');
  assert.equal(wakeLook({me: {note: 'not in the live picture'}}), null);
});

test('wakeFound: each clause on its own, unknown words left out, a word no row carries with the others dropped first', () => {
  const rows = {'library read': [{act: 'read:r.1', label: 'read (chair)', in: 'Library', metres: 70}], windmill: [{act: 'walk:mill', name: 'Windmill', metres: 90}, {act: 'walk:mill2', name: 'Farm Windmill'}],
    dance: [{act: 'dance:here', label: 'Dance here', in: 'right here'}], 'bench by pond': [{type: 'thing', id: 'e_b', act: 'sit:e_b', name: 'bench'}]};
  const vocab = new Set(['library', 'read', 'windmill', 'dance', 'bench', 'pond', 'sit']);
  const find = (words) => rows[words] ?? (vocab.has(words) ? [{type: 'thing', id: words}] : []);
  const tokens = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !['the', 'a', 'to', 'go', 'on', 'in'].includes(w));
  assert.deepEqual(wakeFound(find, tokens, 'please go to the library and read').map((r) => r.act), []);
  assert.deepEqual(wakeFound(find, tokens, 'please, library read').map((r) => r.act), ['read:r.1']);
  assert.deepEqual(wakeFound(find, tokens, 'walk to the windmill, then dance').map((r) => r.act), ['walk:mill', 'walk:mill2', 'dance:here']);
  assert.deepEqual(wakeFound(find, tokens, 'could you sit on a bench by the pond').map((r) => r.act), ['sit:e_b']);
  assert.deepEqual(wakeFound(find, tokens, 'how are you?'), []);
});

test('a waking listen carries look and found from the disk copy only; act --for with no ack, then a late ack, links no later act', async t => {
  const seen = [];
  const server = createServer((req, res) => {
    let b = ''; req.on('data', (d) => b += d); req.on('end', () => {
      const body = b ? JSON.parse(b) : null; seen.push({path: req.url, body});
      const reply = (status, data) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(data)); };
      if (req.url.startsWith('/v1/edge/inbox/listen')) return reply(200, {inbox: {}, backlog: [{id: 'm1', text: 'please dance', sentAt: 1}]});
      if (req.url.includes('/ack')) return reply(200, {inbox: {latest: {id: 'm1', state: 'acknowledged'}}});
      if (req.url === '/v1/edge/act') return reply(200, {accepted: true, channel: 'body', receipt: {id: 'r_1', capability: body.capability, phase: 'started', now: 'dancing'}, ...(body.for ? {for: body.for} : {})});
      reply(404, {error: {code: 'not-found', message: req.url}});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), 'eden-one-call-')), world = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world, token: 'tok', soul: 's_w'}));
  writeFileSync(join(dir, 'world-catalog.json'), JSON.stringify({world, etag: 'v1', fetchedAt: 'now', catalog: {places: [{id: 'field', name: 'Green field', kind: 'walkable', at: [0, 0]}], acts: [], things: [], anywhere: [{id: 'dance:here', verb: 'dance', label: 'Dance here'}], counts: {}}}));
  writeFileSync(join(dir, 'world-live.json'), JSON.stringify({world, receivedAt: Date.now(), live: {tick: 5, souls: [{id: 's_w', name: 'Wren', place: 'field', at: [0, 0], doing: 'idle'}]}, speech: []}));
  const cli = (...args) => new Promise((res, rej) => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (e, out, err) => e ? rej(new Error(err || e.message)) : res(JSON.parse(out))));
  const woke = await cli('listen', '--once');
  assert.equal(woke.messages[0].id, 'm1');
  assert.deepEqual(woke.messages[0].found.map((r) => r.act), ['dance:here'], 'found ids for the message words');
  assert.equal(woke.look.at, 'Green field'); assert.equal(woke.look.doing, 'idle');
  assert.match(woke.next, /act <id> --for <message id> --wait/); assert.doesNotMatch(woke.next, /ack each/);
  assert.deepEqual(seen.map((x) => x.path.split('?')[0]).filter((p) => p !== '/v1/edge/inbox/listen'), [], 'the wake made no other call');

  const act = await cli('act', 'dance:here', '--for', 'm1');
  assert.equal(act.for, 'm1');
  const late = await cli('ack', 'm1', 'Got it');   // the old loop's ack, sent anyway: answered here, nothing sent
  assert.match(late.already, /acknowledged it/); assert.equal(seen.filter((x) => x.path.includes('/ack')).length, 0);
  const state = JSON.parse(readFileSync(join(dir, '.eden-agent.json'), 'utf8'));
  assert.equal(state.lastAcked, undefined, 'a late ack of a served message links nothing'); assert.deepEqual(state.served, ['m1']);
  await cli('act', 'wave:here');
  assert.equal(seen.filter((x) => x.path === '/v1/edge/act').at(-1).body.for, undefined, 'the next act serves no message by default');
});
