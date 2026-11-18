# Lane E · Expressiveness: what the Eden audit found missing in the engine

Draft, local only. Added on 16 Nov after an audit of 240 requests a first-time owner would type, tested on
paper against the engine as designed by two independent auditors and the planner. With the engine as
designed, 57 % of the actionable requests could be carried out as the user meant. These tasks close the gaps
that belong to the engine. None needs the trunk (`v2/docs/TRUNK.md`) changed. Written to
`v2/docs/tranche/FORMAT.md`; its rules are not repeated. K15 puts this file at
`v2/docs/tranche/E-expressiveness.md`: the notes below (today's data, the checked facts) are this lane's
shared notes. The 240 requests with their numbers, the audit's summary and the list of which requests are
actionable are files attached to the gate's issue (E17); each task quotes the requests it serves in words.
Code references are to `origin/main` at `ee208bfdb`; read them with `git show origin/main:<path>`.

The owner's decisions below are fixed, and every task keeps them:

- **"When" is not an engine primitive.** The engine holds no order that waits for a time or a condition. The
  world publishes clocks, calendars and timetables; the client schedules itself.
- **Places carry no labels** such as "quiet" or "cosy". A place's card gives plain facts and the agent infers
  the rest. Light and warmth are not modelled.
- **Things react by rules written as data.** A rule never chooses and never moves a body.
- **Bodies touch only inside an activity both Souls joined.** The engine's closed list of orders is ranked
  fallbacks, a held stance, follow, and standing in a queue.
- **Compose before adding a primitive. Minds stay outside the engine.**

## Changes made at the final audit

The first version of this file was written quickly by the planner. Every task has now been reviewed, checked
against the other lanes, today's data and published sources, and rewritten. IDs, titles and main purposes are
kept.

| Task | Change | Reason |
|---|---|---|
| E1 | Depends adds N1. The size bar is "smaller than today's catalog for the same content", not "under 2 MB"; a cost bar for the Soul list is added; a Soul's place is a named area, not only a node | Today's whole catalog is 1.4 MB, so 2 MB could not fail. Outdoors is one node, so "the node she is in" says nothing for anyone outside |
| E2 | Depends adds N1, K3. "The client and the server resolve each to the same answer" now holds for the choice among things and seats and for the described point; a legal standing spot is bound by the server | Walkable ground lives in `v2/crates/sim`, which is native only. The client's library cannot prove a body may stand somewhere |
| E3 | Depends adds K3, N8, N9, N10. Perches come first from data that exists (26 kinds already carry a surface with a height) and only then from shape. A link holds a still body only where a walker can still pass | The bake's solids drop table tops and merge small shapes, so they cannot give flat tops. N8, N9 and N10 forbid stopping on a link; this task changes that rule and must say so |
| E4 | Depends adds G2, G3. The refusal is G2's function and the rebuild is G3's; work is ordered with a hand-back point at hour 3 | G2 already names "things Souls put down" as a caller. Seven cases with a ground rebuild will not fit four hours if built in any order |
| E5 | Depends adds E23. The pushed thing in the outcome is "a thing whose kind allows one pusher" | The moving group is defined once (E23). Soul Actions' draft lists a sofa as needing two Souls; the kind's data decides |
| E6 | Depends adds T6. Outcome adds: nothing per tick, and a jump equals stepping | K9's property, without which an idle world cannot jump past dusk |
| E7 | **Ceiling 2 h to 3 h.** Depends adds B7, N8. A ride's timetable is computed from its formula, never stored | It is the only owner of the calendar in this tranche, and the boarding wait touches N8 and N12. Today's rides have no timetable at all |
| E8 | Depends adds R4, R9, T8. **Standing consent is a rule in the Soul's own client (R9), or an open proposal the Soul made; it is not a setting the engine holds** | An engine setting that fires when an offer arrives is an order that waits for a condition, which TRUNK T10 rules out |
| E9 | Depends: E8, E23, N8, N13 (B9 and N7 removed). The ring round a point is checked as a composition of N9 and a sit | It needs the group contract and follow, not the carry. A ring of sitters does not move |
| E10 | Depends adds N11. A walk's "via" list and a lap count are bounded | A manner that changes speed is N11's gait. Each "via" is one more route search |
| E11 | Depends adds T8. **The agent names the stand-in clip; the engine never guesses a "nearest" one** | Judging which clip is nearest to free words is a mind's work |
| E12 | Depends adds E23, N5, N11. Outcome keeps the bicycle and the rowing boat only | Sail and rail (numbers 135 and 219 of the 240 requests attached to E17's issue) do not fit the ceiling: proposed as a later task |
| E13 | Depends adds R4, N16, E8. Ordered: reach first, devices second, with a hand-back point | Six cases in three hours. A phone call is an activity both joined (E8) |
| E14 | A weight may read one whole-number field. The proof declares its tolerance first | Soul Actions' chance task allows it. "Near the stated odds" was not a bar |
| E15 | Depends adds V6. **The drawn look is a variant chosen by a field; layered garments stay out** | The crowd renderer draws many bodies from shared data; a mesh per garment per body breaks that. The first draft's "other path" is the design |
| E16 | Depends adds G2. "The nearest thing it can do" is replaced by "the next act the form's author wrote, where there is one" | I6 rules out alternatives chosen by the world |
| E17 | Depends: E1 to E24 except itself, R12, R15, I9, I10, V10, F7 | E18 to E24 were added after it was written; judging reads V10's fact sheet; 22 requests need R15 |
| E18 | Depends adds K3, E6. Effects a rule may apply are a closed, smaller list; fan-out is sliced across ticks | The loop check runs when a kind loads. Dusk lights 770 lamps in Eden at one instant |
| E19 | Depends adds K3, R3. The test gives the model a search and at most twelve cards, not all 1,514 | All cards together are about 450 kB, which is not "short". Live facts of far places are fetched for a shortlist only |
| E20 | Depends adds N5, N7 | It is a walk with a moving target |
| E21 | Depends adds K3, N11 (and E4 at the final pass) | Forms load with kinds; swimming is one of N11's abilities over water |
| E22 | Depends adds R3, R4, F4. The mechanism is membership effects on an audience, not an audience that "follows a field" | T8 resolves an audience when a record is written |
| E23 | Depends: T1, T2, T4, B5. Done when the contract, its types and a checked fixture exist; "B9 is built on it" is removed from the outcome | B9 is another lane's four-hour task and does not list E23 |
| E24 | Outcome is giving, a two-sided swap of things or amounts, and lending. "Coins" is content | Soul Actions section 11 leaves money and trade out, and its stock task says "buying waits". Gene has not confirmed buying |

**At the final pass** (16 to 17 Nov: the planner's rulings in the final audit, and rules 11 to 18 of
`v2/docs/tranche/FORMAT.md`, applied to all 24 tasks).

- **Acceptance.** Every task ends with three to five boxes drawn from its Outcome and Proof. E17 has the four
  gate boxes, with its bar named in the first.
- **Step 0.** Each now names the result that means "stop and hand back" (21 did not).
- **Citations.** Nothing cites a file a checkout lacks. The trunk and the rules are cited by repository path;
  "data n" became the file in today's tree; "fact n" became its link; request numbers alone became the
  request's words plus "the 240 requests attached to E17's issue"; "the notes above" are gone.
- **Labels.** "SA-D6", "SA-F11" and the like are now plain words ("Soul Actions' areas format"); the map from
  words to Soul Actions' IDs is under "Words". "Lane N, C13" in E12 is restated as the fact.
- **Touches.** Narrowed to a module or file, new ones marked "(new)". E2 no longer touches the importer (N1
  keeps window nodes); E17 touches `v2/tools/battery` and uses the playtest seats unchanged.
- **Rulings applied.** E4: no lifetime is set there; a kind says how long a loose thing lasts once nobody holds
  or owns it, owned or in a slot it lasts, and F10 builds that (the two tasks now agree). E8: standing consent
  is a rule in the Soul's own client (R9) and works only while the owner's machine is on. E13: ordinary talk
  is public with a short reach; a whisper has an audience of one. E15: what a Soul owns goes with a body that
  travels or retires; anything else is put down first. E23: a group survives a restart as nodes and links.
  E24: a swap has no stakes, so it is acknowledged at the first durability mark.
- **Audit findings fixed.** E4 builds the at-rest case itself and N14 reuses it. E7 follows B7's queue (T10
  and B7 no longer say "wait for"). E3 relies on N8 and N10 as amended instead of editing lane N's notes. E12
  leaves a standing vehicle to E16's check. E17 judges results that are not public (a whisper, a hidden
  thing) from receipts and the other Soul's copy, runs the whole battery twice, and takes its rubric from the
  issue, not from the scorer. E19's rubric is likewise fixed in its issue.
