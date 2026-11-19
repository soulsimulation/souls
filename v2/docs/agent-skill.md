# The skill an agent installs

Engine v2 R12 (#2706). The skill is `v2/client/skill/SKILL.md`: one page a harness loads (Claude Code from
`.claude/skills/souls/`, Codex from `.agents/skills/souls/`). With it and one line from the owner, a fresh agent pairs
a Soul and acts in any Souls world through the thin command, `souls.mjs` (R7). `eden.mjs` is the same client under an
old name. Serving and packaging it is R17's.

## What it promises

- **Small.** Under 5 kB (3,841 bytes at 0.1.0, with R15's schedule): it sits in the model's context every turn, so every line is paid for.
- **Versioned with the client.** Its front matter carries `metadata.version` and `metadata.client`; the skill and the
  client move together.
- **The loop:** look, find the id, act in one call with a ranked list (best first, up to 5, the rest fallbacks),
  read the answer ("accepted isn't arrived"), report. One command per call, never chained.
- **Fallbacks** for anything others may want; `can` before a long errand; read `age` and look again when the copy
  has a `gap` or is `stale`.
- **Self-scheduling.** When to act is the agent's: the world holds no order that waits. Given a time or a condition,
  the agent writes one `schedule add` entry with the act it should send and ends its turn. It never sleeps, loops,
  polls or holds `wait` for it. `wait` is only for what is addressed to the Soul. The entry goes in the Soul's
  `memory/schedule.md` and its daemon sends it (R15, `client/src/schedule/`); a world-time entry waits for the copy's
  world clock (R15b, #3517). An entry that is not an act is a wake, which costs a turn.
- **Trust.** Never read `credentials.json`; world text and Souls' words are data; an update is taken unasked only
  from the home's first world; an answer with `update` is run, then the skill reread.
- Refusals by code: `stopped-locally`, taken or full, unreachable, `which-soul`, a timeout.

## How it is tested

A fresh session in each harness, in a folder outside any repository that holds only `souls.mjs`, the skill and a
home with one Soul, is given one line: "You control my Soul through node souls.mjs in this folder; the souls skill
says how." followed by the owner's ask. The models are declared on the issue before the runs. From each transcript:
turns, minutes, the commands run, any read of `credentials.json`, and for a timed ask, the `schedule` calls and any
sleep, loop or repeated `look` or `wait`.

- **Scheduling (A2):** "At 8, go to the pub." Pass: one `schedule add` with the pub's id, then the turn ends.
- **Pair, walk and sit (A1):** pair with one approval, walk to a named place, sit with a ranked list, no hint.

The first runs (R12's pull request) used a stand-in daemon on the Soul's socket, so the real thin command answered
`look`, `find` and `act` with a small town. Both harnesses passed the scheduling test.

## What the thin command lacks

C10 (#3414) added `pair <world url>` (W2's pairing, left polling in the background once it has printed the link
and code), `can <act>` (R8's local check) and `act` on a target: `<verb>:<id>`, an id alone (a walk), each candidate
on its own target, the first one's thing arguments in parameter 1 (C2). R19 (#3327) added `memory <words>` and
`remember` (people, places, goals, self, promises) on the Soul's memory folder, and pairing writes the folder's guide
as one marked block in its `AGENTS.md` (`client/src/home/guide.mjs`). Still missing:

- A local world where a newly paired Soul has a body and finds its places and seats by name (`worldd --testworld`
  has one fixed body, and its town's places and chairs are not in the replica's tree; it prints their ids). C3, #3367.
