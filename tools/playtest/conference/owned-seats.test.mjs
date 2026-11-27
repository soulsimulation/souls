import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { downloadConferenceClient, ownedConferenceCommand, requireConferenceRecipe, startConferenceResident } from './owned-seats.mjs';

const scratch = resolve(import.meta.dirname, '../../../.local'); mkdirSync(scratch, { recursive: true });
const directory = mkdtempSync(join(scratch, 'conference-owned-seat-tests-'));
const children = [];
const recipe = { registerCommand(child) { children.push(child); }, registerClient(child) { children.push(child); } };
const controller = new AbortController();
let ordinal = 0;
const options = () => ({ cwd: directory, env: { PATH: process.env.PATH, BRAIN_MODE: 'fake' }, signal: controller.signal, log: join(directory, `command-${++ordinal}.json`) });
after(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const done = once(child, 'close');
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    await done;
  }
});

test('missing pinned recipe capabilities refuse before any pairing child exists', () => {
  assert.throws(() => requireConferenceRecipe({ kind: 'native-page' }), /pinned native-page recipe/);
  assert.equal(children.length, 0);
});

test('ordinary command is registered immediately and its JSON reply is forwarded', async () => {
  const before = children.length;
  const pending = ownedConferenceCommand(recipe, ['-e', 'console.log(JSON.stringify({ok:true,can:"no",says:"question_pending",fix:null}))'], options());
  assert.equal(children.length, before + 1, 'registration happens before awaiting output');
  assert.deepEqual(await pending, { ok: true, can: 'no', says: 'question_pending', fix: null });
  assert.equal(children.at(-1).exitCode, 0);
});

test('a failed pairing command cannot pass on success-looking partial stdout', async () => {
  const opts = options();
  await assert.rejects(ownedConferenceCommand(recipe, ['-e', 'console.log(JSON.stringify({ok:true,soul:"synthetic"}));process.exitCode=1'], opts), /command-exit:1/);
  const saved = JSON.parse(readFileSync(opts.log, 'utf8'));
  assert.equal(saved.code, 1); assert.equal(saved.signal, null);
  assert(saved.stdout.includes('synthetic'));
});

test('aborted command is stopped and retained as failure', async () => {
  const abort = new AbortController(), opts = { ...options(), signal: abort.signal };
  const pending = ownedConferenceCommand(recipe, ['-e', 'setInterval(()=>{},1000)'], opts);
  abort.abort(Error('test cancellation'));
  await assert.rejects(pending);
  assert.notEqual(JSON.parse(readFileSync(opts.log, 'utf8')).signal, null);
  assert.notEqual(children.at(-1).signalCode, null);
});

test('post-pair resident readiness failure stays owned and stops on owner cleanup', async () => {
  const root = join(directory, 'payload'), path = join(root, 'v2/client/src/daemon'); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'daemon.mjs'), 'import{writeSync}from"node:fs";writeSync(3,"wrong\\n");setInterval(()=>{},1000);');
  const before = children.length;
  const pending = startConferenceResident({ recipe: { ...recipe, pkg: directory }, clientRoot: root,
    seat: { home: join(directory, 'fresh-home'), soul: 'synthetic', folder: directory, env: options().env },
    signal: controller.signal, log: join(directory, 'resident.log') });
  assert.equal(children.length, before + 1);
  await assert.rejects(pending, /resident-ready-invalid/);
  const child = children.at(-1), done = once(child, 'close'); process.kill(-child.pid, 'SIGTERM'); await done;
  assert.equal(child.signalCode, 'SIGTERM');
});

test('served client hash mismatch refuses without launching a child', async () => {
  const before = children.length;
  const server = createServer((req, res) => {
    if (req.url === '/v1/config') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ soulClient: { sha256: '0'.repeat(64), bytes: 4 } })); }
    else res.end('wrong');
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  try {
    await assert.rejects(downloadConferenceClient({ base: `http://127.0.0.1:${server.address().port}`, paths: { data: directory, dir: directory }, signal: controller.signal }), /served client SHA256/);
  } finally { await new Promise((ok, no) => server.close(error => error ? no(error) : ok())); }
  assert.equal(children.length, before);
});