- **Dependencies.** E17: "E1 to E16, E18 to E24, R12, R15, I9, I10, V10, F7; Soul Actions' Eden entries
  loaded", and the cut-over (X7) depends on it. E21 gains E4 (its sandcastle is a set-down). E23 is stated as
  the first lane E task of stage 2; B9, B14, E5, E9, E12 and N12 build on it. `INDEX.md` needs rebuilding.
- **Length.** Bodies were trimmed and then grew by the checklist: 392 to 503 words with it (median 424), 342
  to 427 without. E17, E18, E19 and E23 are the longest.

Not resolved at the final pass:

1. **E17's three files and E19's rubric do not exist yet.** The rubric (the facts that must appear for each of
   the 240), the list of actionable requests and E19's twenty requests with accepted places must be written,
   attached and hashed in the issue before dispatch. No task writes them; the split proposed below (E17's
   files early, the run later) would.
2. **Soul Actions' task texts are not in the repository** (that tranche is local). E3, E4, E12 and E14 say
   "attached to this issue": the coordinator must attach the named text when filing.
3. **E23 depends on B5, a win 5 task,** so the six moving-group tasks cannot start until win 5 is under way.
4. **A miss on E17.** The task says the cut-over depends on the gate; rule 11 says a gate is finished when
   scored. Whether a score under 95 % holds the cut-over is not ruled.
