#!/usr/bin/env node
// A release of a pinned sha while main keeps moving (release.yml -f sha=<40 hex>; no merge freeze), and the last release a
// candidate builds on (gate.yml's default baseline).
//
//   node tools/world-launcher/deploy/ship/release-pin.mjs last <rev>
//        the last release tag reachable from <rev> (v0.*, so a stray tag such as v4.18 never wins a version sort)
//   node tools/world-launcher/deploy/ship/release-pin.mjs check <sha> [--main origin/main]
//        exit 1 with the reason unless <sha> is a full 40-hex commit, an ancestor of --main, and strictly newer than the
//        last release reachable from --main (nothing ships backwards), and its tree has this file: the eyes job runs the
//        pin's own eyes.mjs, and only a tree with pinned-sha support matches a run at main's head to the sha it ships;
//        prints last=<tag> (or last= with no release yet)
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RELEASE_TAGS = 'v0.*';
/** A pin's tree must hold this: it came with eyes.mjs's pinned-run match (a run whose title names the sha). */
export const PIN_AWARE = 'tools/world-launcher/deploy/ship/release-pin.mjs';
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const holds = (cwd, ...a) => { try { git(cwd, ...a); return true; } catch { return false; } };

/** The newest release tag in <rev>'s history, or null. */
export function lastRelease(rev, cwd = process.cwd()) {
  try { return git(cwd, 'describe', '--tags', '--abbrev=0', '--match', RELEASE_TAGS, rev); } catch { return null; }
}

/** Why <sha> cannot be pinned for a release, or null when it can. */
export function pinProblem(sha, { main = 'origin/main', cwd = process.cwd() } = {}) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) return `sha must be the full 40-hex commit (got '${sha ?? ''}')`;
  if (!holds(cwd, 'cat-file', '-e', `${sha}^{commit}`)) return `${sha} is not a commit in this checkout`;
  if (!holds(cwd, 'merge-base', '--is-ancestor', sha, main)) return `${sha.slice(0, 12)} is not an ancestor of ${main}`;
  const last = lastRelease(main, cwd);
  if (last) {
    const tagged = git(cwd, 'rev-parse', `${last}^{commit}`);
    if (tagged === sha) return `${sha.slice(0, 12)} is the last release ${last} itself`;
    if (!holds(cwd, 'merge-base', '--is-ancestor', tagged, sha)) return `${sha.slice(0, 12)} is not newer than the last release ${last}`;
  }
  if (!holds(cwd, 'cat-file', '-e', `${sha}:${PIN_AWARE}`)) return `${sha.slice(0, 12)} predates pinned-sha releases (no ${PIN_AWARE}): its eyes would refuse the run; pin a later commit or ship main's HEAD under the freeze`;
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, rev, ...rest] = process.argv.slice(2);
  const i = rest.indexOf('--main'), main = i >= 0 ? rest[i + 1] : 'origin/main';
  if (cmd === 'last' && rev) {
    const last = lastRelease(rev);
    if (!last) { console.error(`no ${RELEASE_TAGS} tag reachable from ${rev}`); process.exit(1); }
    console.log(last);
  } else if (cmd === 'check') {
    const problem = pinProblem(rev, { main });
    if (problem) { console.error(problem); process.exit(1); }
    console.log(`last=${lastRelease(main) ?? ''}`);
  } else { console.error('usage: release-pin.mjs last <rev> | check <sha> [--main <ref>]'); process.exit(2); }
}
