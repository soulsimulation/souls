// #1269: closing an owner message is part of the command that finishes it. `closed` is read from the world, never inferred.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {clipped, keepLinks} from './soul/eden.mjs';

const CLI = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));

async function world(t, {results = {}, saySays = 200, actAnswer, waitReceipt, reads = 200, receipts = 200, receiptOf} = {}) {
  const seen = [], acked = new Set(), dir = mkdtempSync(join(tmpdir(), 'eden-close-'));
  const server = createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const body = JSON.parse(b || '{}'), url = req.url.split('?')[0], send = (s, j) => {res.writeHead(s, {'content-type': 'application/json'}); res.end(JSON.stringify(j));};
      seen.push([req.method, url, body]);
      if (url === '/v1/edge/say') return saySays === 200 ? send(200, {said: {id: 'sp_1', heardBy: 1}}) : send(saySays, {error: {code: 'say.refused', message: 'No.'}});
      if (url === '/v1/edge/act') return send(200, actAnswer(body));
      if (url.startsWith('/v1/edge/receipts/') && receiptOf) return send(200, {receipt: receiptOf(url.split('/').pop())});
      if (url.startsWith('/v1/edge/receipts/')) return receipts === 200 ? send(200, {receipt: waitReceipt}) : send(receipts, {error: {code: 'broken', message: 'the receipts broke'}});
      if (url === '/v1/edge/wait') return send(200, {cursor: 'c_1', events: [{kind: 'receipt.updated', receipt: waitReceipt}]});
      const m = /^\/v1\/edge\/inbox\/([^/]+)(\/ack|\/result)?$/.exec(url);
      if (m?.[2] === '/result' && results.refuse) return send(404, {error: {code: 'not-found', message: 'no such message'}});
      if (m?.[2] === '/result' && results.running) return send(409, {error: {code: 'message.act-running', message: 'not closed: walk:a is still going'}});
      if (m?.[2] === '/result') {results[m[1]] = body; return send(200, {inbox: {}});}
      if (m?.[2] === '/ack') {acked.add(m[1]); return send(200, {inbox: {}});}
      if (m && reads !== 200) return send(reads, {error: {code: reads === 503 ? 'world.busy' : 'broken', message: 'the inbox broke'}});
      if (m) return send(200, {message: {id: m[1], ...(acked.has(m[1]) ? {state: 'acknowledged'} : {}), ...(results[m[1]] ? {result: results[m[1]].text ?? results[m[1]], outcome: results[m[1]].outcome} : {})}});
      send(200, {});
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, {recursive: true, force: true});});
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: `http://127.0.0.1:${server.address().port}`, soul: 's_pip', token: 'tok'}));
  const cli = (...args) => new Promise(res => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (e, out, err) => {let json = null; try {json = JSON.parse(out);} catch {/* words */} res({code: e?.code ?? 0, json, err});}));
  return {seen, cli, results, dir};
}
const posted = (seen, tail) => seen.filter(([m, u]) => m === 'POST' && u.endsWith(tail));

test('say --for says it and closes the message; a refused say closes nothing; without --for nothing changes', async t => {
  const w = await world(t), r = await w.cli('say', 'Good', 'morning', '--for', 'msg_1');
  assert.equal(r.code, 0); assert.equal(r.json.closed, true); assert.equal(r.json.said.id, 'sp_1');
  assert.deepEqual(posted(w.seen, '/say')[0][2], {text: 'Good morning'});
  assert.deepEqual(posted(w.seen, '/msg_1/result')[0][2], {outcome: 'done', text: 'Said: Good morning'});
  const plain = await w.cli('say', 'Hello'); assert.equal(plain.json.closed, undefined); assert.equal(posted(w.seen, '/result').length, 1);
  assert.deepEqual(posted(w.seen, '/say').at(-1)[2], {text: 'Hello'});
  const words = await w.cli('say', 'what', '--for', 'means'); assert.equal(words.json.closed, undefined); assert.deepEqual(posted(w.seen, '/say').at(-1)[2], {text: 'what --for means'}, 'only a message id is a flag');
  await w.cli('say', 'Two\nlines', '--for', 'msg_9'); assert.equal(posted(w.seen, '/msg_9/result')[0][2].text, 'Said: Two lines', 'a result is one line');
  const no = await world(t, {saySays: 403}), refused = await no.cli('say', 'Hello', '--for', 'msg_2');
  assert.notEqual(refused.code, 0); assert.equal(posted(no.seen, '/result').length, 0, 'unsaid, so unclosed');
});

