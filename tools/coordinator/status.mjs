#!/usr/bin/env node
// The coordinator's heartbeat in one call: merges since a time, the merge:ready queue in train order with each head's
// fresh required checks, the Actions queue by workflow, and the PRs labelled needs:rebase.
//
//   node tools/coordinator/status.mjs [--repo o/r] [--since 6h|30m|2d|<ISO time>] [--json]
//   node tools/coordinator/status.mjs --agenda <issue> [--repo o/r] [--json]
//        instead: each task the agenda issue lists, by lane, with its state, PR and head, who it waits on, and the
//        hours since it was claimed against its Ceiling line; the last release and the agenda's Needs Gene section
//
// Read-only: every call is a `gh api` GET (GH_TOKEN or the gh login). The output holds only what the GitHub API says
// about the repository: no tokens, host names or local paths.
// - Merges come from the search API (`is:merged merged:>=<since>`), sorted by merged_at. `gh pr list --state merged
//   --limit N` lists the most recently created merged PRs and misses a late merge of an old PR.
// - Check states are the newest result per required name at the PR head, after dropping stale ones as the merge train
//   does (#910): a check run whose Actions run was cancelled or replaced by a newer run of the same workflow at that
//   head says nothing about the head. A cancelled conclusion is pending, never a failure.
// - Train order is the order `merge-train.mjs next` tries: ascending PR number among merge:ready.
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_CHECKS, READY, REBASE, blocker, maintainerApproved, APPROVED_LABEL } from '../../.github/scripts/merge-train.mjs';
import { loadPolicy, tierFor } from '../proof/tier.mjs';

