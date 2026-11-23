# AGENTS.md

Rules for anyone changing this repository, human or agent (Claude Code, Codex, Cursor, …). `CLAUDE.md` imports this
file. Keep it short: every rule here binds; detail lives in the linked docs.

## What this is

Souls, the server and web app behind soul.game: persistent worlds, Souls driven by their owners' own agents at the
edge, god mode for world creators, and a vendored deterministic engine under `mars/` (its invariants:
[mars/AGENTS.md](mars/AGENTS.md)). **Code wins over docs**; fix a doc you find wrong. Start at
[docs/README.md](docs/README.md). Checkout placement and recovery:
[workspace relocation](docs/process/workspace-relocation.md).

## Where the project is

- **Pre-alpha, zero users.** Nothing here is in production use. Accounts, Souls and world histories are disposable:
  never write migration code for them; wipe and re-pair. A bug or a half-finished feature on the live site is
  acceptable. A delay is not. Speed comes first; safety is restored by fixing what breaks, the same day.
- **Scope: swap the engine, keep the product.** The work is a scalable engine and a fuller Soul Actions system
  (`v2/`), fed into the product that already exists. The web app (`apps/web`: renderer, camera, sound, music, home,
  sign-in, panels) stays and is fed from the new engine; it is never re-made. The new Soul client (`v2/client`) and
  the new creator client stay. Rebuild a working thing only when that makes it better or is needed to connect it,
  and say the cost first.
- **Releases, in order:** 0.132 Core (Eden on the new engine, on the old page), 0.133 Robust (every world moved,
  limits met), 0.134 Complete (Soul Actions expansion, v1 deleted), 0.135 Super (group scenarios). Fixes between
  them take a third number.
- **Parts:** engine, world model, Soul Actions, Soul gateway and Soul API, Soul client, creator client, public
  stream, scene renderer, camera, app shell, identity and directory, infrastructure. Every task names its part and
  its release.
- **Terms:** intent (what a Soul's controller asks), receipt (the world's record of one intent, through its
  phases), event and event log (what happened), kind (a sort of thing), Soul API, Soul gateway.

## Setup and everyday commands

- Node ≥ 22.18 runs TypeScript by type stripping: no `enum`, no parameter properties, no other non-erasable syntax.
  pnpm 10: `pnpm install --frozen-lockfile`, then `pnpm assets:pull` (media is not in git).
- Local server: `BRAIN_MODE=fake DEV_AUTH=1 DATA_DIR=.local/dev node --env-file=.env apps/server/src/main.ts`.
  See [docs/development.md](docs/development.md).
- Before a PR: `pnpm typecheck` (or `tsc -p` for the packages you touched), `node --test` on the affected test files,
  and the walk and bundle checks below when your change can affect them. What to run when:
  [docs/testing.md](docs/testing.md).

## Minds, money and data

- Local and test minds are **fake** (`BRAIN_MODE=fake`; anything else means live). Never run a live model unless the
  task is testing the models.
- The model budget is at most $1 per world per rolling 24 h, default $0.50, reserved before each provider call. Never
  raise it in code or tests.
- New worlds need a verified human owner. One god per world.
- Tests never use production data, production databases or ports of running services. Use an isolated `DATA_DIR`
  under an ignored path (`.local/`).
- Never commit secrets, `.env`, `deploy.env`, databases, run outputs or media. Never bypass the secret scanner or
  commit hooks (`--no-verify`).
- Never publish device details (personal paths, usernames, hosts, private IPs, SSH targets, local URLs, resource ids)
  in GitHub text, commits, proof or media. Run `node tools/proof/publication.mjs` on outgoing text/JSON; it cannot
  read pixels, audio or media metadata, so inspect those yourself. [Publication privacy](docs/process/publication-privacy.md)

## Engine invariants

- The engine core is deterministic: fixed tick, no `Date.now` or `Math.random` (randomness comes from the world RNG),
  zod as its only dependency, named diagnostics. Kernel changes apply or are refused with a reason.
- Never bypass support, ownership or admission; never move through forbidden geometry, teleport or silently respawn.
  Renderers, pose adapters and cameras observe state and never own a second movement path.
- A local failure never stops the clock, the UI or unrelated actors; invariant corruption stays visible and contained.
- Skipped, `FIXME` and `TODO` checks count as unproved. Golden baselines change only with proof of an intended change.
- Contract: [docs/architecture/engine-contract.md](docs/architecture/engine-contract.md).

## Checks

- **One check before merging:** `ci` on the pull request: build, plus the tests for the area the change touches.
  Before pushing a `v2/` change, run `v2/tools/ci.sh quick`. There is no second run in a merge queue.
- **Style never blocks.** Formatting, lint, changelog and description problems are fixed automatically or left as
  advice. A green, working change is never held for them.
