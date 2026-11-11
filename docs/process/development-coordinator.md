# Development coordinator

One coordinator runs Gene's authorized development agenda: it dispatches task issues to lanes, reviews and signs
their pull requests, keeps the merge queue moving through a steward, and releases. It stays thin and never does a
lane's work. It is a role for one main session in any harness, not a service or a
scheduler. Gene alone decides scope, priority, spend and production machines. Lanes follow
[lane.md](../../.claude/agents/lane.md); intake follows [planning](planning.md).

## State

The coordinator keeps two kinds of durable state and nothing else:

- **GitHub**: the agenda issue (the pinned coordination issue named in `AGENTS.md`), task issues, pull requests,
  labels and releases. `node tools/coordinator/status.mjs --agenda <issue>` computes the lane table from them.
- **A private state file**: owner, paused, private bindings (machines, run ids, handles), at most twelve standing
  rules each anchored to the decision that made it, and `updated_at`. `node tools/coordinator/state.mjs check <file>`
  validates it. It is an ignored local file holding no secrets, never tracked or attached publicly. Only the
  current coordinator writes it.

No brief, handoff folder, manifest or lane table is state. Chat history, auto-memory and task ids are conveniences,
never the only record of work or authority. What you have not observed is unknown; an old record proves nothing
about what is still running. Public text never carries device details
([publication privacy](publication-privacy.md)).

## Start or resume

Read `AGENTS.md` and the agenda issue first, and again after any context compaction or handoff.

A **first launch is orientation-only** unless Gene asks for execution in that session. With a few read-only queries, not a new audit,
report what is live, merged but unreleased, in progress or waiting, and what needs Gene, separating observed facts
from old reports. Do not claim ownership, dispatch, edit code or issues, merge, deploy, or stop existing work. Then
wait for Gene's agenda, capacity and instruction to begin. A saved agenda is context, not permission.

A **takeover** names the agenda to resume and authorizes it at once. Run
`node tools/coordinator/state.mjs checkpoint <file> --agenda <issue>`, confirm against `status.mjs` and the live PR
heads, and confirm the previous coordinator and its lanes have stopped: age alone is not proof, and never run two
writers on one worktree. Keep running gates, builds and CI; a switch is not a reason to restart them. Never
repeat a finished side effect (merge, deploy, upload, comment) or valid proof. Then re-dispatch from the checkpoint.

Fresh-session starter (orientation only):

> Act as Souls development coordinator. Read AGENTS.md,
> docs/process/development-coordinator.md and the agenda issue. This turn is orientation-only: with read-only
> queries, report where development and release stand, what is running or waiting, and what needs me, separating
> observed facts from old reports. Do not dispatch, take ownership, change code or issues, merge or deploy. Then
> stop and wait for my agenda, capacity and instruction to begin.

## Dispatch

- **Only the agenda is dispatched**, in its order: one task issue per lane. New work enters by adding a task issue
  to the agenda. A feature idea, a label or a restarted session authorizes nothing.
- **The coordinator writes each task's bounds before dispatch**: a ceiling of 1 to 4 agent-hours, a Touches list,
  at most five acceptance items, what is not in it and a stop rule
  ([template](../../.github/ISSUE_TEMPLATE/task.yml)). Split larger outcomes into several tasks without dropping
  scope; sequence shared-contract changes before their consumers.
- **The brief is short**: "Work task issue #N to its stop rule. Read AGENTS.md, .claude/agents/lane.md and the issue.
  Do nothing outside it. State the time you took in the pull request." Add only the base revision and private
  bindings, the latter through a private channel.
- **Never extend a task by message.** Edit the issue or open a new one. Only the coordinator changes Acceptance,
  Touches or the ceiling.
- **Isolate writers.** One writer per worktree, test data directory and port set; read-only assets and caches are
  shared. Prefer lanes that touch different files; serialize coupled work. A claim label is a record, not a lock.
- **Capacity.** The worker ceiling is a maximum, not a target; the steward and reviewers count against it. Honor
  the executor's real limit and report it. Stop dispatching while more than eight pull requests are ready and
  unmerged. When a lane hands back, dispatch its next task in the same turn. On every wake, reconcile every lane.
  Never claim a worker runs because its issue is assigned.
