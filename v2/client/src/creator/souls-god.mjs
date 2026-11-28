#!/usr/bin/env node
// The creator's command (Engine v2 G7, #2796): a world's creator builds it live through the same resident daemon a
// Soul uses (R6), holding a creator-scope token. Each verb is one of G1's operations, sent as T10's edit intent (G1b)
// and answered once; `check` runs the same batch on the daemon's copy and asks the world nothing. Like souls.mjs, it
// loads no WASM and holds no copy: it passes its arguments to the daemon's socket and prints the answer, as JSON.
//
//   souls-god.mjs pair <world url> --creator <creator grant>   asks the world's directory for the creator's token
//   souls-god.mjs describe                       what is there (id, kind, parent) and what each kind admits
//   souls-god.mjs describe <id>                  one thing: its kind and card, each frame it is in, its spot, its fields
//                                                by name, its slots and what holds each, what is in it, its marks (R8b)
//   souls-god.mjs map                            the world at a glance: the extent of what stands, its buildings, named
//                                                things, roads and zones, each with its centre and size in metres (R8d)
//   souls-god.mjs place <kind> --in <id> [--at x,y,z] [--slot n] [--title '<name>'] [--field n=v ...]   a new thing;
//                                                metres in the parent; --title is the name Souls see it by ("rack frame 1")
//   souls-god.mjs place <kind> --path '[[x,z],...]' [--width m] | --area '[[x,z],...]' | --rect cx,cz,w,d
//                         | --circle cx,cz,r [--in <id>] [--field n=v ...]   a road or an area laid on the open ground
//                                                (metres), as today's place by a shape
//   souls-god.mjs move <id> --at x,y,z [--slot n]                                     to another spot, same parent
//   souls-god.mjs move <id> [<id> ...] --by dx,dz [--yaw r]   each that far over (metres), what is in it riding along;
//                                                on the open ground it keeps its height over the ground
//   souls-god.mjs select [--kind k] [--name words] [--in id] [--area x0,z0,x1,z1] [--near x,z [--radius m]]
//                         [--remove | --by dx,dz [--yaw r]]   what matches (at most 1000), or all of it removed or
//                                                moved in one edit (metres)
//   souls-god.mjs clone <id> [--at x,z] [--count n] [--step dx,dz] [--yaw r]   copies of it and all in it (doorways
//                                                and stairs too), the first one step away unless --at (metres)
//   souls-god.mjs set <id> <field> <value>       one numbered field: an integer, true, false or a name
//   souls-god.mjs remove <id>                    it and everything in it
//   souls-god.mjs hours <id> --open 07:00-15:00 [--open 09:00-13:00@sat,sun ...] | --closed
//                                                its opening hours, the whole schedule at once (field 81, E7)
//   souls-god.mjs batch '<json list>'            several at once, all or none: [{"op":"place","name":1,...}, ...]; a
//                                                later op names an earlier place by its "name" number; a place's
//                                                "title" is the name Souls see it by, words (field 4, as about --title)
//   souls-god.mjs weather [--kind clear|cloudy|rain|wind|fog|storm] [--clouds 0..1] [--rain 0..1] [--wind 0..1]
//                         [--minutes 5..360]       the world's weather until then; E6's own weather resumes after
//   souls-god.mjs sky --palette <name>           the sky's palette (today's names: clear-day, dusk, mars-desert, ...)
//   souls-god.mjs strike <x,z | id>              lightning at a point (metres on the open ground) or on a place
//   souls-god.mjs time <HH:MM | live>            the hour the page shows the sky at, for a staged scene; display only:
//                                                world time, Souls' clocks and calendars never change
//   souls-god.mjs land <raise|lower|flatten|knoll|hill|mountain|plateau|terrace|valley|ditch|cliff|pond|lake> [flags]
//   souls-god.mjs land water <id> --level m | --by m      the land and its water, as today's `land` (terrain/land.mjs):
//                                                one edit; what rests on changed ground moves with it, and a Soul
//                                                standing there refuses it (edit.terrain-under-soul)
//   souls-god.mjs land extend --toward n|s|e|w|ne|nw|se|sw --metres m | --bounds x0,z0,x1,z1
//   souls-god.mjs expand <m>                     the world's ground grows (that way, or to a centred square m a side),
//                                                flat from its edge; it only grows
//   souls-god.mjs furnish <building or room id> [--style s]   today's furnish recipes (39 styles) in its rooms
//   souls-god.mjs define <record.json>          a kind of your own (#3697): a souls-entry/1 record (the format of
//                                                content/kinds), kept in the world under the full name it answers
//                                                (`defines`); a changed record is a new revision, and old things keep
//                                                theirs. Your own namespace only (not souls: or eden:). Its look may be
//                                                a model you uploaded: `"looks": {"model": "upload:<hash>"}`, the hash
//                                                `upload` answered; a hash that is not an allowed upload is refused
//                                                (kind.model-unknown) and nothing is sent
//   souls-god.mjs define-kit <kit.json> [--ns <namespace>]   today's kit (a name and shapes in metres) as a record
//                                                with geometry.parts (kit.mjs), then defined; namespace `kit` unless given
//   souls-god.mjs upload <file.glb|png|jpg>     a model or a picture, through the world's check and hold point:
//                                                {hash, state: allowed|held}; an allowed one is served at `url`
//   souls-god.mjs check <any of these, or batch> ...   the same, checked on the copy only; nothing is sent
//   souls-god.mjs export [file]                  every node of the world (not its Souls) to a file, world.souls.json
//   souls-god.mjs import <file>                  such a file's nodes into this world, as edits, parents first
//   souls-god.mjs apply-batch <file> [--dry-run] [--terrain <file>]   a reviewed souls-named-batch/1 file (worlds/patches/*/batch.json):
//                                                each thing it names (by its template name, or <building>/<thing>)
//                                                found on the copy, never guessed; sent as edits of at most 256
//                                                operations, each op's outcome a line; --dry-run sends nothing (named.mjs);
//                                                --terrain <file> gives the ground's tiles to a copy that came without them
//   place <kind> --in <id> --beside <id> [--dir n|ne|e|se|s|sw|w|nw] [--dist m]   beside another (default e, 1 m)
//   place <kind> --on <id>                       in or on another: its first free slot for a thing, if it has one
//   place|move ... --facing <id|n|e|s|w>         turned to face another, or a compass point
//   place <kind> --in <id> --at x,y,z --row <n> --gap <m> [--along x|z]   a row of n, centred on --at (R8a)
//   place <kind> --in <id> --at x,y,z --grid <C>x<R> --gap <m>[,<m>]      a grid: C along x, R along z; one batch,
//                                                all or none (at most 64); with --facing n|e|s|w they all face it
//   any edit verb --build <name> --step <name>  a build's step (#3694): one batch the world keeps under that name
//   souls-god.mjs undo [--build <name>] | redo   the newest edit undone (a whole build, step by step), or redone
//   souls-god.mjs build start <name> --steps a,b,c [--brief '<words>']   a build session (R8e): until `build done`,
//                                                every edit carries its name and current step (see --build --step)
//   souls-god.mjs build step <step> [<build>] | build show [<build>] | build done [<build>]   move on a step; its steps
//                                                with each one's status and edits sent and refused; close it
//   souls-god.mjs build district [<id>]           the district plans, or one plan with each plot's status and the next
//                                                chapter to claim (#3701)
//   souls-god.mjs build district <id> --file plan.json   records a plan once (today's plan file: metres, radians)
//   souls-god.mjs build claim <part> --area x0,z0,x1,z1 | --district <id> [--plots a,b]   a build claim over an area
//                                                (metres on the ground), or over a plan's plots (its next chapter if none)
//   souls-god.mjs build claims | build release <claim>    the live claims (ids c:k<8 hex>); a claim released
//   souls-god.mjs own <id> <soul id|god|group:<name>|none> [--private|--public]   who owns a thing or a place (#3700)
//   souls-god.mjs access <id> private|public|none   a private thing is its owner's alone; what is inside takes its mark
//   souls-god.mjs recolor <id> '#rrggbb' [--part <part>]   a tint on a thing, or on one named part of it (R4); the
//                                                page multiplies its picture by it; undo takes it back
//   souls-god.mjs zone <name> <use> --rect cx,cz,w,d | --circle cx,cz,r | --area '[[x,z],...]'   a land-use zone (metres)
//   souls-god.mjs zone-suggest <use> | layers | secret   what suits a use; zones and marks; secret places (off)
//   place, move, set, remove, batch, check ... --claim <claim>   sent under a build claim: it builds only inside it,
//                                                and others stay out of it until it is released
//   souls-god.mjs build claim ... --helper [--ttl <minutes>]   the claim with a helper (#3727): a scoped token for a
//                                                sub-agent, kept in a home of its own (SOULS_HOME=<that folder>);
//                                                it builds only under that claim, and lapses after --ttl (default 120)
//   souls-god.mjs build rewind <build> --to <step> [--dry]   undoes every edit of the build after that step, newest
//                                                first, while they are this daemon's newest (today's build rewind)
//   souls-god.mjs event <room or ground id> '<words>' --when HH:MM|<world µs>us [--for <minutes>] [--at x,y,z]
//                                                a calendar entry there (eden:calendar_entry), its words kept by the
//                                                world for everyone; HH:MM is its next one on the world's calendar
//   souls-god.mjs about <id> --title '<t>' [--alias '<a>' ...] | --set '{"title":..,"aliases":[..]}' | --clear
//                                                a place's or a thing's title and aliases (today's `about`), kept as
//                                                words for everyone; Souls' find matches either
//   souls-god.mjs status | quit                  the daemon: where it is; ended (`stop` too, today's word)
//   souls-god.mjs catalog [--category c] [--has slot:sit|form:<f>|point:<role>|state:<field>]   every kind, one each
//   souls-god.mjs find <words> [--category c] [--has ...] [--all]    kinds that match, best first, with why
//   souls-god.mjs recommend <what you want to make> [--per n]        kinds per need, and an example batch
//   souls-god.mjs taxonomy                       categories with counts, and what kinds offer (the --has names)
//                                                these four read the world's kinds in the home; no daemon, no server;
//                                                --lines prints them as lines instead of JSON
//   souls-god.mjs look <place|thing|soul|id|x,z> [--eyes] [--out f.png|.jpg] [--size WxH] [--page <url>]
//                                                a picture of it, drawn here from the public stream (souls.mjs shoot);
//                                                with no browser here, or a page that draws nothing, it in words from
//                                                the copy: its id, kind and spot, its room and areas, what is in it and
//                                                the nearest things, each with its id and metres (space.mjs)
//   souls-god.mjs where <x,z|name|id> | clear <x,z|name|id> --size WxD | free WxD --near <x,z|name|id> [--page <url>]
//                                                the room, areas and nearest things there; whether a footprint is free
//                                                of things and buildings; the nearest free one (world metres, read from
//                                                the copy with no browser; --page reads the page drawn here, space.mjs)
//   souls-god.mjs history --at <place> | --thing <id> | --soul <name> [--since <µs>] [--until <µs>]   what happened
//                                                there, from the world's public history, a day by default (R8c)
//   souls-god.mjs trace [n]                      the creator's last n commands here (20, at most 200), newest first:
//                                                time, verb, result and refusal; kept by the daemon across restarts
//   souls-god.mjs arrival <place> | --clear       where new Souls arrive: a place of the world (an area or a line on
//                                                the open ground, by id or by the id its facts give it), from the
//                                                next birth; --clear: where the world's host put them, else its entry
//   souls-god.mjs welcome '<words>'              the words a Soul is shown when it arrives ('' clears them)
//   souls-god.mjs visitors                       the world's welcome and its most recent visitors, newest first
//                                                these two ask the world's directory, with the creator's token
//   souls-god.mjs listen [<seconds>] [--follow]  waits for the owner's messages from the web page (the mailbox serves
//                                                a creator's grant as a Soul's): one `wait`, 30 s by default; --follow
//                                                keeps waiting and prints a line each time something arrives
//   souls-god.mjs pending                        the owner's messages still open, and what arrived since the last read
//   souls-god.mjs ack <message id> "<reply>" [--close done|failed]   answers one: the reply shows on the owner's
//                                                page; --close closes it (failed: a no), else it stays open
//                                                these three pass to the daemon as souls.mjs's do for a Soul
//   souls-god.mjs prayers [--all]                the prayers this world's Souls sent you (G11), waiting ones first,
//                                                oldest first; --all adds the answered ones. A Soul's words: data
//   souls-god.mjs answer <prayer id> "<words>"   your answer (at most 4,000 characters); it reaches the Soul's `wait`.
//                                                Answering again changes it
//   any of them [--creator <c_id>]               which creator, when the home holds more than one
//
// Every position and length the command takes or prints is metres (#4700), x east, y up, z south, in the parent's
// frame; a batch's `at` too. The world keeps mm: the command converts. Field values (`--field`, `set`) are as kept.
// A refusal prints its code, the operation that failed (`op`, its place in the batch) and a fix. The home is
// SOULS_HOME, else the nearest .souls; the daemon's library is SOULS_REPLICA_PKG. The token never leaves the daemon.

