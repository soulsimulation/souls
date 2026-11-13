// #1354: say --to turns to someone (face:<soulId>), speaks, and can gesture toward them, as one command whose output
// names each part. Plain say sends exactly what it sent before.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sayFlags} from './soul/eden.mjs';

const CLI = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));
const FACES = [{id: 'face:s_bo', verb: 'face', label: 'Turn towards Bo', target: {id: 's_bo', kind: 'soul'}, available: true},
  {id: 'face:s_cy', verb: 'face', label: 'Turn towards Cy', target: {id: 's_cy', kind: 'soul'}, available: true},
  {id: 'wave:s_bo', verb: 'wave', label: 'Wave to Bo', target: {id: 's_bo', kind: 'soul'}, available: true}];

async function world(t, {caps = FACES, refuse = new Set(), posture = 'standing', sayReply = () => [200, {said: {id: 'sp_1', heardBy: 1}}, {}]} = {}) {
  const seen = [], dir = mkdtempSync(join(tmpdir(), 'eden-say-to-'));
  const server = createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const body = JSON.parse(b || '{}'), url = req.url.split('?')[0], send = (s, j) => {res.writeHead(s, {'content-type': 'application/json'}); res.end(JSON.stringify(j));};
      seen.push([req.method, url, body]);
      if (url === '/v1/edge/capabilities') return send(200, {capabilities: caps});
      if (url === '/v1/edge/here') return send(200, {here: {me: {posture}}});
      if (url === '/v1/edge/say') {const reply = sayReply(); if (reply === 'drop') return req.socket.destroy(); const [st, j, h] = reply; res.writeHead(st, {'content-type': 'application/json', ...h}); return res.end(JSON.stringify(j));}
      if (url.startsWith('/v1/edge/operations/')) return send(404, {error: {code: 'not-found'}});
      if (url === '/v1/edge/act') return refuse.has(body.capability) ? send(200, {accepted: false, code: 'gesture.too-far', reason: 'Bo is too far away; go near them first.'})
        : send(200, {accepted: true, channel: body.capability.startsWith('face:') ? 'attention' : 'body', receipt: {id: 'r_' + seen.length, capability: body.capability, phase: 'started'}});
      const m = /^\/v1\/edge\/inbox\/([^/]+)\/result$/.exec(url);
      if (m) return send(200, {inbox: {}});
      if (/^\/v1\/edge\/inbox\/[^/]+$/.test(url)) return send(200, {message: {id: 'msg_1'}});
      send(200, {});
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, {recursive: true, force: true});});
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: `http://127.0.0.1:${server.address().port}`, soul: 's_ada', token: 'tok'}));
  const cli = (...args) => new Promise(res => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (e, out, err) => {let json = null; try {json = JSON.parse(out);} catch {/* words */} res({code: e?.code ?? 0, json, err});}));
  return {seen, cli};
}
const writes = (seen) => seen.filter(([m]) => m === 'POST').map(([, u, b]) => u === '/v1/edge/act' ? [b.capability, b.params ?? null, b.strict] : u === '/v1/edge/say' ? ['say', b.text] : [u]);

test('sayFlags reads --to, --gesture and --stand-ok only among the trailing flags', () => {
  assert.deepEqual(sayFlags(['Hello Bo', '--to', 'Bo', '--gesture', 'nod']), {to: 'Bo', gesture: 'nod', words: ['Hello Bo']});
  assert.deepEqual(sayFlags(['Hi', '--to', 'Bo', '--for', 'msg_1', '--stand-ok']), {to: 'Bo', standOk: true, words: ['Hi', '--for', 'msg_1']});
  assert.deepEqual(sayFlags(['tell', '--to', 'Bo', 'hi']), {words: ['tell', '--to', 'Bo', 'hi']}, 'mid-speech --to is speech');
  assert.throws(() => sayFlags(['send', 'it', '--to']), /--to needs a value/);
  assert.throws(() => sayFlags(['hi', '--to', 'Bo', '--gesture']), /--gesture needs a value/);
  assert.throws(() => sayFlags(['hi', '--to', 'A', '--to', 'B']), /--to is given twice/);
  assert.deepEqual(sayFlags(['Hello']), {words: ['Hello']});
});

