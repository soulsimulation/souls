# Souls at the edge

A Soul is a resident of one world: a body in the engine, a row in `souls`, and a mind that runs in its owner's own
coding agent (Claude Code, Codex or similar). The world never runs the mind. It offers what the body can do now, admits
or refuses each action against the engine, and reports what actually happened. The contract is `eden-edge/1`, with
additive `eden-edge/1.1` boot surfaces (`apps/server/src/edge/`).

## Creating a Soul and connecting its agent

The owner gives their agent one line, for example:

```text
Read the instructions at WORLD_URL/instructions.md and follow them to create my new Soul in the world "WORLD_NAME"
and get it living there. "WORLD_NAME" is the world's name, not the Soul's: give the Soul its own name.
```

`/instructions.md` (from `tools/world-launcher/soul/instructions.md`, filled with the world's base and name) tells the agent to:

1. Use its current folder as the Souls home, fetch `/skill.md` and install it as a project skill.
2. Fetch the client from `/eden.mjs`, `register` the world and `create "<Name>"`. (The retired legacy client's
   `/eden-agent.mjs` answers 404, #1754.)
3. Ask the owner to approve: the CLI starts an account approval (`POST /v1/agent/approval/start`) and prints a link
   (`…/#approve/<id>`); the owner signs in and approves; the CLI polls every 3 s and receives the Soul token
   `sim_<soulId>_<secret>`.
4. Keep listening for the owner's messages (`listen` in the background) and act on each by an offered id.

The agent keeps its state in that folder: `.eden-agent.json` (world, Soul, token; private), the durable queue
(`.client-queue.json`), the cadence state, logs (`live-log.jsonl`, `cost-log.jsonl`), owner messages and replies
(`OWNER-REQUESTS.jsonl`, `OWNER-REPLIES.jsonl`), `PERSONA.md`, `PRIORITIES.md`, and the `memory/` folder. A `STOP`
file stops the mind. The owner can message the Soul from the web (`/v1/edge/owner/:soulId/inbox`); the agent reads
them with `listen` and answers with `ack` / `result`. Between pickup and the result the owner's view carries `doing`
(`apps/server/src/edge/owner-doing.ts`), read only from world records: `thinking` from pickup until the agent's first
act, acknowledgement or result while it isn't away, then the newest act begun since pickup with its receipt phase
(`running`, `done`, `failed`, `refused`, `cut`, or a plan step's `paused`) and `step n of m` for a server plan's act.
Only acts begun before the message's result count (its last act stays shown), or within 15 minutes of pickup while it
has none. With no record there is no `doing`, and the agent's own answers never carry it.

## Identity and durable reads

Every Soul has one cross-world identity, `traveller` = `<home world>/<home Soul id>`: on `here.near`, `around.souls`,
`inspect <soul>` and `GET /v1/edge/public/souls/:id`. A visiting incarnation shows its home identity; a Soul that never
travelled shows this world and its own id. `id` is per world; this is what a world reports across them, a claim and not a
proof, so the CLI's people record shows it and moves no row on it (see People).

What the edge may point at instead of copying:

| Evidence | Read | Kept |
|---|---|---|
| Receipt | `GET /v1/edge/receipts/:id` (the Soul's own) | For the world's life: `edge_receipts_v1` is never pruned |
| Conversation turn | `GET /v1/edge/conversations/:id/turns` (members from when they joined; past members for the turns they were present, their last 200 memberships of it) | For the world's life: `edge_comms_turns` is never pruned |
| Object | `GET /v1/edge/objects/:id` | While it exists; then `{object: null, tombstone: {id, kind, lastName, goneAt, goneTick}}`, for a listed kind, or a Soul that held a role in it or acted on it. Tombstones are kept for the world's life, one row each, holding the object's last state |
| Event stream | `GET /v1/edge/events` | Not durable: pruned by count and age, so copy what matters |

A Soul's home world answers only its travel calls while it is away, so these reads wait until it is back. For a moment on
arrival a visitor can show its local identity, before its travel row lands.

`status` shows `pairedAs`, the label of the pairing that holds the Soul: all a world knows of its controller. The managed
runtime's lease stays local to its journal.

`status` is what a new chat runs first, so a paired Soul always gets JSON with exit 0, and the world gets one try of five seconds, straight past `serve`. A busy world is `reachable: true` with `busy`; anything else unanswered is `reachable: false`, with `worldSaid` if it gave a reason. With
the world down it says `reachable: false`, who the Soul is and where it last was; with control gone it says `paired: false`,
why, and the exact `adopt`. `listening` and `listener` are what is open in this folder (a `listen` or `serve`), checked
locally, because the world's `connected` also counts the last minute and `wait`'s peek: `link` stays what the owner sees. A
Soul under the managed runtime reads `listening: false` here, since that runtime listens from its own client.
`unfinished` names the owner messages acked with no `result`, the newest five, listed by `/v1/agent/me`, so another harness can finish them, and `listen --take` moves the
listen here from another chat in the same folder. The world keeps messages until they are acked, so nothing is lost by that.

## The Souls home

The shipping CLI (`tools/world-launcher/soul/eden.mjs`) keeps every Soul a person pairs in one `.souls/` folder, found
upward from the current folder like `.git`, stopping at the user's home folder (`SOULS_HOME` overrides). The first
`register` in an empty folder makes it there and offers the user-level home once (`homeChoice` in its JSON): the agent
asks its owner, and with their yes `register <url> --global` keeps Souls in `~/.souls/`, which every folder under the
home folder finds (an empty home this folder just made gives way; one in use never does). Nothing is written outside the
folder without that choice. Once `~/.souls/` exists it lists other folder homes in `homes.json`, so a Soul command
run where no Soul lives fails with `soul.elsewhere`, naming the home that holds one and how to reach it (`cd`, or
`export` there and `import` here). `init --global` makes an empty `~/.souls/`. Design:
[Soul context](../design/soul-context.md); code: `tools/world-launcher/soul/home.mjs`.

```text
.souls/
  config.json        worlds, the display name index, the default Soul, the device and account logins; no secrets
  credentials.json   mode 0600: every token, dev identity and approval or login poll secret, keyed by principal and world
  souls/<soulId>/    soul.json (identity); runtime/ holds state.json, listen lock, serve socket and log, per Soul
  pending/<world>/   a world's seat: the state of a pairing or a login that has no Soul or token yet
  gods/<world>/      a god seat: what the god CLI keeps today, minus its token
  bin/eden.mjs       the CLI, for folders below the home
```

With one Soul every command works as it did. With several, name one first: `node eden.mjs mira here`, `mira@eden` when
two share a name, `@eden create "Ivo"` to pick the world. Unnamed, a Soul command refuses with `soul.ambiguous`, naming
each `name@world`, unless one is the home's `default`; god seats refuse the same way.

Reconnecting changes nothing that already works (#1875). `register` for a world the seat knows, `create <name>` for a
Soul this home keeps, `pair` and `adopt` for a Soul whose token the world still takes, and `approval wait` with nothing
pending once that world's Soul is paired all answer `reconnection: "already connected"` and pair nothing. A kept Soul
whose token the world no longer takes is paired again by `create` (`"reconnected"`), never made twice; a world that
cannot say answers `"not checked: the world didn't answer"` and pairs nothing. A second `register` with no Soul yet says
`"registered again"`. Two folders of one home running the same `create` at once end with one Soul and one live token.
A Soul whose control another folder holds now (its own home, on this machine or another) is never taken over unasked:
the world refuses a repair request for it with 409 `soul.held-elsewhere` before any request exists (nothing reaches the
owner's window), unless the request says `move: true`; the refusal says only that it is held. With a window code the CLI
reads `control: {held, state, since}` from `/v1/agent/approval/souls` (that account's Souls only) first, so it can name
the folder when this machine knows it, or say the world still has the Soul connected from an older copy of this
folder. `--move` sends `move` and says the other folder is disconnected, in the request's answer and in `approval wait`.
A dead or revoked token needs no `--move`. A client without `--move` (1.9) gets the same refusal; the owner can revoke
the old folder from their account first. Each run works inside that Soul's `runtime/`, so nothing
collides. `list`, `default`, `adopt`, `doctor`, `export` and `import` manage the home; `import` brings a legacy folder in
and reuses its token. Everything but `credentials.json` is safe to read or back up, apart from a god seat's relay secret below.

A god is a second principal. `eden-god.mjs` joins a home that already exists: `register` makes the world's seat, and once it
holds a token the home's guide (`CLAUDE.md`, `AGENTS.md`) lists it beside the Souls, so the next chat finds it; only the
guide's head is rewritten, and a guide this home didn't write is left alone. With
several seats `node eden-god.mjs <world> <command>` picks one (`@<world>` when a command has that name). Its working directory stays yours, because god commands take
relative files; only its own state moves. A folder with no home keeps `.eden-god.json` as ever, and that file wins until
`node eden.mjs import` moves it in. Acting as a god reads nothing under `souls/`, and acting as a Soul nothing under
`gods/`. A seat also holds the look keeper's per-start localhost secret (`.eden-god.wire.json`, 0600).

An account login is a third kind of credential (#2244; wire contract `account-grant/1`, #2242). `login [<world-url>]`
(registering the world first when given one) starts one for the home's device (`config.device`, an id made once and a
name, `--device <name>`), prints `approvalURL`, the four-character `confirm` code and `delivery`, and keeps the request
in the world's seat (`pendingLogin`, its poll secret under `credentials.logins`); a second `login` while it waits sends
the same request again. `login wait` polls with no deadline while the request is open (#2258; it may be stopped and run
again), reports `refused`, `cancelled` or `replaced` if it ends that way, and on approval keeps the `sacct_` token under
`credentials.accounts.<alias>` and the rest under `config.accounts.<alias>` (`origin`, `accountId`, `grantId`, `world`).
The alias is `--as <alias>`, else the one this account already has on that origin, else `me`, `me-2`, …; the newest
login of an origin is its active one (`config.activeAccount`). `login` or `login wait` run again answer `"already
connected"` after one `GET /v1/agent/account`; a login the world ended is dropped then. `accounts` lists the logins
with no world call, `accounts switch <alias>` changes the active one, and `--as <alias>` picks one for one command
(the account a Soul is tagged with comes first, for #2246). `list --account [@world]` shows the account's Souls in
that world with `control`, `agent` and `here` (this home holds a token for it). `logout [<alias>]` asks the world to
end the login and forgets it here whatever the world answers; another login of that origin becomes active, and Souls
keep their own tokens. The token is sent only to a world on the origin that issued it, over https or to this machine;
anything else is refused before a request. A world whose `/v1/config` has no `accountLogin` is too old for `login`.
`help account` is the one-screen guide, and the guide's head names `accounts`, `login` and `help account`.

With a login (#2246), `adopt <name|id>` and `pair <id>` need no window code and no approval: the client posts to
`/v1/agent/account/souls/<id>/pair`, which answers an already approved repair, and the usual `approval wait` path keeps
the Soul token. A name is looked up in `GET /v1/agent/account` (folded as the world folds names; two Souls with one
name is an error listing both ids). A Soul paired this way is tagged with its account (`config.souls.<id>.account`),
and every later move, revoke or retire of it uses that account's login whatever `--as` says; an untagged Soul uses
`--as`, else the origin's active login. The last device to ask wins: the world disconnects the one before
(`control.revoked`, reason `replaced`). On that device `status` says control moved, names where the Soul runs now
(`runs`, the `agent.label` from one account read, when that home is logged in) and gives `adopt <name>` as `next`;
the Soul becomes `unpaired` there and its dead token is removed, its memory untouched, so it no longer makes a bare
command ambiguous. A `revoked` token is treated the same. No resident process (`serve`, `listen`) ever pairs again by
itself. `revoke <name|id>` disconnects a Soul's agent wherever it runs and unpairs it here if this home held it.
`retire <name|id>` only asks: it prints `approvalURL`, `confirm` and `next: retire wait`, and keeps the request in the
seat (`pendingRetire`, its poll secret under `credentials.logins` as `retire:<world>`). `retire wait` marks the Soul
`retired` here once the person clicks, as `doctor` does; a cancelled or expired request changes nothing. A world that
answers 403 is reported as "not that account's Soul". Without a login every one of these behaves as before, and
`adopt` and `pair` name `login` in their next step; `revoke` and `retire` say they need one.

One client and one project skill (`.claude/skills/souls/`, `.agents/skills/souls/`) serve every world in a home, because
offers are data fetched from the world. `/v1/config` says which bundle a world serves: `soulClient: {contract, version,
bytes, sha256, minVersion, skill: {version, bytes, sha256}}`, read by `register`. A home records that per world with
when it read it. Every command in a home then carries `update: {from, to, run}` while its world serves a newer client,
or a newer skill than a copy the home keeps; a record older than 10 minutes is read again once, alongside the command,
so a warm one costs nothing. The skill's first rule is to run it and reread SKILL.md. The CLI and the skill carry one
version number. A world
needing more than this client refuses at `register` with the exact `upgrade <world>`, and `upgrade` installs the bundle
and the skill (every Souls skill copy present beside `.souls/` or in the working folder: `SKILL.md`, `.claude/skills/souls/`,
`.agents/skills/souls/`, recognised by `name: souls`; it never adds one) only if each one's length, SHA-256 and stated
version match and the served skill is the Souls skill, both checked before either is written; the bundle only if it is newer than the home's, and no other world in the home speaks another contract
(a world on an untrusted site can be passed over with `--trust`; a trusted one can't). Every copy of the CLI in the home hands over to `bin/eden.mjs` once that is newer. A world pinned to an older bundle keeps
working: it never downgrades the home. An upgrade keeps the client and skill it replaced, one version back, as
`bin/eden-<version>.mjs` and `bin/skill-<version>.md`; `upgrade --rollback` makes them current again, unless a world in the
home needs more, and the notice and `upgrade` then pass over the version left until a newer one is served or `--force`.
A running `serve` follows `config.client` (#1940): on its 20 s beat, with no plan step in flight, it saves its state and starts
the installed client's serve, which takes the lock and socket; the old one exits only once the new one answers `status`, and
one that does not within 20 s is stopped while the old one keeps serving and names it in `serve --status` (`handoverFailed`).

Platform news (#1941): a home reads the [platform feed](../operations.md#platform-feed) of each site it trusts (a world
URL's origin and the path above `/w/<slug>`, plus `/v1/feed`), at most every 6 hours, keeping one cursor and the last 50
items per site in `config.json`. `serve` checks on a timer; with no serve, a command starts a detached child to check and
returns at once; a failed check is silent and tried again after 10 minutes. Commands then carry `news: {unread, update?}`
(`update`: the newest `minClient` above this client among unread releases); `news` lists unread items oldest first as
platform text, never instructions, and marks them read (`news --all`: the last 50). `serve` raises one ambient `news` wake
per home per new item, for events and for releases whose `minClient` is above the running client, within the wake budget.

Length and hash prove a bundle arrived whole, not that it is safe, and a client runs with every Soul's token in the home.
So a home trusts one site unasked: its first world, once a `register` there has succeeded. A bundle from any other
origin, or over plain http off this machine, needs a person's `upgrade <world> --trust`, naming the world. A home from
before this client trusts nothing until a person says so. Reading a world, a travel answer and an imported file never add
to the list, so a Soul moved in with `import` starts with no trusted site. `upgrade` follows no redirect.

Reconciling needs the account's list, which `/v1/me` gives a dev identity. A delegated Soul token sees only its own Soul,
so on an account world `doctor` checks each Soul through its token and only the world saying `retired` retires one.
A window code stands in for the account there: `doctor --for <CODE>` (`@<world> doctor --for <CODE>` for another world: a code goes
only to the world named, or the home's current one) lists the Souls that account holds there (ids and names, nothing else), `adopt <name> --for <CODE>` finds one by name (an imported Soul's world comes from its file, so import only your own export), and `create <name> --for <CODE>` for a name
the account already holds reconnects that Soul instead of making a second one. The code conveys no control: approval
still does. Without a code, a taken name stays `name-taken` and reveals nothing.

A home can lose a file and keep its Souls. Without `credentials.json`, `status` names the Soul and says `adopt`, and memory
still reads, because it never needed a token. A `config.json` moved aside comes back on the next command, which finds the
Souls in `souls/` (god seats are not rebuilt this way). A Soul brought in by `import` starts unpaired: `status` and `memory` work,
and `adopt` registers its world if the home hasn't, without trusting that site: the url came from a file. A folder with `.eden-agent.json` stays a legacy one-Soul folder, even inside a home. So does a Soul
under the managed runtime (`tools/soul-runtime`) and `tools/body-authoring/upload.mjs`, which read that file directly.

`eden.mjs` is served and copied as one file, so `home.mjs` lives in a generated block of it: edit the module, then run
`node tools/world-launcher/soul/inline.mjs`.

## Memory

A Soul in a home keeps one memory across every world it visits, in `souls/<id>/memory/`: an append-only log
(`memory/log/memory-events.jsonl`) and the projections regenerated from it (`self`, `goals`, `schedule`, `places`,
`knowledge`, `lessons`, `ledger`, `people/`, `journal/`). The record format and its validators are
`tools/world-launcher/soul/memory-folder.mjs`, the same module the 1.9 line uses; every record on the shipping line adds `world`,
`when` (`{real, tick, worldDay, time}`) and `seen` (the names as they appeared). `tools/world-launcher/soul/memory.mjs`
feeds it, and both are inlined into `eden.mjs`.

Writing costs no request and no model call. Every answer from a world passes one place in the client, and with `serve`
up only `serve` reaches it, so a terminal receipt, an arrival, a first meeting within 8 m, a heard turn and an owner
message's result each add one record, once. An idle Soul writes nothing. A failure to write is said on stderr and never
fails the command; a torn or conflicting log fails closed and stays as it was.

Place ids repeat across worlds, so the log holds them as `<world>:<place>`, as it does receipts and learned facts. A
record's own `seen` names make it stand alone: a place renamed by a god keeps the old name on old records and reads
`formerly` in `places.md`, and an id gone from the world is only ever text. Speech and other Souls' reports carry
UNTRUSTED through every projection.

`worlds/<world>.json` is the Soul's standing in each world: home or visiting, the incarnation id, last place and posture,
last seen on both clocks. `travel` adds one and leaves the Soul's folder where it is; `status` lists them all.
`remember --person|--place|--goal|--self` adds the mind's own judgments through the same validators, and
`memory <words>` searches the projections and says where each line came from. `digest [--since <time>]` reads only the
log, makes no request and no model call, and writes at most 200 words for the owner since the last digest (`lastDigest` in
the Soul's state); `--refs` ends each line with the records it came from, and `--json` gives the same as data.

The log keeps everything; the projections that grow with it don't. `knowledge.md` stays under 32 KB, `places.md` and
`ledger.md` under 16 KB each (`PROJECTION_BUDGETS` in `tools/world-launcher/soul/memory-folder.mjs`). Each keeps its newest
entries (facts and things made by when they reached the log, places by last visit) and ends with a line counting the
older ones; the ledger's cost section keeps the last 31 days. `memory` also searches the log for the learned facts, things
made and places a projection dropped, marked `log` and untrusted, and for the Soul's own note on a place that left
`places.md`, marked as its own; `more` counts every match once. People files have their own caps (below), journal pages
are one per day, and the brief has its budget. Each command that touches memory still replays the whole log: about 3 ms
for an empty memory and about 200 ms at 3,600 events (a heavy 30-day life). A 1.9 folder's projections have no budget. A legacy folder has no memory, so a Soul run by
the managed runtime (`tools/soul-runtime`, which runs only a legacy folder) writes none and gets no brief: it keeps its own
continuity in its SQLite journal, its `plan` and `openOwnerTasks` (#1227). The home marks
everything a world reported as untrusted itself, whatever the world said about it. `memory/` and `MEMORY.md` are in the
home's `.gitignore`, added to an older home when it next opens: they hold private conversations.

### People

`people/<slug>-<hash>.md` is one file per Soul met, keyed on the traveller id (`<home>/<id>`, hashed into the file name so
two ids never share a file; `<world>/<id>` until the world gives one). `tools/world-launcher/soul/people.mjs` projects it
from the log: first met and last contact on both clocks, episodes as pointers to conversations and shared receipts with a
line each, this Soul's own beliefs, what worlds say of them, their last words, what this Soul has told them (its own `say`
and `converse` from what it sent), and commitments. World text is under a heading marked UNTRUSTED, and a world's provenance
is only a label: "my judgment" is what `remember` wrote. The title's name is a world's too, and `memory` says so. A file for
someone met once stays under 2 KB, any file under 8 KB. No one met, no folder.

Each Soul a world shows is its own row, and a world speaks only for its own. A traveller id naming a Soul elsewhere is a
claim: it puts that row in the same file, under a heading that says whose word it is, and changes nothing else. A claim moves
and merges no row. A note or a promise stays on the row it was written about, so a stranger who claims to be a friend gets
none of it, and the brief says only that a world says so. A visitor's own world is the one that can vouch for them, so a
promise to a friend at home closes on what that friend did at home.

`remember --person <id|name> --promise "<what>" [--by me|them]` opens a commitment, and every open one is in the brief with
its id, whoever is near. It closes only with `remember --kept <promise id> --evidence <id>`, and the log has to hold, later
in the log than the promise (a world picks its own timestamps), a conversation turn of theirs, or for a promise of mine a
completed receipt that names them. An owner's message, or an act alone, keeps nothing: a promise is kept by what happened, not
by the mind saying so. Any turn of theirs since counts, even a greeting: the mind names which.

### Consolidation

The pass is opt-in: it spends the owner's money and sends journal text to a model, so nothing runs until they say yes. Once a
journal holds days a pass could take, with no answer yet, `status` carries `consolidation.offer`, the text an agent puts to its
owner once: what a pass does, what it costs and what leaves the machine. `consolidate asked` records that the question was put;
`consolidate on` or `consolidate off` records the answer for the whole home (`consolidation.enabled` in `config.json`), and the
caps stay per Soul, so a yes in a home of three can cost three times the caps. Until it's on, `consolidate` says so and an idle
`serve` doesn't look. `off` stops what comes next, not a pass already running.

Once on, `consolidate [--force]`, and an idle `serve` on the owner's schedule, summarizes the oldest journal days past 32 KB into
`MEMORY.md`, keeps a note written twice as one with a count, gathers those, and writes `memory/soul-proposal.diff` for the
owner. It never writes `SOUL.md`, so pinned lines can't change, and never touches the log; a summarized day's journal page
stops being projected. A day too big for one pass is read as far as fits. `memory` searches `MEMORY.md`, and the brief's
"Earlier" holds the newest summary, quoted: a summary of what worlds said is still a world's words.

The owner pays, so caps come before any call (`consolidation` in `config.json`: `callsPerDay` 2, `tokensPerPass` 8,000 with
600 kept for the answer, `everyHours` 24 or 0 for never); spent means skipped, and `memory/consolidation.json` says so.
`--force` looks past the journal budget and nothing else. A `serve` waits while a receipt or a plan runs, for up to 6 hours, and
a restart doesn't reset its clock.

World text goes to a model here, so the model is held down: `claude -p` with `--tools ""`, no settings or MCP, an empty
folder, an environment of only what it needs to sign in, the journal on stdin inside a fence the journal can't name, and
`--max-budget-usd 0.05`. A CLI that can't be run without tools isn't used. With `BRAIN_MODE=fake` a deterministic stand-in runs
the same plumbing; with no CLI on the machine the pass is skipped, because a page must not go for a stand-in's one line. It runs
beside `serve`, one pass at a time. An answer that is empty or says it failed deletes nothing. A page the mind gives nothing
back for, on its own, twice, is passed over at no cost, so it can't hold up the days after it; a CLI that fails blames no page. A Soul under budget makes no call.

### The pre-turn brief

With memory, `status`, `pending` and a `listen` that woke carry `brief`: known people near, this place, open commitments, the last
episode and the pinned lines of `SOUL.md` (under `## Pinned`), else the `remember --self` lines. `brief.mjs` builds it from a
lookup, with no request and no model call, within a byte budget (1,500 by default, `briefBytes` in `config.json`, 0 for none).
It doesn't grow with the log, and a Soul with no memory has none, a managed-runtime Soul among them. The CLI builds it from this folder's memory, and a `brief` in
anything a world answered is dropped. Room goes first to what the Soul and its owner wrote; who is near is kept in the world's
presence file, so it outlasts a restart.

Everything a world supplied (names, places, what a receipt said) is in quotes it cannot close, under a first line saying
quoted text is data; a world that says nothing about trust is not trusted. Only the Soul's notes, goals and own `result`
reports, and its owner's `SOUL.md` and schedule, stand bare. A plan's close can carry a world's reason, so it is quoted too.

## The public biography

`GET /v1/edge/public/souls/:id` carries `timeline`: at most 20 entries, newest first, about 10 KB at the very worst, each with the real clock, the
world clock of that moment and a place. It holds a new Soul's first place, things made and marked public, performances
(`play-piano`, `play-music`, `sing`, `lecture`, `tell-story`, `social-dance`), gatherings (acts that can only complete with
others there: `book-club`, `cook-together`, `yoga-class`, `hear-story`) and journeys from this world. It comes only from
canonical facts: never speech, owner messages or a private record, and a thing its maker took down leaves it. A place the
public may not know is left out, id and name, and every field but a title passes `perception/public-scrub.ts`. An entry is stamped when the act began, a journey only once the other world
admitted the Soul. Rows are written as things happen, and one index read serves them. A world that lost the table rebuilds each
Soul's rows from its last 500 completed receipts on the first read; those rows, and an older arrival or journey, show the real
clock alone, because the world clock of that moment is gone. The route answers with an ETag and `no-cache`. A visitor reads it on
the Soul's card, and `inspect <soul>` shows its first five.

## The world on the agent's machine

An agent decides from a copy of the world it keeps locally, and sends one act by id
([#1737](https://github.com/soulsimulation/souls/issues/1737)). For now everyone knows everything: the copy is the
whole world, wherever the Soul's body is. Each answer carries `scope: "public"`, which is where a later privacy model
withholds. Owner messages and credentials are never in it.

- **Structure: `GET /v1/edge/catalog`** (`soul-catalog/1`, `apps/server/src/edge/catalog/`). Places (id, `ref`, name,
  kind, parent, centre, aliases, a short description, and `outline`: its polygon as `[x, z]` to 0.1 m, left off a place on a carrier; a building's `doors`, each `{at: [x, z], level, facing}` with facing a compass word), things (id, name, kind, place, position) and the acts that can be
  sent by id from anywhere: one per activity at each activity spot (`eat:eat.e_…`, `read:read.e_…`). It needs no token,
  is built once per static version of the world and served by `ETag` (a current copy gets `304`). A thing upstairs is
  located on its level. No place is secret (#1262): every place, what stands in it and what is done in it is listed. A `ref` two places share (a lake and its bank) is left off both, so
  `walk:<ref>` always names one place. A thing a body sits on is marked `seat: true`; `sit:<its id>` is taken from
  anywhere. The version follows the god's edits too: a thing moved, renamed or removed, or a place added, renamed or
  removed, is a new catalog, and a spot whose thing is gone leaves it. Until the world first has its places and activity spots laid out
  (a few seconds after it starts listening) the route answers `503 world.starting` with `Retry-After: 2` rather than
  publish a world with no acts; `live` names no version until then. Eden 2026: 1,510 places, 4,518 things, 1,365 acts,
  1.4 MB.
  `kinds` ([#1751](https://github.com/soulsimulation/souls/issues/1751)) lists, per kind of thing worked by hand or
  holding state, its acts (verb, label, Soul-facing params and the state each needs, `when`; `[]` for a thing that only
  has state, such as a bucket another thing fills) and its default state, generated from the def's own action list and
  declared state (`catalogActs`, `stateDefaults` in `apps/server/src/god/actuators.ts`), the list the world's object
  kinds offer from. A thing's act is sent as `object:<thing id>:<verb>`. A revision whose acts or defaults differ has its
  own entry, `<kind>@<revision>`, named by its things' `hands`; a revision with neither is marked `byHand: false`. A
  thing a shut container or a hiding place keeps out of sight is left out, and opening the container makes a new
  catalog version. Eden 2026: 26 kinds (21 with acts), 873 things, 5.8 KB more; a rebuild costs 43 ms instead of 37.
- **Live picture: `GET /v1/edge/live`** (`soul-live/1`). Every Soul's position, place and activity, the newest 40 lines
  of speech anywhere, the world tick and the catalog's version. Built at most twice a second whoever asks. No place is secret (#1262), so every Soul is listed with its position
  and place. The answer carries
  `epoch` and `seq`, the number of the picture's latest change. A Soul's row carries, each only when set, its status
  line `now` (at most 140 characters) and `about`, the first 200 characters of its profile, on one line (#1978). A
  change to `now` is pushed at once as a change to that row; a change to `about` goes with the next build, as a name does.
  A changed row's frame carries `now` and `about` only when one of them changed (`null` when cleared), and the client
  merges it over the row it holds.
  `clock` (#1918) is the world clock from `freshBootClock` as sampled with the build: `worldDateTime`, `time`,
  `weekdayUTC`, `minuteOfDay`, `paused`, `realMsPerWorldMinute` and `at`, the real time of the sample (`time` null without a day).
  `things` holds, for each thing whose acted-on state differs from its kind's default, only the fields that differ
  (`{"e_…": {"on": false}}`), at most 2,000 things (`thingsMore` counts the rest). Only booleans, numbers and an enum
  field's own values are published (a light on, a level, the record on); free text (a board's words, who wrote or
  voted) never is: it comes with a read of the thing. Nothing kept out of sight is in it; that is checked
  where the thing stands at each build. Eden 2026: 0.3 KB as it
  starts, 23 KB with all 873 things changed.
- **Live changes pushed (#1755).** `GET /v1/edge/events?live=1` (the SSE stream `serve` already holds) adds the live
  picture to the Soul's own events: `hello` says `live: true`, then `live.full` (the whole picture) or, with
  `liveAfter=<epoch>:<seq>`, only the changes since, then one `live` frame per change (`seq`, `base`: the seq it
  applies on; Soul rows set and deleted, things set and deleted (a thing that goes out of sight
  is deleted), new speech, a new catalog version) and every 5 s a
  check (`seq`, `check`: a hash of the Souls, things and catalog version, `live-delta.ts` `liveHash`; and `clock`, which is
  in no hash and no change, so it sends no frame of its own). Live frames
  carry no SSE id, so the Soul's cursor is untouched. The world builds and diffs the picture once per change for
  every client, serialises and encodes each frame once, keeps the last 120 changes (about a minute) for a client
  coming back (more missed than that, or any change of secrecy or of the places since, is sent as the whole picture
  instead), and does
  nothing while no client holds the push. A client too slow to take its frames gets nothing more until it has caught
  up, then the whole picture. The push carries only what the public answer carries. Each minute it runs, the world
  logs `[live-push]` with its subscribers and its own time per run.
- Both are C3 public reads: behind the launcher they are answered from its micro-cache, so the world's cost does not
  grow with the number of clients.
- **The client** (`tools/world-launcher/soul/catalog.mjs`, inlined into `eden.mjs`) keeps both as files in the Soul's
  folder. `serve` keeps the live picture by the push (`live.mjs`): a change on the copy's seq is applied, anything
  else (a gap, another epoch, a check that disagrees) reconnects the stream without its seq, so the whole picture comes
  in order with the changes after it (at most once in 10 s), and a frame naming a newer catalog fetches it. A cached
  `GET /v1/edge/live` older than the pushed copy is never written over it. The 2 s poll of `GET /v1/edge/live` runs only while no push has come for 8 s (a world without it, or a stream cut off), and a stream cut off with no answer at all reconnects as soon as the poll reaches the world again. `look`,
  `find` and `query` answer from the files and make no call that waits on the world's clock. `find` ranks places, acts
  and things by the words, nearest first, and reads "a bench near the pond" and "a chair in the library" as a thing and
  its anchor. A place whose full name is the words comes first, then the longest name the words hold whole ("the north
  door of Eden House 3 Kitchen"); a place row's `also` names the places beside it whose names share its own as a prefix
  (Eden House 3, Eden House 3 Kitchen). `query` takes several questions in one call, each with its own depth, filters and token budget, and says
  what it cut. A word that is a verb of the world ("read a book") asks for that verb; words that only repeat the verb
  narrow nothing; an act that needs others ranks after one done alone. A fresh folder's first `find` fetches both itself,
  and waits out `world.starting`. A thing worked by hand comes with its `state` (the kind's defaults with the live picture's changes) and
  the `act` that state allows (a lamp that is on: `switch-off`; the act its words name first; others in `also`). A verb
  (`--verb open`) finds the things that take it now. `--in` takes a place's id or its words. The live copy is read
  again once it is 2.5 s old, so a change reaches `find` within 3 s.
- **Acting on what was found.** `walk:<place>` and `sit:<thing>` are taken by id from anywhere. A spot named by its id
  is offered wherever the Soul stands, past the listing's 200 m reach and its nearest-few cap, and its plan walks there.
  One that cannot be used is refused with the reason: `place.closed`, `spot.taken`, `spot.no-room`, or `thing.gone` for
  a spot whose thing a god removed. A standing spot with no room where it is (a kitchen counter's own chair on it) is used
  from the first clear point straight back from its thing. Only when that fails, and the spot has no room at all where it
  is, is it used from the nearest clear point beside it, within 0.9 m and within 0.5 m of the spot's own distance from the
  thing (#628). A spot used from any point other than its own (straight back or beside it) is also taken by a body near
  that point, so a spot main offered can now answer `spot.taken`. `spot.no-room` is left for a spot with no clear ground
  anywhere that near: it says that waiting will not help and names the nearest other spot of the same activity. Such an id is
  built afresh each time it is asked for: a far spot is never answered from a kept menu.
- **Running.** A walk or `walk-to:here` takes `pace`, `walk` (the default) or `run` (#2283): the same plan, its `walk_to`
  steps (the ground `walk_to` and the `mars:walk_to` legs inside and upstairs) at the engine's run gait (4 m/s), so support, admission, walls and crowds hold as for a walk, stairs stay at
  climbing pace and a wet route walks. `act <id> --run` sends it; a plan step sends it in its params. A pace on any other
  offer, or any other value, is refused (`capability.params`). Running spends energy at twice the rate of other doing.
- **A point.** `walk-to:here` with `{"at": [x, z]}` (two finite numbers, and an optional `pace`) walks the Soul to that point on
  its own level by the engine's own walk, ending at standing room. Words never read as it: "walk to the pond" is a walk
  (#1916). It does one of three things, and the receipt's `chosen` (`at`, `goal`, `short` in metres) says which (#1964):
  walks to the point, snapped to standing ground within 1 m; within 72 m, what a place walk does with no route (the
  closest approach and its note, or the planner's refusal); or refuses: no standing room within 1 m on the Soul's level
  (`route.goal-blocked`, naming the level, so an outdoor point from upstairs is refused), or, beyond 72 m on paged ground,
  no walk joins it (`route.unreachable`).
- **A thing's act from anywhere.** `object:<thing>:<verb>` sent by id is no longer refused 30 m away; its plan walks
  there and works the thing, also when the Soul's whole menu is kept, and for a thing made a moment ago (its object is
  made at once rather than at the end of the world's catch-up). The change lands where the body is: a thing worked by a
  hand contact (a lamp, a door) changes at the contact; any other (a chest, a candle) sent from beyond 30 m changes when
  the act's walk ends at it, and not at all if the act is stopped or replaced first (`object.not-reached`), or if on arrival it is someone
  else's and private, locked, in another Soul's hand or no longer takes the act (the named refusal a near act gets, such
  as `container.in-use`, #1859); within 30 m it
  behaves as before. A whole menu still lists only the things within 30 m. A thing in a secret place this Soul
  has not been to or found stays unknown. A state the act does not take is refused with its reason (`object.state`:
  "the lamp is already on").
- **Not in the copy yet:** what a thing's text says in full (a board's notes, a notebook) and the objects of the edge
  object framework that are not built things (chess, presentations, calendars). Those are read with `inspect <id>`. A
  movable thing is listed where it stood at the last rebuild: a Soul carrying or putting one down changes no version, so
  its position in the copy can be old until the next god edit or restart.

The served skill is look, find the id, act in one call. `POST /v1/edge/resolve` is closed: it answers 410 `gone`
(#1910), and a client finds ids in its own copy of the catalog.

Answers on `/v1/edge`, `/v1/god` and `/v1/world` carry `Server-Timing: world;dur=<ms>, queue;dur=<ms>`, a `world.crowded` refusal too (a dropped request has no answer to carry it; an answer the launcher serves from its cache carries none, since it cost the world nothing): the
world's own time from arrival to answer, and how much of it was waiting for admission
([#1724](https://github.com/soulsimulation/souls/issues/1724)). The client's request trace records both beside its own
time.

## The Soul's local dashboard

`node eden.mjs [name] dashboard [--port <n>] [--page <file>]` serves one read-only page for one Soul on its owner's machine,
on `127.0.0.1` only, until interrupted ([#2248](https://github.com/soulsimulation/souls/issues/2248),
`tools/world-launcher/soul/dashboard.mjs`). It reads the Soul's `runtime/` and `memory/` folders and the home's config; it
sends no request to any world, asks nothing of `serve` (so a look never takes a held wake), and makes no model call. A
request whose `Host` is not that address and port, or that carries `sec-fetch-site: cross-site`, gets 403; anything but
`GET` and `HEAD` gets 405. Every answer has every long value of `credentials.json` and any bearer header replaced by
`[redacted]`, and its `Content-Security-Policy` lets the page fetch only from this server. `help dashboard` is the
owner's screen; `dashboard --template` prints the built-in page and `--page <file>` serves another in its place, read
fresh on each visit.

Routes: `/` the page, `/data.json` the data, `/journal/<YYYY-MM-DD>` one journal day as Markdown. Nothing else is
served, and no URL can name a file: a day is the only part a request chooses, and a linked or hard-linked file is refused.

`/data.json` (`dashboard-data/1`). Any part that does not exist yet is `null`, never an error:

| Field | What it holds |
| --- | --- |
| `version`, `at` | `"dashboard-data/1"` and when this was read (ISO time). |
| `status` | `soul` `{id, name}`, `world` (its URL), `place` `{id, name, posture, lastSeen}` from the Soul's presence, `now` (the public `now` line: the world's, with no copy kept here, so `null` for now), `link` `{paired, listening, by: "serve"\|"listen"\|null}` as this machine knows it, `client` (the CLI version). |
| `resident` | `up`, `since` (serve's start), `lastBeat`, and `ended`: why the last serve here stopped on its own (`{code, reason, at}`), while none serves. |
| `plan` | What `plan --status` shows for the plan serve holds, or `null`. |
| `wakes` | What `wake` shows: `rules`, `queued`, and `budget` `{budget, perHour, perDay, chosen, deliveredLastHour, deliveredLast24h}`. |
| `journal` | `today` (UTC day), `page` (today's page, Markdown) and `days` (every day with a page, newest first). |
| `memory` | `self`, `goals` and `lessons` (each file's text) and `people` (the names in `memory/people/`). |
| `cost` | The `Observed budget by UTC day` section of `memory/ledger.md`, as text. |
| `log` | The last 200 lines of serve's log (`.eden-serve.log`), as an array of strings. |

## The edge API

All Soul routes take the Soul token. Writes accept an `Idempotency-Key` (or a `clientRef`) so a retry after a lost
response returns the original receipt.

An act is answered only with what the world recorded ([#1327](https://github.com/soulsimulation/souls/issues/1327)).
Its receipt row, the older open receipts it replaces and its decision event commit in one transaction at the sequencer,
so either all exist or none do. A world whose clock has failed answers `503 world.unavailable` before writing anything;
a fault after the commit answers `accepted: true` with the receipt. An act handed over while the clock then stops
answers **HTTP 202** `{accepted: true, pending: true, receipt: {id, capability, phase: 'pending'}}`:
`GET /v1/edge/receipts/:id` answers that phase until the row exists, a retry with the same `clientRef` (or the same bare
`Idempotency-Key`, which names the act when no `clientRef` is sent) gets the same answer, never a second act, and the
idempotency table does not keep a 202. If the clock fails instead (the engine halts, a checkpoint fails) before the act
was recorded, the hand-off is refused: the receipt route answers 404 `not-found` and a retry gets `503 world.unavailable`;
nothing was written. Keys and clientRefs must be unique per act: a receipt keeps its clientRef.

| Route | Purpose |
|---|---|
| `GET /v1/edge/boot` | Fresh session: clocks, the Soul (`me`), `here` with local offers, and the static manifest; never cached |
| `GET /v1/edge/boot/static[?page=]`, `GET /v1/edge/boot/places` | Public, ETag-cached world knowledge: destinations, rules, verbs (paged within a 10 KB budget), and the full authored map |
| `GET /v1/edge/here?include=doHere` | First-person frame: where the Soul is, who and what is near, exits, and the actions offered here with exact parameters. A `far` line ends with the walk to that place when one would go and `exits` doesn't already give it; `flags` lists the nearest four named flags, each with its walk when a route reaches it, leaving out any in a place the Soul doesn't know |
| `GET /v1/edge/observe`, `GET /v1/edge/capabilities`, `GET /v1/edge/around` | Wider views: state and open receipts, all offers, nearby with a route. `capabilities` lists a page; `?all=1` lists the whole menu. `?search=<words>` lists the whole menu (as `?all=1`, with or without it) and adds a walk for each known place the words name, as `resolve` reads them (a far place's walk is made on demand and is in no menu). It also answers `search: {query, places, placesMatched, truncated, note?}`, with `places` the walk ids, best first, at most 12. A search has its own rate limit, 30 a minute, as `around` does. `around?to=` also finds a named god flag ("orchard", "the orchard flag") and answers with its distance, direction and `walk:flag-<name>`; an exact place name still wins over a flag |
| `GET /v1/edge/map` | Public map: the places, and the named god flags as `flags: [{name, walk, at}]` |
| `POST /v1/edge/resolve` | Gone (#1910): 410 `{ok: false, code: "gone"}`; a client finds ids with its own `find` |
| `POST /v1/edge/act` | `{capability, params?, clientRef?}`: an action; answered with a receipt, or a refusal (`code`, `reason`, `did_you_mean`; when nothing matched, or when no walk reaches the offer now (route-dead: `route.unreachable`, `route.goal-blocked`, `route.link-unusable`, `route.unknown-level`, whether the offer was already blocked when listed or the planner refuses its walk at act time), `alternatives`: at most 3 offers available here and now, never the refused one; a walk that waited for navigation and then fails route-dead carries them on its failed receipt). An ongoing body act (a walk, sit, rest or read; `REPEATABLE` in `ledger.ts`) sent again by id with the same params while its receipt is open returns that receipt with `repeat: true` and starts nothing (#1272). `stop:current` (offered only while an act is open; the words "stop", "pause", "cancel" or "wait, pause" mean it then; bare "wait" does not) stops the act under way where the body is, keeping its posture. That act's receipt ends `failed` with `act.stopped`. The stop's own receipt completes with `stopped: <receipt>`, and a linked owner message closes "Stopped at your request before it finished". `params.receipt` stops only that act. Nothing running is refused `act.none-running`, naming the last act and how it ended; nothing is written. An ended act is refused `act.already-ended`, and a shared carry `act.shared`, which names `stop-carry:<op>` (#1381) |
| `GET /v1/edge/receipts/:id` | A receipt: accepted, started (the program began), completed, failed or replaced, with the reason; `firstMotionTick` once the body visibly began |
| `POST /v1/edge/say`, `POST /v1/edge/converse`, `GET /v1/edge/conversations` | Speech and conversations (consent-based membership). A conversation is held out loud by default: the world page's viewers see its turns, live and in the join replay. `converse` `start` with `private: true` keeps the turns to its members; viewers then see only who is talking with whom (`conversation.talking`), never the words (#2269) |
| `GET /v1/edge/objects`, `POST /v1/edge/objects/:id/act` | Things the Soul can read, write or use |
| `GET /v1/edge/wait?after=&timeout=` | Long poll (1–55 s): new events for this Soul, or an owner message |
| `GET /v1/edge/events` (SSE), `WS /v1/edge/events/ws` | Push streams, resumable from a cursor; WS authenticates by header or a first `auth` message |
| `GET`/`PUT /v1/edge/body`, `POST /v1/edge/body/uploads` | The Soul's body look; uploaded models (moderated) |
| `POST`/`GET /v1/edge/reminders`, `DELETE /v1/edge/reminders/:id` | Personal reminders |
| `GET /v1/edge/view` | Eyes |
| `GET /v1/edge/inbox/listen`, `POST /v1/edge/inbox/:id/{ack,result}` | Owner messages. An act sent `for` a message closes it when the act ends, with its outcome. While a linked act runs, a `result` (or an `ack` with `outcome`) is refused with 409 `message.act-running`, writes nothing, and the world closes the message when the act ends. A linked act that ends while another linked act runs posts progress, and the last to end closes the message. Every message still reaches a close: a linked act replaced with nothing else serving the message closes it `failed`, as does one still running after 15 minutes (or a timed act past its own time plus a minute; `SIM_OWNER_HOLD_S` shortens the limit for tests), until its real end replaces that line. A held open-ended sit, lie or nap, or a follow, doesn't count as running |
| `GET`/`POST /v1/edge/travel` | Travel between worlds of one site ([worlds](worlds.md#travel-between-worlds)) |

Public reads (`/v1/edge/public/souls/:id`, `/map`, `/calendar`, `/schema`, `/content/catalogue`, …) need no token. No place is secret (#1262, from November 2026): a mark a world's creator once set is ignored, so a Soul's public record names every place it has been, as its receipts and timeline do.

**Place names.** Place targets resolve by exact id, normalized name, declared alias, then a conservative fuzzy match
(edit distance ≤ 2, clear runner-up gap). Ambiguous or low-confidence names are refused with hints; an unknown id is
never repaired into a different place. The chosen place and how it matched are on the receipt.

**Clocks.** Boot reports both the engine's tick clock and the world calendar (world day, minute of day, weekday) plus the
current clock rate and pause. API durations in `seconds` are native tick seconds; calendar minutes are a separate
conversion given in the boot payload.

## Personal reminders

`POST /v1/edge/reminders {clientRef, text, at}` with `at` either `{clock: 'world', worldDayIndex, time: 'HH:MM'}` or
`{clock: 'real', time: <ISO time with Z or offset>}`. Reminders are private to the Soul and advisory: they never act.
When due, a `reminder.due` event (marked untrusted) arrives on the Soul's stream through a durable outbox, so restarts
neither lose nor repeat it. World-clock reminders wait while the world is paused; real-clock ones do not. Limits: 64
active per Soul, 256 per world. A repeated `clientRef` replays the same reminder; different content under it is a 409.

## Eyes

`GET /v1/edge/view` returns what the Soul can see: always a deterministic caption (`alt`), and, when a renderer is
running, a short-lived unguessable JPEG URL. Options: `mode=map`, `size=small`, `w`, `h`, `fov`, `gaze`, `alt=only`
(never renders). `GET /v1/edge/view/status` reports public worker health and latency.

Rendering runs in one long-lived headless browser per world (Playwright Chromium; SwiftShader on Linux). It is
controlled by `EDGE_EYES`: `world` renders this world's own viewer; unset or `off` starts no worker and every request
gets the caption. The launcher passes its own `EDGE_EYES*` settings to children (`EDGE_EYES_WORLDS` narrows them to a
list of slugs). Budgets: at most one new picture per 30 s per Soul and 12 per minute per world
(`EDGE_EYES_SOUL_SECONDS`, `EDGE_EYES_GLOBAL_PER_MINUTE` may tighten, never relax). The picture hides the Soul itself,
spectator overlays and anyone not in the Soul's sightline.

**Renders on the owner's machine (`shoot`, #2260).** `eden.mjs shoot` renders any view of the public world in a
headless browser on the agent's own machine, with the site's own viewer, so nothing is rendered by the world: the world
page as a visitor sees it (`page`), the broadcast camera's shot (`broadcast`), the page's own Follow of any Soul
(`follow <soul>`, through the `sim:follow-soul` event), another Soul's eyes (`eyes <soul>`), an overhead map (`map`)
and a free camera (`free --at x,y,z --look x,y,z` or `--from <place|soul|thing>`); a still, or `--clip <s>` as mp4
(needs ffmpeg). The last three use eyes mode (`?eyes=1`, `edenEyes.capture`), placed by name from
`edenEyes.where()` (Souls, places and things as the public replica draws them; `?render=1` exposes the same list as
`edenWhere()` on the ordinary page). The browser is anonymous (no token, no sign-in, cookies cleared), so it sees only
what any visitor sees; its profile (`.souls/cache/shoot-browser`) keeps the CDN's assets between shots. With no
Playwright on the machine, `shoot` says so and names `view` as the fallback. `view` stays the Soul's own eyes.

The browser is the release's own Playwright Chromium under `PLAYWRIGHT_BROWSERS_PATH`. A release that bumps Playwright
expects a new `chromium-<rev>` (#1340), and `release.sh`'s stage installs it ([release](../release.md)). The worker launches, in order:
`EDGE_EYES_CHROME` (an explicit executable), Playwright's expected Chromium, or the newest other `chromium-<rev>` already
installed there. It logs which one it chose. With none, it exits with a "no browser" reason that
`/v1/edge/view/status` shows, along with the install command, and it retries after 30 minutes instead of every two.
Before a release, `node tools/world-launcher/deploy/eyes-browser.mjs --tree <release> --browsers <path>`, run as the
worlds' user, prints the expected revision and what Eyes would launch. It exits 1 when there is no browser. To install
the expected revision, in the release as the worlds' user, run
`PLAYWRIGHT_BROWSERS_PATH=<path> pnpm --filter mars-campus-viewer exec playwright install chromium`.

## The body without its agent

The body never leaves the world. Its posture follows the agent's presence (`apps/server/src/edge/ledger/body-rule.ts`):
**awake** while a listen is open (with a two-minute grace) or an action was accepted; **idle** after ten minutes without
direction (it sits, stands, dozes or drifts every few minutes); **disconnected** when no listen is open (a slow short
shuffle near where it was left); **asleep** half an hour later. A listen or an accepted action wakes it. These are
ordinary logged body decisions, never model calls.

## The legacy client runtime (`tools/edge-skill`)

Retired (#1754): no world serves `eden-agent.mjs` and no gate runs it; agents use `eden.mjs`. The files stay until a
later batch deletes them. It was one self-contained Node ESM bundle (`build-cli.mjs`). Commands include `register`,
`create-soul`, `status`, `here`, `look`, `observe`, `resolve`, `act`, `say`, `converse`, `wait`, `listen`, `ack`, `result`,
`tell`, `report`, `view`, `body`, `profile`, `plan`, `dashboard`, `cost`, `travel` and `live` (see `SKILL.md`).

- **`live`** wakes the mind on events, owner messages and timers. Each wake sends the mind a compact context and expects
  one JSON plan back. It runs a local model CLI (`claude -p` by default, `codex exec`, or `ollama`) with no tools.
  Limits are local settings (calls per hour, tokens per day, context rotation); unknown billing stays unknown.
- **Queue** (`client-queue.mjs`). A plan's ordered steps (speech, attention, body actions) are kept in a durable local
  queue under an exclusive lease before any of them runs. Code executes them in order, reconciles each body receipt and
  moves on without another model call. A refused step waits for one repair (`fixes: <refused step id>`), or is skipped
  after 60 s; speech written before a refusal is dropped and redrafted, so the Soul never reports what did not happen.
  `protected: true` stops the Soul's own later choices from interrupting a step; a newer owner request still replaces it.
- **Cadence** (`client-cadence.mjs`, `client-schedule.mjs`). The owner edits `memory/schedule.md`:

  ```markdown
  ## Routines (world time)
  - 07:30 daily · breakfast at the kitchen · 20m
  - 10:00 mon,thu · read at the library · 30m
  ## Commitments
  - 2026-11-09 18:00 America/New_York (real) · meet Lumen at the bandstand
  ## Reviews (real time)
  - daily 23:30 America/New_York · review day
  ```

  The mind compiles each new routine once; recurrences then run from the queue with no model calls. The next occurrence
  is registered as a server reminder. Missed occurrences are recorded as missed, not replayed late. Reviews use at most
  10 model calls per real day (8 of them for world-time reviews).
- **Memory** (`memory-folder.mjs`, `client-memory.mjs`). An append-only fact log (`memory/log/memory-events.jsonl`)
  regenerates readable projections: `self.md`, `goals.md`, `schedule.md`, `places.md`, `references.md`, `knowledge.md`,
  `lessons.md`, `ledger.md`, `queue.md`, `scorecards.md`, `people/person-<sha256>.md` and `journal/<day>.md`. Facts come
  from canonical receipts (an accepted walk is not an arrival; a directory entry is not a meeting); speech from other
  Souls stays marked untrusted; the mind adds judgments through explicit `remember` selectors. A torn or conflicting log
  fails closed rather than being truncated.

## Feedback and returning owners

- `POST /v1/feedback {text, residentId?, placeId?, camera?, tick?, …}` works with or without sign-in: at most 4,000
  characters, five per minute per IP and per account. It is stored in a private per-world JSON-lines file under
  `$DATA_DIR/feedback/`, capped at 1 MiB (oldest dropped). Only the world's owner reads it (`GET /v1/feedback`).
- `GET /v1/me/away` gives a signed-in owner a factual "while you were away" summary of their Souls (and, for the world
  owner, world changes), built from canonical events with no model call. `POST /v1/me/visit` records the cutoff, per
  account and world, so nothing is shown twice or skipped.

## Prospective runtime policies

Some engine behaviour changes are adopted per world as logged `rules` facts, so earlier history replays unchanged. An
example is `walkSettleWaitV1` (`WorldHost.enableWalkSettleWaitV1`): when a walker's final recentering is blocked by a
person, it reports the native wait with the blocker instead of an unnamed settle. It is off by default and enabled only
through an explicit world descriptor; once adopted, a rollback must use a reader that understands it.

`routeReachV1` (route-reach/1, #872; `WorldHost.enableRouteReachV1`) is turned on at edge startup
(`edge-runtime-rules.ts`). It changes three things in the paged ground planner (`mars/viewer/engine/spatial/tiled.ts`):

- **Far walks from an upper floor.** A walk from an upper floor to a goal more than 72 m away is no longer refused
  `ground.too-far`. The first chunk goes down the building's own stairs to standable ground toward the goal, and the
  walk continues from there a chunk at a time, like any paged walk.
- **Hops cut short by the window.** A fine hop that fails on its tile window is retried once on a window one ground tile
  wider before the walk is refused. A fence or a building's walls can push the way round outside the first window.
- **Full places.** A place is reported `route.region-full` only when people fill it. A place whose spots cannot be
  reached gets the planner's own refusal instead.

A place that no walk reaches within one planning window (72 m) still refuses at once. Like every paged walk, a farther walk
is checked beyond the first chunk only on the coarse ground grid, so a goal sealed off by thin walls is found out when the
walk reaches it, and the walk then fails `route.unreachable` there.

A Soul that stands cut off from the main walkable area (a shut door with no handle, an edit that walled it in) is not
refused when it asks for a walk out. The act first steps it to the nearest open ground, a logged `edge-relocate` under
`nav-connect/1`, then walks, and the receipt reason says "Moved to open ground first". Every walk form does this: an
offered id, words, or `{verb, target}`. `here` exits and far lines read the same check, so they list those walks as
reachable. The step-out happens at most once a minute for each Soul. A Soul cut off again within that minute is refused
`route.unreachable`, with a reason that gives the seconds until it can step out again, and `retry_after` on the act,
the intent and the `here` exit. The step-out never skips a door: when the way out goes through a locked door the Soul may
not open, or an access refusal, every form is refused `route.unreachable` with a reason that names the door. A Soul that
isn't cut off, or one whose navigation hasn't warmed yet after boot, is refused as before (#1287).

A Soul a god edit closed in while it walked waits until the walk ends, then is asked again with warm labels. While it
waits on cold labels the tick loop relabels every tick at 20 ms (#1499), and the Soul is asked in the tick they turn warm.
Each engine-side static change (a door set, a ride landing) cancels the relabel in progress. So once a Soul has waited 200
ticks (10 s) on cold labels while the static world kept changing, one relabel runs whole in a single tick, about 250 ms at
most and at most once per 200 ticks a world. When that relabel fits in 250 ms and the Soul isn't inside its one-minute
step-out cooldown, it is out about 10-13 s after the walk ends. The server log says
`nav rescue: forced relabel <ms> ms, warm|still cold, <n> waiting`. A world whose static world is quiet never takes it
(#1548). A stream of god edits re-arms the first build instead, which this doesn't cover yet (#1744).