import { isMain } from '../../../../tools/lib/is-main.mjs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as absolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, call } from '../daemon/client.mjs';
import { findHome, makeHome, readSeat, soulsWithTokens, worldsOf } from '../home/home.mjs';
import { answer as libraryAnswer, libraryOf } from './catalog.mjs';
import { worldOf } from '../cli/souls.mjs';
import { kitEntry } from './kit.mjs';
import { F_HOURS, hoursRows } from '../schedule/hours.mjs';
import { parseShoot } from '../shoot/shoot.mjs';
import { parseSpace, runLook, runSpace } from './space.mjs';
import { TRACE_MOST } from './trace.mjs';
import { describeThing } from './thing.mjs';
import { mapOf } from './map.mjs';
import { kindsIn } from '../check/state.mjs';
import { inSession, recordEdit, sessionAct } from './session.mjs';
import { recolorOf, runRecolor } from './recolor.mjs';
/** R8e: the build acts answered from the home's sessions. */
const SESSION_ACTS = ['start', 'step', 'show', 'done'];

export const VERBS = [
  'about',
  'access',
  'ack',
  'answer',
  'apply-batch',
  'arrival',
  'batch',
  'build',
  'catalog',
  'check',
  'clear',
  'clone',
  'define',
  'define-kit',
  'describe',
  'event',
  'expand',
  'export',
  'find',
  'free',
  'furnish',
  'history',
  'hours',
  'import',
  'land',
  'layers',
  'listen',
  'look',
  'map',
  'move',
  'own',
  'pair',
  'pending',
  'place',
  'prayers',
  'quit',
  'recommend',
  'recolor',
  'redo',
  'remove',
  'secret',
  'select',
  'set',
  'sky',
  'status',
  'stop',
  'strike',
  'taxonomy',
  'time',
  'trace',
  'undo',
  'upload',
  'visitors',
  'weather',
  'welcome',
  'where',
  'zone',
  'zone-suggest',
];
/** The world's verbs (#3695): the daemon makes their sets on the world node from its copy (`world.mjs`). */
export const WORLD_VERBS = ['weather', 'sky', 'strike', 'land', 'time', 'expand', 'furnish', 'clone', 'select', 'arrival'];
/** A world verb by its words, made on the daemon's copy (#3728): a place by its shape (a road or an area, on the
 *  open ground it knows) and `move --by`; `move --at` is G1's move. */
const SHAPES = ['--path', '--area', '--rect', '--circle'];
const isWorld = (verb, words) => WORLD_VERBS.includes(verb) || (verb === 'place' && words.some((w) => SHAPES.includes(w))) || (verb === 'move' && words.includes('--by'));
/** The verbs answered from the home's library of kinds, on this machine (#3696). */
export const LIBRARY = new Set(['catalog', 'find', 'recommend', 'taxonomy']);
const PAIR = join(dirname(fileURLToPath(import.meta.url)), '../pair/pair.mjs');

/** What to do about each refusal, by its name: the world's (G1, G2) and the command's own. */
export const FIX = {
  'edit.not-the-creator': 'this token is not the world\'s creator\'s: pair with --creator <its creator grant>',
  'edit.kind-unknown': 'use a kind describe lists under kinds (your own kinds too, once defined)',
  'kind.invalid': 'a souls-entry/1 record as content/kinds holds them: whole numbers, sections it can hold (no roles), its kind loads',
  'kind.too-large': 'a record is at most 64 KiB and its bounds_mm at most 1 km: fewer parts, a shorter text or smaller bounds',
  'kind.effects': 'a form creates only a kind describe lists (its full name) into a slot that admits it (a kind with solids only into a hand), and timers that start each other wait 50 ms or more',
  'kind.audience': 'define a kind for everyone (no audience)',
  'kind.namespace': 'name it in your own namespace (not souls: or eden:, nor one the world\'s own kinds use)',
  'kind.field-reserved': 'number your kind\'s state fields from 28 to 79: lower numbers are a thing\'s own facts (27 names the entry it borrows) and higher ones the engine\'s (marks, a tint, schedules)',
  'kind.collision':'that kind is defined already: place it by the full name describe lists',
  'kind.model': 'looks.model names an upload as "upload:1220<64 hex>", the hash upload answered',
  'kind.model-unknown': 'upload the model first (souls-god upload <file>) and name the hash it answers; a held upload cannot be used until it is released',
  'kind.in-use': 'remove the things of that kind first, and change or remove a kind whose form creates it, or do it in the same batch',
  'upload.size': 'a model is at most 3 MB and a picture 2 MB: make it smaller first',
  'upload.format': 'a GLB 2.0 model, a PNG or a JPEG',
  'upload.external-resource': 'export the GLB self-contained: every texture inside it',
  'upload.triangle-budget': 'at most 80,000 triangles: decimate it',
  'upload.off': 'this world takes no uploads',
  'kit.invalid': 'a kit is {"name", "shapes": [{"kind", "at": [x,y,z] m, ...}]}, as today\'s define-kit',
  'kit.program': 'write each shape out: repeat, radial, mirror and $params are not carried',
  'edit.child-not-admitted': 'put it in something whose kind admits it: describe shows each kind\'s admits',
  'edit.node-missing': 'that id is not there now: describe again and use an id it lists',
  'edit.name-unknown': 'a later op names an earlier place by that place\'s "name" number',
  'edit.name-twice': 'give each place in a batch its own "name" number',
  'edit.root': 'the world\'s root is never moved or removed',
  'edit.stale': 'something you changed was changed by someone else first: describe, then send again',
  'edit.too-many-operations': 'split the batch: at most 256 operations',
  'edit.too-many-nodes': 'remove less at once',
  'edit.batch': 'see the usage: souls-god.mjs with no arguments; a field\'s plain string is a name (namespace:name): give a placed thing the name Souls see it by as "title": "rack frame 1"',
  'edit.unanswered': 'the world did not answer in time (10 s, a land edit 120 s): describe to see whether it was done',
  'undo.nothing': 'there is no edit left to undo',
  'undo.nothing-to-redo': 'redo follows an undo; a new edit clears what could be redone',
  'undo.conflict': 'something the undo would change was changed since: describe, then put it back by hand',
  'edit.arrival-unknown': 'name a place of the world: an area or a line on the open ground (describe lists them), or --clear',
  'arrival.unknown-place': 'name a place of the world: an area or a line on the open ground (its id from describe, or its facts id), or --clear',
  'edit.arrival-cut-off': 'that place is walled in: Souls born there could not leave. Open a way in from the entry, or name another place',
  'edit.arrival-no-ground': 'there is no ground to stand on within 16 m of that place\'s middle: name another place',
  'undo.no-inverse': 'that edit cannot be undone (it added a field or moved a thing in motion): change it back by hand',
  'undo.not-the-build': 'undo --build undoes only while the newest edit is one of that build\'s steps: undo the others first',
  'edit.would-bury': 'a Soul stands there now: wait until it has moved, or choose another place',
  'edit.would-cut-off': 'that would shut a Soul in: leave it a way out, or wait until it has moved',
  'edit.in-use': 'a Soul is using that thing: wait until it is done',
  'relation-unknown': 'describe, and name an id it lists with an `at`',
  'edit.no-copy': 'the daemon has no copy yet: run status until connected is true',
  'edit.weather-level': 'levels are 0 to 1',
  'edit.weather-ended': 'give --minutes from 5 to 360',
  'edit.weather-partial': 'use the weather verb: it sets kind, clouds, rain, wind and end together',
  'edit.weather-no-sky': 'this world has no sky to set',
  'weather.kind-unknown': 'use clear, cloudy, rain, wind, fog or storm',
  'weather.level': '--clouds, --rain and --wind are 0 to 1',
  'weather.minutes': '--minutes is 5 to 360 world minutes',
  'weather.nothing': 'give --kind, --clouds, --rain or --wind',
  'sky.palette-unknown': 'run sky with no palette for the list',
  'sky.sun-follows-time': 'leave out --sun: the sun follows world time',
  'time.form': 'time HH:MM (24-hour, e.g. 18:30) or time live',
  'time.never-stops': 'world time never stops or changes speed; time <HH:MM> stages the hour shown',
  'strike.where': 'strike x,z in metres, or an id describe lists',
  'edit.terrain-under-soul': 'a Soul stands where the ground would change: shape the land elsewhere, or when it has moved',
  'edit.terrain-under-building': 'a building stands where the ground would change: shape the land clear of it',
  'edit.terrain-unsettled': 'a thing resting there was not moved with the ground: describe again and send the land verb again',
  'land.flag': 'see the usage: souls-god.mjs with no arguments',
  'land.too-many-things': 'shape a smaller area, or one with fewer things on it',
  'land.no-water': 'name a pond, lake or river\'s id from describe',
  'land.nothing': 'shape the land on the world\'s ground',
  'land.smooth': 'use flatten',
  'land.unavailable': 'use Node 22.18 or later, and the client a world serves (it carries the ground model) or a checkout with packages/ground and zod installed',
  'expand.nothing': 'the world already reaches that far: give a larger size',
  'expand.too-large': 'grow it less: one edit carries the whole ground',
  'furnish.where': 'furnish <id>: a building\'s or a room\'s id from describe',
  'furnish.no-rooms': 'name a building with rooms, or one of its rooms',
  'furnish.style': 'give a style the detail lists, or leave out --style',
  'furnish.nothing': 'every piece is there already or does not fit: the detail says why',
  'furnish.too-many': 'furnish one room at a time',
  'strike.off-the-ground': 'strike somewhere on the world\'s ground',
  'import.file': 'import <file>: a file export wrote, readable here',
  'import.format': 'import a souls-world/1 file, as export writes it',
  'import.unplaced': 'some nodes name a parent or support that was not placed: export the source again and import that',
  'shape.flag': 'place <kind> --path \'[[x,z],[x,z]]\' [--width m] | --area \'[[x,z],...]\' | --rect cx,cz,w,d | --circle cx,cz,r, in metres',
  'shape.no-ground': 'name the parent with --in <id>',
  'move.by': 'move <id> --by dx,dz in metres [--yaw r in radians]',
  'move.where': 'use ids describe lists',
  'move.off-the-ground': 'move it less far: the world\'s ground ends there',
  'clone.where': 'clone <a thing\'s id from describe>',
  'clone.count': '--count is 1 to 100',
  'clone.flag': 'clone <id> [--at x,z] [--count n] [--step dx,dz] in metres [--yaw r in radians]',
  'clone.off-the-ground': 'start nearer, or with fewer copies or a smaller step: the world\'s ground ends there',
  'select.flag': 'select [--kind k] [--name words] [--in id] [--area x0,z0,x1,z1] [--near x,z --radius m] [--remove | --by dx,dz]',
  'select.nothing': 'nothing matches: describe, or widen the filters',
  'select.too-many': 'select fewer: one edit changes at most 256 things',
  'export.file': 'export [file]: a file path to write',
  'edit.off-ground': 'put it somewhere on the world\'s ground: describe shows where things stand',
  'not-a-creator': 'pair with --creator <the world\'s creator grant>',
  'edit.claimed': 'that is inside a live claim: send it with --claim <that claim>, or build release <claim>',
  'edit.outside-claim': 'under a claim, edit only inside its area: build claims shows it; the world\'s own fields are the lead\'s',
  'edit.claim-unknown': 'build claims lists the live claims',
  'edit.claim-malformed': 'claims are at most 8 and never overlap: build claims shows them',
  'edit.district-malformed': 'fix the named plan field and record the plan again',
  'district.unknown': 'build district lists the plans; record one with build district <id> --file plan.json',
  'district.exists': 'a plan is recorded once: pick a new id, or claim its chapters (build district <id>)',
  'district.plot': 'build district <id> lists its plots',
  'claim.unknown': 'build claims lists the live claims',
  'edit.owner-malformed': 'own <id> <soul id|god|group:<name>|none>; access <id> private|public|none',
  'edit.tint-malformed': "recolor <id> '#rrggbb' [--part <part>]: one colour per part, at most 16",
  'edit.zone-malformed': `zone <name> <${'residential|commercial|park|farm|civic|industrial|wild'}> with an outline of 3 to 64 points`,
  'zone.unknown': 'layers lists the zones',
  'secret.off': 'secret places are off, as on soul.game today: every place is on every Soul\'s map',
  'which-creator': 'name one with --creator',
  'no-creator': 'pair first, with the line from God Mode\'s Connect your agent: souls-god.mjs pair <world url> --creator <grant>',
  'pairing-waiting': 'the world\'s owner approves the card on the world page, or opens the pairing\'s link; then run status again',
  'pairing-ended': 'pair again with the line from God Mode\'s Connect your agent',
  'hours.malformed': 'hours <id> --open HH:MM-HH:MM[@sat,sun|@mon-fri] (repeat --open), or --closed',
  'nothing-by-that-name': 'give x,z in metres, or a name or id describe lists',
  'no-browser': 'install a headless browser: npm i -g playwright && npx playwright install chromium',
  'name-ambiguous': 'give one of the ids in choices',
  'named.file': 'apply-batch <file>: a souls-named-batch/1 file readable here',
  'named.format': 'a souls-named-batch/1 file: {"schema": "souls-named-batch/1", "ops": [...]}, as worlds/patches/*/batch.json',
  'named.terrain': 'apply-batch --terrain <file>: {"tileSize": <the ground\'s field 24, mm>, "tiles": [[tx, tz, {"hex"}, {"hex"}], ...]}, as field 25 holds them',
  'unknown-op': 'your daemon is older than this command: run quit, then the command again',
  'when.no-calendar': 'the copy has no world clock yet: run status until connected is true, or give --when <world µs>us',
  'not-the-creator': 'only the world\'s creator: pair with --creator <its creator grant>',
  'welcome-too-long': 'at most 500 characters',
  'welcome-not-text': 'plain words and line breaks only',
  'token-refused': 'pair again with --creator <the world\'s creator grant>',
  'prayer.not-the-creator': 'only the world\'s creator lists and answers its prayers: pair with --creator <its creator grant>',
  'prayer.not-found': 'prayers --all lists the ids of this world\'s prayers',
};