/** `--since`: an ISO time, or a span back from `now` (30m, 6h, 2d). */
export function parseSince(text = '12h', now = Date.now()) {
  const m = /^(\d+(?:\.\d+)?)\s*([mhd])$/.exec(String(text).trim());
  if (m) return new Date(now - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]]).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const t = Date.parse(text);
  if (Number.isNaN(t)) throw Error(`--since: expected an ISO time or 30m/6h/2d, got "${text}"`);
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Newest state per required check at one head: 'pass' | 'fail:<conclusion>' | 'pending' | 'missing'.
 * Check runs from cancelled or superseded Actions runs are dropped first (as #910 does in the train); a name that had
 * only stale runs is pending (its replacing run has not reported yet). Commit statuses fill names no check run has.
 */
export function checkStates({ runs = [], statuses = [], workflowRuns = [], required = DEFAULT_CHECKS }) {
  const bySuite = new Map(workflowRuns.filter(w => w.check_suite_id != null).map(w => [w.check_suite_id, w]));
  const newest = new Map();
  for (const w of workflowRuns) { if (w.conclusion === 'skipped') continue; const prev = newest.get(w.workflow_id); if (!prev || w.id > prev.id) newest.set(w.workflow_id, w); }
  const stale = r => { const w = r.check_suite?.id != null && bySuite.get(r.check_suite.id); return !!w && (w.conclusion === 'cancelled' || newest.get(w.workflow_id) !== w); };
  const latest = new Map(), seen = new Set();
  for (const r of runs) { seen.add(r.name); if (stale(r)) continue; const prev = latest.get(r.name); if (!prev || r.id > prev.id) latest.set(r.name, r); }
  const status = new Map();
  for (const s of statuses) if (!status.has(s.context)) status.set(s.context, s); // newest first
  return Object.fromEntries(required.map(name => {
    const r = latest.get(name), s = status.get(name);
    if (r) return [name, r.status !== 'completed' || r.conclusion === 'cancelled' ? 'pending' : ['success', 'neutral', 'skipped'].includes(r.conclusion) ? 'pass' : `fail:${r.conclusion}`];
    if (seen.has(name)) return [name, 'pending'];
    if (s) return [name, s.state === 'pending' ? 'pending' : s.state === 'success' ? 'pass' : `fail:${s.state}`];
    return [name, 'missing'];
  }));
}

/** Queued and in-progress Actions runs, counted by workflow file (`ci`, `security`, ...; a run-name can be per PR). */
export const workflowOf = r => r.path ? r.path.split('/').pop().replace(/\.ya?ml(@.*)?$/, '') : r.name;
export function queueDepth(runs = []) {
  const out = { queued: {}, in_progress: {} };
  for (const r of runs) if (out[r.status]) { const k = workflowOf(r); out[r.status][k] = (out[r.status][k] ?? 0) + 1; }
  const sort = o => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  return { queued: sort(out.queued), in_progress: sort(out.in_progress) };
}

// ── collect ─────────────────────────────────────────────────────────────────────────────────────────────────────
const exec = promisify(execFile);
const ghGet = async path => { const { stdout } = await exec('gh', ['api', '-X', 'GET', path, '--paginate', '--slurp'], { maxBuffer: 1 << 27 }); return JSON.parse(stdout); };
export const githubApi = { get: ghGet };
const pages = (p, key) => p.flatMap(x => (key && x?.[key]) ?? x);

export async function collect({ repo, since, maintainer = repo.split('/')[0], required = DEFAULT_CHECKS, api = githubApi, policy = loadPolicy() }) {
  const q = encodeURIComponent(`repo:${repo} is:pr is:merged merged:>=${since}`);
  const [repoInfo, mergedPages, readyPages, rebasePages, queued, running] = await Promise.all([
    api.get(`repos/${repo}`).then(p => p[0] ?? p),
    api.get(`search/issues?q=${q}&per_page=100`),
    api.get(`repos/${repo}/issues?state=open&labels=${encodeURIComponent(READY)}&per_page=100`),
    api.get(`repos/${repo}/issues?state=open&labels=${encodeURIComponent(REBASE)}&per_page=100`),
    api.get(`repos/${repo}/actions/runs?status=queued&per_page=100`),
    api.get(`repos/${repo}/actions/runs?status=in_progress&per_page=100`),
  ]);
  const merged = pages(mergedPages, 'items').map(i => ({ number: i.number, merged_at: i.pull_request?.merged_at, title: i.title }))
    .sort((a, b) => String(a.merged_at).localeCompare(String(b.merged_at)));
  const ready = await Promise.all(pages(readyPages).filter(i => i.pull_request).sort((a, b) => a.number - b.number).map(async i => {
    const n = i.number;
    const [pr, files] = await Promise.all([api.get(`repos/${repo}/pulls/${n}`).then(p => p[0] ?? p), api.get(`repos/${repo}/pulls/${n}/files?per_page=100`)]);
    const labels = (pr.labels ?? []).map(l => l.name);
    const { tier } = tierFor(pages(files).flatMap(f => [f.filename, f.previous_filename]).filter(Boolean), policy, labels);
    const sha = pr.head.sha;
    const [runs, statuses, workflowRuns, reviews, events] = await Promise.all([
      api.get(`repos/${repo}/commits/${sha}/check-runs?per_page=100`).then(p => pages(p, 'check_runs')),
      api.get(`repos/${repo}/commits/${sha}/statuses?per_page=100`).then(p => pages(p)),
      api.get(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`).then(p => pages(p, 'workflow_runs')),
      ['T3', 'T4'].includes(tier) ? api.get(`repos/${repo}/pulls/${n}/reviews?per_page=100`).then(p => pages(p)) : [],
      ['T3', 'T4'].includes(tier) && labels.includes(APPROVED_LABEL) ? api.get(`repos/${repo}/issues/${n}/events?per_page=100`).then(p => pages(p)) : [],
    ]);
    const approved = ['T3', 'T4'].includes(tier) ? maintainerApproved({ reviews, events, labels, maintainer }) : false;
    return { number: n, title: pr.title, tier, head: sha.slice(0, 8), waits: blocker({ pr, tier, approved, defaultBranch: repoInfo.default_branch }), checks: checkStates({ runs, statuses, workflowRuns, required }) };
  }));
  const needsRebase = pages(rebasePages).filter(i => i.pull_request).map(i => ({ number: i.number, title: i.title })).sort((a, b) => a.number - b.number);
  return { repo, since, merged, ready, needsRebase, actions: queueDepth([...pages(queued, 'workflow_runs'), ...pages(running, 'workflow_runs')]) };
}

// ── format ──────────────────────────────────────────────────────────────────────────────────────────────────────
const cut = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const hm = iso => String(iso).slice(5, 16).replace('T', ' ');
const counts = o => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ');

export function format(s, now = new Date().toISOString()) {
  const lines = [`status ${s.repo} at ${now.slice(0, 16)}Z`];
  lines.push(`merged since ${s.since} (${s.merged.length}):`);
  for (const m of s.merged) lines.push(`  #${m.number} ${hm(m.merged_at)}Z ${cut(m.title)}`);
  lines.push(`train, merge:ready in order (${s.ready.length}):`);
  s.ready.forEach((p, i) => {
    const bad = Object.entries(p.checks).filter(([, v]) => v !== 'pass');
    const checks = bad.length ? bad.map(([k, v]) => `${k}=${v}`).join(' ') : 'all required green';
    lines.push(`  ${i + 1}. #${p.number} ${p.tier} ${p.waits ? `waits:${p.waits}` : 'can go'} @${p.head} | ${checks} | ${cut(p.title, 50)}`);
  });
  lines.push(`needs:rebase (${s.needsRebase.length}):${s.needsRebase.length ? '' : ' none'}`);
  for (const p of s.needsRebase) lines.push(`  #${p.number} ${cut(p.title)}`);
  const q = Object.values(s.actions.queued).reduce((a, b) => a + b, 0), r = Object.values(s.actions.in_progress).reduce((a, b) => a + b, 0);
  lines.push(`actions: queued ${q}${q ? ` (${counts(s.actions.queued)})` : ''}; running ${r}${r ? ` (${counts(s.actions.in_progress)})` : ''}`);
  return lines.join('\n');
}

// ── agenda ──────────────────────────────────────────────────────────────────────────────────────────────────────
// `--agenda <issue>`: the lane table, computed from GitHub. A task is a table row whose first cell starts with `#N`,
// in the lane named by the `##` heading above it; the agenda's "Lanes and order" table (first cell the lane name, then
// its issues in order, parenthesised refs ignored) sets each lane's dispatch order. A task's PR is one that closes it
// (`Closes #N`), else an open PR on a branch `agent/<N>-…`; its claim time is the newest `agent:claimed` label event.
const refs = s => [...String(s).matchAll(/#(\d+)/g)].map(m => Number(m[1]));
const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
const laneKey = s => s.replace(/^Lane\s+/i, '').trim();

export function parseAgenda(body) {
  const tasks = [], order = new Map(), sections = new Map();
  let lane = '', header = null;
  for (const line of String(body).split(/\r?\n/)) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) { lane = h[1].trim(); header = null; sections.set(lane, []); continue; }
    if (lane) sections.get(lane).push(line);
    if (!line.trim().startsWith('|')) { header = null; continue; }
    const c = cells(line);
    if (c.every(x => /^:?-+:?$/.test(x))) continue;
    if (!/^#\d+/.test(c[0])) {
      if (!header) header = c.map(x => x.toLowerCase());
      else if (c.length === 2 && refs(c[1]).length) order.set(laneKey(c[0]), refs(c[1].replace(/\([^)]*\)/g, '')));
      continue;
    }
    const col = re => { const i = header?.findIndex(x => re.test(x)) ?? -1; return i >= 0 ? c[i] ?? '' : ''; };
    const number = refs(c[0])[0];
    if (!tasks.some(t => t.number === number)) tasks.push({ number, lane, ceiling: Number.parseFloat(col(/ceiling/)) || null, tier: col(/tier/), depends: col(/depend/), title: col(/title/) });
  }
  for (const t of tasks) { const o = order.get(laneKey(t.lane)) ?? []; t.rank = o.includes(t.number) ? o.indexOf(t.number) : o.length + tasks.indexOf(t); }
  const section = name => (sections.get(name) ?? []).join('\n').trim();
  return { tasks, needsGene: section('Needs Gene') };
}

const PR_FIELDS = 'number state isDraft headRefName headRefOid mergedAt labels(first:30){nodes{name}}';
const TASK_FIELDS = `number title state closedAt body labels(first:30){nodes{name}}
  timelineItems(itemTypes:[LABELED_EVENT], last:50){nodes{... on LabeledEvent{createdAt label{name}}}}
  closedByPullRequestsReferences(first:10, includeClosedPrs:true){nodes{${PR_FIELDS}}}`;
const ghGraphql = async query => { const { stdout } = await exec('gh', ['api', 'graphql', '-f', `query=${query}`], { maxBuffer: 1 << 27 }); return JSON.parse(stdout).data; };
githubApi.graphql = ghGraphql;

/** One task's row from its issue and PRs: state, PR and head, who it waits on, hours since claimed. */
export function taskRow(task, issue, openPrs = [], depState = new Map(), now = Date.now()) {
  const names = o => (o?.labels?.nodes ?? []).map(l => l.name);
  const linked = issue?.closedByPullRequestsReferences?.nodes ?? [];
  const byBranch = openPrs.filter(p => p.headRefName?.startsWith(`agent/${task.number}-`));
  const prs = [...linked, ...byBranch.filter(p => !linked.some(l => l.number === p.number))];
  const pr = prs.find(p => p.state === 'OPEN') ?? prs.find(p => p.mergedAt) ?? prs.sort((a, b) => b.number - a.number)[0];
  const labels = names(issue), prLabels = names(pr);
  const ceiling = Number.parseFloat(/\*\*Ceiling:\*\*\s*(\d+(?:\.\d+)?)/.exec(issue?.body ?? '')?.[1]) || task.ceiling;
  const tier = prLabels.find(l => /^tier:T\d$/.test(l))?.slice(5) ?? (task.tier || null);
  const claims = (issue?.timelineItems?.nodes ?? []).filter(e => e.label?.name === 'agent:claimed').map(e => e.createdAt).sort();
  const claimedAt = claims.at(-1) ?? null;
  const end = pr?.mergedAt ?? issue?.closedAt ?? null;
  let hours = claimedAt ? Math.max(0, ((end ? Date.parse(end) : now) - Date.parse(claimedAt)) / 3_600_000) : null;
  const openDeps = refs(task.depends).filter(n => depState.get(n) === 'OPEN');
  let state, waits;
  if (pr?.mergedAt) [state, waits] = ['merged', null];
  else if (issue?.state === 'CLOSED') [state, waits] = ['closed', null];
  else if (pr?.state === 'OPEN' && pr.isDraft) [state, waits] = ['draft', 'lane'];
  else if (pr?.state === 'OPEN') {
    state = 'review';
    waits = prLabels.includes(REBASE) ? 'lane (rebase)'
      : ['T3', 'T4'].includes(tier) && !prLabels.includes(APPROVED_LABEL) ? 'maintainer (T3+ sign-off)'
        : prLabels.includes(READY) ? 'merge train' : 'coordinator (review)';
  } else if (labels.includes('agent:claimed')) [state, waits] = ['claimed', 'lane'];
  else [state, waits] = ['ready', openDeps.length ? `deps ${openDeps.map(n => `#${n}`).join(' ')}` : /after release \d+/i.exec(task.depends)?.[0] ?? 'coordinator (dispatch)'];
  if (state === 'ready') hours = null; // an unclaimed task's old claim (an earlier agenda) is not running time
  return { ...task, ceiling, tier, state, waits, pr: pr ? { number: pr.number, state: pr.mergedAt ? 'MERGED' : pr.state, head: pr.headRefOid?.slice(0, 8) ?? null, mergedAt: pr.mergedAt ?? null } : null, claimedAt, hours, openDeps };
}

export async function collectAgenda({ repo, agenda, api = githubApi, now = Date.now() }) {
  const [owner, name] = repo.split('/');
  const issue = await api.get(`repos/${repo}/issues/${agenda}`).then(p => p[0] ?? p);
  const { tasks, needsGene } = parseAgenda(issue.body);
  const deps = [...new Set(tasks.flatMap(t => refs(t.depends)))].filter(n => !tasks.some(t => t.number === n));
  const issues = new Map(), depState = new Map();
  const all = [...tasks.map(t => ['t', t.number]), ...deps.map(n => ['d', n])];
  for (let i = 0; i < all.length; i += 20) {
    const part = all.slice(i, i + 20).map(([k, n]) => k === 't'
      ? `i${n}: issueOrPullRequest(number:${n}){ ... on Issue { ${TASK_FIELDS} } ... on PullRequest { number state } }`
      : `i${n}: issueOrPullRequest(number:${n}){ ... on Issue { number state } ... on PullRequest { number state } }`).join('\n');
    const data = await api.graphql(`{ repository(owner:"${owner}", name:"${name}") { ${part} } }`);
    for (const [k, v] of Object.entries(data.repository)) if (v) { issues.set(Number(k.slice(1)), v); depState.set(Number(k.slice(1)), v.state); }
  }
  const head = await api.graphql(`{ repository(owner:"${owner}", name:"${name}") { latestRelease { tagName publishedAt }
    pullRequests(states:OPEN, first:100, orderBy:{field:CREATED_AT, direction:DESC}){ nodes { ${PR_FIELDS} } } } }`);
  const release = head.repository.latestRelease;
  const since = release?.publishedAt
    ? (await api.graphql(`{ search(query:"repo:${repo} is:pr is:merged merged:>=${release.publishedAt}", type:ISSUE, first:1){ issueCount } }`)).search.issueCount
    : null;
  const rows = tasks.map(t => taskRow(t, issues.get(t.number), head.repository.pullRequests.nodes, depState, now));
  return { repo, agenda: Number(agenda), at: new Date(now).toISOString(), release: release ? { tag: release.tagName, at: release.publishedAt, mergedSince: since } : null, rows, needsGene };
}

const fmtH = h => (h == null ? '—' : `${h.toFixed(1)}h`);
const esc = s => String(s).replace(/\|/g, '\\|');

/** The agenda table as Markdown: per lane, what it is on and what goes next, then the task rows in dispatch order. */
export function formatAgenda(a) {
  const out = [`Agenda #${a.agenda} on ${a.repo}, computed from GitHub at ${a.at.slice(0, 16)}Z.`, ''];
  const r = a.release;
  const tasksSince = r ? a.rows.filter(x => x.pr?.mergedAt && x.pr.mergedAt >= r.at).map(x => `#${x.number}`) : [];
  out.push(r ? `**Release:** last ${r.tag} at ${r.at.slice(0, 16)}Z; ${r.mergedSince} PRs merged since, ${tasksSince.length} of them agenda tasks${tasksSince.length ? ` (${tasksSince.join(', ')})` : ''}.` : '**Release:** none published.');
  const gene = a.rows.filter(x => x.waits?.startsWith('maintainer'));
  out.push('', '## Needs Gene', '', ...(gene.length ? gene.map(x => `- #${x.number} PR #${x.pr.number}: ${x.tier} sign-off`) : ['- No task PR waits on a maintainer sign-off.']));
  if (a.needsGene) out.push('', 'From the agenda:', '', a.needsGene);
  const lanes = [...new Set(a.rows.map(x => x.lane))];
  for (const lane of lanes) {
    const rows = a.rows.filter(x => x.lane === lane).sort((x, y) => x.rank - y.rank);
    const on = rows.filter(x => ['claimed', 'draft', 'review'].includes(x.state));
    const next = rows.find(x => x.state === 'ready');
    out.push('', `## ${lane}`, '');
    out.push(`On: ${on.length ? on.map(x => `#${x.number} (${x.state})`).join(', ') : 'nothing'}. Next: ${next ? `#${next.number}${next.depends && next.depends !== 'none' ? ` (depends on ${esc(next.depends)}${next.openDeps.length ? `; open: ${next.openDeps.map(n => `#${n}`).join(' ')}` : ''})` : ''}` : 'none'}.`, '');
    out.push('| Task | State | PR @head | Waits on | Claimed / ceiling | Title |', '|---|---|---|---|---|---|');
    for (const x of rows) out.push(`| #${x.number} | ${x.state} | ${x.pr ? `#${x.pr.number} @${x.pr.head ?? '—'}` : '—'} | ${x.waits ?? '—'} | ${fmtH(x.hours)} / ${x.ceiling ?? '?'}h${x.hours != null && x.ceiling && x.hours > x.ceiling ? ' over' : ''} | ${esc(cut(x.title || '', 70))} |`);
  }
  return out.join('\n');
}

export async function repoFromGit() {
  const { stdout } = await exec('git', ['remote', 'get-url', 'origin']);
  const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?\s*$/.exec(stdout);
  if (!m) throw Error('no GitHub origin remote; pass --repo owner/name');
  return m[1];
}

async function main(argv) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const repo = opt('--repo') ?? process.env.GITHUB_REPOSITORY ?? await repoFromGit();
  const required = process.env.MERGE_TRAIN_CHECKS ? process.env.MERGE_TRAIN_CHECKS.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_CHECKS;
  if (opt('--agenda')) {
    const a = await collectAgenda({ repo, agenda: opt('--agenda') });
    console.log(argv.includes('--json') ? JSON.stringify(a, null, 2) : formatAgenda(a));
    return 0;
  }
  const s = await collect({ repo, since: parseSince(opt('--since')), maintainer: opt('--maintainer') ?? process.env.MAINTAINER, required });
  console.log(argv.includes('--json') ? JSON.stringify(s, null, 2) : format(s));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
