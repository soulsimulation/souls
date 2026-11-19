#!/usr/bin/env node
// The runbook's command check (Engine v2 O13, #2829): on every page of v2/docs/runbook/ except those the index lists
// under "Background", each command is a script in v2/tools/ops that takes at most a world's name, with nothing else
// to fill in and no host name. Commands are each line of a fenced block (comments and config skipped) and each
// multi-word inline command in the index's command column. Exits 1 when any fails.
//   node v2/tools/ops/runbook-check.mjs [v2/docs/runbook]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'v2/docs/runbook';
const HOST = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[a-z0-9-]+\.(?:com|net|org|io|dev|game|local|lan)\b|\bssh\b/i;
const index = readFileSync(join(dir, 'README.md'), 'utf8');
const background = new Set([...(index.split(/^## Background.*$/m)[1] ?? '').split(/^## /m)[0].matchAll(/\]\(([^)#]+)\)/g)].map((m) => m[1]));

function commands(text) {
  const cmds = [];
  for (const [, lang, body] of text.matchAll(/```([a-z]*)\n([\s\S]*?)```/g)) {
    if (lang === 'caddyfile') continue;
    for (const l of body.replace(/\\\n\s*/g, ' ').split('\n')) if (l.trim() && !l.trim().startsWith('#')) cmds.push(l.replace(/\s+#.*$/, '').trim());
  }
  for (const row of text.split('\n').filter((l) => /^\| \d/.test(l))) {
    for (const [, c] of (row.split('|')[4] ?? '').matchAll(/`([^`]+)`/g)) if (/\s/.test(c)) cmds.push(c);
  }
  return cmds;
}

function problems(c) {
  const why = [];
  if (!/^(?:(?:bash|node)\s+)?v2\/tools\/ops\//.test(c.replace(/^(?:[A-Z_]+=\S+\s+)+/, ''))) why.push('not a v2/tools/ops script');
  const fills = [...c.matchAll(/<([^>]+)>|\$\{?([A-Z_]+)/g)].map((m) => m[1] ?? `$${m[2]}`).filter((f) => f !== 'world');
  if (fills.length) why.push(`fill in ${fills.join(', ')}`);
  if (HOST.test(c)) why.push('host name');
  return why;
}

let bad = 0;
let all = 0;
for (const page of readdirSync(dir).filter((f) => f.endsWith('.md') && !background.has(f)).sort()) {
  for (const c of commands(readFileSync(join(dir, page), 'utf8'))) {
    all++;
    const why = problems(c);
    if (why.length) {
      bad++;
      console.log(`${page}: ${c.slice(0, 100)}\n    ${why.join('; ')}`);
    }
  }
}
console.log(`${all - bad} of ${all} commands pass; ${bad} fail (background, not checked: ${[...background].join(', ')})`);
process.exit(bad ? 1 : 0);