const usage = (detail) => Object.assign(new Error(detail), { code: 'usage' });
const takeOpt = (args, name) => { const k = args.indexOf(name); if (k < 0) return undefined; const v = args[k + 1]; args.splice(k, 2); return v; };
const takeAll = (args, name) => { const out = []; for (let v; (v = takeOpt(args, name)) !== undefined;) out.push(v); return out; };
/** Metres as the world's whole mm. */
const mmOf = (m) => Math.round(Number(m) * 1000);
/** The world's mm as metres, for printing. */
export const metres = (mm) => Math.round(Number(mm)) / 1000;
/** `--at x,y,z` in metres, as the world's mm. */
const xyz = (t) => {
  const p = String(t).split(',').map(Number);
  if (p.length !== 3 || p.some((n) => !Number.isFinite(n))) throw usage(`--at x,y,z in metres, not ${t}`);
  return p.map(mmOf);
};
/** A field's value as written: an integer, true or false, else a name. */
const valueOf = (t) => (/^-?\d+$/.test(t) ? Number(t) : t === 'true' ? true : t === 'false' ? false : t);
const node = (t) => (/^\d+$/.test(String(t)) ? Number(t) : String(t));

/** R8c: `history --at <place> | --thing <id> | --soul <name> [--since <µs>] [--until <µs>]` as the daemon's request. */
export function historyOf(words) {
  const args = [...words], how = 'history --at <place> | --thing <id> | --soul <name> [--since <world µs>] [--until <world µs>]';
  const at = takeOpt(args, '--at'), thing = takeOpt(args, '--thing'), soul = takeOpt(args, '--soul'), since = takeOpt(args, '--since'), until = takeOpt(args, '--until');
  const asked = [at, thing, soul].filter((v) => v !== undefined);
  if (args.length || asked.length !== 1 || [since, until].some((t) => t !== undefined && !/^\d+$/.test(t))) throw usage(how);
  return { op: 'history', ...(at !== undefined ? { at } : thing !== undefined ? { thing } : { soul }), ...(since !== undefined ? { since: Number(since) } : {}), ...(until !== undefined ? { until: Number(until) } : {}) };
}

/** R8a: the most things one row or grid places (one batch, all or none). */
export const SPOTS_MOST = 64;
/**
 * R8a: the spots of a row (`--row n`, along x, or z with `--along z`) or a grid (`--grid CxR`: C along x, R along z),
 * `--gap` metres apart (a grid may give `--gap gx,gz`), centred on `--at` (metres in the parent), in order: the first row's
 * things west to east, then the next row south of it.
 */
export function spotsOf(at, row, grid, gap, along) {
  const how = 'place <kind> --in <id> --at x,y,z --row <n> --gap <m> [--along x|z] | --grid <C>x<R> --gap <m>[,<m>]';
  if (at === undefined || (row === undefined) === (grid === undefined) || gap === undefined) throw usage(how);
  if (along !== undefined && (row === undefined || !['x', 'z'].includes(along))) throw usage(how);
  const whole = (t) => (/^\d+$/.test(String(t)) ? Number(t) : NaN);
  const [cols, rows] = grid !== undefined ? String(grid).split('x').map(whole) : along === 'z' ? [1, whole(row)] : [whole(row), 1];
  const gaps = String(gap).split(',').map(Number), gx = mmOf(gaps[0]), gz = mmOf(gaps[1] ?? gaps[0]);
  if (!(cols >= 1 && rows >= 1) || cols * rows < 2 || gaps.length > 2 || ![gx, gz].every((g) => Number.isFinite(g) && g > 0)) throw usage(how);
  if (cols * rows > SPOTS_MOST) throw usage(`at most ${SPOTS_MOST} things in one row or grid, not ${cols * rows}`);
  const [x, y, z] = xyz(at), out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push([Math.round(x + (c - (cols - 1) / 2) * gx), y, Math.round(z + (r - (rows - 1) / 2) * gz)]);
  return out;
}

