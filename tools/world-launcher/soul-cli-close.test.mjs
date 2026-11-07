// #1269: closing an owner message is part of the command that finishes it. `closed` is read from the world, never inferred.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {clipped} from './soul/eden.mjs';

const CLI = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));

async function world(t, {results = {}, saySays = 200, actAnswer} = {}) {
  const seen = [], dir = mkdtempSync(join(tmpdir(), 'eden-close-'));
  const server = createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const body = JSON.parse(b || '{}'), url = req.url.split('?')[0], send = (s, j) => {res.writeHead(s, {'content-type': 'application/json'}); res.end(JSON.stringify(j));};
      seen.push([req.method, url, body]);
      if (url === '/v1/edge/say') return saySays === 200 ? send(200, {said: {id: 'sp_1', heardBy: 1}}) : send(saySays, {error: {code: 'say.refused', message: 'No.'}});
      if (url === '/v1/edge/act') return send(200, actAnswer(body));
      const m = /^\/v1\/edge\/inbox\/([^/]+)(\/ack|\/result)?$/.exec(url);
      if (m?.[2] === '/result' && results.refuse) return send(404, {error: {code: 'not-found', message: 'no such message'}});
      if (m?.[2] === '/result') {results[m[1]] = body; return send(200, {inbox: {}});}
      if (m?.[2] === '/ack') return send(200, {inbox: {}});
      if (m) return send(200, {message: {id: m[1], ...(results[m[1]] ? {result: results[m[1]].text ?? results[m[1]]} : {})}});
      send(200, {});
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, {recursive: true, force: true});});
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: `http://127.0.0.1:${server.address().port}`, soul: 's_pip', token: 'tok'}));
  const cli = (...args) => new Promise(res => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (e, out, err) => {let json = null; try {json = JSON.parse(out);} catch {/* words */} res({code: e?.code ?? 0, json, err});}));
  return {seen, cli, results};
}
const posted = (seen, tail) => seen.filter(([m, u]) => m === 'POST' && u.endsWith(tail));

test('say --for says it and closes the message; a refused say closes nothing; without --for nothing changes', async t => {
  const w = await world(t), r = await w.cli('say', 'Good', 'morning', '--for', 'msg_1');
  assert.equal(r.code, 0); assert.equal(r.json.closed, true); assert.equal(r.json.said.id, 'sp_1');
  assert.deepEqual(posted(w.seen, '/say')[0][2], {text: 'Good morning'});
  assert.deepEqual(posted(w.seen, '/msg_1/result')[0][2], {outcome: 'done', text: 'Said: Good morning'});
  const plain = await w.cli('say', 'Hello'); assert.equal(plain.json.closed, undefined); assert.equal(posted(w.seen, '/result').length, 1);
  assert.equal((await w.cli('say', 'Hello', '--for')).code, 1);
  const no = await world(t, {saySays: 403}), refused = await no.cli('say', 'Hello', '--for', 'msg_2');
  assert.notEqual(refused.code, 0); assert.equal(posted(no.seen, '/result').length, 0, 'unsaid, so unclosed');
});

test('a close that fails after the speech says so and exits 0: what was said stays said', async t => {
  const w = await world(t, {results: {refuse: true}}), r = await w.cli('say', 'Hello', '--for', 'msg_gone');
  assert.equal(r.code, 0); assert.equal(r.json.closed, false); assert.match(r.json.why, /no such message/);
});

test('ack --close acks and closes with the reply; plain ack does not close', async t => {
  const w = await world(t), r = await w.cli('ack', 'msg_1', 'It is about a mill.', '--close', 'done');
  assert.equal(r.json.acked, 'msg_1'); assert.equal(r.json.closed, true);
  assert.deepEqual(posted(w.seen, '/msg_1/ack')[0][2], {reply: 'It is about a mill.'});
  assert.deepEqual(posted(w.seen, '/msg_1/result')[0][2], {outcome: 'done', text: 'It is about a mill.'});
  const no = await w.cli('ack', 'msg_2', 'There is no orchard here.', '--close', 'failed'); assert.equal(posted(w.seen, '/msg_2/result')[0][2].outcome, 'failed'); assert.equal(no.json.closed, true);
  const plain = await w.cli('ack', 'msg_3', 'Got it'); assert.equal(plain.json.closed, undefined); assert.equal(posted(w.seen, '/msg_3/result').length, 0);
  for (const bad of [['ack', 'msg_4', 'x', '--close', 'maybe'], ['ack', 'msg_4', '--close', 'done']]) assert.equal((await w.cli(...bad)).code, 1, bad.join(' '));
  assert.equal(w.seen.filter(([, u]) => u.includes('msg_4')).length, 0, 'a bad flag sends nothing');
});

test('act prints closed only when the world has closed the message', async t => {
  const ended = (extra = {}) => ({accepted: true, channel: 'body', receipt: {id: 'r_1', capability: 'walk:a', phase: 'completed', done: 'walked.'}, for: 'msg_1', ...extra});
  const closed = await world(t, {results: {msg_1: {text: 'walked.'}}, actAnswer: () => ended()});
  assert.equal((await closed.cli('act', 'walk:a', '--for', 'msg_1')).json.closed, true);
  const notYet = await world(t, {actAnswer: () => ended()});
  assert.equal((await notYet.cli('act', 'walk:a', '--for', 'msg_1')).json.closed, undefined, 'ended, but the world did not close it');
  const unlinked = await world(t, {results: {msg_1: {text: 'x'}}, actAnswer: () => ended({for: undefined})});
  assert.equal((await unlinked.cli('act', 'walk:a', '--for', 'none')).json.closed, undefined);
  assert.equal(unlinked.seen.filter(([m, u]) => m === 'GET' && u.includes('/inbox/')).length, 0, 'no read for an unlinked act');
  const going = await world(t, {results: {msg_1: {text: 'x'}}, actAnswer: () => ({...ended(), receipt: {id: 'r_1', capability: 'walk:a', phase: 'started'}})});
  assert.equal((await going.cli('act', 'walk:a', '--for', 'msg_1')).json.closed, undefined, 'still going');
});

test('text over 140 characters is clipped at a word and says so', async t => {
  const long = 'a walk along the pond and back again '.repeat(6), c = clipped(long);
  assert.ok(c.text.length <= 140, c.text); assert.ok(c.text.endsWith('…')); assert.equal(c.clipped, true);
  assert.deepEqual(clipped('short'), {text: 'short'}); assert.ok(clipped('x'.repeat(200)).text.length <= 140);
  const w = await world(t), r = await w.cli('result', 'msg_1', 'done', long);
  assert.equal(r.code, 0); assert.equal(r.json.clipped, true); assert.ok(posted(w.seen, '/msg_1/result')[0][2].text.length <= 140);
  const a = await w.cli('ack', 'msg_2', long); assert.equal(a.code, 0); assert.equal(a.json.clipped, true); assert.ok(posted(w.seen, '/msg_2/ack')[0][2].reply.length <= 140);
});
