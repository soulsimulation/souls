import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, checkpoint, MAX_BYTES } from './state.mjs';
import { collectAgenda, formatAgenda, parseAgenda, taskRow } from './status.mjs';
import { publicationFindings } from '../proof/publication.mjs';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const valid = (o = {}) => ({
  owner: 'Claude coordinator', paused: false,
  bindings: { runner: 'build box ssh alias', release_job: 'job-123' },
  rules: [{ rule: 'One lane, one issue.', anchor: '#1960' }, { rule: 'Ceilings are limits.', anchor: 'https://github.com/o/r/issues/1960#issuecomment-1' }],
  updated_at: '2026-11-11T10:00:00Z', ...o,
});
const text = o => JSON.stringify(valid(o));

test('check: exactly owner, paused, bindings, rules (each anchored) and updated_at', () => {
  assert.deepEqual(check(text(), { now: NOW }), []);
  const { paused, ...noPaused } = valid();
  assert.deepEqual(check(JSON.stringify(noPaused)), ['missing field "paused"']);
  assert.deepEqual(check(text({ lanes: [] })), ['unknown field "lanes"']);
  assert.deepEqual(check(text({ rules: [{ rule: 'x', anchor: '#1', note: 'y' }] })), ['rules[0]: unknown field "note"']);
  assert.deepEqual(check(text({ rules: [{ rule: 'x' }] })), ['rules[0].anchor: #N or a github.com issue, PR or comment URL']);
  assert.deepEqual(check(text({ rules: [{ rule: 'x', anchor: 'Gene said so' }] })), ['rules[0].anchor: #N or a github.com issue, PR or comment URL']);
  assert.deepEqual(check(text({ rules: Array.from({ length: 13 }, (_, i) => ({ rule: `r${i}`, anchor: `#${i + 1}` })) })), ['13 rules, more than 12']);
  assert.deepEqual(check(text({ paused: 'no', updated_at: 'yesterday' })), ['paused: true or false', 'updated_at: an ISO time']);
  assert.deepEqual(check('[]'), ['not a JSON object']);
});

test('check: more than 6,000 bytes fails; --max-age fails an older file', () => {
  const big = text({ bindings: { note: 'x'.repeat(MAX_BYTES) } });
  assert.match(check(big)[0], /bytes, more than 6000/);
  assert.deepEqual(check(text(), { maxAgeHours: 3, now: NOW }), []);
  assert.deepEqual(check(text(), { maxAgeHours: 1, now: NOW }), ['updated_at 2026-11-11T10:00:00Z is older than 1h']);
});

const AGENDA = `# Agenda
## Lanes and order

| Lane | Order |
|---|---|
| 4 · Resident | #12 (after #99), #11, #13 |
| After release 2 | #20 |

## Needs Gene

- Off-site backups (#557): a storage target.

## Lane 4 · Resident

| Task | Ceiling (h) | Tier | Depends on | Title |
|---|---|---|---|---|
| #10 | 3 | T0 | none | Done already |
| #11 | 2 | T1 | #12 | Second |
| #12 | 4 | T3 | none | First |
| #13 | 1 | T1 | PR #50 merged | Third |

## After release 2

| Task | Ceiling (h) | Tier | Depends on | Title |
|---|---|---|---|---|
| #20 (re-scopes #20) | 3 | T1 | none · after release 2 | Later |
`;

test('parseAgenda: task rows per lane heading, dispatch order from the lanes table, the Needs Gene section', () => {
  const { tasks, needsGene } = parseAgenda(AGENDA);
  assert.deepEqual(tasks.map(t => [t.number, t.lane, t.ceiling, t.tier, t.depends]), [
    [10, 'Lane 4 · Resident', 3, 'T0', 'none'], [11, 'Lane 4 · Resident', 2, 'T1', '#12'], [12, 'Lane 4 · Resident', 4, 'T3', 'none'],
    [13, 'Lane 4 · Resident', 1, 'T1', 'PR #50 merged'], [20, 'After release 2', 3, 'T1', 'none · after release 2']]);
  assert.deepEqual(tasks.filter(t => t.lane.startsWith('Lane')).sort((a, b) => a.rank - b.rank).map(t => t.number), [12, 11, 13, 10], 'parenthesised #99 ignored; unlisted last');
  assert.equal(needsGene, '- Off-site backups (#557): a storage target.');
});

const pr = (number, o = {}) => ({ number, state: 'OPEN', isDraft: false, headRefName: `agent/${number}-x`, headRefOid: 'abcdef0123456789', mergedAt: null, labels: { nodes: [] }, ...o });
const lbl = (...names) => ({ nodes: names.map(name => ({ name })) });
const claimed = at => ({ nodes: [{ createdAt: '2026-11-10T00:00:00Z', label: { name: 'agent:claimed' } }, { createdAt: at, label: { name: 'agent:claimed' } }] });

