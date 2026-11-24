// A test's teardown: stop the programs it started, wait for each to end, and only then remove their folder. A worldd
// that is told to stop goes on for up to 8 s, backing up its public stream (R15, #4469), so removing its folder at
// once races its last writes (`ENOTEMPTY` in views/). Every test and script that starts worldd and then removes its
// folder ends through here.
import { rmSync } from 'node:fs';

/** Sends each child `signal` (SIGTERM unless told otherwise) and resolves once every one has exited; a child still
 *  running after `graceMs` (15 s) is sent SIGKILL. An entry that is not a child process (`{ kill }`) is only killed. */
export function stopAll(procs, { signal = 'SIGTERM', graceMs = 15_000 } = {}) {
  return Promise.all([...procs].map((p) => new Promise((done) => {
    const kill = (s) => { try { p.kill(s); } catch { /* gone */ } };
    if (typeof p?.once !== 'function' || p.pid === undefined || p.exitCode !== null || p.signalCode !== null) {
      kill(signal);
      return done();
    }
    const hard = setTimeout(() => kill('SIGKILL'), graceMs);
    const last = setTimeout(done, graceMs + 5_000); // no exit seen even after SIGKILL: do not hang the teardown
    p.once('exit', () => { clearTimeout(hard); clearTimeout(last); done(); });
    kill(signal);
  })));
}

/** `stopAll(procs, opts)`, then removes `dir` unless `opts.keep`. */
export async function stopThenRemove(procs, dir, { keep = false, ...opts } = {}) {
  await stopAll(procs, opts);
  if (!keep) rmSync(dir, { recursive: true, force: true });
}