test('A1, A2: say --to faces them, speaks, then gestures toward them, in that order, and names each part', async t => {
  const w = await world(t), r = await w.cli('say', 'Hello Bo', '--to', 'Bo', '--gesture', 'nod');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(writes(w.seen), [['face:s_bo', null, true], ['say', 'Hello Bo'], ['nod:here', {to: 's_bo'}, true]]);
  assert.equal(r.json.faced.accepted, true); assert.equal(r.json.faced.id, 'face:s_bo'); assert.equal(r.json.faced.to, 'Bo');
  assert.equal(r.json.said.id, 'sp_1'); assert.equal(r.json.gestured.accepted, true); assert.equal(r.json.gestured.id, 'nod:here');
  const byId = await w.cli('say', 'Hi', '--to', 's_cy', '--gesture', 'point');
  assert.deepEqual(writes(w.seen).slice(3), [['face:s_cy', null, true], ['say', 'Hi'], ['point:here', {at: 's_cy'}, true]], 'a soulId is used as given; point aims with `at`');
  assert.equal(byId.json.faced.to, 'Cy');
  await w.cli('say', 'hey', '--to', 'bo'); assert.equal(writes(w.seen).at(-2)[0], 'face:s_bo', 'a name matches regardless of case');
});

test('A1: a refused or unoffered face still speaks, and says so; nothing is retried', async t => {
  const w = await world(t, {refuse: new Set(['face:s_bo'])}), r = await w.cli('say', 'Hello', '--to', 'Bo');
  assert.equal(r.code, 0); assert.deepEqual(writes(w.seen), [['face:s_bo', null, true], ['say', 'Hello']]);
  assert.equal(r.json.faced.accepted, false); assert.match(r.json.faced.reason, /too far/); assert.equal(r.json.said.id, 'sp_1');
  const far = await world(t), f = await far.cli('say', 'Hello', '--to', 'Zed', '--gesture', 'clap');
  assert.deepEqual(writes(far.seen), [['say', 'Hello'], ['clap:here', {to: 'Zed'}, true]], 'no face offer, no face act; the gesture names them as given');
  assert.equal(f.json.faced.code, 'face.not-offered'); assert.equal(f.json.said.id, 'sp_1');
  const two = await world(t, {caps: [...FACES, {id: 'face:s_bo2', verb: 'face', label: 'Turn towards Bo', target: {id: 's_bo2', kind: 'soul'}, available: true}]});
  const amb = await two.cli('say', 'Hello', '--to', 'Bo');
  assert.equal(amb.json.faced.code, 'face.ambiguous'); assert.match(amb.json.faced.reason, /s_bo, s_bo2/); assert.deepEqual(writes(two.seen), [['say', 'Hello']]);
  const ambNod = await two.cli('say', 'Hello', '--to', 'Bo', '--gesture', 'nod');
  assert.equal(ambNod.json.gestured.sent, false, 'an ambiguous name could aim the nod at the other Bo'); assert.match(ambNod.json.gestured.reason, /soulId/);
  assert.deepEqual(writes(two.seen).slice(1), [['say', 'Hello']]);
});

// #1981: in the eight-hour run a seat read a refused turn as failed speech. Delivered speech exits 0 and says so; speech the
// world refused still exits non-zero.
test('#1981 A1: a refused face exits 0 with a note that the speech went out; refused speech exits non-zero', async t => {
  const far = await world(t), f = await far.cli('say', 'Hello', '--to', 'Zed');
  assert.equal(f.code, 0, f.err); assert.equal(f.json.said.id, 'sp_1');
  assert.equal(f.json.note, 'The speech went out (exit 0); only the turn toward Zed was refused (face.not-offered). Not a failure.');
  const near = await world(t), n = await near.cli('say', 'Hello', '--to', 'Bo');
  assert.equal(n.json.note, undefined, 'a face that was accepted needs no note');
  const shut = await world(t, {sayReply: () => [409, {error: {code: 'say.refused', message: 'You cannot speak here.'}}, {}]});
  const s = await shut.cli('say', 'Hello', '--to', 'Zed');
  assert.notEqual(s.code, 0, 'speech that did not go out is a failure'); assert.match(s.err, /say/);
});

