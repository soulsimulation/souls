// 2.24.8 (#1381, #1420): `stop` sends stop:current, this Soul's own stop for the act under way, and prints the world's
// answer, refusals included; a world without stop:current is told apart and said in words.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stopAnswer} from './soul/eden.mjs';

const CLI = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));

async function world(t, answer) {
  const acts = [], dir = mkdtempSync(join(tmpdir(), 'eden-stop-'));
  const server = createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const body = JSON.parse(b || '{}'), url = req.url.split('?')[0], send = (s, j) => {res.writeHead(s, {'content-type': 'application/json'}); res.end(JSON.stringify(j));};
      if (url === '/v1/edge/act') {acts.push(body); return send(200, answer(body));}
      if (url.startsWith('/v1/edge/operations')) return send(200, {operations: []});
      send(200, {});
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, {recursive: true, force: true});});
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: `http://127.0.0.1:${server.address().port}`, soul: 's_ada', token: 'tok'}));
  const cli = (...args) => new Promise(res => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (e, out, err) => {let json = null; try {json = JSON.parse(out);} catch {/* words */} res({code: e?.code ?? 0, json, out, err});}));
  return {acts, cli, dir};
}

test('#1381: stop sends stop:current (strict, keyed), with the receipt it names, and prints the stopped act', async t => {
  const {acts, cli} = await world(t, () => ({accepted: true, channel: 'body', receipt: {id: 'r_stop', capability: 'stop:current', phase: 'completed'}, stopped: 'r_walk'}));
  const r = await cli('stop', '--json');
  assert.equal(r.code, 0, r.err);
  assert.equal(acts[0].capability, 'stop:current'); assert.equal(acts[0].strict, true); assert.ok(acts[0].clientRef, 'keyed like any act');
  assert.deepEqual(acts[0].params ?? {}, {}, 'no receipt: the act under way');
  assert.equal(r.json.accepted, true); assert.equal(r.json.receipt.id, 'r_stop');
  const plain = await cli('stop', 'r_walk');
  assert.deepEqual(acts[1].params, {receipt: 'r_walk'});
  assert.equal(plain.json.stopped, 'r_walk', 'the brief output names the act the world stopped'); assert.equal(r.json.stopped, 'r_walk');
  for (const bad of [['r_walk', 'extra'], ['--wait', 'r_walk'], ['--bogus'], ['--for'], ['--key', '--json']]) {
    const r2 = await cli('stop', ...bad);
    assert.notEqual(r2.code, 0, bad.join(' ')); assert.match(r2.err, /usage: stop/, bad.join(' '));
  }
  assert.equal(acts.length, 2, 'stray words and flags are refused before anything is sent');
  await cli('stop', '--wait', '5', '--key', 'k-stop-1', '--json');
  assert.equal(acts.length, 3, 'stop\'s own flags go through');
});

test('#1381: every refusal is the world\'s answer; a shared carry names its stop-carry offer', async t => {
  const answers = {
    'act.none-running': 'Nothing to stop: walk:knoll already completed at tick 120.',
    'act.already-ended': 'That act already ended (completed).',
    'act.not-started': 'That act has not started yet.',
    'act.shared': 'This carry is shared with Bo; stop it with stop-carry:op_7 so both of you put it down.',
    'ride.aloft': 'You are aboard the balloon in flight; it sets you down when it lands.',
    'receipt.unknown': 'No receipt r_nope here.',
  };
  let code = 'act.none-running';
  const {acts, cli} = await world(t, () => ({accepted: false, code, reason: answers[code]}));
  for (code of Object.keys(answers)) {
    const r = await cli('stop');
    assert.equal(r.code, 0, r.err); assert.equal(r.json.accepted, false); assert.equal(r.json.code, code); assert.equal(r.json.reason, answers[code]);
    assert.equal(r.json.next, code === 'act.shared' ? 'stop-carry:op_7' : undefined, code);
  }
  assert.equal(acts.length, 6, 'one try each, never retried');
});

test('#1381: a world without stop:current says so in words, and nothing else is sent', async t => {
  const {acts, cli} = await world(t, (b) => ({accepted: false, code: 'capability.unknown', capability: b.capability, reason: '"stop:current" is not an offer on this Soul right now, so nothing was done.'}));
  const r = await cli('stop');
  assert.equal(r.json.code, 'stop.unsupported'); assert.equal(r.json.worldCode, 'capability.unknown'); assert.match(r.json.reason, /no stop:current/);
  assert.equal(acts.length, 1, 'no stand:here or other fallback is sent');
  assert.deepEqual(stopAnswer({accepted: true, receipt: {id: 'r'}}), {accepted: true, receipt: {id: 'r'}});
});

test('#1436 review: an old world\'s body.unsupported is stop.unsupported; act.shared prefers the world\'s offer and drops a full stop', async t => {
  let answer = {accepted: false, code: 'body.unsupported', reason: 'Floater bodies cannot stop; try glide.'};
  const {acts, cli} = await world(t, () => answer);
  assert.equal((await cli('stop')).json.code, 'stop.unsupported');
  answer = {accepted: false, code: 'act.shared', reason: 'Shared with Bo: stop it with stop-carry:op_9.', did_you_mean: [{id: 'stop-carry:op_8', label: 'Stop carrying'}]};
  assert.equal((await cli('stop')).json.next, 'stop-carry:op_8', 'the world\'s offer first');
  answer = {accepted: false, code: 'act.shared', reason: 'Shared with Bo: stop it with stop-carry:op_9.'};
  assert.equal((await cli('stop')).json.next, 'stop-carry:op_9', 'no trailing full stop');
  assert.equal(acts.length, 3);
});

test('#1436 review: a stop serves an owner message only when named; the implicit link after an ack is not used', async t => {
  const {acts, cli, dir} = await world(t, () => ({accepted: true, channel: 'body', receipt: {id: 'r_stop', capability: 'stop:current', phase: 'completed'}, stopped: 'r_walk'}));
  const file = join(dir, '.eden-agent.json'), state = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({...state, lastAcked: 'msg_0', lastAckedAt: new Date().toISOString(), lastAckedActed: false}));   // just acked
  await cli('stop');
  assert.equal(acts[0].for, undefined, 'no link by default'); assert.equal(acts[0].forDefault, undefined);
  await cli('stop', '--for', 'msg_1');
  assert.equal(acts[1].for, 'msg_1', '--for names the message');
});
