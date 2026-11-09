// #457: the watchdog thread names the frame the main thread is stuck in, while it is stuck (an inspector pause from the
// watchdog's own session, enabled while the world was healthy). Reports hold frames only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {frameText, reportFile} from './load/stall-stack.ts';
import {stallConfig} from './load/watchdog.ts';

const here = new URL('.', import.meta.url).pathname;

test('a main thread stuck in a busy loop: the watchdog names the looping function while it is stuck; frames only; a debugger statement never stops it', {timeout: 60_000}, async t => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'souls-stall-')); t.after(() => rmSync(dir, {recursive: true, force: true}));
  const script = join(dir, 'stuck.mjs');
  writeFileSync(script, `
    import {startWatchdog} from ${JSON.stringify(join(here, 'load/watchdog.ts'))};
    import {bootPhase} from ${JSON.stringify(join(here, 'load/boot-progress.ts'))};
    import {sharedLoad, S} from ${JSON.stringify(join(here, 'load/shared.ts'))};
    bootPhase('serving', 7);
    setInterval(() => { sharedLoad[S.lastTurnAt] = Date.now(); }, 50);   // the main thread's turn marker, as monitor.ts keeps it
    function withADebuggerStatement() { debugger; return 1; }
    function stuckInTheLoop(ms) {
      const token = 'sim_s_secret_token_in_scope', body = {text: 'a request body in scope'};
      const end = Date.now() + ms; let x = 0; while (Date.now() < end) x += token.length + body.text.length; return x;
    }
    startWatchdog({dataDir: ${JSON.stringify(dir)}, everyMs: 200, stall: {dataDir: ${JSON.stringify(dir)}, root: ${JSON.stringify(dir)}, stallMs: 600, gapMs: 60_000}});
    setTimeout(() => {
      withADebuggerStatement(); console.log('DEBUGGER PASSED');
      setTimeout(() => { console.log('BUSY ' + Date.now()); stuckInTheLoop(10_000); console.log('FREE ' + Date.now()); setTimeout(() => process.exit(0), 300); }, 300);
    }, 800);`);
  const child = spawn(process.execPath, [script], {stdio: ['ignore', 'pipe', 'inherit']});
  t.after(() => child.kill('SIGKILL'));
  let out = ''; child.stdout!.on('data', (b: Buffer) => { out += b; });
  await new Promise<void>((r) => child.on('exit', () => r()));
  assert.match(out, /DEBUGGER PASSED/, 'a debugger statement did not stop the main thread');
  const busy = Number(/BUSY (\d+)/.exec(out)![1]), free = Number(/FREE (\d+)/.exec(out)![1]);
  const files = readdirSync(dir).filter((f) => /^stall-\d+\.json$/.test(f));
  assert.equal(files.length, 1, `one capture for one stall (and none for the debugger statement): ${files.join(', ')}`);
  const text = readFileSync(join(dir, files[0]), 'utf8'), r = JSON.parse(text);
  assert.ok(r.at > busy && r.at < free, `captured while stuck (${r.at - busy} ms into a ${free - busy} ms stall)`);
  assert.ok(r.stuckMs >= 600, `stuck ${r.stuckMs} ms when asked`);
  assert.deepEqual({fn: r.frames[0].fn, file: r.frames[0].file}, {fn: 'stuckInTheLoop', file: 'stuck.mjs'}, JSON.stringify(r.frames.slice(0, 3)));
  assert.ok(r.frames[0].line >= 8 && r.frames[0].line <= 11);
  // frames only: no scope values, no arguments, no paths outside the release root
  assert.deepEqual(Object.keys(r).sort(), ['at', 'frames', 'pauseMs', 'stuckMs', 'v']);
  for (const f of r.frames) assert.deepEqual(Object.keys(f).sort(), ['col', 'file', 'fn', 'line']);
  assert.ok(!/secret_token|request body|\/Users\/|\/home\//.test(text), 'no token, body or home path in the report');
  // live.json carries it for the launcher's wedge line
  const live = JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8'));
  assert.equal(live.stall.at, r.at); assert.equal(live.stall.top, `stuckInTheLoop stuck.mjs:${r.frames[0].line}`);
});

test('stall stacks: on unless SIM_STALL_STACK=0, after SIM_STALL_STACK_MS; report files are release-relative or bare names', () => {
  assert.equal(stallConfig('/d', {SIM_STALL_STACK: '0'}), undefined);
  assert.equal(stallConfig('/d', {})!.stallMs, 2000); assert.equal(stallConfig('/d', {SIM_STALL_STACK_MS: '5000'})!.stallMs, 5000);
  assert.equal(reportFile('file:///srv/rel/apps/server/src/x.ts', '/srv/rel'), 'apps/server/src/x.ts');
  assert.equal(reportFile('file:///srv/rel/apps/server/src/x.ts', '/srv/rel/'), 'apps/server/src/x.ts');
  assert.equal(reportFile('node:internal/timers', '/srv/rel'), 'node:internal/timers');
  assert.equal(reportFile('file:///home/someone/elsewhere/y.mjs', '/srv/rel'), 'y.mjs');
  assert.equal(reportFile('', '/srv/rel'), '');
  assert.equal(frameText({fn: 'f', file: 'a.ts', line: 3, col: 1}), 'f a.ts:3'); assert.equal(frameText(undefined), 'unknown');
});