/** The batch a verb's words make. */
export function opsOf(verb, words, { related = false } = {}) {
  const args = [...words];
  if (verb === 'batch') {
    let ops;
    try { ops = JSON.parse(args.join(' ')); } catch { throw usage('batch takes a JSON list of operations'); }
    // A place's or a move's `at` is metres, as every flag is (#4700).
    const metresAt = (o) => (o && Array.isArray(o.at) ? { ...o, at: o.at.map((v) => (Number.isFinite(Number(v)) ? mmOf(v) : v)) } : o);
    return Array.isArray(ops) ? ops.map(titled).map(metresAt) : ops;
  }
  if (verb === 'place') {
    const on = takeOpt(args, '--on');
    const into = takeOpt(args, '--in') ?? on, at = takeOpt(args, '--at'), slot = takeOpt(args, '--slot');
    const row = takeOpt(args, '--row'), grid = takeOpt(args, '--grid'), gap = takeOpt(args, '--gap'), along = takeOpt(args, '--along');
    const title = takeOpt(args, '--title');
    const fields = Object.fromEntries(takeAll(args, '--field').map((f) => { const [n, v] = f.split('='); return [n, valueOf(v)]; }));
    if (!args[0] || into === undefined) throw usage('place <kind> --in <id> [--at x,y,z] [--slot n] [--title \'<name>\'] [--field n=v]');
    const one = titled({ op: 'place', kind: args[0], in: node(into), ...(slot !== undefined ? { slot: Number(slot) } : {}), ...(Object.keys(fields).length ? { fields } : {}), ...(title !== undefined ? { title } : {}) });
    if (row === undefined && grid === undefined && gap === undefined && along === undefined) return [{ ...one, name: 1, ...(at ? { at: xyz(at) } : {}) }];
    return spotsOf(at, row, grid, gap, along).map((p, i) => ({ ...one, name: i + 1, at: p }));
  }
  if (verb === 'move') {
    const at = takeOpt(args, '--at'), slot = takeOpt(args, '--slot');
    if (!args[0] || (!at && !related)) throw usage('move <id> --at x,y,z [--slot n] (or --beside, --facing)');
    if (!at) return [{ op: 'move', node: node(args[0]), ...(slot !== undefined ? { slot: Number(slot) } : {}) }];
    return [{ op: 'move', node: node(args[0]), at: xyz(at), ...(slot !== undefined ? { slot: Number(slot) } : {}) }];
  }
  if (verb === 'set') {
    if (args.length !== 3 || !/^\d+$/.test(args[1])) throw usage('set <id> <field number> <value>');
    return [{ op: 'set', node: node(args[0]), field: Number(args[1]), value: valueOf(args[2]) }];
  }
  if (verb === 'hours') {
    const closed = args.indexOf('--closed');
    if (closed >= 0) args.splice(closed, 1);
    const open = takeAll(args, '--open');
    if (args.length !== 1 || (closed >= 0) === (open.length > 0)) throw usage('hours <id> --open HH:MM-HH:MM[@days] ... | --closed');
    return [{ op: 'set', node: node(args[0]), field: F_HOURS, value: hoursRows(open) }];
  }
  if (verb === 'about') return aboutOps(args);
  if (verb === 'remove') {
    if (!args[0]) throw usage('remove <id>');
    return [{ op: 'remove', node: node(args[0]) }];
  }
  if (verb === 'define' || verb === 'define-kit') return [{ op: 'define', name: 1, entry: definitionOf(verb, args).entry }];
  throw usage(`one of ${VERBS.join(', ')}`);
}

/** #3697: the record a define or define-kit sends, read from its file, and what a kit did not carry. */
export function definitionOf(verb, words) {
  const args = [...words];
  const ns = takeOpt(args, '--ns');
  if (args.length !== 1) throw usage(verb === 'define' ? 'define <record.json>' : 'define-kit <kit.json> [--ns <namespace>]');
  let text;
  try { text = readFileSync(args[0], 'utf8'); } catch (e) { throw Object.assign(new Error(`${args[0]}: ${e.code ?? e.message}`), { code: 'file-unreadable' }); }
  let json;
  try { json = JSON.parse(text); } catch { throw Object.assign(new Error(`${args[0]} is not JSON`), { code: verb === 'define' ? 'kind.invalid' : 'kit.invalid' }); }
  if (verb === 'define') return { entry: text };
  const { entry, not_carried } = kitEntry(json, ns ? { ns } : {});
  return { entry: JSON.stringify(entry), ...(not_carried.length ? { not_carried } : {}) };
}

/** A calendar entry's kind and its fields (start, end in world µs; words): `content/kinds/calendar/entry.json`. */
export const ENTRY = { kind: 'eden:calendar_entry', start: 28, end: 29, words: 30 };
const MINUTE_US = 60_000_000;

/** The batch that posts one event: a calendar entry placed in `into`, from `start` for `minutes`, with its words. */
export function eventOps({ into, words, start, minutes = 60, at }) {
  return [{ op: 'place', name: 1, kind: ENTRY.kind, in: node(into), ...(at ? { at } : {}),
    fields: { [ENTRY.start]: start, [ENTRY.end]: start + minutes * MINUTE_US, [ENTRY.words]: { words } } }];
}

/** `event`'s words: where, what, when (HH:MM, or world µs as `<n>us`), how long and the spot. */
export function eventOf(words) {
  const args = [...words];
  const when = takeOpt(args, '--when'), long = takeOpt(args, '--for'), at = takeOpt(args, '--at');
  const how = "event <room or ground id> '<words>' --when HH:MM|<world µs>us [--for <minutes>] [--at x,y,z]";
  if (args.length !== 2 || !args[1].trim() || !when) throw usage(how);
  const minutes = long === undefined ? 60 : Number(long);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60) throw usage('--for is whole minutes, 1 to a week');
  const us = /^(\d+)us$/.exec(when), hm = /^([01]\d|2[0-3]):[0-5]\d$/.test(when);
  if (!us && !hm) throw usage(how);
  return { into: args[0], words: args[1].trim(), ...(us ? { start: Number(us[1]) } : { when }), minutes, ...(at ? { at: xyz(at) } : {}) };
}

/** A place's title and aliases (`brief/copy.mjs` F_TITLE, F_ALIASES): the words, or false to clear. */
export const ABOUT = { title: 4, aliases: 101 };
const ALIASES_MOST = 64;

/** A place op's `title`, the name Souls see the thing by ("rack frame 1": one line of words, spaces and all), as its
 *  field 4 in words, as `about --title` sets it after. A field's plain string is a name (`namespace:name`), not words. */
export function titled(op) {
  if (!op || typeof op !== 'object' || op.op !== 'place' || op.title === undefined) return op;
  const { title, ...rest } = op;
  if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title)) throw usage('a title is one line of words');
  return { ...rest, fields: { ...(rest.fields ?? {}), [ABOUT.title]: { words: title.trim() } } };
}

/** `about`'s batch: today's `about <ref> --set JSON | --clear`, or its `--title` and `--alias` parts. */
export function aboutOps(words) {
  const args = [...words];
  const how = 'about <id> --title \'<t>\' [--alias \'<a>\' ...] | --set \'{"title":"..","aliases":[".."]}\' | --clear';
  const clear = args.indexOf('--clear');
  if (clear >= 0) args.splice(clear, 1);
  const set = takeOpt(args, '--set'), title = takeOpt(args, '--title'), alias = takeAll(args, '--alias');
  if (args.length !== 1 || [clear >= 0, set !== undefined, title !== undefined || alias.length > 0].filter(Boolean).length !== 1) throw usage(how);
  const id = node(args[0]);
  const setTo = (field, value) => ({ op: 'set', node: id, field, value });
  if (clear >= 0) return [setTo(ABOUT.title, false), setTo(ABOUT.aliases, false)];
  let about = { title, aliases: alias.length ? alias : undefined };
  if (set !== undefined) {
    try { about = JSON.parse(set); } catch { throw usage('--set takes a JSON object'); }
    if (!about || typeof about !== 'object' || Array.isArray(about) || Object.keys(about).some((k) => k !== 'title' && k !== 'aliases')) throw usage('--set takes {"title": "..", "aliases": [".."]}');
  }
  const line = (t) => (typeof t === 'string' && t.trim() && !/[\r\n]/.test(t) ? t.trim() : null);
  const ops = [];
  if (about.title !== undefined) {
    if (!line(about.title)) throw usage('a title is one line of words');
    ops.push(setTo(ABOUT.title, { words: line(about.title) }));
  }
  if (about.aliases !== undefined) {
    const list = Array.isArray(about.aliases) ? about.aliases.map(line) : [null];
    if (list.some((a) => a === null) || list.length > ALIASES_MOST) throw usage(`aliases are 1 to ${ALIASES_MOST} lines of words`);
    ops.push(setTo(ABOUT.aliases, list.length ? { words: [...new Set(list)].join('\n') } : false));
  }
  if (!ops.length) throw usage(how);
  return ops;
}

/** A world verb's words as the daemon reads them: `{ verb, ...flags }`, numbers as given. */
export function worldVerbOf(verb, words) {
  const args = [...words], out = { verb };
  const flags = {
    weather: ['kind', 'clouds', 'rain', 'wind', 'minutes'], sky: ['palette', 'sun'], strike: ['at'], time: ['speed'],
    land: ['at', 'radius', 'amount', 'level', 'height', 'peak', 'path', 'area', 'rect', 'circle', 'edge', 'step', 'depth', 'width', 'side', 'face', 'steps', 'by', 'toward', 'metres', 'bounds'],
    expand: [], furnish: ['style'],
    place: ['path', 'width', 'area', 'rect', 'circle', 'in'],
    move: ['by', 'yaw'],
    clone: ['at', 'count', 'step', 'yaw'],
    select: ['kind', 'name', 'in', 'area', 'near', 'radius', 'by', 'yaw'],
    arrival: [],
  }[verb];
  if (verb === 'select') { const k = args.indexOf('--remove'); if (k >= 0) { args.splice(k, 1); out.remove = true; } }
  for (const f of flags) { const v = takeOpt(args, `--${f}`); if (v !== undefined) out[f] = v; }
  if (verb === 'strike' && out.at === undefined && args[0] !== undefined) out.at = args.shift();
  if (verb === 'time') {
    for (const f of ['--pause', '--resume']) { const k = args.indexOf(f); if (k >= 0) { args.splice(k, 1); out.pause = true; } }
    if (args[0] !== undefined) out.hour = args.shift();
  }
  if (verb === 'arrival') {
    const k = args.indexOf('--clear');
    if (k >= 0) { args.splice(k, 1); out.clear = true; } else if (args.length === 1) out.place = args.shift();
    if (args.length || (!out.clear && out.place === undefined)) throw usage('arrival <place id> | --clear');
  }
  if (verb === 'furnish') {
    if (args[0] === undefined) throw usage('furnish <building or room id> [--style s]');
    out.ref = args.shift();
  }
  if (verb === 'expand') {
    if (args[0] === undefined) throw usage('expand <metres>: the side of the centred square the world grows to');
    out.extent = args.shift();
  }
  if (verb === 'place') {
    const fields = Object.fromEntries(takeAll(args, '--field').map((f) => { const [n, v] = f.split('='); return [n, valueOf(v)]; }));
    if (Object.keys(fields).length) out.fields = fields;
    if (args.length !== 1) throw usage('place <kind> --path \'[[x,z],...]\' [--width m] | --area \'[[x,z],...]\' | --rect cx,cz,w,d | --circle cx,cz,r [--in <id>] [--field n=v]');
    out.kind = args.shift();
  }
  if (verb === 'move') {
    if (!args.length) throw usage('move <id> [<id> ...] --by dx,dz [--yaw r]');
    out.refs = args.splice(0);
  }
  if (verb === 'clone') {
    if (args[0] === undefined) throw usage('clone <id> [--at x,z] [--count n] [--step dx,dz] [--yaw r]');
    out.ref = args.shift();
  }
  if (verb === 'land') {
    if (!args[0]) throw usage('land <raise|lower|flatten|knoll|hill|mountain|plateau|terrace|valley|ditch|cliff|pond|lake|water> [flags]');
    out.land = args.shift();
    if (out.land === 'water' && args[0] !== undefined) out.ref = args.shift();
    else if (out.at === undefined && args[0] !== undefined && /,/.test(args[0])) out.at = args.shift();
  }
  if (args.length) throw usage(`${verb}: unknown words ${args.join(' ')}`);
  return out;
}

