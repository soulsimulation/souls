# Versioning and releases

Several version lines move independently. This page says what each one is, what moves it, how to read it from a running
world and what compatibility is actually promised. Numbers were read from `main` at f6c658203 and go stale; the file
named beside each one is the authority.

## The version lines

| Line | At f6c658203 | Read it from | What moves it |
|---|---|---|---|
| Server release | 0.119 | newest `v*` tag, top of `CHANGELOG.md` | the release owner names it at publish time |
| Soul CLI, `eden.mjs` | 2.14.0 | `VERSION` in `tools/world-launcher/soul/eden.mjs`, `controllerCli` in `SOURCES.json` | the release owner, at release ([below](#the-client-version)) |
| Soul guide, `skill.md` | 2.9.3 | front matter of `tools/world-launcher/soul/skill.md`, `skill` in `SOURCES.json` | stamped with the CLI: one version for both |
| Schema notes | 2.9.3 | `schemaNotes` in `SOURCES.json` | moves with the guide |
| Instructions | 2.0.3 | `instructions` in `SOURCES.json` | a new published capture |
| Managed runtime | 0.1.0 | `runtime` in `SOURCES.json` | a new runtime publication |
| Legacy CLI, `eden-agent.mjs` | 1.9, build 1.9.21 | `cli` in `SOURCES.json` | retained; worlds serve a `build-cli.mjs` build of `tools/edge-skill/eden-agent.mjs` (manifest in `builds/`) |
| Edge wire contract | `eden-edge/1` | `EDGE_CONTRACT` in `apps/server/src/edge/contract.ts` | a breaking wire change; none so far |
| Edge API contract | `eden-edge/1.1` | `BOOT_API_CONTRACT` in `apps/server/src/edge/boot/routes.ts` | additive changes |
| Build id | `we-<sha12>` | `build` in `/v1/config` and `/__sim/healthz` | every build, from the commit |

`SOURCES.json` is `tools/world-launcher/soul/SOURCES.json`. `package.json` versions (0.0.1) mean nothing here.

The lines are not tied together. A server release stamps a new CLI version only when the client changed, and a new CLI
doesn't need a server release to exist in the tree, though worlds only serve it after one ships. The version numbers
carry no meaning beyond order: there is no semver promise on any line.

## The client version

The client version (`eden.mjs` and `skill.md`) is assigned at release by the release owner. A pull request that changes
the client edits `eden.mjs` or `skill.md` and nothing else: no version line, no hash in `SOURCES.json`, no literal in a
test. Before the release gate, the release owner stamps the release's client with one command:

```sh
node tools/world-launcher/soul/stamp.mjs <version>
```

It sets `VERSION` in `eden.mjs`, the skill's two version lines, the `controllerCli` and `skill` versions in `SOURCES.json`
and the hash of every file `SOURCES.json` lists. It takes digits and dots only, and refuses a version not above the current
one when the client's bytes changed. The other files `SOURCES.json` lists (`eden-agent.mjs`, `instructions.md`,
`schema-notes.md`, the runtime) keep their own versions and are frozen: an edit to one fails the launcher tests in PR CI,
and `stamp.mjs` refuses to re-hash it, until the same pull request moves that file's version and sha256. `stamp.mjs --check` changes nothing and exits non-zero when anything disagrees. A
release head's full gate runs it on the candidate and blocks on a disagreement; a lane's `--scope auto` gate does not, so
between releases `main` may hold client changes that are not stamped yet.

## How a world shows what it serves

- **`/eden.mjs`, `/skill.md`, `/instructions.md`, `/eden-agent.mjs`:** every launcher world serves exact copies of the
  files in `tools/world-launcher/soul/`, never forks, and `SOURCES.json` records each one's version, hash and origin.
- **`/v1/config`:** the build id, among other public settings. It does not name a CLI version.
- **`GET /v1/edge/boot`:** `apiContract`, `eden-edge/1.1`. Edge responses carry `contract`, `eden-edge/1`.
- **The CLI itself:** its help header and `status` name its version.

To know which CLI a world serves, read the file it serves. Nothing reports it in an API.

## From fragments to a release

1. Each PR with something for users adds a fragment under `changes/`
   ([format](../../changes/README.md)), or carries `no-changelog`.
2. `tools/changelog/compile.mjs --version <v>` folds the fragments into a new section of `CHANGELOG.md`, writes the same
   section to the release notes file and deletes the fragments. `internal` fragments are checked and left out.
3. The tag `v<version>` goes on the commit that shipped, and the GitHub Release takes those notes.

Two workflows do step 2 and 3. `release.yml`'s `publish` job runs after its own ship. `publish.yml` does the same for a
release shipped another way, such as 0.119, which was shipped by hand:

```sh
gh workflow run publish.yml -f version=<v> -f sha=<full sha of the shipped commit>
```

`publish.yml` refuses a commit that isn't on `main`, that already has a `v*` tag, or that the public healthz doesn't name
as live (`skip_live_check=true` is only for a release that is deliberately not live). The changelog commit reaches `main`
through a pull request, because the `main` ruleset requires checks.

A version looks like `0.123` or `0.123.1` (`release.yml` checks the pattern). Soul is pre-beta, so releases are numbered 0.N, with
patches 0.N.x; 1.0 is kept for the first stable release. Releases before 2026-11-09 were renumbered from 1.1–4.18 to
0.1–0.122 ([#1500](https://github.com/soulsimulation/souls/issues/1500)); the line at the top of `CHANGELOG.md` maps them.

## Receipts

Each ship reads the gate's `receipt.json` and `ship-receipt.json` from `SHIP_RECEIPTS`, a folder the release owner keeps
outside the repository ([release](../release.md)). They aren't committed. A public summary may be attached to a GitHub
Release as an asset, as 0.111 and 0.113 have; raw receipts and live clips stay private.

## Compatibility

**No formal promise is made between a CLI version and a server version.** This is what holds today:

- **The server doesn't check client versions.** It never refuses a client for being old. The CLI strips `contract` and
  `apiContract` from responses without acting on them.
- **New behaviour is opt-in per request until callers have moved.** Strict offers (#1093) began as `strict: true` in an
  act, sent by `eden.mjs` 2.9.0 and later. Since #1911 every act is strict: `POST /v1/edge/act` takes an offered id and
  refuses words and `{verb, target}` intents with the gate's `capability.unknown`, whatever the request says.
- **A server-side switch can undo such a change for a release.** `EDGE_FREE_TEXT_ACT=1` did this for strict offers until
  #1911 removed it. Add the same kind of switch to a change that could strand clients, and remove it once callers have moved.
- **A newer CLI against an older world** is not guarded: a command the world doesn't have fails as that world answers it.
- **Changes to the contract** are additive within `eden-edge/1`, as `eden-edge/1.1` was. A breaking change would be a new
  contract, and none has been needed.
