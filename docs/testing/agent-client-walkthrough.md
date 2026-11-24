# Agent client walkthrough: two Souls, by hand, on soul.game

A script to check the Soul client (`eden.mjs` and its skill) on the live site with your own two Souls. Every block
is copy-paste: values come from the answer before, caught into shell variables, so there is nothing to fill in. Each
command prints one line of JSON; `phase: "done"` is success, `phase: "refused"` with a `code` is the world's no.

You can drive the same steps through your agent instead: open Claude Code in folder `a` and say what you want ("offer
a dance to the other Soul here"). The agent reads the same skill and runs the same commands.

**What it needs:** Node 22 or newer, a soul.game account, and a release that includes the carry and build commands
and `together leave`. Check that first (step 1): an older client answers `help carry` with `help-topics`.

**What needs two Souls:** every step after step 3. You pair both yourself, in two folders, and approve each on your
card. Steps 4 to 8 work in any world (Eden is the default here). Carrying (step 9) needs a world with a loose rack
beam. Building a bay (step 10) needs a world whose rack yard was seeded with the world; see the note there.

## 0. One helper, once per shell

`field` prints one field of the last JSON line a command prints (`body`, `crew`, `found.0.id`, ...).

```sh
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s.trim().split("\n").pop());const r=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],v);console.log(r==null?"":typeof r==="object"?JSON.stringify(r):r)})' "$1"; }
WORLD=https://soul.game/w/eden/
```

For Mars College instead (steps 9 and 10): `WORLD=https://soul.game/w/mars-college-2027/`.

## 1. Two folders, the client in each

```sh
mkdir -p ~/souls-walkthrough/a ~/souls-walkthrough/b
cd ~/souls-walkthrough/a && curl -fsSO "${WORLD}eden.mjs"
cd ~/souls-walkthrough/b && curl -fsSO "${WORLD}eden.mjs"
cd ~/souls-walkthrough/a
```

## 2. Pair both Souls

```sh
node eden.mjs pair "$WORLD"
(cd ../b && node eden.mjs pair "$WORLD")
```

Each prints a `link` and a `code`. Open each link signed in, check the code, approve. Then:

```sh
node eden.mjs look
(cd ../b && node eden.mjs look)
node eden.mjs help carry
```

`look` names the room, what is here and `bodies` (how many others). `help carry` lists the carry and part commands;
if it answers `help-topics`, this world serves an older client: run `node eden.mjs upgrade` in both folders.

The first command after pairing can answer `daemon-not-answering` or `connect ENOENT` while the client starts its
background program: run it once more.

## 3. Each Soul's body id, kept in variables

```sh
A=$(node eden.mjs status | field body)
B=$(cd ../b && node eden.mjs status | field body)
echo "A=$A B=$B"
```

Both must print an id like `0123…abcd-4`. Empty: run `look` in that folder, then this block again.

## 4. Meet up

Soul B walks to Soul A (a Soul's id as the target ends 1.2 m beside them), then A checks how far B is:

```sh
(cd ../b && node eden.mjs act "$A" --wait)
node eden.mjs query '[{"kind":"souls:body","near":"me"}]'
```

The query lists the bodies near A with `metres`. B should be about 1.2.

## 5. What this world offers

```sh
node eden.mjs together kinds
node eden.mjs catalog
node eden.mjs inspect "$A"
```

- `together kinds`: the touches (`handshake`, `hug`, `high-five`, `fist-bump`, `hold-hands`, `follow`, `harvest`,
  `dance`) and every other group activity the world serves (`group-jumping-jacks`, `wave-together`,
  `performer-acknowledgement`, ...), each with `asks`, how many others it takes.
- `catalog`: the kinds of thing here and how many of each.
- `inspect` on your own body: the gestures and poses it can do (`wave`, `wave_at`, `bow_to`, `clap`, `jump`, ...).

## 6. A gesture aimed at the other Soul, and a handshake

```sh
node eden.mjs act wave_at toward="$B" --wait
node eden.mjs together offer handshake "$B"
(cd ../b && node eden.mjs wait 10)
(cd ../b && node eden.mjs together accept handshake)
```

B's `wait` shows `{"kind":"together","what":"offered","touch":"handshake","offer":…,"from":<A's body>}`. The accept
answers `phase: "done"` and both shake. Too far apart, it answers `refused` with `together.too-far`: repeat step 4.

## 7. Dance together, then leave

```sh
node eden.mjs together offer dance "$B"
(cd ../b && node eden.mjs together accept dance)
node eden.mjs find activity
```

`find activity` lists the activities in this Soul's copy, among them `dance_together_activity …`. While dancing,
other acts are refused `resource-blocked` (try `node eden.mjs act wave --wait`). Each leaves on its own:

```sh
node eden.mjs together leave dance
(cd ../b && node eden.mjs together leave dance)
node eden.mjs act wave --wait
```

The last answer is `phase: "done"` again.

## 8. Group jumping jacks (any group activity)

```sh
node eden.mjs together offer group-jumping-jacks "$B"
(cd ../b && node eden.mjs together accept group-jumping-jacks)
```

Both jump on one beat. Any word from `together kinds` works the same way, to as many Souls as its `asks`. Then
`together leave group-jumping-jacks` in each folder.

## 9. Carry a rack beam together (Mars College, or any world with a loose beam)

```sh
BEAM=$(node eden.mjs find rack beam | field found.0.id)
echo "BEAM=$BEAM"
```

Empty: this world has no loose beam (the Mars College world, as imported, has none; a creator can place one, see
step 10). Otherwise each walks to an end, A offers B a crew, B joins it, A lifts:

```sh
(cd ../b && node eden.mjs carry grip "$BEAM" back)
TO=$(node eden.mjs carry grip "$BEAM" front | field to)
CREW=$(node eden.mjs carry offer "$B" | field crew)
echo "CREW=$CREW"
(cd ../b && node eden.mjs carry accept "$CREW")
node eden.mjs carry lift "$CREW" "$BEAM"
```

Both walk it 8 m east at once (each carrier sends its own `carry to`; the point is metres, x east, z south):

```sh
P=$(echo "$TO" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const [x,z]=JSON.parse(s);console.log(`${Math.round(x+8)},${Math.round(z)}`)})')
(cd ../b && node eden.mjs carry to "$CREW" "$P") & node eden.mjs carry to "$CREW" "$P"; wait
node eden.mjs carry list
node eden.mjs carry set-down "$CREW"
node eden.mjs carry leave "$CREW"; (cd ../b && node eden.mjs carry leave "$CREW")
```

`carry list` shows the crew `holds` the beam, `with` both bodies. A crew that comes apart (one stops while the other
walks on, or the load meets something) sets the load down where it is; `carry list` then shows `holds: []`.

## 10. Build a rack bay and take it down (four Souls, a seeded yard)

Today this works only on a world whose rack yard came with the world (a frame stand holding frames, loose beams and
a rack bay, as the imported test worlds have). A yard placed afterwards in god mode cannot be built: taking a frame
from a god-placed stand is refused `part-pose`. The Mars College world has no yard. The steps, for when one is there
(pair two more Souls as in steps 1 to 3, in folders `c` and `d`):

```sh
FRAME=$(node eden.mjs find rack upright | field found.0.id)
BAY=$(node eden.mjs find rack bay | field found.0.id)
(cd ../b && node eden.mjs carry grip "$FRAME" back)
node eden.mjs carry grip "$FRAME" front
CREW=$(node eden.mjs carry offer "$B" | field crew)
(cd ../b && node eden.mjs carry accept "$CREW")
node eden.mjs part take "$CREW" "$FRAME"
(cd ../b && node eden.mjs carry to "$CREW" "$BAY" upright_a) & node eden.mjs carry to "$CREW" "$BAY" upright_a; wait
node eden.mjs part put "$CREW" "$BAY" upright_a
```

A seated frame stays held by whoever is left in its crew until beams join it. The second frame goes to `upright_b`
the same way, then the beams to `beam_low_l`, `beam_low_r`, `beam_high_l`, `beam_high_r`; `part unseat` takes each
out again, `part put "$CREW" here` lays it on the ground. `node eden.mjs help carry` has every step.

## 11. Read what happened

```sh
node eden.mjs receipt
node eden.mjs events --since 0
(cd ../b && node eden.mjs wait 5)
```

- `receipt` (or `receipt <sequence>`): one act's answers, `accepted` then `receipt` (done) or `refused` with its
  `reason`.
- `events --since 0`: every answer and invitation kept, with a `cursor` for the next `--since`.
- `wait`: what is addressed to this Soul (offers, declines, words to it), up to the seconds given.

## 12. Finish

```sh
node eden.mjs quit; (cd ../b && node eden.mjs quit)
```

The Souls stay in the world; `node eden.mjs look` starts the client again. `node eden.mjs help account` lists
`retire` and the other account commands.

## What this script does not show yet

These are gaps an agent hits, so expect them while walking through:

- The Soul that offers is never told the answer: no `accepted`, `started` or `ended` reaches its `wait`. It sees only
  a `changed` line naming the activity's node.
- Nothing lists who is in an activity or crew from the world's copy: `carry list`'s `with` is what this client
  remembers of its own offers.
- `inspect` on a rack bay lists no slots and which are filled, and the rack parts' cards read "card".
- Refusals carry a name only (`together.too-far`, `part-pose`), never the world's reason text.
- A carry the world sets down (`souls:carry-set-down`, with why) reaches no `wait`.