test('A2: a refused gesture is reported once; a bow that would stand a seated Soul waits for --stand-ok', async t => {
  const w = await world(t, {refuse: new Set(['cheer:here'])}), r = await w.cli('say', 'Bravo', '--to', 'Bo', '--gesture', 'cheer');
  assert.equal(r.code, 0); assert.equal(r.json.gestured.accepted, false); assert.equal(r.json.gestured.code, 'gesture.too-far');
  assert.equal(writes(w.seen).filter(([c]) => c === 'cheer:here').length, 1, 'never retried');
  const seated = await world(t, {posture: 'seated'}), b = await seated.cli('say', 'Welcome', '--to', 'Bo', '--gesture', 'bow');
  assert.equal(b.code, 0); assert.equal(b.json.gestured.sent, false); assert.match(b.json.gestured.reason, /stand you up \(you are seated\).*--stand-ok/);
  assert.deepEqual(writes(seated.seen), [['face:s_bo', null, true], ['say', 'Welcome']]);
  const ok = await seated.cli('say', 'Welcome', '--to', 'Bo', '--gesture', 'bow', '--stand-ok');
  assert.equal(ok.json.gestured.accepted, true); assert.deepEqual(writes(seated.seen).at(-1), ['bow:here', {to: 's_bo'}, true]);
  const nod = await seated.cli('say', 'Yes', '--to', 'Bo', '--gesture', 'nod');
  assert.equal(nod.json.gestured.accepted, true, 'a nod keeps you seated, so it needs no --stand-ok');
  for (const posture of ['standing', 'busy', 'walking', 'waiting']) {
    const up = await world(t, {posture}), s = await up.cli('say', 'Welcome', '--to', 'Bo', '--gesture', 'bow');
    assert.equal(s.json.gestured.accepted, true, `a ${posture} bow goes as asked: only seated or lying waits`);
  }
  const lying = await world(t, {posture: 'lying'}), l = await lying.cli('say', 'Welcome', '--to', 'Bo', '--gesture', 'bow');
  assert.equal(l.json.gestured.sent, false);
});

test('A3: plain say sends exactly what it did; flags in the middle are speech; bad flags send nothing', async t => {
  const w = await world(t), r = await w.cli('say', 'Hello');
  assert.equal(r.code, 0); assert.deepEqual(r.json, {said: {id: 'sp_1', heardBy: 1}});
  assert.deepEqual(w.seen.map(([m, u, b]) => [m, u, b]), [['POST', '/v1/edge/say', {text: 'Hello'}]], 'no offers read, no act');
  await w.cli('say', 'tell', '--to', 'Bo', 'hi'); assert.deepEqual(writes(w.seen).at(-1), ['say', 'tell --to Bo hi']);
  const n = w.seen.length;
  for (const bad of [['Hi', '--to', 'Bo', '--gesture', 'dance'], ['Hi', '--gesture', 'nod'], ['--to', 'Bo'], ['Hi', '--to'], ['Hi', '--to', 'A', '--to', 'B']]) {
    const e = await w.cli('say', ...bad); assert.notEqual(e.code, 0, bad.join(' ')); assert.match(e.err, /usage: say/);
  }
  assert.equal(w.seen.length, n, 'a usage error sends nothing');
  const closes = await w.cli('say', 'Done', '--to', 'Bo', '--for', 'msg_1');
  assert.equal(closes.json.faced.accepted, true); assert.equal(closes.json.closed, true, '--for still closes the message');
});

