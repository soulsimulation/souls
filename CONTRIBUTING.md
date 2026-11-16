# Contributing to Souls

Thanks for helping. Souls is built mostly by coding agents working with the maintainer, and your agent is as welcome
here as you are. People and agents follow the same rules: this page is the short version, and
[AGENTS.md](AGENTS.md) is the full one. If you are an agent, read AGENTS.md before you change anything.

Everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Live in it.** Run a Soul or build a world on [soul.game](https://soul.game) and tell us what was confusing,
  broken or delightful.
- **Report a bug** with the bug template: the world, what you or your agent did, what happened and what you
  expected. A clip or the command and its receipt helps most.
- **Share ideas and worlds** in [Discussions](https://github.com/soulsimulation/souls/discussions).
- **Fork it.** The code is MIT-licensed; build your own worlds, clients and tools on it.
- **Send a pull request**, as below.

Security issues go through [SECURITY.md](SECURITY.md), never a public issue.

## Before you write code

1. **Find or open an issue.** For anything bigger than a small fix, describe the problem and the change you have in
   mind, and wait for a reply before building it. That saves you work on something that won't merge.
2. **Say you are taking it** in a comment on the issue, so nobody else starts the same thing. A maintainer assigns
   it to you.
3. **Fork, and branch from `main`.** Any branch name works. Keep one change per pull request, small and focused, and
   put unfinished work behind a flag that defaults to off.

Setup takes a few minutes: Node ≥ 22.18, pnpm 10, then

```sh
pnpm install --frozen-lockfile
pnpm assets:pull
cp .env.example .env
pnpm build
BRAIN_MODE=fake DEV_AUTH=1 DATA_DIR=.local/dev node --env-file=.env apps/server/src/main.ts
```

and open <http://localhost:4500/w/toy/?dev=1>. Details, environment variables and other worlds are in
[docs/development.md](docs/development.md); the repository map is in [docs/README.md](docs/README.md).

## Making the change

- **Test it.** Add or update tests with the code, and update the doc that describes any behaviour you change.
- **Use fake minds.** Local worlds run with `BRAIN_MODE=fake`. Never run a live model or point tests at production
  data.
- **Prove it.** `node tools/proof/tier.mjs` prints your change's proof tier
  ([PROOF-POLICY.yml](docs/process/PROOF-POLICY.yml)). A change people can see needs an uncut, real-speed screen
  recording of it working on a local world: drag the video into the pull request description. Soul, navigation and
  engine changes also need a playtest; a maintainer can help with that.
- **Add a changelog line** in `changes/` if people using Souls will notice the change: one line, written for them
  ([format](changes/README.md)). Never edit `CHANGELOG.md`; releases compile it.

### Checks to run

```sh
pnpm typecheck                                              # or tsc -p for the packages you touched
node --test <the test files you touched>                    # focused tests
node tools/test-harness/walk/walk.mjs                       # if geometry, navigation or god builds can change
node tools/test-harness/bundle-budget/budget.mjs --build --check   # if the web app changed
pnpm --filter @souls/conformance test                       # if library defs, generators or the compiler changed
node tools/changelog/compile.mjs --check                    # if you added a changelog line
```

What each check means and when it matters: [docs/testing.md](docs/testing.md). A walk or bundle baseline update, or a
conformance supplement, goes in its own commit with the reason in the message. Never edit an older conformance
supplement.

### Commits

- Imperative, scoped subject lines: `fix(nav): keep basement rooms out of default mesh entry`.
- Explain why in the body when it isn't obvious.
- Agents add their co-author trailer.

### Never commit

Secrets, `.env` or `deploy.env`, databases, run outputs, screenshots, video or other media (media lives on the asset
CDN, see [ASSETS.md](ASSETS.md)), or status and report files. A secret scanner and a path guard run on every pull
request, and the hooks must never be bypassed.

## The pull request

Open it from the template and fill in what it asks: what changed, why, how you checked it, and the proof. Then:

- **CI runs** the checks your paths need; `ci-ok` is the one required check. The `security` and `changelog` checks
  run too.
- **Review.** An automated reviewer reads the change against [AGENTS.md](AGENTS.md) and the proof policy, and a
  maintainer reviews it. Answer each comment with a fix or a reason.
- **Merge.** When it is ready, a maintainer adds `merge:ready` and the merge train merges it. Larger or engine
  changes are rebased, re-tested and approved by the maintainer first. How that works:
  [docs/process/agent-workflow.md](docs/process/agent-workflow.md).

Maintainers and the agents working with them claim issues with labels and name branches `agent/<issue>-<slug>`; the
lifecycle is in [docs/process/agent-lifecycle.md](docs/process/agent-lifecycle.md).

## Licence

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE). Media is handled
separately; see [ASSETS.md](ASSETS.md).
