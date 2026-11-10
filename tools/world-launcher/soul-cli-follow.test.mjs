// #1359: `listen --follow` stays open and prints one JSON line per wake; plain `listen` is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile, spawn} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {followLine, FOLLOW_MAX} from './soul/eden.mjs';

const CLI = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));

async function world(t) {
  const messages = [], extra = [], listens = [], waiting = [], state = {supersede: 0};
  const wakeAll = () => { while (waiting.length) waiting.shift()(); };
  const server = createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', async () => {
      const u = new URL(req.url, 'http://x'), send = (s, j) => { if (!res.writableEnded) { res.writeHead(s, {'content-type': 'application/json'}); res.end(JSON.stringify(j)); } };
      if (u.pathname === '/v1/edge/inbox/listen') {
        const after = u.searchParams.get('after'), hold = Number(u.searchParams.get('timeoutMs')) > 0;
        listens.push(after);
        if (hold && state.supersede > 0) { state.supersede--; return send(409, {error: {code: 'superseded', message: 'superseded by a newer listen for this agent; this listen has ended, do not restart it'}}); }
        const ready = () => { const at = after ? messages.findIndex(m => m.id === after) + 1 : 0; return messages.slice(at).filter(m => !m.acked).length || extra.length; };
        if (hold && !ready()) await new Promise(r => { const t = setTimeout(r, 1500); waiting.push(() => { clearTimeout(t); r(); }); });
        const at = after ? messages.findIndex(m => m.id === after) + 1 : 0, backlog = messages.slice(at).filter(m => !m.acked).map(({id, text, sentAt}) => ({id, text, sentAt}));
        const more = extra.shift() ?? {};
        return send(200, {inbox: {connected: true, ...(backlog[0] ? {latest: backlog[0]} : {})}, backlog, ...more});
      }
      if (u.pathname.startsWith('/v1/edge/inbox/')) return send(404, {error: {code: 'not-found', message: 'no such message'}});
      send(200, {});
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'eden-follow-'));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, {recursive: true, force: true}); });
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: `http://127.0.0.1:${server.address().port}`, soul: 's_pip', token: 'tok'}));
  const post = (m) => { messages.push({sentAt: new Date().toISOString(), ...m}); wakeAll(); };
  const also = (d) => { extra.push(d); wakeAll(); };
  const cli = (...args) => new Promise(res => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (e, out, err) => { let json = null; try { json = JSON.parse(out); } catch { /* words */ } res({code: e?.code ?? 0, out, json, err}); }));
  const follow = (...args) => {
    const child = spawn(process.execPath, [CLI, 'listen', '--follow', ...args], {cwd: dir, stdio: ['ignore', 'pipe', 'pipe']}), lines = [], waiters = [];
    let buf = ''; child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.splice(0).forEach(f => f()); } });
    const exited = new Promise(r => child.on('exit', (code, signal) => { r({code, signal}); waiters.splice(0).forEach(f => f()); }));
    const line = async (n, ms = 8000) => { const until = Date.now() + ms; while (lines.length < n && Date.now() < until) await new Promise(r => { const t = setTimeout(r, 100); waiters.push(() => { clearTimeout(t); r(); }); }); assert.ok(lines.length >= n, `line ${n} never came: ${lines.join(' | ')}`); return JSON.parse(lines[n - 1]); };
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    return {child, lines, line, exited};
  };
  return {dir, post, also, cli, follow, listens, messages, state};
}

test('--follow prints each wake as one line, each message once, and keeps listening', async t => {
  const w = await world(t), f = w.follow();
  w.post({id: 'm1', text: 'walk to the mill'});
  const one = await f.line(1);
  assert.equal(one.wake, 1); assert.deepEqual(one.messages.map(m => m.id), ['m1']); assert.match(one.next, /do not restart it/);
  assert.equal(f.lines[0].includes('\n'), false); assert.equal(f.child.exitCode, null, 'still running after a message');
  w.post({id: 'm2', text: 'then the pond'}); w.post({id: 'm3', text: 'and wave'});
  const seen = [one];
  while (seen.flatMap(l => l.messages ?? []).length < 3) seen.push(await f.line(seen.length + 1));
  assert.deepEqual(seen.flatMap(l => l.messages.map(m => m.id)), ['m1', 'm2', 'm3'], 'each message printed once, in order (unacked, so only the cursor stops a repeat)');
  assert.ok(w.listens.includes('m1'), 'the cursor moved past what was printed');
  w.also({addressed: [{from: 'Bo', text: 'Pip, over here!'}]});
  const said = await f.line(seen.length + 1);
  assert.deepEqual(said.messages, []); assert.equal(said.addressed[0].text, 'Pip, over here!'); assert.match(said.next, /keeps running/);
  w.also({plan: {state: 'stopped', next: 'plan step 2 was refused: pending shows why'}});
  const plan = await f.line(seen.length + 2);
  assert.equal(plan.plan.state, 'stopped'); assert.match(plan.next, /refused/);
  assert.equal(f.child.exitCode, null);
  f.child.kill('SIGTERM');
  const end = await f.line(seen.length + 3), how = await f.exited;
  assert.match(end.ended, /SIGTERM/); assert.equal(end.wake, undefined); assert.equal(how.code, 143);
});

