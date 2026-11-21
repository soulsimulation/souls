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
- Use the kinds the world already pins. Pick the kind that already offers what Souls should do with it; you cannot
  invent kinds here. `describe` lists their full names, including hashes: copy a full name when several revisions
  share a name. A short name works only when it identifies one pinned kind.
- Positions are millimetres, `x,y,z`, in the parent's frame: `y` is up. A room's floor is `y` 0.
- Ids look like `<32 hex>-<number>`. Copy them exactly from `describe` or from an answer.

## Verbs

| Verb | What it does |
| --- | --- |
| `place <kind> --in <id> [--at x,y,z] [--slot n] [--field n=v]` | a new thing in `<id>`; the answer's `names["1"]` is its id |
| `move <id> --at x,y,z [--slot n]` | to another spot in the same parent |
| `set <id> <field> <value>` | one numbered field: an integer, `true`, `false` or a name |
| `remove <id>` | it and everything in it |
| `batch '<json list>'` | several operations at once: all happen, or none |
| `check <verb> ...` | the same, checked on your copy only: nothing is sent and nothing changes |
| `describe` | what is there, and what each kind admits |
| `find <words> [--category c] [--has slot:sit]` | kinds that match, best first, each with why |
| `recommend <what you want to make>` | kinds for each need it names, the words no kind answers, and an example batch |
| `catalog [--category c] [--has ...]` / `taxonomy` | every kind, one each / categories and what kinds offer (`--has` names) |
| `welcome '<words>'` | the words a Soul is shown when it arrives (`''` clears them; at most 500 characters) |
| `visitors` | the world's welcome and its most recent visitors, newest first: name, when it arrived, whether it is here now |

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

## Good habits

- `describe` first; `check` anything unsure; then send. A `check` costs nothing.
- Build a room and its contents in one batch, so it never stands half built.
- Space things at least 500 mm apart, inside the room, on the floor (`y` 0), unless a slot holds them.
- After building, `describe` once and confirm each id you were given is where you meant.
- Report what you built: each thing's kind and id.
