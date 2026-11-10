# New core-kit families

Add `<slug>.family.ts` here, exporting a default `DefInput[]` (or importing/re-exporting an existing family array).
Only matching files participate; discovery uses deterministic filename order. Run:

```sh
node packages/world-compiler/scripts/family-index.mjs --write
node packages/world-compiler/scripts/family-index.mjs --check
```

The generated `../index.ts` contains ordinary static imports, compatible with the existing browser and Node paths.
Package tests rebuild it in memory and fail if it is stale; `--check` never writes. Regenerate rather than hand-edit
or hand-resolve the generated index. No runtime filesystem scan or new install/build hook is required.

`../legacy.ts` is the frozen historical corpus, preserving its original ordering and bytes. Do not register new
families there; new modules append after that corpus in filename order. Existing definition revisions, supplements
and baselines remain unchanged. The original LOD mapping also applies to new mesh families.

This addresses definition discovery only ([#1681 A1](https://github.com/soulsimulation/souls/issues/1681)); it does not
prove conflict-free service integration (A3/A4). See the [canonical direction](https://github.com/soulsimulation/souls/blob/647d04a5ce5621717c2fad78c153d082e3dffcb2/docs/design/soul-actions-direction.md)
and the owning [Soul Client contract](https://github.com/soulsimulation/souls/issues/1737) for action discovery.