5. **Length.** The bodies are over 380 words. Going lower would mean dropping outcome clauses or checked
   facts.

**Split, merge, drop.**

- **Would split:** E1 (the index; where a Soul is). E2 (choosing among things and seats; points on a place's
  own shape). E3 (perches on things; staying on a doorway or stair, which changes lane N's rules). E13 (reach
  and audience; devices). E16 (the way-out check on forms; the refusal table). E17 (the request files and
  rubric, which can be written early; the run). Each task below carries a hand-back point where the split falls.
- **Would merge:** the manner half of E10 with E11. Both are a word held on the body, drawn by a stand-in.
- **Would drop:** none. E23 is the cheapest task here and saves the most if it lands before B9.

**For the coordinator (other files I did not edit).** Items 1 to 7 were settled by the final audit and are
kept as the record: the lane files now list E23, F4, T10, B7, N8 to N10 and G5 are amended, and the two open
questions (6 and 7) were ruled.

1. B9, B14 and N12 should list E23 in "Depends on". E23 must be the first lane E task of stage 2.
2. F4's outcome says "a made thing appears in a hand or a slot, never on the ground". E4 reverses it.
3. `v2/docs/TRUNK.md` T10 names the fourth order "standing in a queue"; the task bodies of T10 and B7 still
   said "wait for" (a named slot frees and the engine fires the act). E7 follows the trunk. B7 needed the same
   reading.