- **Objects are tested when they change.** A kind's case files run when that kind is added or edited, when the
  rules that read it change, and nightly. Keep case files to a small sample per kind.
- **The net is after merging.** The full battery (walk, bundle, conformance, full Eden) runs nightly on main. A red
  nightly run gets a fix the same day. A real browser looks at the real address after every deploy.
- **Flaky tests:** fix or delete within the day. Never raise a timeout to pass.
- **Baselines and conformance pins** change in the same pull request as the change that moves them, with one line
  saying why.

## God mode build safety and seats

- **BUILDSAFE:** under legal-edits/1 (adopted at boot where the engine factory is described, so not Eden core), god
  edits that would cut off or bury a Soul (stand where it stands, put it inside a building, change the seat, bed or
  thing it uses) are refused, not repaired, while ways an edit newly cuts off are still repaired in the same batch
  (`apps/server/src/god/engine-bridge.ts` `legalCheck`, `buildsafe-rule.ts`). Never add a separate after-the-fact
  walk fix.
- **SEATDEF:** seat heights come from the def's model geometry. A change is a new def revision; old revisions keep
  their bytes. A seat is refused only above the body's standing reach (`seat.out-of-reach`).

## Scaling

- Work whose point is that Souls carries more Souls, agents, viewers or worlds starts from
  [docs/architecture/scaling.md](docs/architecture/scaling.md): the goal, and the rules that bind it. Never meet a
  number with a cap, a queue or a redirect. Keep one concern to one thread or process with its own limit and gauge.
  Measure in even and uneven load, and state the expected and the measured effect.

## Playtests and the swarm director

- Batteries, personas and casts live in `tools/playtest/`. Measure on a quiet machine only, two repeats per arm.
  Seats use one relative command per call. [docs/testing/playtests.md](docs/testing/playtests.md)
- Directed live casts: `node tools/playtest/playtest.mjs direct <cast>`, or the `souls-director` skill from a chat
  session. [docs/testing/swarm-director.md](docs/testing/swarm-director.md)

## How work is done

- **A task is one issue:** what is wrong or wanted, how we will know it is done, its part, its release, and a
  ceiling in agent-hours. One lane works one task, does what it asks and stops. The ceiling is a limit, not a
  target; at about twice the ceiling, say so on the issue and carry on unless told to stop.
- **Stay in scope.** A small defect found on the way (about 30 minutes) is fixed in the same pull request. Anything
  larger is a new task. Widening scope or rebuilding a working thing needs Gene's yes, with the cost stated.
- **One branch `agent/<issue>-<slug>` and one worktree per task.** Small pull requests. Unfinished work sits behind
  a flag. No status, brief or report files in the tree.
- **A pull request says:** the issue, one line on what changed, and how it was checked. Add one short clip, taken
  on the old page, only when a viewer would see the change.
- **Merging:** when `ci` is green and the change does what the task asked, the coordinator merges it. Engine-core
  changes get one independent read first. Nothing else needs a label, a tier or a sign-off.
- **Done** means seen working on the real address with real input.
- Never commit secrets or bypass the secret scanner. Never publish device details (see above).
- Repo skills in `.claude/skills/`: `e2e`, `souls-director`, `entry`, `coordinator-handoff`. Agent definitions in
  `.claude/agents/`: `coordinator`, `lane`, `reviewer`.

## Development coordinator

- **The plan lives in two places.** The pinned agenda issue lists the releases, the lanes and every task. The
  master view is Gene's page: his inbox, the blueprint, and the state of every part and lane. Keep both true.
- **Talk to Gene through the master view's inbox.** A decision or an action he must take is one inbox item with
  the choice stated and a recommendation. Read his answers and notes there at the start of every wave. Do not ask
  what is already decided; decide small things yourself and record them.
- **Stay thin:** dispatch one task per lane, read each result against its task, merge, release. Do not do a lane's
  work. Run as many lanes as have independent tasks and the usage budget allows.
- **After each wave:** update the tasks and lanes on the master view, and leave one short update in the inbox. No
  separate checkpoint documents.
- **Gene alone decides** scope, priority, spend and anything that deletes data on the production machine.
  [Coordinator contract](docs/process/development-coordinator.md)

## Release and operations

- A release is main at a green nightly, built once, deployed, then looked at in a real browser on the real
  address: the world draws, a Soul moves, sign-in works, the home page is intact. If not, switch back and fix.
- No freeze, no gate receipt, no rehearsal. The coordinator releases when a release's tasks are done.
- Never touch services, users, DNS or proxies on the host that aren't Soul's. [docs/operations.md](docs/operations.md)

## Visitor analytics

- `apps/web/src/visitor-counts.ts` is cookieless and never sends a query string, hash, Soul id or token. Automation
  is excluded (`navigator.webdriver`, `?shot`, `skipgc`). A CSP fetch directive must allow the counter origin.
  [docs/operations/analytics.md](docs/operations/analytics.md)
