---
name: souls-creator
description: Build a Souls world live as its creator, through souls-god.mjs and the resident daemon. Use when asked to build, change or tidy a world you are the creator of.
---

# Building a Souls world

You are the creator of one world. You change it with `node souls-god.mjs <verb> ...`. Every command prints one line
of JSON. A small resident program (the daemon) holds your creator token and a copy of the world; you never see the
token, and you never need it.

## Start

With the client a world serves (`<world url>/eden.mjs`), the command is `node eden.mjs god <verb> ...`: read
`node souls-god.mjs` in this skill as that.

1. `node souls-god.mjs status`: `connected: true` means the daemon holds a current copy. If it is false, run it
   again after a second or two.
2. `node souls-god.mjs describe`: everything in the world (`nodes`: `id`, `kind`, `parent`) and what you can place
   (`kinds`: each kind and the kinds it `admits`). Read it before you build, and again whenever you are unsure.

If the home has no creator yet, pair first: `node souls-god.mjs pair <world url> --creator <creator grant>`. It prints
a link and a short code; the world's owner opens the link signed in and approves. Then run `status`.

On a large world, save `node souls-god.mjs describe > world.json` in your scratch folder. Inspect selected JSON with
`jq '.kinds | keys' world.json` and `jq '.nodes[] | select(.kind == "eden:ground")' world.json`; filter other kinds or
node ids the same way. This keeps the whole world out of your tool output. Refresh the file after edits.

## The world's shape

- The world is a tree. The root is the place (kind `souls:place`). Its shape is the world's own: follow `admits`
  down from the root. In a small world rooms hang under the place; in a large one the ground is under the place, a
  building stands on the ground, and its rooms stand on a floor of that building. Things and bodies stand in rooms.
- A thing can only go in something whose kind admits it. `describe` shows each kind's `admits`: a kind name, or a
  category (`thing`, `body`) that admits every kind of that sort.
- Use a kind the world already has when one offers what Souls should do with it; when none does, define your own
  (below). `describe` lists every kind's full name, including its hash: copy a full name when several revisions share
  a name. A short name works only when it identifies one kind.
- Positions are millimetres, `x,y,z`, in the parent's frame: `y` is up. A room's floor is `y` 0.
- Ids look like `<32 hex>-<number>`. Copy them exactly from `describe` or from an answer.

## Verbs

| Verb | What it does |
| --- | --- |
| `place <kind> --in <id> [--at x,y,z] [--slot n] [--field n=v]` | a new thing in `<id>`; the answer's `names["1"]` is its id |
| `place <kind> --path '[[x,z],...]' [--width m]` | a road, footpath, hedge or wall along a line (metres), on the open ground unless `--in` |
| `place <kind> --area '[[x,z],...]' \| --rect cx,cz,w,d \| --circle cx,cz,r` | a lawn, pitch, bed or named area (`eden:place`, with `--field 15=<its kind>`) over an area |
| `move <id> --at x,y,z [--slot n]` | to another spot in the same parent |
| `set <id> <field> <value>` | one numbered field: an integer, `true`, `false` or a name |
| `remove <id>` | it and everything in it |
| `about <id> --title '<t>' [--alias '<a>' ...]` | a place's title and aliases, kept as words for everyone; Souls' `find` matches either. `--set '{"title":"..","aliases":[".."]}'` sets both, `--clear` clears both |
| `batch '<json list>'` | several operations at once: all happen, or none |
| `check <verb> ...` | the same, checked on your copy only: nothing is sent and nothing changes |
| `define <record.json>` | a kind of your own, from a `souls-entry/1` record; the answer's `defines` is its full name |
| `define-kit <kit.json> [--ns <namespace>]` | a kind of your own from a kit: a name and primitive shapes, in metres |
| `find <words> [--category c] [--has slot:sit]` | kinds that match, best first, each with why |
| `recommend <what you want to make>` | kinds for each need it names, the words no kind answers, and an example batch |
| `catalog [--category c] [--has ...]` / `taxonomy` | every kind, one each / categories and what kinds offer (`--has` names) |
| `place <kind> --beside <id> [--dir n\|ne\|e\|...] [--dist mm]` | beside another, in the same parent (default east, 1000 mm; north is -z) |
| `place <kind> --on <id>` | in or on another, in its first free slot a thing may take |
| `place ... --facing <id\|n\|e\|s\|w>`, `move <id> --facing ...` | turned to face another thing or a compass point |
| `undo` | the newest edit taken back; the answer's `changed` says what changed |
| `redo` | the newest undo done again, with the same ids; a new edit clears it |
| `<edit verb> ... --build <name> --step <name>` | one step of a build: the world keeps that batch under the build's name |
| `undo --build <name>` | the whole build undone, step by step, while its steps are your newest edits |
| `build claim <part> --area x0,z0,x1,z1 --helper [--ttl <minutes>]` | a claim with a helper: prints the helper's home (`SOULS_HOME=<folder>`); a sub-agent run there builds only inside that claim, until it lapses (default 120 minutes) |
| `build rewind <build> --to <step> [--dry]` | undoes every edit of that build after the step, newest first (`--dry` lists them) |
| `describe` | what is there, and what each kind admits |
| `look <name or id> [--out f.png] [--eyes]` | a picture of a place, thing or Soul, drawn on this machine from the public stream; open the file it names. With no browser here it answers in words |
| `where <x,z or name>` · `clear <x,z or name> --size WxD` · `free WxD --near <x,z or name>` | the room, areas and nearest things at a spot; whether a footprint there is free; the nearest free one. World metres, read from the page drawn here |
| `event <room or ground id> '<words>' --when HH:MM [--for <minutes>] [--at x,y,z]` | an event on the world's calendar there, beside its notice board (not under it): its words are kept for everyone, and `whatson` lists it. HH:MM is its next one in world time |
| `time <HH:MM \| live>` | the hour the page shows the sky at, for a staged scene (`time 18:30` for a sunset); `live` shows the world's own time. Display only: world time never stops or changes speed, and Souls' clocks and calendars are unchanged |
| `trace [n]` | your last `n` commands here (20, at most 200), newest first: time, verb, result and refusal. If you see the same refusal again and again, stop and read its `fix` |
| `welcome '<words>'` | the words a Soul is shown when it arrives (`''` clears them; at most 500 characters) |
| `visitors` | the world's welcome and its most recent visitors, newest first: name, when it arrived, whether it is here now |
| `listen [<seconds>] [--follow]` | waits for your owner's messages from the web page; `--follow` prints a line each time one arrives |
| `pending` | your owner's messages still open, and what arrived since the last read |
| `ack <message id> "<reply>" [--close done\|failed]` | answers a message: the reply shows on the owner's page; `--close` closes it (`failed` is a no), else it stays open |

