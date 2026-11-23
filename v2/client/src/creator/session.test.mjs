// R8e: build sessions kept in the creator's home (session.mjs): start, step, show, done; edits carry the open one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inSession, readSessions, recordEdit, sessionAct } from './session.mjs';

test('a session: started with its steps, edits carry it and are counted per step, moved on, shown, closed', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'r8e-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const edit = { op: 'edit', ops: [] };
  assert.equal(inSession(home, edit), edit, 'no session: the edit is as written');
  const s = sessionAct(home, { act: 'start', name: 'garden', steps: ['beds', 'paths'], brief: 'a kitchen garden' }, 0);
  assert.deepEqual([s.ok, s.step, s.steps.map((x) => x.status)], [true, 'beds', ['open', 'waiting']]);
  assert.equal(sessionAct(home, { act: 'start', name: 'other', steps: ['a'] }).code, 'build.other-open', 'one open at a time');
  const r1 = inSession(home, edit);
  assert.deepEqual([r1.build, r1.step], ['garden', 'beds']);
  recordEdit(home, r1, { ok: true, sequence: 4 }, 1); recordEdit(home, r1, { ok: false, code: 'edit.claim-unknown' }, 2);
  assert.deepEqual(inSession(home, { op: 'edit', ops: [], build: 'mine', step: 'x' }).build, 'mine', 'an edit naming its own build keeps it');
  assert.equal(sessionAct(home, { act: 'step', step: 'roof' }).code, 'build.step-unknown');
  sessionAct(home, { act: 'step', step: 'paths' });
  recordEdit(home, inSession(home, edit), { ok: true, sequence: 5 }, 3);
  const shown = sessionAct(home, { act: 'show' });
  assert.deepEqual(shown.steps.map((x) => [x.step, x.status, x.edits, x.refused]), [['beds', 'done', 2, 1], ['paths', 'open', 1, 0]]);
  assert.equal(shown.brief, 'a kitchen garden');
  const done = sessionAct(home, { act: 'done' }, 10);
  assert.ok(done.closed); assert.deepEqual(done.steps.map((x) => x.status), ['done', 'done']);
  assert.equal(inSession(home, edit), edit, 'closed: edits are as written again');
  assert.equal(readSessions(home).current, null);
  assert.equal(sessionAct(home, { act: 'step', name: 'garden', step: 'beds' }).code, 'build.closed');
  assert.equal(sessionAct(home, { act: 'start', name: 'Bad Name', steps: ['a'] }).code, 'build.name');
});
