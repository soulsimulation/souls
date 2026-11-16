# Door-fit in live worlds

Templates, and so new worlds, carry real doors (#2397, #2438). A live world keeps its drawn doorways until the
live rule is switched on for it: `door-fit/2` alone, the last boot rule (it fits every building door-fit/1 would,
with its checks; door-fit/1 alone cut off 19 places on bench-eden)
(`apps/server/src/god/door-fit.ts`, wired in `apps/server/src/edge-runtime-rules.ts`). This note says what the rule
guarantees, what must be measured before it is switched on, how to switch it on and how to roll it back. Switching it
on for any production world is a separate step that needs the maintainer's yes.

## What the rule does

Each world fits once. The fit starts after the other boot rules and does not hold them up. It runs one building at a
time, each building its own recorded edit, and the world serves between slices. Each fit then logs one rules event.
A building it could not fit this boot (a body in the way, an engine that had not caught up, a building that kept
changing) holds the event back, so the next boot fits what is left. A restart part way through goes on where it stopped.

What one building's fit guarantees (#2462):

- **Its own building only.** A fit edit that would re-settle anything its ops do not name (a padded neighbour, re-settled
  when the building's foundation comes up and goes back) is refused. The building keeps its drawn doorways (on bench-eden
  such re-settling cut whole houses off, and no check of the fitted building saw it).
- **BUILDSAFE.** The edit is checked on the would-be world before it commits, as a god edit is. It is not made when it
  edits a resident's body, when legal-edits/1 refuses it (its preview breaks a rule on a Soul, a Soul is in its way or
  uses what it changes), or, in a world without legal-edits/1, when the walk-out planner would have to walk somebody out
  of its way, or would leave one stuck in it. The god's own guard holds too: no deck or stair flight someone stands on
  is moved or removed under them. A fit never walks anyone. The building is tried again at the next boot.
- **Bodies.** The bodies are read again for each building. A doorway with a body standing in it gets no door this
  boot. A prop never moves onto a body.
- **Reach.** The engine must have taken the edit in before anything is judged: three waits, then the fit is undone and
  tried again at the next boot. The check walks from outside the building's front door, or, when the building has no
  door yet, from outside the outside doorway its fit plans. If it has neither, the building is refused and keeps its
  drawn doorways. The walk goes to both sides of each new door, and to each thing, seat, bed and body of the building
  on every floor that was reached before the fit. Anything reached before and not after undoes the prop moves first.
  Then the new doors come out one by one: the door whose side is cut, else the one nearest the front. If something is
  still cut off with every new door out, the whole fit is undone. These clean-up edits put back what was there, so they
  are checked only against a resident's own body and the god's deck guard. The whole fit is undone only while the
  building and everything the fit changed stand as the fit left them. A fit that cannot be undone (a Soul on the deck,
  or the building changed since) is never counted as fitted: it is named in the rules event, and the event waits a boot.
- **The engine is told.** Each edit's own diff (entities, defs, tiles) goes to the engine as it is made.
- **Doors follow.** A live-fitted door is its building's child, and door-fit/2 makes door-fit/1's doors its children
  too, so a later edit that moves the building moves its doors. A template's outside doors are world-root until the
  templates are refitted.
- **Turns.** Each slice is cut at 50 ms, half #2433's 100 ms turn budget. A turn over the budget is logged with what held it, and each
  fit ends with its longest turn (`[world] door-fit/N: longest turn … ms`). One building's edit is a single turn and
  cannot be cut. Before #2443 it took up to 15.9 s on Eden. #2443 removed the cause: re-settling every padded neighbour
  on the edit's tiles. Whether one edit now stays under the budget on each live world is what the measurement below
  answers.

Doorways a door does not fit stay bare (the maintainer, 15 Nov). That covers doorways narrower than the door's frame,
doors a hand cannot work either way, doors held by name in `DOOR_FIT_HELD`, and doors whose frame cuts a way off.

## Before switching it on

Tests never use production data. The measurement (#2462 A3) runs on the walk gate's fixture worlds
(`tools/test-harness/walk/fixtures/`: eden-2026, bench-eden, bench-hamlet) and on a fake-mind Eden 2026 world, from
before any door fit, with Souls placed inside and beside buildings. Each world boots with fake minds, the fits run as
the boot runs them, and four bars are scored:

1. The fit completes, and its rules events are logged.
2. The walk audit after the fit is no worse than before it (the walk gate's own comparison).
3. Every Soul that could walk before the fit still can (`navCheckV1` on each body, before and after).
4. The longest turn the fit logs, and the slowest building's edit, are recorded. Bar: no turn over the budget. Until
   a single fit edit costs less, a world like the one that misses it stays off.

Only when all four hold is a world proposed for switching on. For a production world, the release owner then rehearses
its first boot on the host with `DOOR_FIT_BOOT=1` ([boot rehearsal](../operations.md): the original is opened read-only
and the copy is deleted).

## Switching on

Set `DOOR_FIT_BOOT=1` for that world's process and restart it in the release window, smallest world first and Eden
last. Watch the world log for the `door-fit/1` and `door-fit/2` summary lines, the longest-turn lines, and the healthz
and watchdog heartbeats while it fits.

## Rollback

1. **Stop.** Unset `DOOR_FIT_BOOT` and restart. No further building is fitted. Buildings already fitted keep their
   doors, and the world serves as before.
2. **Undo one building.** The journal holds each fit edit's ops, with a `door-fit/` note, but no inverse (an engine
   edit is journaled with none). Rebuilding a building's old state means taking its old revision from
   `DOOR_FIT_FROM`/`ALL_DOORS_FROM` read backwards and its contents from the ops. No tool does this yet; write one only
   if a fitted building is found wrong.
3. **Restore.** Restoring the world's snapshot from before the switch rewinds everything since, Souls' time included.
   It is a destructive production step and needs the maintainer's explicit yes.