4. E3 changes three lane N rules for a body that chose to stay: N8 ("nobody stops inside"), N9 ("a doorway or
   a stair must never hold a spot") and N10 (a still body in a doorway is asked to make way).
5. G5 and E6 both say what weather is. G5 sets it; E6 owns the field.
6. F10 ends a loose thing "nobody keeps", and Soul Actions counts "placed" as kept. After E4 every thing a Soul
   sets down may last for ever. One of the two must say what a set-down counts as.
7. T11 makes "anything with stakes" wait for the second durability. Whether a swap (E24) has stakes is Gene's.
8. Soul Actions round 6 (17 Nov, section 9a of its spec, local until that tranche is filed) wrote the *format*
   for much of this lane: areas, placements, stock, chance, mounts, the body's own entry, six activities of
   two. Its task IDs (D6, F10 to F14, G3 to G5, C9) collide with this tranche's F10, F11, G3, G4 and G5, so the
   tasks name them in plain words (the map is under "Words"). Where a list is closed in both places, it must
   be one list.
9. Lane E's ceilings are now 69 h. `build-index.py` rebuilds the tables.

**Not verified.**

- Nothing here was run. Every number in an outcome is a bar.
- No official source was found for The Sims' placement and routing rules; the two facts used are from modders'
  tutorials for The Sims 4.
- Read only as search summaries, not as fetched pages: the trade rule (DDO and Guild Wars wikis), Unreal's
  tether distance, the three chemistry rules of Breath of the Wild (a press report of the talk), the EQS
  auto-sort bug, Recast's filter descriptions, furniture heights.
- Whether N1's export file keeps window openings, how many of Eden's kinds are mesh kinds (no shape list), and
  the widths of Eden's stairs: each is a Step 0.
- Whether a closed container's contents were ever withheld by a shipped game's protocol the way E22 needs. The
  design rests on Riot's account of withholding positions.
- The size of the index (E1) and of a card (E19): arithmetic from today's catalog, not a build.

## The primitives behind these tasks

Most of what people ask composes from a few things. Where two tasks below are the same idea, build the idea
once.

| Primitive | In plain words | Tasks that are this one idea |
|---|---|---|
| **Describe** | Say where, which, who or all, by relation instead of by name; say by what way; let a place describe itself in facts, never in labels | E1, E2, E19, E20, and the "by what way" half of E10 |
| **Rest** | A body or a thing can rest on anything that can hold it, at a described spot | E3 (bodies), E4 (things), E15 (things on a body) |
| **Move as a group** | Several bodies and things move as one, with one of them steering | B9, B14, E5, E9, E12, N12, defined once in E23 |
| **Offer** | Anything that needs someone else's yes | E8, E24, and joining any activity |
| **Be heard** | A voice or music reaches as far as it should, and things can carry it | E13 |
| **React** | A thing answers something that happened to it, by a rule written as data (approved by Gene, 16 Nov) | E18; E6 announces what a rule can react to |
| **Express** | How a body does something, and any gesture at all | E11, and the manner half of E10 |
| **Chance** | An outcome that depends on a draw | E14 |

Not a primitive of its own: E6 and E7 (what the world publishes), E16 (safety), E21 (where a form may live),
E22 (who sees what), E17 (the gate).

**Not the engine's:** *when* to act (the agent's client schedules itself: E7, R15), remembering (R14), looking
up the past (R16), and doing one thing to many targets (a plan in the client).

## Words

- **Copy:** the part of the world an agent's client holds locally (lane R's replica).
- **Index:** one line per place and thing in the whole world: enough to find it and walk to it.
- **Card:** a few lines of plain facts about one place.
- **Selector:** a description that the engine turns into one thing, seat or spot, by a stated rule.
- **Perch:** somewhere a body can rest that is not a seat or a bed.
- **Outline:** a thing's shape seen from above.
- **Group:** several bodies and things that move as one (E23).
- **Offer:** a proposal (B5) addressed to someone, which waits for their answer.
- **Reach:** how far an utterance carries.
- **Rule:** "when this happens to a thing, apply these changes", written as data on its kind.
- **Soul Actions' …:** a task of the Soul Actions tranche, which writes content and its format; lane E builds
  what the engine needs to run it. Named in plain words, because its IDs collide with this tranche's: areas
  (its D6), recorded sounds (D7), weights (F10), where to put it, or placement (F11), stock (F12), chance
  (F13), mounts (F14), the body's own entry (G3), activities for two (G4). Until that tranche is filed its
  texts are not in the repository: the coordinator attaches the one a task names to that task's issue.

## What today's data already carries

- **Data 1. The bake** (`packages/generators/src/types.ts`): solids as turned boxes with a bottom, a top and a
  tag; floors with a `material`; openings of kind door, **window**, gate or arch with position, width, height,
  `sill` and level; links (stairs, ramp, ladder) with a path and a `width`; rooms; slots; water as an area or a
  path with a width.
