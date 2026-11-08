// #1314: `ack` and `listen` list the owner's older messages that are still open with nothing running for them. The CLI only
// lists: it sends no close, and the world makes none it wouldn't have made.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {firstWords, heardWith, olderThan, orphanState} from './soul/eden.mjs';

const CLI = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));

test('firstWords keeps a short text and cuts a long one at a word', () => {
  assert.equal(firstWords('  Walk   to the\nflag '), 'Walk to the flag');
  const long = firstWords('Walk to the orchard flag, then sit on the bench by the pond for a while');
  assert.ok(long.length <= 40); assert.match(long, /…$/); assert.equal(long, 'Walk to the orchard flag, then sit on…');
  assert.equal(firstWords(undefined), '');
});

test('the record keeps one batch per answer, newest last, at most 8, and a known message keeps its place', () => {
  let r = heardWith([], [{id: 'm1', text: 'a'}]);
  r = heardWith(r, [{id: 'm2', text: 'b'}, {id: 'm3', text: 'c'}]);
  assert.deepEqual(r.map(h => [h.id, h.batch]), [['m1', 'm1'], ['m2', 'm2'], ['m3', 'm2']]);
  r = heardWith(r, [{id: 'm1', text: 'again'}, {id: 'm4', text: 'd'}]);
  assert.deepEqual(r.map(h => h.id), ['m1', 'm2', 'm3', 'm4']); assert.equal(r[0].text, 'a');
  for (let i = 5; i < 20; i++) r = heardWith(r, [{id: `m${i}`, text: 'x'}]);
  assert.equal(r.length, 8); assert.equal(r[0].id, 'm12');
});

test('older means before the newest of these messages and not in their batch', () => {
  const r = heardWith(heardWith(heardWith([], [{id: 'm1'}]), [{id: 'm2'}, {id: 'm3'}]), [{id: 'm4'}]);
  assert.deepEqual(olderThan(r, ['m4']).map(h => h.id), ['m1', 'm2', 'm3']);
  assert.deepEqual(olderThan(r, ['m3']).map(h => h.id), ['m1'], 'm2 came in the same answer as m3');
  assert.deepEqual(olderThan(r, ['m2']).map(h => h.id), ['m1'], 'm3 is newer');
  assert.deepEqual(olderThan(r, ['m1']), []);
  assert.deepEqual(olderThan(r, ['m9']).map(h => h.id), ['m1', 'm2', 'm3', 'm4'], 'unrecorded: the newest');
});

test('an orphan is open, with nothing running, replaced, planned or about to be served', () => {
  const open = {status: 200, data: {message: {id: 'm1', state: 'acknowledged'}}}, rec = (phase, held) => ({status: 200, data: {receipt: {phase}}, held});
  assert.equal(orphanState({message: open}), 'list', 'an acked card with no act');
  assert.equal(orphanState({message: open, receipts: [rec('completed')]}), 'list', 'its walk ended open');
  assert.equal(orphanState({message: open, receipts: [rec('started', true)]}), 'list', 'a held sit holds nothing (#1295)');
  assert.equal(orphanState({message: open, receipts: [{status: 404}]}), 'list', 'too old to hold a receipt');
  assert.equal(orphanState({message: open, receipts: [rec('completed'), rec('started')]}), 'keep', 'an act still going');
  assert.equal(orphanState({message: open, receipts: [rec('replaced')]}), 'keep', 'the world sweeps a replaced act');
  assert.equal(orphanState({message: open, receipts: [{status: 500}]}), 'keep', 'unread is not known');
  assert.equal(orphanState({message: open, plan: true}), 'keep');
  assert.equal(orphanState({message: open, nextAct: true}), 'keep');
  assert.equal(orphanState({message: {status: 200, data: {message: {id: 'm1', result: 'Done', outcome: 'done'}}}}), 'drop');
  assert.equal(orphanState({message: {status: 404}}), 'drop');
  assert.equal(orphanState({message: {status: 503}}), 'keep');
  assert.equal(orphanState({message: null}), 'keep');
});