- **Models.** The coordinator uses a top frontier model; lanes a top workhorse; cheaper models suit mechanical work
  with objective checks; a frontier delegate is an exception with its reason recorded. Select and verify the model;
  report a fallback. Unknown quota is not permission; never silently buy API capacity.
- **Waiting.** Use completion events and bounded waits, not polling turns. A watch that expires and is re-armed on
  wake (for example a 30-minute PR-change monitor) is allowed; cron, scheduled agents and daemons are not. Remain
  available to Gene while lanes run; a status question is not a stop.
- **Changed priorities** reorder unstarted work first. Pause means no new dispatch; reduced capacity drains lanes
  at their stop rule.

**Claude Code.** Lanes run as background subagents of the coordinator session, started with the Agent tool
(`lane` agent, worktree isolation), never as `start_session` sidebar sessions. Their completion wakes the
coordinator; they end with its session. A permission-classifier refusal is fixed with a narrow allow rule in the
ignored local Claude settings, never a broad one; a lane never asks another session to run a command it
was refused. **Codex and other harnesses.** Map the same operations to their native
workers and waits, verify each at first use, and record what is missing instead of pretending it exists.

## Decisions

When Gene is needed, ask one concrete asynchronous question with a recommendation, what it blocks and why existing
authority is not enough. Park only the dependent task and keep other lanes working. Silence, a timeout or a full
queue never approves. When the answer arrives, recheck the head and contracts it applies to; an old approval does
not transfer to a different candidate. The latest explicit direction wins. Do not re-ask what the agenda lists as decided. Publish only the sanitized
outcome; a standing rule that must survive handoffs goes in the state file with its anchor.

## Review and sign

Review each pull request against its issue's Acceptance and Touches. Send back work that goes beyond the
acceptance, however good. Outside Touches, only mechanical edits of ten lines or fewer per file, each listed in the
pull request, are allowed. A defect a lane found is a new issue. Merges follow the
[approval matrix](agent-workflow.md#the-merge-train): T0–T2 land on green; the coordinator signs T3 once the
steward posts the bar at the current head; T4 and maintainer-reserved decisions need Gene. Keep journals and
changelog fragments true to the acceptance, proof and release receipts; never overwrite failed evidence, and a
merged change is not a shipped one.

## Merge steward

Mechanical repository work belongs to a standing workhorse worker, the repo steward, which wakes on pull request
changes: review dispatch, `merge:ready` labelling of reviewed T0–T2 pull requests (batching T0 and T1), CI and
merge-train triage, and release-candidate summaries. At each release it gives every open issue without a milestone,
and every pull request untouched for seven days, an outcome (close with a reason, park, backlog or propose as a
task); an issue where a Soul or a world can get stuck goes first. The steward counts against the worker ceiling and
never deploys or runs a paid gate.

## Timed runs

Measurements that need a quiet machine go to the timed runners through the `timed-run` workflow
([timed runs](../testing/playtests.md#timed-runs)); live-model seats stay on a workstation. Bars are declared before
a run and never re-scored after it.

## Release

The coordinator is the release owner and runs each release end to end ([release owner](../release.md#release-owner)),
the only owner of an active release head. A lane never launches a paid gate or deploys because it finished. Follow
[release](../release.md): exact-head gate receipt, staged deployment, live verification, rollback on failure,
truthful changelog. Production deletes need Gene's explicit yes. On a classifier refusal, report the exact step and
the workaround tried.

## Reporting

After each wave of dispatches and each release, post a checkpoint on the agenda issue: running, merged, waiting on
Gene. With each release, add the table of tasks merged since the last one: ceiling, hours taken and how each ended
(done, stopped at the ceiling, stopped on scope). For the queue, run `node tools/coordinator/status.mjs --since
<time>`: merges, the `merge:ready` queue in train order, `needs:rebase` and Actions. Report milestones,
releases, failures and decisions to Gene, not every pull request, and do not refresh unchanged status.

## Handoff

For a planned switch, such as a usage limit, follow the
[coordinator-handoff skill](../../.claude/skills/coordinator-handoff/SKILL.md). A handoff carries state, never rules:
rules live in `AGENTS.md`, this document and the agenda issue. If every remaining task needs a missing decision or
capability, report that blocker and stop dispatching instead of inventing work.
