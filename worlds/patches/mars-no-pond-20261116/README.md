# Mars College has no swimming pond (#1984)

The live Mars College world (`/w/mars-college-2026/`) got a pond, `campus-swimming-pond`, as a god edit on
2026-10-27: `tools/meaning/fixtures.mjs apply mars-two` placed it for the unified-affordances test arms, and the
meaning overlay described it. It is world state, not template: a release that ships the pond-free
`worlds/templates/mars-two.json` changes new worlds only. The live world loses the pond only through this god edit.

`mars-college-2026.json` is one batch with three operations:

- `remove campus-swimming-pond`: the pond and its ground (the carve and the water) go; the playa is level again.
- `set water-tank about`: the tank's description no longer says "distinct from the open swimming pond".
- `world about`: the world tour no longer says "For a swim choose the Campus Swimming Pond".

Nothing else changes: no definition, no other entity, one ground tile.

## Apply (release owner)

In the live world's paired God CLI folder (never copy its token), with `REPO` set to a checkout that has this folder:

```sh
node "$REPO"/tools/god-skill/eden-god.mjs status        # this world, you are god
node "$REPO"/tools/god-skill/eden-god.mjs snapshot > before.json
node "$REPO"/tools/god-skill/eden-god.mjs dryrun "$REPO"/worlds/patches/mars-no-pond-20261116/mars-college-2026.json
```

The dry run must say `accepted: true`, no warnings, and `diff` `{upserts: 1, removes: 1, defs: [], tiles: 1,
world: ["about"]}`. If it names a Soul it would move (one standing or swimming in the pond), the edit walks it out to
dry ground; run it when the pond is empty if you prefer. Then:

```sh
node "$REPO"/tools/god-skill/eden-god.mjs act "$REPO"/worlds/patches/mars-no-pond-20261116/mars-college-2026.json
```

Check `https://soul.game/w/mars-college-2026/v1/world/snapshot`: no entity named `campus-swimming-pond`,
`ground.waters` and `ground.landforms` empty. `undo`, run before any later edit, takes it back (rehearsed on the local copy).