test('a close that fails after the speech says so and exits 0: what was said stays said', async t => {
  const w = await world(t, {results: {refuse: true}}), r = await w.cli('say', 'Hello', '--for', 'msg_gone');
  assert.equal(r.code, 0); assert.equal(r.json.closed, false); assert.match(r.json.why, /no such message/); assert.match(r.json.why, /not by repeating/);
  const unread = await world(t, {reads: 500}), u = await unread.cli('say', 'Hello', '--for', 'msg_1');
  assert.equal(u.code, 0); assert.equal(u.json.closed, false); assert.equal(posted(unread.seen, '/result').length, 0, 'unread, so unclosed: it may be the world\'s already');
});

test('a message the world closed keeps its outcome: say --for and ack --close never replace it', async t => {
  const w = await world(t, {results: {msg_1: {text: 'walk:a failed: blocked', outcome: 'failed'}}}), r = await w.cli('say', 'I could not', '--for', 'msg_1');
  assert.equal(r.code, 0); assert.equal(r.json.said.id, 'sp_1', 'the speech still goes'); assert.equal(r.json.closed, false); assert.equal(r.json.already, 'failed'); assert.match(r.json.why, /already closed/);
  assert.equal(posted(w.seen, '/result').length, 0);
  const late = await w.cli('ack', 'msg_1', 'It went fine', '--close', 'done');
  assert.equal(late.json.closed, false); assert.equal(late.json.reply, undefined, 'nothing went to the card'); assert.equal(posted(w.seen, '/result').length, 0); assert.equal(posted(w.seen, '/ack').length, 0);
});

test('a closed message leaves no default link: the next act can\'t replace the world\'s line', async t => {
  const answer = () => ({accepted: true, channel: 'body', receipt: {id: 'r_1', capability: 'wave:here', phase: 'completed', done: 'waved.'}});
  const w = await world(t, {results: {msg_1: {text: 'walk:a failed: blocked', outcome: 'failed'}}, actAnswer: answer});
  await w.cli('ack', 'msg_1', 'It went fine', '--close', 'done'); await w.cli('act', 'wave:here');
  assert.equal(posted(w.seen, '/act')[0][2].for, undefined, 'ack --close');
  await w.cli('ack', 'msg_1', 'Got it'); await w.cli('say', 'I could not', '--for', 'msg_1'); await w.cli('act', 'wave:here');
  assert.equal(posted(w.seen, '/act')[1][2].for, undefined, 'say --for');
});

test('ack --close that does not close still gets its text to the card, and arms no default link', async t => {
  const answer = () => ({accepted: true, channel: 'body', receipt: {id: 'r_1', capability: 'wave:here', phase: 'completed', done: 'waved.'}});
  const w = await world(t, {reads: 503, actAnswer: answer}), r = await w.cli('ack', 'msg_1', 'A mill by the pond.', '--close', 'done');
  assert.equal(r.code, 0); assert.equal(r.json.closed, false); assert.equal(posted(w.seen, '/result').length, 0);
  assert.deepEqual(posted(w.seen, '/msg_1/ack')[0][2], {reply: 'A mill by the pond.'});
  assert.equal(w.seen.filter(([m, u]) => m === 'GET' && u.includes('/inbox/msg_1')).length, 1, 'one quick read, no retries');
  await w.cli('act', 'wave:here'); assert.equal(posted(w.seen, '/act')[0][2].for, undefined, 'an unrelated act must not close what --close declined to');
  const ok = await world(t), two = await ok.cli('ack', 'msg_2', 'one\ntwo', '--close', 'done');
  assert.equal(two.code, 0); assert.equal(two.json.closed, true); assert.equal(posted(ok.seen, '/msg_2/result')[0][2].text, 'one two', 'a result is one line');
});