test('listen --take ends a --follow with a final line', async t => {
  const w = await world(t), f = w.follow();
  await new Promise(r => setTimeout(r, 800));
  const taker = spawn(process.execPath, [CLI, 'listen', '--take'], {cwd: w.dir, stdio: 'ignore'});
  t.after(() => taker.kill('SIGKILL'));
  const end = await f.line(1);
  assert.match(end.ended, /SIGTERM/); assert.match(end.next, /listen --follow/);
  await f.exited;
});

test('a second --follow leaves the first alone, and --follow --once is a usage error', async t => {
  const w = await world(t), f = w.follow();
  await new Promise(r => setTimeout(r, 800));
  const again = await w.cli('listen', '--follow');
  assert.equal(again.json.alreadyListening, true); assert.equal(f.child.exitCode, null);
  const both = await w.cli('listen', '--follow', '--once');
  assert.notEqual(both.code, 0); assert.match(both.err, /--follow never ends on a message/);
  f.child.kill('SIGTERM'); await f.exited;
});

test('a superseded long-poll while the lock is still ours is retried; three in a row end the follow', async t => {
  const w = await world(t); w.state.supersede = 2;
  const f = w.follow();
  w.post({id: 'm1', text: 'still here?'});
  const one = await f.line(1);
  assert.deepEqual(one.messages.map(m => m.id), ['m1'], 'two 409s (a serve starting) do not end it'); assert.equal(f.child.exitCode, null);
  w.state.supersede = 3;
  const end = await f.line(2, 15000);
  assert.equal(end.ended, 'superseded'); assert.match(end.next, /from somewhere else/);
  await f.exited;
});

test('plain listen still exits on the first wake with the usual output', async t => {
  const w = await world(t);
  setTimeout(() => w.post({id: 'm1', text: 'hello'}), 300);
  const r = await w.cli('listen');
  assert.equal(r.code, 0); assert.deepEqual(r.json.messages.map(m => m.id), ['m1']); assert.match(r.json.next, /restart listen --after m1/i);
  assert.ok(r.out.split('\n').length > 2, 'pretty-printed as before, not one line');
});

test('followLine keeps a wake within the bound: texts first, then the brief, then older messages', () => {
  const long = 'x'.repeat(5000), msgs = Array.from({length: 12}, (_, i) => ({id: `m${i}`, text: long, sentAt: '2026-11-08T00:00:00Z'}));
  const small = followLine({messages: [{id: 'm1', text: 'hi'}], next: 'ack', wake: 1});
  assert.deepEqual(small, {messages: [{id: 'm1', text: 'hi'}], next: 'ack', wake: 1}, 'a small line is untouched');
  const o = followLine({messages: msgs, brief: 'b'.repeat(3000), next: 'ack each', wake: 2});
  assert.ok(JSON.stringify(o).length <= FOLLOW_MAX, JSON.stringify(o).length);
  assert.equal(o.briefOmitted, true); assert.equal(o.messages.at(-1).id, 'm11', 'the newest stays'); assert.ok(o.messagesOmitted >= 1);
  assert.ok(o.messages.every(m => m.textShortened));
  const fits = followLine({messages: [{id: 'm1', text: long}], brief: 'short', next: 'ack', wake: 3});
  assert.equal(fits.brief, 'short', 'the brief stays when shortening the text was enough'); assert.equal(fits.messages[0].text.length, 301);
  const open = Array.from({length: 8}, (_, i) => ({id: `o${i}`, text: 'y'.repeat(280)}));
  const four = followLine({messages: [1, 2, 3, 4].map(i => ({id: `n${i}`, text: 'short'})), stillOpen: open, stillOpenNext: 'close them', next: 'ack each', wake: 4});
  assert.deepEqual(four.messages.map(m => m.id), ['n1', 'n2', 'n3', 'n4'], 'the older-open list goes before any new message');
  assert.equal(four.stillOpen, undefined); assert.equal(four.stillOpenNext, undefined); assert.equal(four.stillOpenOmitted, true);
  const many = followLine({messages: Array.from({length: 50}, (_, i) => ({id: `msg_${i}`, text: 'z'.repeat(400)})), next: 'ack each', wake: 5});
  assert.ok(many.messagesOmitted > 0); assert.match(many.next, /listen --once/); assert.ok(JSON.stringify(many).length <= FOLLOW_MAX);
  const steps = Array.from({length: 24}, (_, i) => ({n: i + 1, id: `walk:place-number-${i}`, state: i < 3 ? 'done' : i === 3 ? 'refused' : 'waiting', receipt: `r_${'0'.repeat(36)}`, ...(i === 3 ? {code: 'walk.no-route', reason: 'No route there from here.', candidates: Array.from({length: 5}, (_, k) => ({id: `walk:other-${k}`, label: 'x'.repeat(80)}))} : {})}));
  const plan = followLine({messages: [], plan: {id: 'p1', state: 'stopped', step: 4, of: 24, steps, next: 'Step 4 was refused.'}, next: 'pending shows it', wake: 6});
  assert.ok(JSON.stringify(plan).length <= FOLLOW_MAX); assert.equal(plan.plan.stepsOmitted, 24);
  assert.deepEqual(plan.plan.refused, {n: 4, id: 'walk:place-number-3', code: 'walk.no-route', reason: 'No route there from here.'}); assert.equal(plan.plan.state, 'stopped');
});