- **Data 2. Slots** (`packages/generators/src/fields.ts`): kinds seat, bed, surface, stand, door, hang, carry,
  socket, room, floor, roof, wall, post, perch, shelf; each has a position, a `height`, what it `accepts` and a
  `capacity`. In the nine core-kit files (321 kinds) there are 102 seat, 66 stand, 26 surface, 18 shelf, 13
  bed, 7 perch and 4 hang slots. Surfaces include the counter's top (0.90 m, capacity 8), the table's (0.75 m,
  12), the pool table's baize (0.78 m, 16) and the stove's hob. The bathtub has a bed slot `soak`; the bunk has
  `lower` and `upper`. Seat heights are 0.44 to 0.52 m. `perch` today means a bird's place (a birdbath's rim,
  a lamp post's top). The piano, the lamp post's side and "under" have nothing.
- **Data 3. Kit shapes** (`packages/generators/src/kit.ts`): a kind is a list of simple shapes with a centre and a
  size. Solids come only from shapes marked `collide`, by default boxes and cylinders at least 0.3 m tall; more
  than 12 are merged into one box. The table is a top 0.02 m thick at 0.715 m on four thin legs: its top is
  not a solid. A mesh kind has no shape list.
- **Data 4. The catalog** (`apps/server/src/edge/catalog/catalog.ts`; the audit's summary, attached to E17's
  issue): 1,514
  places (870 rooms, 239 buildings, 199 outdoor, 7 waters, 7 shores, 9 piers) with id, name, kind, parent,
  outline to 0.1 m, aliases and up to 200 characters of `what`; 4,536 things of 192 kinds with id, kind, name,
  position and `place`; 984 seats; 21 acts a body can do anywhere. 1.4 MB as JSON. A thing's `place` comes from
  which outline contains it, not from its parent: 1,771 things sit at the world's root.
- **Data 5. The live picture** (`apps/server/src/edge/catalog/live.ts`): every client is already told "who is where
  doing what, and what was said, anywhere", built at most twice a second and encoded once for all.
- **Data 6. The clock** (`apps/server/src/god/real-clock.ts`, `edge/events/index.ts`, `edge/eyes/sight.ts`,
  `edge/perception/here.ts`): worlds run on real time in the world's own time zone, re-aligned by a logged
  event after drift or a daylight-saving change. `light.changed` has five labels (morning, day, evening, dusk,
  night) at 0, .2, .45, .55 and .75 of the day; two other functions cut the day at different minutes.
  `weather.changed` is "reserved: no weather yet": the page draws weather as a function of the clock, one kind
  per two-hour slot, and the server mirrors it.
- **Data 7. Schedules** (`mars/viewer/engine/vehicles/carrier.ts`, `apps/server/src/edge/comms/objects/`): a ride
  has no timetable; it starts boarding when its first rider claims a place and leaves 45 s later, or when
  full. A calendar item is an object with a start and an end in ticks and a list of interested Souls, whom the
  server reminds; the live Eden 2026 held 8,273 of them.
- **Data 8. Speech** (`apps/server/src/edge/comms/speech.ts`): indoors, everyone in the room hears; outdoors,
  everyone within 12 m. Perception is 20 m.

## Checked facts (16 Nov 2026)

- **Fact 1. Unreal's Environment Query System** builds a set of candidate items with a generator (actors of a
  class; points on a circle, cone, ring or grid) and runs tests on them (distance, dot product, tags, overlap,
  pathfinding, trace), each as a filter, a score or both. "Filtering is done before scoring to avoid
  calculating the score on filtered-out items."
  https://dev.epicgames.com/documentation/en-us/unreal-engine/eqs-node-reference-tests-in-unreal-engine
  A reported fault: its sorting put a costly path test before a cheap filter.
  https://issues.unrealengine.com/issue/UE-137553
- **Fact 2. The Sims 4** gives an object separate outlines for placement and for pathing. The modding tool's
  outline made from the mesh "will work for basic items only" and otherwise "will strip off all but one
  footprint and screw up the routing features".
  https://sims4studio.com/thread/4509/use-studios-automatic-footprint-feature
- **Fact 3. Recast** finds standable ground from raw geometry with three filters: a low obstacle that can be
  stepped over, a ledge (a neighbour further away than the climb height), and too little headroom.
  https://recastnav.com/group__recast.html