`find`, `recommend`, `catalog` and `taxonomy` read the world's kinds kept in your home: they ask the world nothing
and cost nothing. They print JSON; add `--lines` for one line per kind.

A kind may be written as its bare name (`room`) when only one kind has that name, or as `namespace:name`.

These are all the verbs there are. If you know today's god command (`eden-god`), its undo, place by relation, land,
weather, search of kinds and the others are not here yet; do not try them. `v2/docs/creator-verbs.md` maps each one.

### Batches

A batch is a JSON list. Each operation is one of:

```json
{"op": "place", "name": 1, "kind": "room", "in": "<id>", "at": [0, 0, 0]}
{"op": "move", "node": "<id or name>", "at": [1000, 0, 500]}
{"op": "set", "node": "<id or name>", "field": 1, "value": 1}
{"op": "remove", "node": "<id or name>"}
```

`name` is a number you choose for each place in the batch. A later operation can use that number instead of an id,
for example placing a thing `"in": 1` inside the room the same batch places. The answer maps each name to the id the
world gave it: `"names": {"1": "<id>", "2": "<id>"}`.

Example: a room with two things in it, in one step.

```
node souls-god.mjs batch '[{"op":"place","name":1,"kind":"room","in":"<place id>"},{"op":"place","name":2,"kind":"<kind>","in":1,"at":[1000,0,1000]},{"op":"place","name":3,"kind":"<kind>","in":1,"at":[-1000,0,1000]}]'
```

## Kinds of your own

When the world has no kind for what you need, define one. It is kept in the world as data (a `souls:kind` node at
the root, which `describe` shows), and from then on you place it like any other kind.

- **A kit** is the quickest: a name and its shapes, in metres, with `y` = 0 the ground, `+y` up and the front `+z`.
  ```json
  {"name": "birdbath", "box": [1, 1.2, 1],
   "shapes": [{"kind": "cyl", "at": [0, 0.4, 0], "r": 0.18, "h": 0.8, "material": "stone"},
              {"kind": "lathe", "at": [0, 0.8, 0], "profile": [[0, 0], [0.45, 0.05], [0.5, 0.15]], "material": "stone"}]}
  ```
  `define-kit birdbath.kit.json --ns garden` makes the kind `garden:birdbath`; then
  `place garden:birdbath --in <room id> --at 1000,0,1000`. Shapes: `box`, `wedge`, `rbox`, `cyl`, `cone`, `capsule`,
  `sphere`, `ring`, `torus`, `arch`, `lathe`, `extrude`, `loft`, `sweep`; each needs `at`. Angles (`yaw`, `pitch`,
  `roll`, `arc`) are radians. Write each shape out: `repeat`, `radial`, `mirror` and `$params` are refused
  (`kit.program`). A kit's `actions`, `components` or `state` are not carried, and the answer lists them in
  `not_carried`.