/** The daemon request the arguments make, and the creator named. */
export function requestOf(argv) {
  const args = [...argv];
  const creator = takeOpt(args, '--creator');
  const claim = takeOpt(args, '--claim');
  const under = claim === undefined ? {} : { claim: claimId(claim) };
  const [verb = 'status', ...rest] = args;
  if (!VERBS.includes(verb)) throw Object.assign(new Error(`one of ${VERBS.join(', ')}`), { code: 'unknown-command' });
  if (verb === 'pair') return { pair: rest[0], creator };
  if (LIBRARY.has(verb)) return { library: verb, args: rest, creator };
  // A creator's look (#3699 reads; today's `look --at <ref>`): G10's shot, checked here so a usage is answered at once.
  if (verb === 'look') {
    const how = 'look <place|thing|soul|id> [--eyes] [--out f.png|.jpg] [--size WxH] [--page <url>]';
    if (rest[0] === 'picture') throw usage(how);
    try { parseShoot(rest); } catch (e) { throw usage(e.message.startsWith('shoot <') || /needs a value|unknown/.test(e.message) ? how : e.message); }
    return { look: rest, creator };
  }
  if (verb === 'where' || verb === 'clear' || verb === 'free') { parseSpace(verb, rest); return { space: verb, args: rest, creator }; }
  if (verb === 'event') return { event: eventOf(rest), creator };
  if (verb === 'welcome') {
    if (rest.length > 1) throw usage("welcome '<words>': quote the words as one argument");
    return { directory: '/v1/worlds/welcome', body: { welcome: rest[0] ?? '' }, creator };
  }
  if (verb === 'pending') return { req: { op: 'pending', list: true }, creator };
  if (verb === 'ack') {
    const close = takeOpt(rest, '--close');
    if (!rest[0] || rest.length < 2 || (close !== undefined && !['done', 'failed'].includes(close))) throw usage('ack <message id> "<reply>" [--close done|failed]');
    return { req: { op: 'ack', id: rest[0], reply: rest.slice(1).join(' '), ...(close !== undefined ? { close } : {}) }, creator };
  }
  if (verb === 'listen') {
    const follow = rest.includes('--follow'), [secs = '30', ...more] = rest.filter((w) => w !== '--follow');
    if (more.length || !/^\d+$/.test(secs)) throw usage('listen [<seconds>] [--follow]');
    return { listen: { seconds: Number(secs), follow }, creator };
  }
  if (verb === 'visitors') return { directory: '/v1/worlds/visitors', body: {}, creator };
  // G11 (#3335; #5006 row 15): the prayers to this world's creator and an answer, through the daemon's socket
  if (verb === 'prayers') {
    if (rest.some((w) => w !== '--all')) throw usage('prayers [--all]');
    return { req: { op: 'prayers', all: rest.includes('--all') }, creator };
  }
  if (verb === 'answer') {
    if (!rest[0] || rest.length < 2) throw usage('answer <prayer id> "<words>"');
    return { req: { op: 'answer', id: rest[0], words: rest.slice(1).join(' ') }, creator };
  }
  // R8b: one thing, read from the copy (thing.mjs)
  if (verb === 'describe' && rest.length) { if (rest.length !== 1) throw usage('describe [<id>]'); return { thing: rest[0], creator }; }
  // R8d: the world at a glance, read from the copy (map.mjs)
  if (verb === 'map') { if (rest.length) throw usage('map'); return { map: true, creator }; }
  // `quit` ends the daemon, as souls.mjs's `quit` does a Soul's (#4700); `stop` is kept, a creator having no act to stop
  if (verb === 'quit') return { req: { op: 'stop' }, creator };
  if (verb === 'status' || verb === 'stop' || verb === 'describe' || verb === 'redo') return { req: { op: verb }, creator };
  if (verb === 'apply-batch') {
    const t = rest.indexOf('--terrain'), terrain = t >= 0 ? rest[t + 1] : undefined;
    const files = rest.filter((w, i) => w !== '--dry-run' && (t < 0 || (i !== t && i !== t + 1)));
    if (files.length !== 1 || (t >= 0 && !terrain)) throw usage('apply-batch <souls-named-batch/1 file> [--dry-run] [--terrain <file>]');
    return { named: { file: absolute(files[0]), dry: rest.includes('--dry-run'), ...(terrain ? { terrain: absolute(terrain) } : {}) }, creator };
  }
  if (verb === 'export' || verb === 'import') {
    if (rest.length > 1 || (verb === 'import' && !rest[0])) throw usage(`${verb} ${verb === 'import' ? '<file>' : '[file]'}`);
    return { req: { op: verb, file: absolute(rest[0] ?? 'world.souls.json') }, creator };
  }
  if (verb === 'upload') {
    if (rest.length !== 1 || !/\.(glb|png|jpe?g)$/i.test(rest[0])) throw usage('upload <file.glb|png|jpg>');
    return { req: { op: 'upload', path: absolute(rest[0]) }, creator };
  }
  // R8c: what happened at a place, to a thing or a Soul, from the world's public history (the daemon's R16 answer)
  if (verb === 'history') return { req: historyOf(rest), creator };
  if (verb === 'trace') {
    const n = rest[0] === undefined ? 20 : Number(rest[0]);
    if (!Number.isInteger(n) || n < 1 || n > TRACE_MOST || rest.length > 1) throw usage(`trace [n]: 1 to ${TRACE_MOST}`);
    return { req: { op: 'trace', n }, creator };
  }
  if (verb === 'build') return { build: buildOf(rest), creator };
  if (LAYER_VERBS.includes(verb)) return { layer: layerOf(verb, rest), creator };
  if (verb === 'recolor') return { recolor: recolorOf(rest), creator };
  if (verb === 'undo') { const build = takeOpt(rest, '--build'); return { req: { op: 'undo', ...(build !== undefined ? { build } : {}) }, creator }; }
  if (verb === 'check' && isWorld(rest[0], rest.slice(1))) return { req: { op: 'check', world: worldVerbOf(rest[0], rest.slice(1)), ...under }, creator };
  if (isWorld(verb, rest)) return { req: { op: 'edit', world: worldVerbOf(verb, rest), ...under }, creator };
  if (verb === 'define-kit') {
    const { not_carried } = definitionOf(verb, rest);
    return { req: { op: 'edit', ops: opsOf(verb, rest), ...under }, creator, ...(not_carried ? { say: { not_carried } } : {}) };
  }
  const build = takeOpt(rest, '--build'), step = takeOpt(rest, '--step');
  if ((build === undefined) !== (step === undefined)) throw usage('a build\'s step names both: --build <name> --step <name>');
  const named = build !== undefined ? { build, step } : {};
  const [v, words] = verb === 'check' ? [rest[0], rest.slice(1)] : [verb, rest];
  const relation = v === 'place' || v === 'move' ? relationOf(words) : null;
  let plain = relation ? withoutRelation(words) : words;
  // Beside another, in the same parent: the parent is filled in from describe.
  if (v === 'place' && relation?.beside !== undefined && !plain.includes('--in')) plain = [...plain, '--in', relation.beside];
  const ops = opsOf(v, plain, { related: !!relation });
  const req = verb === 'check' ? { op: 'check', ops, ...under } : { op: 'edit', ops, ...named, ...under };
  return { req, creator, ...(relation ? { relation } : {}) };
}

const RELATIONS = ['--beside', '--dir', '--dist', '--facing', '--on'];
/** A place's or a move's relation to another (#3694): `{ beside, dir, dist, facing, on }`, or null. */
export function relationOf(words) {
  const args = [...words], r = {};
  for (const k of RELATIONS) { const v = takeOpt(args, k); if (v !== undefined) r[k.slice(2)] = v; }
  return r.beside !== undefined || r.facing !== undefined || r.on !== undefined ? r : null;
}
const withoutRelation = (words) => { const args = [...words]; for (const k of ['--beside', '--dir', '--dist', '--facing']) takeOpt(args, k); return args; };

const COMPASS = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] };
/**
 * The batch with its relation resolved on `world` (describe's answer: each node's parent and `at`, mm in it): beside
 * puts the thing `dist` metres (default 1) from the other toward `dir` (default e; north is −z), in the same parent;
 * on puts it in the other, in its first slot a thing may take and nothing holds; facing turns it about +y so its +z
 * faces the other, or the compass point. A relation that names what is not there is refused `relation-unknown`.
 */
export function resolve(req, relation, world) {
  const nodes = new Map(world.nodes.map((n) => [n.id, n]));
  const known = (id) => { const n = nodes.get(String(id)); if (!n) throw Object.assign(new Error(`no ${id} here`), { code: 'relation-unknown' }); return n; };
  const ops = req.ops.map((o) => ({ ...o }));
  const op = ops[0];
  const self = op.op === 'move' ? known(op.node) : null;
  if (relation.beside !== undefined) {
    const other = known(relation.beside);
    if (!other.at) throw Object.assign(new Error(`${other.id} has no place to stand beside`), { code: 'relation-unknown' });
    const [dx, dz] = COMPASS[relation.dir ?? 'e'] ?? (() => { throw usage('--dir is n, ne, e, se, s, sw, w or nw'); })();
    const dist = mmOf(relation.dist ?? 1), k = Math.hypot(dx, dz);
    if (!Number.isFinite(dist)) throw usage('--dist is metres');
    op.at = [Math.round(other.at[0] + (dx / k) * dist), other.at[1], Math.round(other.at[2] + (dz / k) * dist)];
    if (op.op === 'place') op.in = /^\d+$/.test(String(other.parent)) ? Number(other.parent) : other.parent;
  }
  if (relation.on !== undefined && op.op === 'place') {
    const other = known(relation.on);
    const kind = Object.entries(world.kinds ?? {}).find(([name]) => name.split('@')[0] === other.kind || name === other.kind)?.[1];
    const held = new Set(world.nodes.filter((n) => n.parent === other.id && n.slot !== undefined).map((n) => n.slot));
    const free = Object.entries(kind?.slots ?? {}).find(([n, s]) => s?.admits !== 'body' && !s?.posture && !held.has(Number(n)));
    if (free && op.slot === undefined) op.slot = Number(free[0]);
    op.at ??= [0, 0, 0];
  }
  if (relation.facing !== undefined) {
    const here = op.at ?? self?.at;
    const point = COMPASS[relation.facing];
    let d;
    if (point) d = point;
    else {
      const other = known(relation.facing);
      if (!other.at || !here) throw Object.assign(new Error(`cannot face ${relation.facing} from here`), { code: 'relation-unknown' });
      d = [other.at[0] - here[0], other.at[2] - here[2]];
    }
    op.yaw = ((Math.round((Math.atan2(d[0], d[1]) * 180_000) / Math.PI) % 360_000) + 360_000) % 360_000;
    // R8a: a row or grid all face the compass point
    if (point) for (const o of ops) if (o.op === 'place') o.yaw = op.yaw;
    if (op.op === 'move') op.at ??= self.at;
  }
  if (op.op === 'move' && !op.at) throw usage('move <id> needs --at, --beside or --facing');
  return { ...req, ops };
}