- **Fact 4. SQL Server** lets triggers set off triggers to 32 levels; when "a trigger in the chain starts an
  infinite loop, the nesting level is exceeded and the trigger terminates", and the whole transaction is undone.
  https://learn.microsoft.com/en-us/sql/relational-databases/triggers/create-nested-triggers
- **Fact 5. Breath of the Wild** avoids chains by layers: elements change materials, elements change each other,
  materials never change materials.
  https://gamesbeat.com/the-legend-of-zelda-breath-of-the-wild-makes-chemistry-just-as-important-as-physics/
- **Fact 6. Leader following** (Reynolds): followers arrive at a point slightly behind the leader, steer sideways
  if they find themselves in front, and keep apart from each other. https://www.red3d.com/cwr/steer/gdc99/
- **Fact 7. Formations** (Pottinger, Age of Empires): each place is an offset in the formation's own frame. At a
  gap the choices are to scale the offsets ("pretty useless for formations where the units are already
  shoulder to shoulder"), to break and reform on the far side, or to halve and rejoin.
  https://gamedeveloper.com/programming/implementing-coordinated-movement
- **Fact 8. Vehicles on their own map:** GTA San Andreas keeps vehicle nodes and pedestrian nodes as separate
  lists; boats are vehicle nodes with a flag; trains have their own track files.
  https://gtamods.com/wiki/Paths_(GTA_SA) Detour's route filter includes or excludes ground by flags and prices
  areas; "a cost modifier less than 1.0 is likely to lead to problems". https://recastnav.com/classdtQueryFilter.html
- **Fact 9. Reach in shipped worlds:** Second Life: whisper 10 m, say 20 m, shout 100 m, and a region may set its
  own. https://wiki.secondlife.com/wiki/LlSay A voice mod for Minecraft: 48 blocks, 24 when whispering.
  https://modrepo.de/minecraft/voicechat/wiki/server_config
- **Fact 10. Withholding:** in Valorant "the game server withholds information about the positions of enemies
  until a client needs to display it". Its first version popped enemies in late, and hidden actors missed
  one-off events and came back in the wrong state. https://www.riotgames.com/en/news/demolishing-wallhacks-valorants-fog-war
- **Fact 11. Containers in interactive fiction** (Inform 7): "If a container is not transparent, we can see into
  and out of it only when it is open." https://ganelson.github.io/inform-website/book/WI_3_6.html Its room
  description lists unremarkable things once, in one closing sentence, and never repeats a thing already
  mentioned. https://ganelson.github.io/inform-website/book/WI_18_25.html
- **Fact 12. Draws:** reducing a random number with a remainder is biased; unbiased methods reject and draw again.
  https://www.pcg-random.org/posts/bounded-rands.html
- **Fact 13. Trades:** in online games both sides must accept, and any change to the offer needs both to accept
  again. https://ddowiki.com/page/Trade
- **Fact 14. Consent by context:** Second Life grants a script permission to animate an avatar with no dialog once
  the avatar sits on the object. https://wiki.secondlife.com/wiki/LlRequestPermissions
- **Fact 15. A moving goal:** Unreal re-makes a path when the goal actor moves further than a "tether distance"
  from the path's end.
  https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/NavigationSystem/UNavigationSystemV1/FindPathToActorSynchronously
- **Fact 16. Free-worded gestures** are the "emote" of text worlds. One warns: "Abuse of emote to show misleading
  information (such as 'emote slashes your head and shatters it!') can lead to punishment."
  https://docs.mume.org/wiki/pages/Emote
- **Fact 17. Descriptions for a language model:** in the LIGHT text world, a ranking model scored 68.1 on dialogue
  alone, 70.6 with the setting's description added and 68.2 with the objects' descriptions added, the "least
  improvement". https://ar5iv.labs.arxiv.org/html/1903.03094 Models use what is at the start or end of a long
  context best, and performance "significantly degrades" for the middle. https://arxiv.org/abs/2307.03172
- **Fact 18. A long thing at a corner:** a thin rod turns between two equal passages only if shorter than 2.83
  times their width. https://mathworld.wolfram.com/MovingLadderProblem.html

---