test('say --for leaves a message alone while its linked act is going, and closes it once the act has ended', async t => {
  const started = {accepted: true, channel: 'body', receipt: {id: 'r_1', capability: 'walk:a', phase: 'started'}, for: 'msg_1'};
  const w = await world(t, {actAnswer: () => started, waitReceipt: started.receipt});
  await w.cli('act', 'walk:a', '--for', 'msg_1');
  const r = await w.cli('say', 'On my way', '--for', 'msg_1');
  assert.equal(r.json.closed, false); assert.match(r.json.why, /still going.*`result` once it has ended/); assert.equal(posted(w.seen, '/result').length, 0);
  assert.equal((await w.cli('say', 'Next', '--for', 'msg_2')).json.closed, true, 'a link to another message blocks nothing');
  const ended = await world(t, {actAnswer: () => started, waitReceipt: {...started.receipt, phase: 'completed', done: 'walked.'}});
  await ended.cli('act', 'walk:a', '--for', 'msg_1');
  assert.equal((await ended.cli('say', 'Here', '--for', 'msg_1')).json.closed, true);
  const unread = await world(t, {actAnswer: () => started, receipts: 500});
  await unread.cli('act', 'walk:a', '--for', 'msg_1');
  const blind = await unread.cli('say', 'On my way', '--for', 'msg_1');
  assert.equal(blind.json.closed, false, 'an act it could not read may be running'); assert.match(blind.json.why, /could not be read/); assert.equal(posted(unread.seen, '/result').length, 0);
  const pruned = await world(t, {actAnswer: () => started, receipts: 404});
  await pruned.cli('act', 'walk:a', '--for', 'msg_1');
  assert.equal((await pruned.cli('say', 'Here', '--for', 'msg_1')).json.closed, true, 'a receipt too old to hold has ended');
});

test('every message linked to a running receipt is guarded, not only the last (#1289)', async t => {
  const started = (id) => ({accepted: true, channel: 'body', receipt: {id: 'r_1', capability: 'walk:a', phase: 'started'}, for: id});
  const w = await world(t, {actAnswer: (b) => started(b.for), waitReceipt: started().receipt});
  await w.cli('act', 'walk:a', '--for', 'msg_1'); await w.cli('act', 'walk:a', '--for', 'msg_2');
  for (const id of ['msg_1', 'msg_2']) {
    const said = await w.cli('say', 'On my way', '--for', id); assert.equal(said.json.closed, false, id); assert.match(said.json.why, /still going/);
    assert.equal((await w.cli('ack', id, 'Nearly', '--close', 'failed')).json.closed, false, id);
  }
  assert.equal(posted(w.seen, '/result').length, 0);
  const ended = await world(t, {actAnswer: (b) => started(b.for), waitReceipt: {...started().receipt, phase: 'completed', done: 'walked.'}});
  await ended.cli('act', 'walk:a', '--for', 'msg_1'); await ended.cli('act', 'walk:a', '--for', 'msg_2');
  assert.equal((await ended.cli('say', 'Here', '--for', 'msg_1')).json.closed, true, 'once the act has ended');
});

test('the links outlast a long run of repeats, and a re-linked message is guarded by its newest act (#1289)', async t => {
  const started = (id) => ({accepted: true, channel: 'body', receipt: {id: 'r_1', capability: 'sit:a', phase: 'started'}, for: id});
  const w = await world(t, {actAnswer: (b) => started(b.for), waitReceipt: started().receipt});
  for (let i = 1; i <= 12; i++) await w.cli('act', 'sit:a', '--for', `msg_${i}`);
  assert.equal((await w.cli('say', 'Still here', '--for', 'msg_1')).json.closed, false, 'the first of twelve, on a receipt still open');
  assert.equal(posted(w.seen, '/result').length, 0);
  const receipts = {r_1: {id: 'r_1', capability: 'walk:a', phase: 'replaced'}, r_2: {id: 'r_2', capability: 'walk:b', phase: 'started'}};
  let next = 0;
  const re = await world(t, {actAnswer: (b) => ({accepted: true, channel: 'body', receipt: {...receipts[`r_${++next}`], phase: 'started'}, for: b.for}), receiptOf: (id) => receipts[id]});
  await re.cli('act', 'walk:a', '--for', 'msg_1'); await re.cli('act', 'walk:b', '--for', 'msg_1');
  assert.equal((await re.cli('say', 'On my way', '--for', 'msg_1')).json.closed, false, 'its newest act is the one running');
});

