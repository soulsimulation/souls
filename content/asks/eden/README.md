# The Eden asks

A standing test with no engine and no model (Soul Actions SA-P9, [#2889](https://github.com/soulsimulation/souls/issues/2889)):
of the things a new owner would type in Eden, how many can the entries and the format express? The real measure is
Engine v2's gate E17 ([#2824](https://github.com/soulsimulation/souls/issues/2824)), which gives every request to a real
agent on the new engine; this one is the early warning.

```sh
node tools/entry/asks.mjs            # the share expressible, by group, and what the rest wait on
node tools/entry/asks.mjs --list     # every request, yes or no, and why
node tools/entry/asks.mjs --json     # the same as one JSON line
```

- `requests.md` is the frozen list: the words, as typed. A line is never edited, removed or renumbered.
- Each request has one file, `<n>-<words>.json`, holding its words and the chain of forms that would satisfy it. Its
  words and group must match the frozen list, or the command fails.
- The share is a measure, not a gate: the command fails only on a malformed or drifted file. Never tune a chain toward a
  score. A chain may be corrected to name a form as it is published, never to drop or soften a request.

## A request's file (`souls-ask/1`)

```json
{"format": "souls-ask/1", "n": 111, "group": "two-things", "words": "put the bowl on the table", "obvious": 3,
 "things": {"bowl": "eden:bowl", "table": "eden:table"},
 "chain": [{"this": "me", "form": "pick_up", "carry": "bowl", "args": {"thing": "bowl"}},
           {"this": "me", "form": "put", "args": {"thing": "bowl"}, "place": {"at": "on", "thing": "bowl", "anchor": "table"}}]}
```

- `things`: the request's things by name, each a kind. `me` is the acting body (`eden:humanoid`); another Soul is a body
  of the same kind (`"her": "eden:humanoid"`). Everyone and everything stands loose in one place, `here`.
- `chain`: the steps in order. A step is one of:
  - a form: `{"this", "form", "args"}`, where `this` is `me` or a thing, and an argument that names a thing uses its name;
    `carry` or `push` (with `souls`) names the thing moved, and `place` (`at`, `thing`, `anchor`, `facing`) where it is
    put, so the format's rules for moving and placing are asked too; a slot argument the step does not name, described
    by a selector of the thing's own free slots, is the first free one ("go on the swings" takes a free swing);
  - a line said: `{"say": "<what, in a few words>"}`;
  - a read of the copy: `{"read": "<thing>", "field": "<a state field, or stock>"}`, for a question;
  - a choice: `{"any": [[...], [...]]}`, for an open-ended request: expressible when any one chain is.
- `when` (optional): when the owner wants it, in their words. Scheduling is the agent's client's business, so the chain
  is one occurrence.
- `fields` (optional): what the request presumes of a thing, such as a class already running.
- `none` instead of `chain`: `{"why": ...}`, one of `home`, `animal`, `game`, `refused` (the list is in
  `tools/entry/asks.mjs`). A request with no chain is counted, never dropped.

## How a chain is judged

Each step runs through the rules on Eden's content (`content/kinds`, `content/moves`): every kind it names has an entry,
its form exists, the format's own rules allow it (how a thing moves, where it is put, what an area forbids, the six base
forms), and `@souls/form-rules` decides its needs and applies its effects, so a later step sees what an earlier one did.
The walk to a thing is taken as done, since every thing can be gone to. A step not yet written is reported as missing
(`entry eden:door`, `form open of eden:door`); a step the rules refuse is reported with its reason.

Engine v2's own frozen list (E25, [#2794](https://github.com/soulsimulation/souls/issues/2794)) is read when it exists.

To add a request: add a line at the end of `requests.md` with the next number, and its file beside it.