// ---------------------------------------------------------------- #3701: district plans and build claims
// Both are fields of the zone's root (replica `edit::claims`): plans in 140, live claims in 141, whole mm on the ground
// and millidegrees. Every text there is a `namespace:name` name, so ids are kept with a prefix (`d:`, `p:`, `c:`) and
// shown without it. Recording a plan or a claim is an ordinary edit of that field, so undo takes it back.
export const F_DISTRICTS = 140, F_CLAIMS = 141;
const SLUG = /^[a-z][a-z0-9_-]*$/;
/** A name an effect may carry from what a creator writes: lowercase, other characters as `-`, a letter first. */
export function slug(t) {
  let s = String(t ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(s)) s = `x${s}`;
  return s.slice(0, 56);
}
const named = (ns, t) => `${ns}:${slug(t)}`;
const bare = (t) => String(t).replace(/^[a-z][a-z0-9-]*:/, '');
/** A claim id as written (`c:1a2b3c4d` or `1a2b3c4d`) as the world holds it. */
export const claimId = (t) => (String(t).startsWith('c:') ? String(t) : `c:${String(t)}`);
const mdegOf = (rad) => Math.round(((Number(rad ?? 0) * 180) / Math.PI) * 1000);

/** The build request the words make: `{ act: 'districts' | 'district' | 'record' | 'claim' | 'claims' | 'release', ... }`. */
export function buildOf(words) {
  const args = [...words];
  const file = takeOpt(args, '--file'), area = takeOpt(args, '--area'), district = takeOpt(args, '--district'), plots = takeOpt(args, '--plots');
  const ttl = takeOpt(args, '--ttl'), to = takeOpt(args, '--to');
  const flag = (f) => { const k = args.indexOf(f); if (k >= 0) args.splice(k, 1); return k >= 0; };
  const helper = flag('--helper'), dry = flag('--dry');
  const [what, id] = args;
  // R8e: a build session, kept in the home (session.mjs)
  const brief = takeOpt(args, '--brief'), steps = takeOpt(args, '--steps');
  if (what === 'start') {
    const list = String(steps ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!id || !list.length || args.length > 2) throw usage("build start <name> --steps a,b,c [--brief '<words>']");
    return { act: 'start', name: id, steps: list, ...(brief !== undefined ? { brief } : {}) };
  }
  if (what === 'step') { if (!id || args.length > 3) throw usage('build step <step> [<build>]'); return { act: 'step', step: id, ...(args[2] ? { name: args[2] } : {}) }; }
  if (what === 'show' || what === 'done') { if (args.length > 2) throw usage(`build ${what} [<build>]`); return { act: what, ...(id ? { name: id } : {}) }; }
  if (what === 'rewind') {
    if (!id || to === undefined) throw usage('build rewind <build> --to <step> [--dry]');
    return { act: 'rewind', build: id, to, ...(dry ? { dry } : {}) };
  }
  if (ttl !== undefined && (!helper || !/^\d+$/.test(ttl) || Number(ttl) < 1 || Number(ttl) > 720)) throw usage('build claim --ttl <minutes> (1..720) needs --helper');
  const helped = helper ? { helper: true, ...(ttl !== undefined ? { ttl: Number(ttl) } : {}) } : {};
  if (what === 'district') {
    if (id === undefined) return { act: 'districts' };
    return file === undefined ? { act: 'district', id } : { act: 'record', id, file };
  }
  if (what === 'claims') return { act: 'claims' };
  if (what === 'release') { if (!id) throw usage('build release <claim>'); return { act: 'release', claim: claimId(id) }; }
  if (what === 'claim') {
    if (!id || (area === undefined) === (district === undefined)) throw usage('build claim <part> --area x0,z0,x1,z1 | --district <id> [--plots a,b]');
    if (area !== undefined) {
      const a = area.split(',').map(Number);
      if (a.length !== 4 || a.some((n) => !Number.isFinite(n)) || a[0] >= a[2] || a[1] >= a[3]) throw usage(`--area x0,z0,x1,z1 in metres, x0 < x1 and z0 < z1, not ${area}`);
      return { act: 'claim', part: id, area: a.map(mmOf), ...helped };
    }
    return { act: 'claim', part: id, district, ...(plots ? { plots: plots.split(',') } : {}), ...helped };
  }
  throw usage('build district [<id>] [--file plan.json] | build claim <part> ... [--helper] | build claims | build release <claim> | build rewind <build> --to <step>');
}

/** Today's plan file (metres, radians: `apps/server/src/god/districts.ts`) as the world's plan row. */
export function planRow(id, plan) {
  if (!plan || !Array.isArray(plan.plots) || plan.plots.length === 0) throw Object.assign(new Error('a plan has plots: [{id, at: [x, z], size: [w, d]}]'), { code: 'district.plan' });
  const plot = (p) => {
    if (!Array.isArray(p.at) || !Array.isArray(p.size)) throw Object.assign(new Error(`plot ${p.id}: at [x, z] and size [w, d] in metres`), { code: 'district.plan' });
    return [named('p', p.id), mmOf(p.at[0]), mmOf(p.at[1]), mmOf(p.size[0]), mmOf(p.size[1]), mdegOf(p.yaw), ...(p.use ? [named('use', p.use)] : [])];
  };
  const road = (r) => [named('road', r.id), mmOf(r.width), (r.path ?? []).flatMap(([x, z]) => [mmOf(x), mmOf(z)])];
  return [named('d', id), named('title', plan.title ?? id), plan.plots.map(plot), (plan.roads ?? []).map(road), (plan.chapters ?? []).map((c) => c.map((p) => named('p', p)))];
}

const rowsIn = (v) => (Array.isArray(v) ? v : []);
/** The live claims a root field holds, as a creator reads them. */
export const claimsIn = (v) => rowsIn(v).map(([id, part, x0, z0, x1, z1]) => ({ id, part: bare(part), area: [x0, z0, x1, z1].map(Number) }));
/** A plot's corners on the ground, mm. */
function corners([, x, z, w, d, yaw]) {
  const a = (Number(yaw) / 1000) * (Math.PI / 180), c = Math.cos(a), s = Math.sin(a);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => { const u = (i * w) / 2, v = (j * d) / 2; return [x + u * c + v * s, z - u * s + v * c]; });
}
/** The rectangle on the ground that holds the plots, whole mm. */
export function areaOf(plots) {
  const pts = plots.flatMap(corners), xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  // A turn's sine and cosine are not exact: a hair past a whole mm is that mm.
  const lo = (v) => Math.floor(v + 1e-6), hi = (v) => Math.ceil(v - 1e-6);
  return [lo(Math.min(...xs)), lo(Math.min(...zs)), hi(Math.max(...xs)), hi(Math.max(...zs))];
}
const inside = ([x0, z0, x1, z1], x, z) => x >= x0 && x < x1 && z >= z0 && z < z1;
/** One plan as a creator reads it: plots with their status (claimed by a live claim over its centre, else planned) and
 * the next chapter to claim. */
export function districtView(row, claims) {
  const [id, title, plots, roads, chapters] = row;
  const claimOf = (p) => claims.find((c) => inside(c.area, Number(p[1]), Number(p[2])));
  const view = plots.map((p) => ({ id: bare(p[0]), at: [metres(p[1]), metres(p[2])], size: [metres(p[3]), metres(p[4])], yaw: p[5], ...(p[6] ? { use: bare(p[6]) } : {}), status: claimOf(p) ? 'claimed' : 'planned', ...(claimOf(p) ? { claim: claimOf(p).id } : {}) }));
  const groups = chapters.length ? chapters.map((c) => c.map(bare)) : view.map((p) => [p.id]);
  const open = groups.find((g) => g.every((p) => view.find((v) => v.id === p)?.status === 'planned'));
  return {
    id: bare(id), title: bare(title), plots: view, roads: roads.map(([r, w, path]) => ({ id: bare(r), width: metres(w), path: rowsIn(path).reduce((o, n, i) => (i % 2 ? (o.at(-1).push(metres(n)), o) : [...o, [metres(n)]]), []) })),
    counts: { plots: view.length, claimed: view.filter((p) => p.status === 'claimed').length, planned: view.filter((p) => p.status === 'planned').length },
    next: open ? { plots: open, then: `build claim <part> --district ${bare(id)} --plots ${open.join(',')}` } : null,
  };
}

const fail = (code, detail) => ({ ok: false, code, detail });
/** Runs a build request through the daemon's `fields` and `edit`; the answer to print. `mint(minutes)` asks the
 * gateway for a helper (#3727): `{ helper, token, home }`, the helper's home written with its token. */
export async function runBuild(b, ask, mint) {
  if (b.act === 'rewind') return ask({ op: 'undo', build: b.build, to: b.to, ...(b.dry ? { dry: true } : {}) });
  const root = await ask({ op: 'fields' });
  if (root.ok === false) return root;
  const plans = rowsIn(root.fields[F_DISTRICTS]), claims = claimsIn(root.fields[F_CLAIMS]);
  const set = (field, value) => ask({ op: 'edit', ops: [{ op: 'set', node: root.id, field, value }] });
  const find = (id) => plans.find((r) => r[0] === named('d', id));
  if (b.act === 'districts') return { ok: true, districts: plans.map((r) => { const v = districtView(r, claims); return { id: v.id, title: v.title, counts: v.counts }; }) };
  if (b.act === 'claims') return { ok: true, claims: claims.map((c) => ({ ...c, area: c.area.map(metres) })) };
  if (b.act === 'district') { const r = find(b.id); return r ? { ok: true, district: districtView(r, claims) } : fail('district.unknown', `no plan ${b.id}`); }
  if (b.act === 'record') {
    if (find(b.id)) return fail('district.exists', `plan ${b.id} is recorded`);
    const row = planRow(b.id, JSON.parse(readFileSync(b.file, 'utf8')));
    const out = await set(F_DISTRICTS, [...plans, row]);
    return out.ok === false ? out : { ...out, district: districtView(row, claims) };
  }
  if (b.act === 'release') {
    if (!claims.some((c) => c.id === b.claim)) return fail('claim.unknown', `no live claim ${b.claim}`);
    return set(F_CLAIMS, rowsIn(root.fields[F_CLAIMS]).filter((r) => r[0] !== b.claim));
  }
  let area = b.area;
  if (b.district !== undefined) {
    const r = find(b.district);
    if (!r) return fail('district.unknown', `no plan ${b.district}`);
    const v = districtView(r, claims), ids = b.plots ?? v.next?.plots;
    if (!ids) return fail('district.plot', `every plot of ${b.district} is claimed`);
    const rows = ids.map((p) => r[2].find((x) => x[0] === named('p', p)));
    if (rows.some((x) => !x)) return fail('district.plot', `${b.district} has no plot ${ids[rows.findIndex((x) => !x)]}`);
    area = areaOf(rows);
  }
  const id = `c:k${randomBytes(4).toString('hex')}`; // a name part starts with a letter
  // A helper (#3727): minted first, so the claim names it; its token goes to its own home, never to this output.
  const h = b.helper ? await mint(b.ttl, id) : null;
  const out = await set(F_CLAIMS, [...rowsIn(root.fields[F_CLAIMS]), [id, named('part', b.part), ...area, ...(h ? [`helper:h${h.helper}`] : [])]]);
  if (out.ok === false) return out;
  return {
    ...out, claim: { id, part: slug(b.part), area: area.map(metres), ...(h ? { helper: h.helper } : {}) },
    then: h ? `give the helper SOULS_HOME=${h.home}: its souls-god sends every edit under ${id}, inside it only, for ${h.minutes} minutes` : `send its edits with --claim ${id}`,
    ...(h ? { helper: { home: h.home, expires_in: h.expires_in } } : {}),
  };
}