test('links: past the cap, the open receipt keeps all of its own; an ended receipt makes room and leaves the others (#1289)', async t => {
  const many = Array.from({length: 70}, (_, i) => ({receipt: 'r_1', message: `msg_${i}`}));
  assert.equal(keepLinks(many, 'r_1').length, 70, 'none on the open receipt goes');
  const mixed = [...Array.from({length: 10}, (_, i) => ({receipt: `r_old${i}`, message: `msg_o${i}`})), ...many.slice(0, 60)];
  const kept = keepLinks(mixed, 'r_1'); assert.equal(kept.length, 64); assert.equal(kept.filter((l) => l.receipt === 'r_1').length, 60, 'others go first, oldest first');
  const receipts = {r_1: {id: 'r_1', capability: 'walk:a', phase: 'started'}, r_2: {id: 'r_2', capability: 'make:mark', phase: 'completed'}};
  let next = 0;
  const w = await world(t, {actAnswer: (b) => ({accepted: true, channel: 'body', receipt: receipts[`r_${++next}`], for: b.for}), receiptOf: (id) => receipts[id]});
  await w.cli('act', 'walk:a', '--for', 'msg_1'); await w.cli('act', 'make:mark', '--for', 'msg_1');
  const links = JSON.parse(readFileSync(join(w.dir, '.eden-agent.json'), 'utf8')).links;
  assert.deepEqual(links, [{receipt: 'r_1', message: 'msg_1'}], 'the ended mark made room; the walk stays');
  assert.equal((await w.cli('say', 'On my way', '--for', 'msg_1')).json.closed, false, 'a later step ended, the walk is still going');
});

test('an act that ends between the reads keeps the world\'s close (#1289)', async t => {
  const started = {accepted: true, channel: 'body', receipt: {id: 'r_1', capability: 'walk:a', phase: 'started'}, for: 'msg_1'};
  const results = {}, w = await world(t, {results, actAnswer: () => started, receiptOf: () => {results.msg_1 = {text: 'walk completed.', outcome: 'done'}; return {...started.receipt, phase: 'completed'};}});
  await w.cli('act', 'walk:a', '--for', 'msg_1');
  const r = await w.cli('ack', 'msg_1', 'I could not get there.', '--close', 'failed');
  assert.equal(r.json.closed, false); assert.equal(r.json.already, 'done'); assert.equal(posted(w.seen, '/result').length, 0);
});

test('wait names the newest message on the receipt (#1289)', async t => {
  const started = (id) => ({accepted: true, channel: 'body', receipt: {id: 'r_1', capability: 'walk:a', phase: 'started'}, for: id});
  const w = await world(t, {results: {msg_1: {text: 'walked.'}, msg_2: {text: 'walked.'}}, actAnswer: (b) => started(b.for), waitReceipt: {...started().receipt, phase: 'completed', done: 'walked.'}});
  await w.cli('act', 'walk:a', '--for', 'msg_1'); await w.cli('act', 'walk:a', '--for', 'msg_2');
  const done = await w.cli('wait', '1', 'r_1'); assert.equal(done.json.closed, true); assert.equal(done.json.for, 'msg_2');
});

test('a world that refuses a close while the act runs (#1295) gets a true answer, exit 0 (#1289)', async t => {
  const w = await world(t, {results: {running: true}});
  const r = await w.cli('result', 'msg_1', 'done', 'Walked there.');
  assert.equal(r.code, 0); assert.equal(r.json.reported, false); assert.equal(r.json.closed, false); assert.match(r.json.why, /still going.*nothing to send/);
  const s = await w.cli('say', 'On my way', '--for', 'msg_1');
  assert.equal(s.code, 0); assert.equal(s.json.closed, false); assert.match(s.json.why, /nothing to send/); assert.doesNotMatch(s.json.why, /Close it with result/);
});

test('act says when the world answered with the act under way (#1289)', async t => {
  const answer = (extra) => () => ({accepted: true, channel: 'body', receipt: {id: 'r_1', capability: 'walk:a', phase: 'started'}, ...extra});
  const w = await world(t, {actAnswer: answer({repeat: true})});
  assert.equal((await w.cli('act', 'walk:a')).json.repeat, true); assert.equal((await w.cli('act', 'walk:a', '--json')).json.repeat, true);
  const fresh = await world(t, {actAnswer: answer({})});
  assert.equal((await fresh.cli('act', 'walk:a')).json.repeat, undefined); assert.equal((await fresh.cli('act', 'walk:a', '--json')).json.repeat, undefined);
});