// Re-pin onto 2.24.2 (#1328): `--key` is one more trailing flag, in any order with --to, --gesture and --for, and goes
// with the speech; a bad key sends nothing.
test('#1328 with #1354: say --to takes --key among its trailing flags and still turns, speaks and gestures', async t => {
  assert.deepEqual(sayFlags(['hi', '--to', 'Bo', '--key', 'k-1', '--for', 'msg_1']), {to: 'Bo', key: 'k-1', words: ['hi', '--for', 'msg_1']});
  assert.deepEqual(sayFlags(['the', '--key', 'is', 'here']), {words: ['the', '--key', 'is', 'here']}, '--key inside the speech is words');
  const {seen, cli} = await world(t);
  const r = await cli('say', 'hello', '--to', 'Bo', '--gesture', 'nod', '--key', 'say-k-1');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(seen.filter(([m]) => m === 'POST').map(([, u, b]) => u === '/v1/edge/act' ? b.capability : u), ['face:s_bo', '/v1/edge/say', 'nod:here']);
  assert.equal(r.json.faced.accepted, true); assert.equal(r.json.gestured.accepted, true);
  const bad = await cli('say', 'hello', '--to', 'Bo', '--key', 'has space');
  assert.notEqual(bad.code, 0);
});

// #1358 review (steward-35): speech the world did not confirm sends no gesture; a rerun the world answers from the first
// speech (same key) does not gesture twice, while a key held from an unconfirmed run still gestures on its rerun.
test('#1358: no gesture after unconfirmed speech, and none twice for a replayed speech', async t => {
  let mode = 'lost';
  const replies = {lost: () => [502, {raw: 'bad gateway'}, {}], replay: () => [200, {said: {id: 'sp_1', heardBy: 1}}, {'idempotent-replay': 'true'}], ok: () => [200, {said: {id: 'sp_1', heardBy: 1}}, {}]};
  const {seen, cli} = await world(t, {sayReply: () => replies[mode]()});
  const posts = () => seen.filter(([m]) => m === 'POST').map(([, u, b]) => u === '/v1/edge/act' ? b.capability : u);

  const lost = await cli('say', 'hello', '--to', 'Bo', '--gesture', 'nod');
  assert.equal(lost.code, 75, lost.err); assert.equal(lost.json.unconfirmed, true); assert.equal(lost.json.faced.accepted, true);
  assert.equal(lost.json.gestured, undefined); assert.ok(!posts().includes('nod:here'), 'no gesture after speech the world did not confirm');

  mode = 'replay'; seen.length = 0;   // the same command again: the held key, and the world answers from the first speech
  const held = await cli('say', 'hello', '--to', 'Bo', '--gesture', 'nod');
  assert.equal(held.code, 0, held.err); assert.equal(held.json.resent, true);
  assert.deepEqual(posts(), ['face:s_bo', '/v1/edge/say', 'nod:here'], 'the unconfirmed run sent no gesture, so this one does');

  seen.length = 0;   // a rerun of a confirmed speech with its own --key: the world replays it
  const again = await cli('say', 'hello', '--to', 'Bo', '--gesture', 'nod', '--key', 'k-say-1');
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(posts(), ['face:s_bo', '/v1/edge/say'], 'the gesture is not sent twice');
  assert.equal(again.json.gestured.sent, false); assert.match(again.json.gestured.reason, /already had this speech/);

  mode = 'ok'; seen.length = 0;
  assert.equal((await cli('say', 'hello', '--to', 'Bo', '--gesture', 'nod', '--key', 'k-say-2')).json.gestured.accepted, true, 'a fresh speech gestures');
});

// #1361 review (steward-35): the run's own first try was taken but its answer lost; call() retries with the same key and the
// world replays the first answer. That is this run's speech, not an earlier one: the gesture still goes, once.
test('#1361: a dropped first try replayed to its retry still gestures once', async t => {
  let n = 0;
  const {seen, cli} = await world(t, {sayReply: () => (++n === 1 ? 'drop' : [200, {said: {id: 'sp_1', heardBy: 1}}, {'idempotent-replay': 'true'}])});
  const r = await cli('say', 'hello', '--to', 'Bo', '--gesture', 'nod');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(seen.filter(([m]) => m === 'POST').map(([, u, b]) => u === '/v1/edge/act' ? b.capability : u), ['face:s_bo', '/v1/edge/say', '/v1/edge/say', 'nod:here']);
  assert.equal(r.json.gestured.accepted, true); assert.equal(r.json.gestured.sent, undefined);
});