test('taskRow: state, PR and head, who it waits on, hours since the newest claim against the Ceiling line', () => {
  const t = { number: 12, lane: 'L', ceiling: 4, tier: 'T3', depends: 'none', title: 'First' };
  const issue = o => ({ number: 12, state: 'OPEN', closedAt: null, body: '**Ceiling:** 2 agent-hours', labels: lbl('agent:claimed'), timelineItems: claimed('2026-11-11T09:00:00Z'), closedByPullRequestsReferences: { nodes: [] }, ...o });
  const r = taskRow(t, issue(), [], new Map(), NOW);
  assert.deepEqual([r.state, r.waits, r.pr, r.hours, r.ceiling], ['claimed', 'lane', null, 3, 2], 'Ceiling line wins over the table');
  assert.deepEqual(taskRow(t, issue(), [pr(40, { headRefName: 'agent/12-x', isDraft: true })], new Map(), NOW).pr, { number: 40, state: 'OPEN', head: 'abcdef01', mergedAt: null }, 'found by branch');
  const linked = p => issue({ closedByPullRequestsReferences: { nodes: [p] } });
  assert.equal(taskRow(t, linked(pr(41)), [], new Map(), NOW).waits, 'maintainer (T3+ sign-off)');
  assert.equal(taskRow(t, linked(pr(41, { labels: lbl('approved:maintainer', 'merge:ready') })), [], new Map(), NOW).waits, 'merge train');
  assert.equal(taskRow(t, linked(pr(41, { labels: lbl('tier:T1', 'needs:rebase') })), [], new Map(), NOW).waits, 'lane (rebase)');
  assert.equal(taskRow(t, linked(pr(41, { labels: lbl('tier:T1') })), [], new Map(), NOW).waits, 'coordinator (review)');
  const m = taskRow(t, linked(pr(41, { state: 'MERGED', mergedAt: '2026-11-11T11:00:00Z' })), [], new Map(), NOW);
  assert.deepEqual([m.state, m.waits, m.hours, m.pr.state], ['merged', null, 2, 'MERGED'], 'hours stop at the merge');
  const ready = o => taskRow({ ...t, number: 11, ...o }, { ...issue(), labels: lbl() }, [], new Map([[12, 'OPEN'], [50, 'MERGED']]), NOW);
  assert.deepEqual([ready({ depends: '#12' }).state, ready({ depends: '#12' }).waits, ready({ depends: '#12' }).hours], ['ready', 'deps #12', null], 'an old claim label event on an unclaimed task counts no hours');
  assert.equal(ready({ depends: 'PR #50 merged' }).waits, 'coordinator (dispatch)');
  assert.equal(ready({ depends: 'none · after release 2' }).waits, 'after release 2');
});

test('collectAgenda + checkpoint: one Markdown checkpoint, bindings left out, publishable', async () => {
  const issues = {
    10: { number: 10, state: 'CLOSED', closedAt: '2026-11-11T08:00:00Z', body: '', labels: lbl(), timelineItems: { nodes: [] }, closedByPullRequestsReferences: { nodes: [pr(30, { state: 'MERGED', mergedAt: '2026-11-11T08:00:00Z' })] } },
    11: { number: 11, state: 'OPEN', body: '', labels: lbl(), timelineItems: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] } },
    12: { number: 12, state: 'OPEN', body: '**Ceiling:** 4 agent-hours', labels: lbl('agent:claimed'), timelineItems: claimed('2026-11-11T11:00:00Z'), closedByPullRequestsReferences: { nodes: [pr(31)] } },
    13: { number: 13, state: 'OPEN', body: '', labels: lbl(), timelineItems: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] } },
    20: { number: 20, state: 'OPEN', body: '', labels: lbl(), timelineItems: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] } },
    50: { number: 50, state: 'MERGED' },
  };
  const queries = [];
  const api = {
    get: async path => { assert.equal(path, 'repos/o/r/issues/1960'); return [{ body: AGENDA }]; },
    graphql: async q => {
      queries.push(q);
      if (/latestRelease/.test(q)) return { repository: { latestRelease: { tagName: 'v0.124', publishedAt: '2026-11-11T07:00:00Z' }, pullRequests: { nodes: [] } } };
      if (/search\(/.test(q)) { assert.match(q, /merged:>=2026-11-11T07:00:00Z/); return { search: { issueCount: 5 } }; }
      return { repository: Object.fromEntries([...q.matchAll(/i(\d+): issueOrPullRequest/g)].map(m => [`i${m[1]}`, issues[m[1]]])) };
    },
  };
  const a = await collectAgenda({ repo: 'o/r', agenda: 1960, api, now: NOW });
  assert.ok(queries.every(q => !/mutation/.test(q)), 'read-only');
  assert.deepEqual(a.rows.map(r => [r.number, r.state, r.waits]), [[10, 'merged', null], [11, 'ready', 'deps #12'], [12, 'review', 'maintainer (T3+ sign-off)'], [13, 'ready', 'coordinator (dispatch)'], [20, 'ready', 'after release 2']]);
  const md = formatAgenda(a);
  assert.match(md, /\*\*Release:\*\* last v0\.124 at 2026-11-11T07:00Z; 5 PRs merged since, 1 of them agenda tasks \(#10\)\./);
  assert.match(md, /- #12 PR #31: T3 sign-off/);
  assert.match(md, /On: #12 \(review\)\. Next: #11 \(depends on #12; open: #12\)\./);
  assert.match(md, /\| #12 \| review \| #31 @abcdef01 \| maintainer \(T3\+ sign-off\) \| 1\.0h \/ 4h \| First \|/);
  const out = checkpoint(valid(), a);
  assert.match(out, /## Standing rules\n\n1\. One lane, one issue\. \(#1960\)\n2\. Ceilings are limits\./);
  assert.ok(!out.includes('job-123') && !out.includes('ssh alias'), 'bindings never appear');
  assert.deepEqual(publicationFindings(out, { denylist: [] }), []);
});