async function world(t, {messages = {}, receipts = {}, backlog = [], reads = 200, events = []} = {}) {
  const seen = [], dir = mkdtempSync(join(tmpdir(), 'eden-still-'));
  const server = createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const body = JSON.parse(b || '{}'), url = req.url.split('?')[0], send = (s, j) => {res.writeHead(s, {'content-type': 'application/json'}); res.end(JSON.stringify(j));};
      seen.push([req.method, url, body]);
      if (url === '/v1/edge/wait') return send(200, {cursor: 'c_1', events});
      if (url === '/v1/edge/inbox/listen') return send(200, {inbox: {}, backlog: backlog.shift() ?? []});
      if (url.startsWith('/v1/edge/receipts/')) { const r = receipts[url.split('/').pop()]; return r ? send(200, {receipt: r}) : send(404, {error: {code: 'not-found', message: 'no such receipt'}}); }
      const m = /^\/v1\/edge\/inbox\/([^/]+)(\/ack|\/result)?$/.exec(url);
      if (m?.[2] === '/ack') { messages[m[1]] = {...messages[m[1]], state: 'acknowledged'}; return send(200, {inbox: {}}); }
      if (m?.[2] === '/result') { messages[m[1]] = {...messages[m[1]], result: body.text, outcome: body.outcome}; return send(200, {inbox: {}}); }
      if (m && reads !== 200) return send(reads, {error: {code: 'broken', message: 'the inbox broke'}});
      if (m) return messages[m[1]] ? send(200, {message: {id: m[1], ...messages[m[1]]}}) : send(404, {error: {code: 'not-found', message: 'no such message'}});
      send(200, {});
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, {recursive: true, force: true});});
  const state = (patch = {}) => writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: `http://127.0.0.1:${server.address().port}`, soul: 's_pip', token: 'tok', ...patch}));
  state();
  const read = () => JSON.parse(readFileSync(join(dir, '.eden-agent.json'), 'utf8'));
  const cli = (...args) => new Promise(res => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (e, out, err) => {let json = null; try {json = JSON.parse(out);} catch {/* words */} res({code: e?.code ?? 0, json, err});}));
  return {seen, cli, state, read, messages};
}
const posted = (seen, tail) => seen.filter(([m, u]) => m === 'POST' && u.endsWith(tail));

test('ack lists an older acked card with no act, and closes nothing', async t => {
  const card = {id: 'msg_1', text: 'What is this place called? I would like to know its name', state: 'delivered'}, walk = {id: 'msg_2', text: 'Walk to the flag', state: 'delivered'};
  const w = await world(t, {messages: {msg_1: {...card}, msg_2: {...walk}}, backlog: [[card], [walk]]});
  await w.cli('listen', '--once');
  const first = await w.cli('ack', 'msg_1', 'A hamlet by a pond.');
  assert.equal(first.json.stillOpen, undefined, 'nothing older');
  const l = await w.cli('listen', '--once');
  assert.deepEqual(l.json.messages.map(m => m.id), ['msg_2']);
  assert.equal(l.json.stillOpen, undefined, 'the next act would serve msg_1 by default: something is about to run for it');
  const a = await w.cli('ack', 'msg_2', 'Got it: walking.');
  assert.deepEqual(a.json.stillOpen, [{id: 'msg_1', text: 'What is this place called? I would…'}]);
  assert.match(a.json.stillOpenNext, /result <id> done\|failed/);
  assert.equal(posted(w.seen, '/result').length, 0, 'listing closes nothing');
  assert.deepEqual(posted(w.seen, '/ack').map(([, u]) => u), ['/v1/edge/inbox/msg_1/ack', '/v1/edge/inbox/msg_2/ack']);
  await w.cli('result', 'msg_1', 'done', 'Answered.');
  assert.deepEqual(w.read().heard.map(h => h.id), ['msg_2'], 'closed through this CLI: forgotten');
});

test('a linked act still going or replaced keeps a message off the list; one ended or held puts it on', async t => {
  const msgs = {m_run: {state: 'acknowledged', text: 'run'}, m_rep: {state: 'acknowledged', text: 'rep'}, m_end: {state: 'acknowledged', text: 'Walk, then sit'}, m_sit: {state: 'acknowledged', text: 'Sit down'}, m_shut: {state: 'acknowledged', text: 'done', result: 'Done.', outcome: 'done'}, m_new: {state: 'delivered', text: 'Now come here'}};
  const w = await world(t, {messages: msgs, receipts: {r_run: {id: 'r_run', phase: 'started'}, r_rep: {id: 'r_rep', phase: 'replaced'}, r_end: {id: 'r_end', phase: 'completed'}, r_sit: {id: 'r_sit', phase: 'started'}}});
  w.state({heard: ['m_run', 'm_rep', 'm_end', 'm_sit', 'm_shut', 'm_gone'].map(id => ({id, text: msgs[id]?.text ?? '', batch: id})),
    links: [{receipt: 'r_run', message: 'm_run'}, {receipt: 'r_rep', message: 'm_rep'}, {receipt: 'r_end', message: 'm_end'}, {receipt: 'r_sit', message: 'm_sit', held: true}]});
  const a = await w.cli('ack', 'm_new', 'Got it.');
  assert.deepEqual(a.json.stillOpen.map(x => x.id), ['m_end', 'm_sit']);
  assert.deepEqual(w.read().heard.map(h => h.id), ['m_run', 'm_rep', 'm_end', 'm_sit', 'm_new'], 'closed and unknown messages leave the record');
  assert.equal(posted(w.seen, '/result').length, 0);
});

