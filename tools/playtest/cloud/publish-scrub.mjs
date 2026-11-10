#!/usr/bin/env node
// A spec arm's results on their way to a public branch (#1131): node tools/playtest/cloud/publish-scrub.mjs <dir>
// Seat folders, world data and binary files go. Machine details are replaced in every text file, then each file must pass
// tools/proof/publication.mjs's check, name and contents; one that still fails is removed and named, never its contents, in
// OMITTED-PRIVATE.txt (a name that fails is withheld too). Symbolic links go: git would publish where they point.
// Anything that goes wrong here exits non-zero, and run-replay.sh then publishes nothing.
import { lstatSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { publicationFindings } from '../../proof/publication.mjs';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !statSync(root).isDirectory()) throw new Error('usage: publish-scrub.mjs <dir>');
const DROP = /(?:^|\/)(?:folder|server\/data|node_modules)(?:\/|$)/;
const lit = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const host = hostname(), user = userInfo().username;
const REPLACE = [
  [new RegExp(lit(homedir()), 'g'), '<home>'],
  [/\/(?:private\/)?(?:tmp|var\/folders)\/[^\s"'`\\)]*/g, '<tmp>'],
  [/\/home\/[^/\s"'`\\)]+/g, '<home>'],
  [/\b(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?/g, 'http://world.invalid'],
  [/\b127\.0\.0\.1\b(?::\d+)?/g, '<local>'],
  [/\blocalhost:\d{2,5}\b/g, '<local>'],
  [/\b0\.0\.0\.0\b/g, '<any>'],
  [/(?<![\w.%+:/@-])([A-Za-z_][\w.-]*)@([A-Za-z][\w-]*)(?![\w.@-])/g, '$1 at $2'],   // an SSH-shaped word: `name@label`
  ...(host ? [[new RegExp(lit(host.split('.')[0]), 'gi'), '<host>']] : []),
  ...(user && user.length > 2 ? [[new RegExp(`\\b${lit(user)}\\b`, 'g'), '<user>']] : []),
];
const scrub = (t) => REPLACE.reduce((s, [a, b]) => s.replace(a, b), t);
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.isFile() ? [join(d, e.name)] : [e.isSymbolicLink() ? join(d, e.name) : []].flat()));
const isText = (b) => !b.subarray(0, 8192).includes(0);
const asValue = (file, t) => {
  try { if (/\.json$/.test(file)) return JSON.parse(t); if (/\.jsonl$/.test(file)) return t.split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* read as text */ }
  return t;
};
const removed = [], kept = [];
const listed = (rel) => (publicationFindings(scrub(rel)).length ? '<name withheld>' : scrub(rel));
const drop = (f, why) => { rmSync(f, { force: true }); removed.push(`${listed(relative(root, f))}: ${why}`); };
for (const f of walk(root)) {
  const rel = relative(root, f);
  if (DROP.test(rel)) { drop(f, 'seat folder or world data'); continue; }
  if (lstatSync(f).isSymbolicLink()) { drop(f, 'symbolic link'); continue; }
  const bytes = readFileSync(f);
  if (!isText(bytes)) { drop(f, 'binary'); continue; }
  const text = scrub(bytes.toString('utf8'));
  writeFileSync(f, text);
  const findings = publicationFindings([rel, asValue(f, text)]);
  if (findings.length) drop(f, findings.join(', ')); else kept.push(rel);
}
writeFileSync(join(root, 'OMITTED-PRIVATE.txt'), `${removed.join('\n')}\n`);
console.log(JSON.stringify({ kept: kept.length, removed: removed.length }));
