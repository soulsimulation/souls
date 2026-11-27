#!/usr/bin/env node
// Codex's files (Gene, 26 Nov; #5068): a pull request that is not Codex's fails when it changes a file listed in
// tools/ci/codex-files.txt, and gets a warning line for a `warn` entry. A PR is Codex's when it carries the
// `codex:land` label: every Codex PR is opened from the same account and an `agent/` branch like ours and carries no
// body marker, while Codex labels each PR it wants landed (the landing protocol on #5068). `codex:files-ok` is the
// coordinator's override for a change Codex agreed to, named on #5068.
//
//   node .github/scripts/codex-files.mjs --repo owner/name --pr 123      (the ci workflow: files and labels from the API)
//   node .github/scripts/codex-files.mjs --files a.ts,b.ts [--labels x,y] (local)
// Labels are read when the job runs, not from the event, so re-running the failed job after adding a label counts it.
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const CODEX_LABEL = 'codex:land';
export const OVERRIDE_LABEL = 'codex:files-ok';
const LIST = new URL('../../tools/ci/codex-files.txt', import.meta.url);

/** A glob from the list as a RegExp over a repository path: `*` within a segment, `**` across segments, `{a,b}`. */
export function globRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) throw new Error(`unclosed { in ${glob}`);
      re += `(?:${glob.slice(i + 1, end).split(',').map(escape).join('|')})`;
      i = end;
    } else re += escape(c);
  }
  return new RegExp(`^${re}$`);
}
const escape = s => s.replace(/[.+?^$()[\]|\\]/g, '\\$&');

/** Parse the list: `[{ glob, level: 'fail' | 'warn', re }]`; `#` lines and blank lines are skipped. */
export function parseList(text) {
  return text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => {
    const warn = line.startsWith('warn ');
    const glob = warn ? line.slice(5).trim() : line;
    return { glob, level: warn ? 'warn' : 'fail', re: globRegExp(glob) };
  });
}

/** Judge one PR. `files` are changed paths (a rename lists both its old and new path). */
export function check({ files, labels, rules }) {
  const hits = [];
  for (const file of new Set(files)) {
    const rule = rules.find(r => r.re.test(file));
    if (rule) hits.push({ file, glob: rule.glob, level: rule.level });
  }
  const codex = labels.includes(CODEX_LABEL);
  const override = labels.includes(OVERRIDE_LABEL);
  const failing = hits.filter(h => h.level === 'fail');
  const warnings = hits.filter(h => h.level === 'warn');
  const exempt = codex ? `${CODEX_LABEL}: a Codex PR` : override ? `${OVERRIDE_LABEL}: the coordinator passed it (#5068)` : '';
  return { ok: Boolean(exempt) || failing.length === 0, exempt, failing, warnings };
}

export function report(result) {
  const lines = [];
  if (result.exempt) lines.push(`Codex's files: exempt (${result.exempt}).`);
  else if (result.failing.length) {
    lines.push(`Codex's files: this PR changes files Codex owns (Gene, 26 Nov; #5068). Write the exact change for Codex on #5068 instead, or the coordinator adds \`${OVERRIDE_LABEL}\` once Codex agrees and re-runs this job.`);
    for (const h of result.failing) lines.push(`- ${h.file} (${h.glob})`);
  } else lines.push("Codex's files: none changed.");
  if (!result.exempt) for (const h of result.warnings)
    lines.push(`- warn: ${h.file} is shared; Codex owns its carried-load path. Leave that path alone or ask Codex on #5068.`);
  return lines.join('\n');
}

function gh(args) {
  return JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 })).flat();
}

function main(argv) {
  const arg = name => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
  const list = (s) => (s ?? '').split(',').map(x => x.trim()).filter(Boolean);
  let files, labels;
  if (arg('pr')) {
    const repo = arg('repo') ?? process.env.GITHUB_REPOSITORY;
    files = gh([`repos/${repo}/pulls/${arg('pr')}/files?per_page=100`]).flatMap(f => [f.filename, f.previous_filename].filter(Boolean));
    labels = gh([`repos/${repo}/issues/${arg('pr')}/labels?per_page=100`]).map(l => l.name);
  } else {
    files = list(arg('files'));
    labels = list(arg('labels'));
  }
  const result = check({ files, labels, rules: parseList(readFileSync(LIST, 'utf8')) });
  const text = report(result);
  console.log(text);
  if (process.env.GITHUB_ACTIONS) {
    for (const h of result.exempt ? [] : result.failing) console.log(`::error file=${h.file},title=Codex's file::${h.file} is Codex's (#5068)`);
    for (const h of result.exempt ? [] : result.warnings) console.log(`::warning file=${h.file},title=Shared with Codex::Codex owns the carried-load path in ${h.file} (#5068)`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