test('ack --close on a message already acked claims no reply: the first one stands (#1289)', async t => {
  const started = {accepted: true, channel: 'body', receipt: {id: 'r_1', capability: 'walk:a', phase: 'started'}, for: 'msg_1'};
  const w = await world(t, {actAnswer: () => started, waitReceipt: started.receipt});
  await w.cli('ack', 'msg_1', 'Got it'); await w.cli('act', 'walk:a', '--for', 'msg_1');
  const r = await w.cli('ack', 'msg_1', 'Nearly there.', '--close', 'done');
  assert.equal(r.json.closed, false); assert.equal(r.json.reply, undefined); assert.equal(posted(w.seen, '/msg_1/ack').length, 1, 'only the first');
});

test('say --for none is the flag, not speech', async t => {
  const w = await world(t), r = await w.cli('say', 'Hi', '--for', 'none');
  assert.deepEqual(posted(w.seen, '/say')[0][2], {text: 'Hi'}); assert.equal(r.json.closed, undefined); assert.equal(posted(w.seen, '/result').length, 0);
});

test('after a close the next act carries no message', async t => {
  const answer = () => ({accepted: true, channel: 'body', receipt: {id: 'r_1', capability: 'walk:a', phase: 'completed', done: 'walked.'}});
  const w = await world(t, {actAnswer: answer});
  await w.cli('ack', 'msg_1', 'Got it'); await w.cli('say', 'Done', '--for', 'msg_1'); await w.cli('act', 'walk:a');
  assert.equal(posted(w.seen, '/act')[0][2].for, undefined, 'say --for');
  await w.cli('ack', 'msg_2', 'A mill.', '--close', 'done'); await w.cli('act', 'walk:a');
  assert.equal(posted(w.seen, '/act')[1][2].for, undefined, 'ack --close');
});

test('ack --close acks and closes with the reply; plain ack does not close', async t => {
  const w = await world(t), r = await w.cli('ack', 'msg_1', 'It is about a mill.', '--close', 'done');
  assert.equal(r.json.acked, 'msg_1'); assert.equal(r.json.closed, true);
  assert.equal(posted(w.seen, '/msg_1/ack').length, 0, 'the card shows a reply and a result: the text goes once, and a result acks by itself');
  assert.deepEqual(posted(w.seen, '/msg_1/result')[0][2], {outcome: 'done', text: 'It is about a mill.'});
  const no = await w.cli('ack', 'msg_2', 'There is no orchard here.', '--close', 'failed'); assert.equal(posted(w.seen, '/msg_2/result')[0][2].outcome, 'failed'); assert.equal(no.json.closed, true);
  await w.cli('ack', 'msg_5', 'No', 'orchard', 'here', '--close', 'failed'); assert.equal(posted(w.seen, '/msg_5/result')[0][2].text, 'No orchard here');
  const plain = await w.cli('ack', 'msg_3', 'Got it'); assert.equal(plain.json.closed, undefined); assert.equal(posted(w.seen, '/msg_3/result').length, 0);
  for (const bad of [['ack', 'msg_4', 'x', '--close', 'maybe'], ['ack', 'msg_4', '--close', 'done']]) assert.equal((await w.cli(...bad)).code, 1, bad.join(' '));
  assert.equal(w.seen.filter(([, u]) => u.includes('msg_4')).length, 0, 'a bad flag sends nothing');
});

