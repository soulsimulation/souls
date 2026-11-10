// A live seat's folder must sit outside any repository checkout (#1098 arm B2). Claude Code takes the project it runs in
// from the folder's ancestors: inside a checkout, `--setting-sources project` loads that repository's own settings and
// skills into every seat turn (arm B2 on a laptop: about twice the context per turn, and world-budget refusals that
// CTRL and arm B never had). The user's and parents' CLAUDE.md are already off (CLAUDE_CODE_DISABLE_CLAUDE_MDS).
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { REPO_ROOT } from '../../lib/paths.mjs';

const MARKERS = ['.git', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md'];
/** The nearest ancestor of `dir` (itself included) that would make Claude Code read a project into a seat, or null. The
 *  user's own home `.claude` is the login's user config, which the seat already excludes, so it is not a marker. */
export function projectAncestor(dir, { exists = existsSync, home = homedir() } = {}) {
  let d = resolve(dir);
  for (;;) {
    for (const m of MARKERS) if (exists(join(d, m))) return { dir: d, marker: m };
    if (d !== resolve(home) && exists(join(d, '.claude'))) return { dir: d, marker: '.claude' };
    const up = dirname(d); if (up === d) return null; d = up;
  }
}
/** Throws for a live seat whose folder would load a project: name a run folder outside the checkout (`--out`, or
 *  SOULS_RUNS_DIR for the default). */
export function assertSeatHome(folder, opts) {
  const hit = projectAncestor(dirname(resolve(folder)), opts);
  if (hit) throw new Error(`seat.home-in-project: a live seat's folder ${folder} is inside ${hit.dir} (it has ${hit.marker}), so its Claude Code session would load that project's settings and skills. Put the run outside any checkout: --out <dir>, or SOULS_RUNS_DIR for the default`);
}
/** A folder outside every project above this checkout (a worktree can sit inside another checkout), for run output with
 *  live seats: `<that folder>/<name>`. */
export function outsideCheckout(name, { from = REPO_ROOT, ...opts } = {}) {
  let d = dirname(resolve(from));
  for (let hit = projectAncestor(d, opts); hit; hit = projectAncestor(d, opts)) { const up = dirname(hit.dir); if (up === hit.dir) break; d = up; }
  return join(d, name);
}
