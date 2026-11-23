// R8e (0.133): build sessions, today's `build start / step / show / done`, on top of the world's own build steps
// (#3694: any edit sent `--build <name> --step <name>` is kept under them, and `undo --build` and `build rewind` take
// them back). A session is the creator's own record, kept in the home (`builds.json`): its brief, its steps in order,
// the step it is on, and each edit sent under it with its answer. While a session is open, every edit the creator sends
// carries its name and current step without repeating them. Nothing here is sent to the world but those edits.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NAME = /^[a-z][a-z0-9_-]{0,55}$/;
const fileOf = (home) => join(home, 'builds.json');
const fail = (code, detail) => ({ ok: false, code, detail });

export function readSessions(home) {
  try { const s = JSON.parse(readFileSync(fileOf(home), 'utf8')); if (s && typeof s.builds === 'object') return s; } catch { /* none yet */ }
  return { current: null, builds: {} };
}
function save(home, s) { writeFileSync(`${fileOf(home)}.tmp`, JSON.stringify(s, null, 1), { mode: 0o600 }); renameSync(`${fileOf(home)}.tmp`, fileOf(home)); }

/** A session's view: its steps in order, each with its status (done, open, waiting) and its edits sent and refused. */
export function viewOf(name, b) {
  const at = b.steps.indexOf(b.step);
  return {
    build: name, brief: b.brief, started: b.started, ...(b.closed ? { closed: b.closed } : { step: b.step }),
    steps: b.steps.map((step, i) => {
      const edits = b.edits?.[step] ?? [];
      return { step, status: b.closed || i < at ? 'done' : i === at ? 'open' : 'waiting', edits: edits.length, refused: edits.filter((e) => !e.ok).length, ...(edits.length ? { last: edits.at(-1) } : {}) };
    }),
  };
}

/** `start | step | show | done` on the home's sessions; `now` is the clock (ms). */
export function sessionAct(home, a, now = Date.now()) {
  const s = readSessions(home);
  if (a.act === 'start') {
    if (!NAME.test(a.name)) return fail('build.name', 'a build is named with a-z, 0-9, _ and -, a letter first');
    if (s.builds[a.name] && !s.builds[a.name].closed) return fail('build.open', `${a.name} is open: build show ${a.name}, or build done ${a.name}`);
    if (s.current && s.current !== a.name && !s.builds[s.current]?.closed) return fail('build.other-open', `${s.current} is open: build done ${s.current} first`);
    s.builds[a.name] = { brief: a.brief ?? '', steps: a.steps, step: a.steps[0], started: new Date(now).toISOString(), edits: {} };
    s.current = a.name;
    save(home, s);
    return { ok: true, ...viewOf(a.name, s.builds[a.name]) };
  }
  const name = a.name ?? s.current, b = name ? s.builds[name] : undefined;
  if (!b) return fail('build.unknown', name ? `no build ${name}` : 'no build is open: build start <name> --steps a,b,c');
  if (a.act === 'show') return { ok: true, ...viewOf(name, b) };
  if (b.closed) return fail('build.closed', `${name} is done`);
  if (a.act === 'step') {
    if (!b.steps.includes(a.step)) return fail('build.step-unknown', `${name}'s steps are ${b.steps.join(', ')}`);
    b.step = a.step; s.current = name;
    save(home, s);
    return { ok: true, ...viewOf(name, b) };
  }
  if (a.act === 'done') {
    b.closed = new Date(now).toISOString();
    if (s.current === name) s.current = null;
    save(home, s);
    return { ok: true, ...viewOf(name, b) };
  }
  return fail('usage', 'build start | step | show | done');
}

/** The request with the open session's name and step, when it is an edit that names none. */
export function inSession(home, req) {
  if (!req || req.op !== 'edit' || req.build !== undefined) return req;
  const s = readSessions(home), b = s.current ? s.builds[s.current] : undefined;
  return b && !b.closed ? { ...req, build: s.current, step: b.step } : req;
}

/** Records an edit sent under a session with its answer (its sequence, and its refusal when refused). */
export function recordEdit(home, req, answer, now = Date.now()) {
  if (!req || req.op !== 'edit' || req.build === undefined) return;
  const s = readSessions(home), b = s.builds[req.build];
  if (!b || b.closed) return;
  (b.edits[req.step] ??= []).push({ at: new Date(now).toISOString(), ok: answer?.ok === true, ...(answer?.sequence !== undefined ? { sequence: answer.sequence } : {}), ...(answer?.ok === false && answer.code ? { code: answer.code } : {}) });
  save(home, s);
}