test('act prints closed only when the world has closed the message', async t => {
  const ended = (extra = {}) => ({accepted: true, channel: 'body', receipt: {id: 'r_1', capability: 'walk:a', phase: 'completed', done: 'walked.'}, for: 'msg_1', ...extra});
  const closed = await world(t, {results: {msg_1: {text: 'walked.'}}, actAnswer: () => ended()});
  assert.equal((await closed.cli('act', 'walk:a', '--for', 'msg_1')).json.closed, true);
  const failed = await world(t, {results: {msg_1: {text: 'walk:a failed: blocked'}}, actAnswer: () => ({...ended(), receipt: {id: 'r_1', capability: 'walk:a', phase: 'failed', code: 'blocked'}})});
  assert.equal((await failed.cli('act', 'walk:a', '--for', 'msg_1')).json.closed, true, 'a failed receipt the world closed');
  const broken = await world(t, {reads: 503, actAnswer: () => ended()}), quiet = await broken.cli('act', 'walk:a', '--for', 'msg_1');
  assert.equal(quiet.code, 0); assert.equal(quiet.json.closed, undefined, 'unread: says nothing, as before');
  assert.equal(broken.seen.filter(([m, u]) => m === 'GET' && u.includes('/inbox/')).length, 1, 'one quick read, no retries');
  const notYet = await world(t, {actAnswer: () => ended()});
  assert.equal((await notYet.cli('act', 'walk:a', '--for', 'msg_1')).json.closed, undefined, 'ended, but the world did not close it');
  const unlinked = await world(t, {results: {msg_1: {text: 'x'}}, actAnswer: () => ended({for: undefined})});
  assert.equal((await unlinked.cli('act', 'walk:a', '--for', 'none')).json.closed, undefined);
  assert.equal(unlinked.seen.filter(([m, u]) => m === 'GET' && u.includes('/inbox/')).length, 0, 'no read for an unlinked act');
  const going = await world(t, {results: {msg_1: {text: 'x'}}, actAnswer: () => ({...ended(), receipt: {id: 'r_1', capability: 'walk:a', phase: 'started'}})});
  assert.equal((await going.cli('act', 'walk:a', '--for', 'msg_1')).json.closed, undefined, 'still going');
  const opened = await world(t, {results: {msg_1: {text: 'walked.'}}, actAnswer: () => ended({open: true})}), both = (await opened.cli('act', 'walk:a', '--for', 'msg_1')).json;
  assert.equal(both.closed, true, 'open at the start, closed at the end: the world has the last word'); assert.equal(both.open, undefined);
  const raw = (await opened.cli('act', 'walk:a', '--for', 'msg_1', '--json')).json; assert.equal(raw.closed, true); assert.equal(raw.open, undefined, 'the same under --json');
  const stillOpen = await world(t, {actAnswer: () => ended({open: true})}), left = (await stillOpen.cli('act', 'walk:a', '--for', 'msg_1')).json;
  assert.equal(left.open, true); assert.equal(left.closed, undefined);
  const replaced = await world(t, {results: {msg_1: {text: 'an earlier step.'}}, actAnswer: () => ({...ended(), receipt: {id: 'r_1', capability: 'walk:a', phase: 'replaced'}})});
  assert.equal((await replaced.cli('act', 'walk:a', '--for', 'msg_1')).json.closed, undefined, 'a replaced act closed nothing; an earlier line is not its own');
});

test('wait prints closed and the message it closed, for the linked receipt only', async t => {
  const started = {accepted: true, channel: 'body', receipt: {id: 'r_1', capability: 'walk:a', phase: 'started'}, for: 'msg_1'};
  const w = await world(t, {results: {msg_1: {text: 'walked.'}}, actAnswer: () => started, waitReceipt: {id: 'r_1', capability: 'walk:a', phase: 'completed', done: 'walked.'}});
  assert.equal((await w.cli('act', 'walk:a', '--for', 'msg_1')).json.closed, undefined, 'still going');
  const done = await w.cli('wait', '1', 'r_1');
  assert.equal(done.json.closed, true); assert.equal(done.json.for, 'msg_1');
  const other = await world(t, {results: {msg_1: {text: 'walked.'}}, actAnswer: () => started, waitReceipt: {id: 'r_2', capability: 'walk:b', phase: 'completed', done: 'walked.'}});
  await other.cli('act', 'walk:a', '--for', 'msg_1');
  assert.equal((await other.cli('wait', '1', 'r_2')).json.closed, undefined, 'another receipt closes nothing');
});

test('text over 140 characters is clipped at a word and says so', async t => {
  const long = 'a walk along the pond and back again '.repeat(6), c = clipped(long);
  assert.ok(c.text.length <= 140, c.text); assert.ok(c.text.endsWith('…')); assert.equal(c.clipped, true);
  assert.equal(long[c.text.length - 1], ' ', 'cut at a word'); assert.ok(long.startsWith(c.text.slice(0, -1)));
  assert.deepEqual(clipped('short'), {text: 'short'}); assert.ok(clipped('x'.repeat(200)).text.length <= 140);
  const w = await world(t), r = await w.cli('result', 'msg_1', 'done', long);
  assert.equal(r.code, 0); assert.equal(r.json.clipped, true); assert.ok(posted(w.seen, '/msg_1/result')[0][2].text.length <= 140);
  const a = await w.cli('ack', 'msg_2', long); assert.equal(a.code, 0); assert.equal(a.json.clipped, true); assert.ok(posted(w.seen, '/msg_2/ack')[0][2].reply.length <= 140);
});