/**
 * Asks the world's directory (#3702) as the creator: the seat's world and token from the home, sent as a Bearer to
 * the directory the pairing kept. The token is never printed.
 */
async function askDirectory(home, creator, path, body) {
  const seat = readSeat(home, creator);
  let url;
  try { url = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).worlds?.[seat.world]?.url; } catch { /* below */ }
  if (typeof url !== 'string') throw Object.assign(new Error(`no directory kept for ${seat.world}; pair again`), { code: 'no-directory' });
  const r = await fetch(new URL(path, url), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${seat.token}` },
    body: JSON.stringify({ world: seat.world, ...body }), signal: AbortSignal.timeout(15_000),
  });
  const got = await r.json().catch(() => ({}));
  return got.refused ? { ok: false, code: got.refused } : { ok: true, ...got };
}

/** An answer with its fix, when it is a refusal the table knows. */
export const withFix = (out) => (out?.ok === false && FIX[out.code] ? { ...out, fix: FIX[out.code] } : out);

/**
 * A helper for a claim (#3727): the gateway mints a creator-scope token that lapses after `minutes`, and it is kept in
 * a home of its own beside this one (`helpers/<claim>/`, as `.souls` is): its config, the world's kinds, the token and
 * the claim it builds under. The token is printed nowhere.
 */
async function mintHelper(home, creator, minutes, claim) {
  const seat = readSeat(home, creator);
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  const world = config.worlds?.[seat.world];
  if (typeof world?.gateway !== 'string') throw Object.assign(new Error(`no gateway kept for ${seat.world}; pair again`), { code: 'no-gateway' });
  const url = new URL('/v2/creator-helper', world.gateway.replace(/^ws/, 'http'));
  if (minutes !== undefined) url.searchParams.set('minutes', String(minutes));
  const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${seat.token}` }, signal: AbortSignal.timeout(15_000) });
  const got = await r.json().catch(() => ({}));
  if (!r.ok || typeof got.token !== 'string') throw Object.assign(new Error(`the gateway refused a helper (${r.status})`), { code: got.refused ?? 'helper-refused' });
  const at = join(home, 'helpers', bare(claim));
  mkdirSync(join(at, 'kinds'), { recursive: true, mode: 0o700 });
  writeFileSync(join(at, 'config.json'), JSON.stringify({ worlds: { [seat.world]: world } }));
  writeFileSync(join(at, 'credentials.json'), JSON.stringify({ souls: { [`c_${got.helper}`]: { [seat.world]: { token: got.token } } } }), { mode: 0o600 });
  writeFileSync(join(at, 'helper.json'), JSON.stringify({ claim, creator, expires_in: got.expires_in }));
  try { writeFileSync(join(at, 'kinds', `${seat.world}.kinds`), readFileSync(join(home, 'kinds', `${seat.world}.kinds`))); } catch { /* no kinds kept */ }
  return { helper: got.helper, home: at, expires_in: got.expires_in, minutes: Math.round(got.expires_in / 60) };
}

/** The claim a helper's home builds under (#3727), if this is one. */
function helperClaim(home) {
  try { return JSON.parse(readFileSync(join(home, 'helper.json'), 'utf8')).claim; } catch { return undefined; }
}

