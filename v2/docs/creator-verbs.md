# Creator verbs: eden-god 1.9 to souls-god

Every verb of today's god command (`tools/god-skill/eden-god.mjs`, skill 1.9) and what replaces it on Engine v2's
creator command (`v2/client/src/creator/souls-god.mjs`). 0.131 ships when every row is **done** or **retired** with a
reason (#3729, parity row N-C23). A **gap** names the task that closes it.

souls-god today: `pair`, `describe`, `place <kind> --in <id> [--at x,y,z] [--slot n] [--field n=v]`, `move <id> --at`,
`set <id> <field> <value>`, `remove`, `batch`, `weather`, `sky`, `strike`, `land`, `time`, `check`, `status`, `stop`, `trace`. Every edit goes through the world's safety
rule (BUILDSAFE, G2): an edit that would cut off or bury a Soul is refused by name, never repaired after the fact.

## Seat and session

| eden-god | souls-god | Status |
|---|---|---|
| `register`, `mint`, `pair` | `pair <world url> --creator <grant>`; the owner approves the link | done |
| `status` | `status` (the daemon: connected, copy version) | done |
| `doctor [--fix]` | `status`, `stop`; the daemon holds the token and the copy, so there is no lock file to repair | retired: no locks |
| `help`, `schema [--md]` | no arguments prints the usage; `describe` lists each kind and what it admits | done |
| `trace` | `trace [n]`: the creator's last commands (the daemon keeps 200, across restarts), each with its time, verb, result and refusal | done |
| `request <clientRef>` | each edit is answered once with its `sequence` and, on a refusal, its code, op and fix | retired: one answer per edit |
| `listen`, `ack` | none for a creator | gap: no task (page messages to the creator) |
| `prayers`, `answer` | daemon ops exist; CLI verbs in open PR #3557 (G11, #3335) | gap: #3335 |
| `flags`, `flag` | gated off on soul.game (`godFeature("flags")`) | retired: not offered today |

## Reading the world

| eden-god | souls-god | Status |
|---|---|---|
| `describe <ref>`, `map`, `history`, `resolve` | `describe` gives every node (id, kind, parent, text) from the daemon's copy | partial: no per-ref read; `history` gap: #3694 |
| `mirror`, `snapshot`, `query`, `follow`, `stream` | the daemon keeps a live copy; `describe` reads it | retired: the copy is local |
| `defs <words>`, `catalog`, `find`, `recommend`, `taxonomy` | `describe` kinds only | gap: #3696 |
| `where`, `reach`, `clear`, `free`, `verify-use` | `where`, `clear` and `free`, read from the creator's copy with no browser (#5006); `check` runs any edit on the copy and names the refusal | partial: no `reach` read |
| `look`, `thumbnail`, `kit look` | `look`: a picture drawn here from the public stream, or with no picture the copy's words for it (what, where, what is in it, what is near, with ids and metres) | partial: no `thumbnail` or `kit look` |
| `examples`, `gallery`, `parts` | the creator skill teaches by example | retired: docs |

## Building

| eden-god | souls-god | Status |
|---|---|---|
| `place <def> --at x,z` | `place <kind> --in <id> --at x,y,z` (metres in the parent) | done |
| `place --near/--inside/--on/--along/--against/--between/--facing/--count/--row/--grid` | `place --beside/--on/--facing`; `--row n --gap m [--along x\|z]` and `--grid CxR --gap m` as one all-or-none batch (R8a) | partial: near, inside, along, against, between and count no task |
| `place <path-def> --from --to`, `place <area-def> --rect/--circle/--area` | none | gap: roads and areas; zones in #3700, the rest no task |
| `move <ref> --by / relations / --in` | `move <id> --at` (same parent) | partial: `--by` and relations with #3694; a new parent is a crossing |
| `set --param --state` | `set <id> <field number> <value>` | partial: named params no task |
| `recolor` | `recolor <id> '#rrggbb' [--part <part>]`: a tint on the thing or one named part (field 145, `replica::tint`), the world's creator only (`edit.tint-malformed` for one that does not read); the old page multiplies the picture by it; `undo` takes it back | done (0.134 R4) |
| `remove` | `remove <id>` (and its subtree) | done |
| `clone`, `select [filters] [--remove ...]` | `batch` | partial: no task |
| `plan`, `preview`, `commit`, `act`, `dryrun` | `check` (on the copy, free) and `batch` (all or none) | done |
| `group`, `undo`, `redo` | none on the wire; the engine has them (G4, `sim::edit::undo`) | gap: #3694 |
| `build start/step/check/show/wait/resume/continue/pause/done/abandon` | `build start <name> --steps a,b,c [--brief]`, `build step`, `build show`, `build done` (R8e), kept in the creator's home; every edit carries the session's build and step | partial: check, wait, resume, continue, pause and abandon no task |
| `build district` | none | gap: #3701 |
| `build claim/release`, `--helper` | none | gap: #3701 (claims), #3727 (helpers) |
| `build rewind` | none | gap: #3727 |
| `about` | none | gap: #3699 |

## The world

| eden-god | souls-god | Status |
|---|---|---|
| `land raise/lower/.../water/extend` | engine and expansion exist (G5); no verb | gap: #3695 |
| `weather`, `sky`, `strike` | engine weather exists (G5), not on the wire; no sky palette or strike | gap: #3695 |
| `time [--speed/--pause]` | `time <HH:MM \| live>`: the hour the page shows the sky at (field 91 on the world node, display only); world time never stops or changes speed | done (speed and pause retired: parity row 97) |
| `expand`, `furnish`, `export`, `import` | `v2/tools/import-world` for operators only | gap: #3728 |
| `define`, `define-kit`, `upload` | upload check and hold point exist (G6); no verb | gap: #3697 |
| hide an upload; hide a world | world `unlisted` setting exists (W9) | gap: #3698 |
| welcome message, visitor list (`/v1/god/welcome`, `/v1/god/visitors`) | none | gap: #3702 |
| `hours`, `event` | schedules published (E7); no verb | gap: #3699 |
| `own`, `access`, `secret`, `zone`, `zone-suggest`, `layers` | form access rules (F6) | gap: #3700 |
| `price`, `currency`, `give`, `pay`, `relate` | only where a world opts in (`LAYERS=1`) | retired unless the coordinator says a world uses them |
| `constitution`, `amendments`, `decide`, `governance` | gated off on soul.game (`godFeature("constitution")`) | retired: not offered today |