- **A record** says what a thing is and does: the `souls-entry/1` format of the world's own kinds (`kind`, `owner`,
  `state`, `points`, `slots`, `geometry` with `bounds_mm` and `parts`, `forms`, `text`). Whole numbers only: mm,
  millidegrees and permille. Its `forms` must pass the same checks the world's own kinds pass, and a `create` names
  the made kind's full name (`namespace:name@hash`, from `describe`).
- **Your namespace:** any namespace that is not `souls`, `eden` or one the world's own kinds use (`kind.namespace`).
- **Revisions:** a changed record is a new revision with a new full name; what you placed from the old one keeps it.
  `place` by `namespace:name` works while one revision exists; with several, copy the full name from `describe`.
- **Removing a kind:** `remove <its souls:kind id>`, once nothing of that kind is left and no other kind's form
  creates it, or in the same batch as the last of them (`kind.in-use`).

## Export and import

- `node souls-god.mjs export [file]` writes every node of the world (not its Souls) to a file, `world.souls.json` by
  default: kinds, places, fields and poses, and the world's public names.
- `node souls-god.mjs import <file>` brings such a file into the world you are paired with, as edits, parents first.
  What the world already holds (the same id and kind, the world itself and its open ground) keeps its id and only its
  changed fields are set; everything else is placed, and then each doorway and stair it lacks is linked again (the
  `link` operation), so Souls walk in through the doors and up the stairs. The answer counts the edits, what was
  placed, set and linked, and anything not brought over. A refusal stops it and says how far it got. When the file's
  ground is larger than the world's, its tiles are set first, so the world grows before anything is placed on it.

## Growing the world

- `node souls-god.mjs expand <m>` grows the world's ground to a square `m` metres a side, centred on the middle.
- `node souls-god.mjs land extend --toward n|s|e|w|ne|nw|se|sw --metres <m>` grows it one way, or
  `--bounds x0,z0,x1,z1` (metres) to cover a box.
- The new ground is flat, level with the old ground's edge, and Souls walk on it. The world only grows. The whole
  ground goes in one edit, so a refusal `expand.too-large` names the largest size one edit carries.

## Answers and refusals

- Success: `{"ok": true, "names": {...}, "at": <version>, "changed": ...}`.
- Refusal: `{"ok": false, "code": "edit.<why>", "op": <which operation, from 0>, "fix": "<what to do>"}`. Nothing in
  the batch happened. Do what `fix` says, then send it again. `"local": true` means your copy caught it before
  anything was sent.

| Code | Meaning |
| --- | --- |
| `edit.child-not-admitted` | that parent's kind does not admit that kind: pick another parent or kind |
| `edit.kind-unknown` | the world does not pin that kind |
| `edit.node-missing` | that id is not there (removed, or mistyped) |
| `edit.name-unknown` | the batch uses a name no earlier place gave |
| `edit.stale` | someone changed that thing after your copy saw it: `describe`, then send again |
| `edit.not-the-creator` | this token is not the creator's |
| `kind.invalid` | the record is not one the world can keep: its `detail` names the part |
| `kind.too-large` | the record is over 64 KiB, or a `bounds_mm` is over 1 km |
| `kind.effects` | a form would fail every time it ran: it creates a kind the world has not got (use its full name), into a slot that does not admit it, or its timers start each other sooner than 50 ms in a ring |
| `kind.audience` | a kind is defined for everyone |
| `kind.namespace` | that namespace is not yours |
| `kind.collision` | that kind is defined already: place it by the name `describe` lists |
| `kind.in-use` | things of that kind are still placed, or another kind's form still creates it |
| `kit.invalid`, `kit.program` | the kit is not one `define-kit` reads, or it uses a program |
| `edit.would-bury`, `edit.would-cut-off`, `edit.in-use` | a Soul is there, would be shut in, or is using it: an edit or an undo is refused, never forced |
| `undo.nothing`, `undo.nothing-to-redo` | nothing left to undo, or nothing undone to redo |
| `undo.conflict` | something the undo would change has changed since: put it back by hand |

## Good habits

- `describe` first; `check` anything unsure; then send. A `check` costs nothing.
- Build a room and its contents in one batch, so it never stands half built.
- Space things at least 500 mm apart, inside the room, on the floor (`y` 0), unless a slot holds them.
- After building, `describe` once and confirm each id you were given is where you meant.
- Report what you built: each thing's kind and id.
