#!/usr/bin/env node
// The coordinator's private state file holds only what GitHub cannot: who owns the agenda, whether it is paused,
// private bindings (machines, run ids, handles) and at most twelve standing rules, each anchored to the decision that
// made it. Everything else (lanes, PRs, heads, claims, releases) is computed from GitHub by status.mjs --agenda.
//
//   node tools/coordinator/state.mjs check <file> [--max-age <hours>]
//        exit 1 with each problem when the file has a missing or unknown field, a bad value, more than twelve rules,
//        more than 6,000 bytes, or (with --max-age) an updated_at older than that
//   node tools/coordinator/state.mjs checkpoint <file> --agenda <issue> [--repo o/r]
//        the status table plus the standing rules as Markdown, bindings left out; refused (exit 1, nothing printed)
//        unless the output passes tools/proof/publication.mjs
//
// The file is JSON:
//   { "owner": "<who coordinates>", "paused": false, "bindings": { ...private, free-form... },
//     "rules": [{ "rule": "<one standing rule>", "anchor": "#1960 or a github.com issue/PR/comment URL" }],
//     "updated_at": "<ISO time>" }
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicationFindings } from '../proof/publication.mjs';
import { collectAgenda, formatAgenda, repoFromGit } from './status.mjs';

export const MAX_BYTES = 6000, MAX_RULES = 12;
const FIELDS = ['owner', 'paused', 'bindings', 'rules', 'updated_at'];
const ANCHOR = /^(#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+(#[\w-]+)?)$/;
const isObject = v => v != null && typeof v === 'object' && !Array.isArray(v);

/** Every problem with a state file's text; empty when it is valid. */
export function check(text, { maxAgeHours, now = Date.now() } = {}) {
  const problems = [];
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_BYTES) problems.push(`${bytes} bytes, more than ${MAX_BYTES}`);
  let s;
  try { s = JSON.parse(text); } catch { return [...problems, 'not JSON']; }
  if (!isObject(s)) return [...problems, 'not a JSON object'];
  for (const k of Object.keys(s)) if (!FIELDS.includes(k)) problems.push(`unknown field "${k}"`);
  for (const k of FIELDS) if (!(k in s)) problems.push(`missing field "${k}"`);
  if ('owner' in s && (typeof s.owner !== 'string' || !s.owner.trim())) problems.push('owner: a non-empty string');
  if ('paused' in s && typeof s.paused !== 'boolean') problems.push('paused: true or false');
  if ('bindings' in s && !isObject(s.bindings)) problems.push('bindings: an object');
  if ('rules' in s) {
    if (!Array.isArray(s.rules)) problems.push('rules: an array');
    else {
      if (s.rules.length > MAX_RULES) problems.push(`${s.rules.length} rules, more than ${MAX_RULES}`);
      s.rules.forEach((r, i) => {
        if (!isObject(r)) return problems.push(`rules[${i}]: an object { rule, anchor }`);
        for (const k of Object.keys(r)) if (!['rule', 'anchor'].includes(k)) problems.push(`rules[${i}]: unknown field "${k}"`);
        if (typeof r.rule !== 'string' || !r.rule.trim()) problems.push(`rules[${i}].rule: a non-empty string`);
        if (typeof r.anchor !== 'string' || !ANCHOR.test(r.anchor)) problems.push(`rules[${i}].anchor: #N or a github.com issue, PR or comment URL`);
      });
    }
  }
  if ('updated_at' in s) {
    const t = typeof s.updated_at === 'string' ? Date.parse(s.updated_at) : NaN;
    if (Number.isNaN(t)) problems.push('updated_at: an ISO time');
    else if (maxAgeHours != null && now - t > maxAgeHours * 3_600_000) problems.push(`updated_at ${s.updated_at} is older than ${maxAgeHours}h`);
  }
  return problems;
}

/** The checkpoint: the agenda status, then owner and standing rules. Bindings never appear. */
export function checkpoint(state, agendaStatus) {
  const rules = state.rules.map((r, i) => `${i + 1}. ${r.rule} (${r.anchor})`);
  return [
    `# Coordinator checkpoint`, '',
    `**Owner:** ${state.owner}. **Paused:** ${state.paused ? 'yes' : 'no'}. State file updated ${state.updated_at}.`, '',
    formatAgenda(agendaStatus), '',
    '## Standing rules', '', ...(rules.length ? rules : ['None.']),
  ].join('\n');
}

async function main(argv) {
  const [cmd, file] = argv;
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (!['check', 'checkpoint'].includes(cmd) || !file) { console.error('usage: state.mjs check <file> [--max-age <hours>] | checkpoint <file> --agenda <issue> [--repo o/r]'); return 2; }
  const text = readFileSync(file, 'utf8');
  const maxAge = opt('--max-age');
  const problems = check(text, { maxAgeHours: maxAge == null ? undefined : Number(maxAge) });
  if (problems.length) { for (const p of problems) console.error(`state: ${p}`); return 1; }
  if (cmd === 'check') { console.log('state: ok'); return 0; }
  const agenda = opt('--agenda');
  if (!agenda) { console.error('checkpoint needs --agenda <issue>'); return 2; }
  const repo = opt('--repo') ?? process.env.GITHUB_REPOSITORY ?? await repoFromGit();
  const out = checkpoint(JSON.parse(text), await collectAgenda({ repo, agenda }));
  const findings = publicationFindings(out);
  if (findings.length) { console.error(`checkpoint refused, publication check: ${findings.join(', ')}`); return 1; }
  console.log(out);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