test('messages in one listen answer are never listed against each other, and a failed read lists nothing', async t => {
  const one = {id: 'm_a', text: 'First', state: 'delivered'}, two = {id: 'm_b', text: 'Second', state: 'delivered'};
  const w = await world(t, {messages: {m_a: {...one}, m_b: {...two}}, backlog: [[one, two]]});
  const l = await w.cli('listen', '--once');
  assert.equal(l.json.stillOpen, undefined);
  await w.cli('ack', 'm_a', 'Got it.');
  const b = await w.cli('ack', 'm_b', 'Got it.');
  assert.equal(b.json.stillOpen, undefined, 'same batch');
  const broken = await world(t, {reads: 500, messages: {m_x: {state: 'delivered'}}});
  broken.state({heard: [{id: 'm_old', text: 'old', batch: 'm_old'}]});
  const r = await broken.cli('ack', 'm_x', 'Got it.');
  assert.equal(r.code, 0); assert.equal(r.json.stillOpen, undefined); assert.equal(r.json.acked, 'm_x');
  assert.deepEqual(broken.read().heard.map(h => h.id), ['m_old', 'm_x'], 'unread is kept to ask again');
});

test('with nothing older the answers carry no new keys', async t => {
  const m = {id: 'm_1', text: 'Hello', state: 'delivered'};
  const w = await world(t, {messages: {m_1: {...m}}, backlog: [[m]]});
  const l = await w.cli('listen', '--once'), a = await w.cli('ack', 'm_1', 'Hi.');
  assert.deepEqual(Object.keys(l.json).filter(k => /stillOpen/.test(k)), []);
  assert.deepEqual(Object.keys(a.json).sort(), ['acked', 'reply']);
});

test('ack --close takes its message out of the record, and lists nothing from its own answer', async t => {
  const one = {id: 'm_a', text: 'Is it raining?', state: 'delivered'}, two = {id: 'm_b', text: 'Walk home', state: 'delivered'};
  const w = await world(t, {messages: {m_a: {...one}, m_b: {...two}}, backlog: [[one, two]]});
  await w.cli('listen', '--once');
  const a = await w.cli('ack', 'm_a', 'No.', '--close', 'done');
  assert.equal(a.json.closed, true); assert.equal(a.json.stillOpen, undefined, 'm_b came in the same answer');
  assert.deepEqual(w.read().heard.map(h => h.id), ['m_b']);
  const again = await w.cli('ack', 'm_a', 'No.', '--close', 'done');
  assert.equal(again.json.already, 'done'); assert.deepEqual(w.read().heard.map(h => h.id), ['m_b'], 'already closed: not recorded again');
});

test('a sit that asked for its own seconds is still running while held: wait never marks it, so it is never listed', async t => {
  const sit = {id: 'r_sit', capability: 'sit:bench', phase: 'started'};
  const held = {id: 'e_1', kind: 'activity.observed', receipt: {...sit}, action: {status: 'executing', phase: 'seated'}, body: {posture: 'seated', seated: true}};
  for (const timed of [true, false]) {
    const w = await world(t, {messages: {m_sit: {state: 'acknowledged', text: 'Sit'}, m_new: {state: 'delivered', text: 'Come here'}}, receipts: {r_sit: sit}, events: [held]});
    w.state({heard: [{id: 'm_sit', text: 'Sit', batch: 'm_sit'}], lastReceipt: 'r_sit', links: [{receipt: 'r_sit', message: 'm_sit', ...(timed ? {timed: true} : {})}]});
    const waited = await w.cli('wait', '2', 'r_sit');
    assert.equal(waited.json.receipt.observed, 'seated', 'the wait saw the pose held');
    assert.equal(w.read().links[0].held, timed ? undefined : true);
    const a = await w.cli('ack', 'm_new', 'Got it.');
    assert.deepEqual(a.json.stillOpen?.map(x => x.id), timed ? undefined : ['m_sit']);
  }
});