/** W2's pairing for a creator, detached as souls.mjs's is: its first line (the link and code, or the refusal). */
async function pairing(home, url, grant, { within = 15_000 } = {}) {
  if (!/^creator-[0-9a-f]{32}-\d+$/.test(grant ?? '')) throw Object.assign(new Error('pair <world url> --creator creator-<32 hex>-<n>'), { code: 'not-a-creator' });
  const { directory, world, gateway } = worldOf(url);
  makeHome(home);
  const log = join(home, 'pairing.log');
  writeFileSync(log, '', { mode: 0o600 });
  const out = openSync(log, 'a');
  const child = spawn(process.execPath, [PAIR, '--directory', directory, '--world', world, '--gateway', gateway, '--label', 'souls-god.mjs', '--creator', grant], {
    detached: true, stdio: ['ignore', out, out], env: { PATH: process.env.PATH ?? '', SOULS_HOME: home },
  });
  writeFileSync(join(home, 'pairing.pid'), String(child.pid), { mode: 0o600 });
  child.unref();
  for (const until = Date.now() + within; Date.now() < until;) {
    const first = readFileSync(log, 'utf8').split('\n').find((l) => l.startsWith('{'));
    if (first) return { ...JSON.parse(first), then: 'describe, once the world\'s owner has approved' };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Object.assign(new Error(`no answer from ${directory}`), { code: 'directory-not-answering' });
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/**
 * The pairing this home is still waiting on, from the detached pair.mjs's lines (`pairing.log`) and its process
 * (`pairing.pid`): `{state: 'waiting', code}` while it has asked and has no answer, `{state: 'ended', ...}` when it
 * was refused or stopped with no answer, or null (no pairing, or it is done).
 */
export function pairingOf(home, alive = isAlive) {
  let lines;
  try { lines = readFileSync(join(home, 'pairing.log'), 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)); } catch { return null; }
  const last = lines.at(-1);
  if (!last || last.soul) return null;
  if (last.ok === false) return { state: 'ended', refused: last.code };
  let pid;
  try { pid = Number(readFileSync(join(home, 'pairing.pid'), 'utf8')); } catch { /* an older pairing: taken as running */ }
  return pid && !alive(pid) ? { state: 'ended' } : { state: 'waiting', code: last.code };
}

/**
 * #5024 finding 1: the home holds no creator until the detached pairing's next poll collects the token (the directory
 * answers polls every 5 s), so a `status` sent the moment the owner approved found none and was refused `which-creator`
 * ("name one with --creator"). While a pairing is waiting, a command waits for it for at most `within` ms: the
 * creator, once its token is kept; otherwise an answer that says what is happening. Null when no pairing is waiting.
 */
export async function afterPairing(home, { within = 20_000, step = 100, alive = isAlive } = {}) {
  for (const until = Date.now() + within; ;) {
    const ids = soulsWithTokens(home).filter((id) => id.startsWith('c_'));
    if (ids.length === 1) return { creator: ids[0] };
    const p = pairingOf(home, alive);
    if (!p) return null;
    if (p.state === 'ended') return { ok: false, code: 'pairing-ended', detail: p.refused ? `the pairing was refused (${p.refused})` : 'the pairing stopped with no answer' };
    if (Date.now() >= until) return { ok: false, code: 'pairing-waiting', detail: `the pairing${p.code ? ` (code ${p.code})` : ''} is waiting for the world's owner to approve it` };
    await new Promise((r) => setTimeout(r, step));
  }
}


// ---------------------------------------------------------------- #3700: ownership, access and land-use zones
// Today's `own`, `access`, `zone`, `zone-suggest`, `layers` and `secret` (tools/god-skill/lib/layers.mjs). Owner and
// access are two fields of the thing (replica `who_may::F_OWNER`, `F_ACCESS`); zones are a root field (142). Each is an
// ordinary edit, so undo takes it back. Secret places are off on soul.game today (#1262), so `secret` says so.
export const F_OWNER = 143, F_ACCESS = 144, F_ZONES = 142;
export const LAYER_VERBS = ['own', 'access', 'zone', 'zone-suggest', 'layers', 'secret'];
export const USES = ['residential', 'commercial', 'park', 'farm', 'civic', 'industrial', 'wild'];
/** Today's catalogue categories for each use (apps/server/src/god/layers.ts ZONE_SUGGEST). */
export const ZONE_SUGGEST = {
  residential: ['building.residential', 'furniture.seat', 'vegetation.shrub', 'vegetation.flower', 'utility.lighting', 'object.street'],
  commercial: ['building.commercial', 'public.square', 'object.street', 'object.sign', 'furniture.seat', 'utility.lighting', 'object.food'],
  park: ['public.park', 'vegetation.tree', 'vegetation.flower', 'water.feature', 'public.play', 'furniture.seat', 'utility.lighting'],
  farm: ['building.agricultural', 'vegetation.crop', 'living.farm', 'object.tool', 'object.container'],
  civic: ['building.civic', 'public.square', 'public.monument', 'public.venue', 'object.sign', 'water.feature'],
  industrial: ['building.industrial', 'utility.power', 'utility.waste', 'vehicle.road', 'layer.construction', 'object.container'],
  wild: ['vegetation.tree', 'terrain.landform', 'terrain.rock', 'water.body', 'living.wild', 'living.bird'],
};
const ID_TEXT = /^[0-9a-f]{32}-\d+$/;
/** An owner as written: a Soul's id, god, group:<name> or none, as the field holds it. */
export function ownerValue(t) {
  const v = String(t ?? '');
  if (v === 'none') return 0;
  if (v === 'god') return 'owner:god';
  if (/^group:[a-z][a-z0-9_-]*$/.test(v)) return v;
  if (ID_TEXT.test(v.replace(/^soul:/, ''))) return v.replace(/^soul:/, '');
  throw usage(`own <id> <soul id|god|group:<name>|none>, not ${v}`);
}
const ACCESS = { none: 0, public: 1, private: 2 };
/** A zone's outline in whole mm, from today's --rect, --circle and --area in metres. */
export function outlineOf({ rect, circle, area }) {
  const nums = (t, n, what) => { const a = String(t).split(',').map(Number); if (a.length < n || a.slice(0, n).some((x) => !Number.isFinite(x))) throw usage(`${what}, in metres`); return a; };
  let pts;
  if (rect !== undefined) { const [cx, cz, w, d] = nums(rect, 4, '--rect cx,cz,w,d'); pts = [[cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2], [cx + w / 2, cz + d / 2], [cx - w / 2, cz + d / 2]]; }
  else if (circle !== undefined) { const [cx, cz, r] = nums(circle, 3, '--circle cx,cz,r'); pts = Array.from({ length: 12 }, (_, k) => [cx + Math.sin((k / 12) * 2 * Math.PI) * r, cz + Math.cos((k / 12) * 2 * Math.PI) * r]); }
  else if (area !== undefined) { try { pts = JSON.parse(area); } catch { throw usage("--area '[[x,z],...]' in metres"); } }
  else throw usage('zone <name> <use> --rect cx,cz,w,d | --circle cx,cz,r | --area \'[[x,z],...]\' (metres)');
  if (!Array.isArray(pts) || pts.length < 3 || pts.some((p) => !Array.isArray(p) || p.length !== 2 || p.some((n) => !Number.isFinite(Number(n))))) throw usage('a zone outline is at least three [x, z] points');
  return pts.flatMap(([x, z]) => [mmOf(x), mmOf(z)]);
}

/** The request a layer verb's words make. */
export function layerOf(verb, words) {
  const args = [...words];
  if (verb === 'own') {
    const priv = args.indexOf('--private'), pub = args.indexOf('--public');
    for (const k of [priv, pub].filter((k) => k >= 0).sort((a, b) => b - a)) args.splice(k, 1);
    if (args.length !== 2) throw usage('own <id> <soul id|god|group:<name>|none> [--private|--public]');
    return { act: 'own', node: args[0], owner: ownerValue(args[1]), ...(priv >= 0 ? { access: 2 } : pub >= 0 ? { access: 1 } : {}) };
  }
  if (verb === 'access') {
    if (args.length !== 2 || !(args[1] in ACCESS)) throw usage('access <id> private|public|none');
    return { act: 'access', node: args[0], access: ACCESS[args[1]] };
  }
  if (verb === 'zone') {
    const rect = takeOpt(args, '--rect'), circle = takeOpt(args, '--circle'), area = takeOpt(args, '--area');
    const [name, use] = args;
    if (!name || !USES.includes(use)) throw usage(`zone <name> <${USES.join('|')}> --rect cx,cz,w,d | --circle cx,cz,r | --area '[[x,z],...]' (metres); zone <name> none removes it`);
    return { act: 'zone', name: slug(name), use, outline: outlineOf({ rect, circle, area }) };
  }
  if (verb === 'zone-suggest') {
    if (!USES.includes(args[0])) throw usage(`zone-suggest <${USES.join('|')}>`);
    return { act: 'zone-suggest', use: args[0] };
  }
  return { act: verb };
}

/** The zones a root field holds, as a creator reads them. */
export const zonesIn = (v) => (Array.isArray(v) ? v : []).map(([n, u, pts]) => ({ name: bare(n), use: bare(u), outline: (pts ?? []).reduce((o, x, i) => (i % 2 ? (o.at(-1).push(x), o) : [...o, [x]]), []) }));

/** Runs a layer request through the daemon; the answer to print. */
export async function runLayer(l, ask) {
  if (l.act === 'secret') return { ok: false, code: 'secret.off', detail: 'secret places are off (#1262, decided 10 Nov 2026): every place is on every Soul\'s map', secrets: [] };
  if (l.act === 'zone-suggest') return { ok: true, use: l.use, categories: ZONE_SUGGEST[l.use] };
  const edit = (ops) => ask({ op: 'edit', ops });
  if (l.act === 'own') return edit([{ op: 'set', node: l.node, field: F_OWNER, value: l.owner }, ...(l.access !== undefined ? [{ op: 'set', node: l.node, field: F_ACCESS, value: l.access }] : [])]);
  if (l.act === 'access') return edit([{ op: 'set', node: l.node, field: F_ACCESS, value: l.access }]);
  const root = await ask({ op: 'fields' });
  if (root.ok === false) return root;
  const zones = Array.isArray(root.fields[F_ZONES]) ? root.fields[F_ZONES] : [];
  if (l.act === 'zone') {
    const row = [`zone:${l.name}`, `use:${l.use}`, l.outline];
    const out = await edit([{ op: 'set', node: root.id, field: F_ZONES, value: [...zones.filter((z) => z[0] !== row[0]), row] }]);
    return out.ok === false ? out : { ...out, zone: { name: l.name, use: l.use }, suits: ZONE_SUGGEST[l.use] };
  }
  // layers: the zones, and every marked thing (describe carries each node's marks).
  const d = await ask({ op: 'describe' });
  if (d.ok === false) return d;
  const words = { 0: 'none', 1: 'public', 2: 'private' };
  const marked = d.nodes.filter((n) => n.marks).map((n) => ({ id: n.id, kind: n.kind, ...(n.marks.owner !== undefined ? { owner: n.marks.owner } : {}), ...(n.marks.access !== undefined ? { access: words[n.marks.access] ?? n.marks.access } : {}) }));
  return { ok: true, zones: zonesIn(zones).map((z) => ({ ...z, outline: z.outline.map((p) => p.map(metres)) })), marked, secrets: 'off, as today' };
}

if (isMain(import.meta.url)) {
  const out = (v) => process.stdout.write(JSON.stringify(v) + '\n');
  try {
    const asked = requestOf(process.argv.slice(2));
    // 0.133 Q2: a creator's pairing adds to a home, so it never takes a parent folder's
    const home = findHome({ cwd: process.cwd(), env: process.env, homedir: homedir(), adds: asked.pair !== undefined });
    if (asked.pair !== undefined) { out(await pairing(home, asked.pair, asked.creator)); process.exit(0); }
    if (asked.look || asked.space) {
      // The picture needs no creator. The words with no picture, and where, clear and free, come from the creator's
      // copy (the daemon's `space`) when the home has a creator, with no browser (#5006 finding 5).
      const creators = soulsWithTokens(home).filter((id) => id.startsWith('c_'));
      const who = asked.creator ?? (creators.length === 1 ? creators[0] : null);
      const ask = who ? (r) => call(home, who, r, { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG, ms: 30_000 }) : null;
      out(asked.look ? await runLook(asked.look, { home, env: process.env, ask }) : await runSpace(asked.space, asked.args, { home, env: process.env, ask }));
      process.exit(0);
    }
    const creators = soulsWithTokens(home).filter((id) => id.startsWith('c_'));
    let creator = asked.creator ?? (creators.length === 1 ? creators[0] : undefined);
    if (asked.library) {
      const said = libraryAnswer(asked.library, asked.args, libraryOf(home, creator && worldsOf(home, creator)[0]));
      if (typeof said === 'string') process.stdout.write(said + '\n'); else out(withFix(said));
      if (said?.ok === false) process.exitCode = 1;
      process.exit();
    }
    if (!creator && creators.length === 0) {
      const p = await afterPairing(home);
      if (p?.ok === false) { out(withFix(p)); process.exit(1); }
      creator = p?.creator;
    }
    if (!creator && creators.length === 0) throw Object.assign(new Error('no creator is paired in this folder yet'), { code: 'no-creator' });
    if (!creator) throw Object.assign(new Error(`creators here: ${creators.join(', ')}`), { code: 'which-creator' });
    if (asked.directory) {
      const said = await askDirectory(home, creator, asked.directory, asked.body);
      out(withFix(said));
      if (said.ok === false) process.exitCode = 1;
      process.exit();
    }
    if (asked.listen) {
      // One wait, printed whatever it holds; with --follow, waits again and prints only what brought something.
      const { seconds, follow } = asked.listen;
      for (;;) {
        const got = await call(home, creator, { op: 'wait', seconds }, { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG, ms: seconds * 1000 + 5000 });
        if (got.ok === false) { out(withFix(got)); process.exitCode = 1; break; }
        if (!follow || !got.timedOut) out(got);
        if (!follow) break;
      }
      process.exit();
    }
    if (asked.event) {
      // HH:MM is its next one on the world's published calendar, read from the creator's copy.
      const e = asked.event, ask = (r) => call(home, creator, r, { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG, ms: 15_000 });
      const when = e.start === undefined ? await ask({ op: 'when', at: e.when }) : { ok: true, worldUs: e.start };
      asked.req = when.ok ? { op: 'edit', ops: eventOps({ ...e, start: when.worldUs }) } : null;
      if (!asked.req) { out(withFix(when)); process.exit(1); }
    }
    const pkg = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
    const ask = (req, ms = 60_000) => call(home, creator, req, { pkg, ms: req.op === 'import' || req.world?.verb === 'clone' ? 3_600_000 : req.op === 'export' ? 120_000 : ['land', 'expand'].includes(req.world?.verb) ? 130_000 : ms });
    // A relation is resolved on the daemon's copy: describe first, then the batch with its places filled in.
    let req = asked.relation ? resolve(asked.req, asked.relation, await ask({ op: 'describe' }, 15_000)) : asked.req;
    // A helper's home sends every edit under its claim (#3727).
    const scoped = helperClaim(home);
    if (scoped && req && (req.op === 'edit' || req.op === 'check') && req.claim === undefined) req = { ...req, claim: scoped };
    if (asked.named) {
      // A reviewed named batch (named.mjs): each op's outcome a line, then the summary.
      const { runNamed } = await import('./named.mjs');
      const said = await runNamed(asked.named, ask, out);
      out(withFix(said));
      if (said.ok === false) process.exitCode = 1;
      process.exit();
    }
    if (asked.thing !== undefined) {
      const d = await ask({ op: 'describe' }, 15_000), f = d.ok === false ? null : await ask({ op: 'fields', node: asked.thing }, 15_000);
      const said = d.ok === false ? d : f.ok === false ? f : describeThing(asked.thing, d, f.fields, kindsIn(join(home, 'kinds')));
      if (Array.isArray(said.at)) said.at = said.at.map(metres); // printed in metres, as every position (#4700)
      out(withFix(said));
      if (said.ok === false) process.exitCode = 1;
      process.exit();
    }
    if (asked.map) {
      const d = await ask({ op: 'describe' }, 15_000), root = d.ok === false ? null : await ask({ op: 'fields' }, 15_000);
      const said = d.ok === false ? d : mapOf(d, root?.ok === false ? {} : root?.fields ?? {}, kindsIn(join(home, 'kinds')));
      out(withFix(said));
      if (said.ok === false) process.exitCode = 1;
      process.exit();
    }
    if (asked.build && SESSION_ACTS.includes(asked.build.act)) {
      const said = sessionAct(home, asked.build);
      out(withFix(said));
      if (said.ok === false) process.exitCode = 1;
      process.exit();
    }
    // R8e: an edit sent while a build session is open carries its name and step, and is recorded under them
    req = inSession(home, req);
    const answer = asked.build ? await runBuild(asked.build, ask, (minutes, claim) => mintHelper(home, creator, minutes, claim)) : asked.layer ? await runLayer(asked.layer, ask) : asked.recolor ? await runRecolor(asked.recolor, ask) : await ask(req);
    recordEdit(home, req, answer);
    // describe's spots are the world's mm (a relation is resolved on them); printed in metres, as every position
    if (req?.op === 'describe' && Array.isArray(answer.nodes)) answer.nodes = answer.nodes.map((n) => (Array.isArray(n.at) ? { ...n, at: n.at.map(metres) } : n));
    out(withFix({ ...answer, ...(asked.say ?? {}), ...(req?.build !== undefined && answer.build === undefined ? { build: req.build, step: req.step } : {}) }));
    if (answer.ok === false) process.exitCode = 1;
  } catch (e) {
    out(withFix({ ok: false, code: e.code ?? 'failed', detail: String(e.message ?? e).slice(0, 200), ...(e.choices ? { choices: e.choices } : {}) }));
    process.exitCode = 1;
  }
}
