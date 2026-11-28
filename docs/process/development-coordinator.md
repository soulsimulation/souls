# Development coordinator

One coordinator runs the agenda. This page is the whole contract; [AGENTS.md](../../AGENTS.md) holds the rules that
bind everyone.

## Start or resume

1. Read `AGENTS.md`, this page, and the pinned agenda issue.
2. Open the master view (its address is in the private state file). Read the inbox: Gene's answers and notes come
   first. Then read the lanes and tasks.
3. Check what is actually running and what is open on GitHub against the tasks. Fix the page where it is wrong.
4. Read the previous coordinator's process lessons (its handoff). Apply the mechanical ones before dispatching,
   such as a rule in the lane brief or a small script, and say in your first inbox update what you changed.
5. Dispatch.

## Each wave

- Pick the next task of every lane that is free, in release order. One task per lane. Give the lane its issue and
  nothing else.
- When a lane returns: read the change against the task, run nothing twice, merge when `ci` is green. Send back
  work that goes beyond the task. A change a viewer would see is accepted only after someone has looked at it on
  the page: frames or screenshots, looked at by eye. Tests and receipts alone do not accept it.
- Update each task's status and each lane's latest line on the master view. Leave one inbox update: what landed,
  what is running, what is stuck.
- Anything that needs Gene is one inbox item of kind decision or action, with the choice and a recommendation. Carry
  on with everything that does not depend on it.

## Release cadence

Release only for one of two reasons:

1. **A significant upgrade:** a set of merged work that changes what people see or can do.
2. **A critical fix:** a core path broken on the live site. That means one of:
   - a world won't draw;
   - sign-in fails;
   - a new person can't get a Soul at all;
   - data is lost or corrupted.

Everything else (first-day polish, timing, wording, tests) merges to main and waits for the next real release,
about once a day, in the morning EST.

Before releasing for a fix, prove it works on the real address, or on a production-like setup, first.

Why: each release costs about two hours. That's about 50 minutes of build and deploy, about 20 minutes of checks on
soul.game, and a 45-minute first-day walk that uses real usage. Never release just because a lane finished. Release
at most once a night unless the live site is broken on a core path, and say why in the morning report.

On 28 Nov three releases went out in one morning (0.149, 0.150, 0.151). 0.149 and 0.150 were live barely an hour
each, none of the three met the critical bar, and one was rolled back on a misread result and rolled forward again.

## The master view's data

The page reads five collections. Write them with the artifact data tool; never republish the page to change them.

| Collection | One document is | Fields |
|---|---|---|
| `inbox` | a message | `from` (coordinator or gene), `kind` (decision, action, update, handoff, note), `title`, `body`, `options`, `status` (open, answered, done), `answer`, `reply`, `part`, `lane`, `links`, `createdAt` |
| `tasks` | a task | `title`, `part`, `lane`, `release` (r1 to r4), `status` (todo, doing, review, done, blocked, held), `issue`, `pr`, `note`, `order` |
| `lanes` | a lane | `name`, `release`, `status`, `summary`, `latest`, `worker`, `ceiling`, `spent`, `order` |
| `parts` | a part | `name`, `group`, `old`, `new`, `direction`, `summary`, `gaps`, `order` |
| `releases` | a release | `version`, `summary` |

When Gene answers an item, act on it and set its `reply` to one line saying what was done.

## Releasing

Main at a green nightly, built once, deployed, looked at in a real browser on the real address. Then an inbox
update with what the release contains.

## Handing over

Leave one inbox item of kind handoff: what is running, what is half-done, what the next coordinator should do
first. Add the process lessons: what slowed you down, and for each, the rule or tool that would have prevented it.
The agenda issue and the master view carry everything else.
