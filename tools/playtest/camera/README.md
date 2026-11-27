# Frozen camera comparison protocol

CAM-01, part of [#4907](https://github.com/soulsimulation/souls/issues/4907). Protocol `cam01/1` freezes the
acceptance targets in [budgets.json](budgets.json) and the fixture recipes, seeds and run cells in
[scenarios.json](scenarios.json). These files define acceptance, not measured performance or executable fixtures.
CAM-05 supplies the comparison runner, evidence manifest, served-page E2E and frame extraction. Product camera
changes, a new playtest platform and optional capture integrations are outside this baseline task.

The outcome is a calm, readable Follow with framing slack through unpredictable motion, rooms, doorways,
activity objects and moving carriers. Face and context preferences yield to visibility and comfort. Cuts are
rare, deliberate and separated. Broadcast chooses meaningful developing and quiet scenes, preserves continuity,
varies coverage, and uses purposeful pans, tracks, arcs, pushes or stillness. Runtime is client procedural code,
with no AI. Offline coding-agent inspection of actual pixels is allowed; no paid vision service is required.
Cameras observe public displayed state and never acquire movement or hidden-world authority from geometry.

## Source and adapter map

Revalidate this map at each dispatched source. Record immutable commit/file links and actual overlap state in the
PR evidence; do not put transient availability or run reports in these definitions.

| Role | Current source / reusable adapter | Boundary |
|---|---|---|
| Native public view | `v2/crates/worldd/src/views/{mod,index,served}.rs`; `v2/docs/views.md` | Existing audience-filtered projection; public immutable parts, no new engine callback |
| Public stream reader | `v2/web/src/source/{worker,source}.ts` | Replica worker consumes pointer/snapshot/parts |
| Served page selection | `apps/web/src/useSouls.ts`, `v2-engine/{early-stream,use-v2-souls}.ts` | Page config `v2Stream` selects native input; early reader is claimed by the bridge |
| Displayed world | `apps/web/src/v2-engine/{bridge,takes}.ts`, `LiveWorld.tsx` | Public native samples become takes; camera reads the same depicted entities as the renderer |
| Automatic cameras | `apps/web/src/World{Follow,FollowMotion,Broadcast}.ts`, `camera-spring.ts` | Follow resolution/motion and Broadcast sampling in `LiveWorld.tsx` |
| Geometry/manual input | `WorldCamera{Ground,RenderRoots}.ts`, `WorldRtsCamera.ts`, `WorldNavigation.ts`, `touch/WorldTouchFree.ts` under `apps/web/src/` | Clearance/visibility observations and real input ownership |
| UI contracts | `apps/web/src/WorldViewer.ts`, `ViewerFrame.tsx`, `SoulCard.tsx`, `LiveWorld.tsx` | Follow, Broadcast, Orbit/Free, Explore and selection |
| Existing trace | `apps/web/src/camera-trace.ts`, opt-in `camtrace` query | Input and changed-pose records plus Follow resolver cost, not all camera work |
| Native served test world | `tools/playtest/arena/new-engine/{world,seat,old-page}.mjs` | Isolated fake/scripted world, apps/web page, test routing and owned cleanup |
| Observer/video | `tools/playtest/observer/browser.mjs`, `tools/playtest/lib/{platform,arrival}.mjs` | Real Follow button, readiness/selection facts, recording sidecars, partial/failed takes |
| Derived review media | `tools/playtest/runs/recording.mjs` | Hash-checked originals, labelled excerpts and contact-sheet indexes |
| Ordinary PR proof | `.claude/skills/proof/record.mjs`, `tools/proof/{upload,publication}.mjs` | Reuse only where available and compatible; preserve originals and publication privacy |
| Existing shoot/look | `v2/client/src/shoot/shoot.mjs`, `apps/web/src/v2-engine/capture.ts` | `shot=1`, `v2.capture`, exact requested-eye semantics; not an automatic-camera quality run |

Authored tracks (`WorldShotTrack.ts`) and shot pins can stage a capture and therefore cannot prove automatic
Follow/Broadcast behavior. Existing observers may be reused after verifying the actually served selectors and
browser launcher; never silently fall back to an installed personal browser or profile.

The existing trace times only `follow.resolve`, emits changed poses rather than every displayed frame, and
retains at most 50,000 pose/input records and 50,000 cost samples. Its summary is median/p95/max, not p99 or total
CPU. At 60 Hz a cost buffer covers about 13.9 minutes, not a 60-minute control. It omits Broadcast/worker/query
attribution outside that resolver, memory and cold bytes. Preserve raw exports where available, but never claim
these missing metrics from constants, old PRs or this limited trace. Export before rollover or mark missing
coverage unknown; CAM-05 must establish complete timestamped evidence for longer claims.

## Reference resources and evidence availability

Bind the portable `desktop`, `mobile` and conditional `linux` roles privately under ignored `.local/`; public
records use neutral role labels only. Declare actual capabilities at dispatch: built page and assets, browser
launch/access, pointer/keyboard/touch input, original video recording, normal-speed playback, full-resolution
frame extraction and pixel inspection, CPU/memory instrumentation, and isolated native runner. Probe each
capability actually used; an installed binary or a viewport preset alone does not establish working capture.

Desktop is a quiet reference with fixed browser/renderer settings. Physical mobile is one real device with its
actual OS/browser, pixels, refresh, power and thermal state recorded privately; viewport emulation is only a UI
check. Linux is isolated from production and required only when testing the optional compiler. Missing mobile,
Linux, playback, browser or profiling access is `unknown`/`unavailable` in run evidence and PR limitations. A
fresh worktree's missing builds/dependencies mean not yet provisioned, not that no desktop resource exists.
Do not invent fresh measurements or replace missing physical evidence with emulation.

All runs use fake/scripted legal acts, isolated data and allocated ports under `.local/`. Keep mutable installs,
builds and outputs within the assigned worktree. Record what was started and stop only owned processes; do not
inspect private profiles or interfere with an existing service. Run measurements on a quiet reference, never
while building or running unrelated workloads. No paid tools, production data or live model calls are needed.

## Frozen inputs, feasibility and cells

Materialize the scenario recipes with existing world/act helpers. Before seeing camera outcomes, retain the
world/public tape/assets hashes, seed and repeat offset, legal act receipts/refusals, timing and displayed ticks.
Freeze fixture geometry and oracle feasibility for each depicted interval. Every initial recipe declares
`[0,180)` feasible: provide at least one public readable collision-clear shot throughout, including inside rooms,
at closed-door refusals and aboard carriers. A fixture that cannot substantiate this is unqualified/unknown;
repair and version its inputs before a new comparison. Do not remove bad camera frames from the denominator.
A camera's failed search, wall occlusion, crowd choice or chest crop does not make an interval impossible.

Any later genuinely infeasible interval needs a pre-run half-open interval, physical/public-information reason
and independent fixture/oracle evidence, frozen before either arm's outcome. Report its duration, camera fallback
and recovery separately. No post-hoc relabelling or retroactive rescoring. A missing/unplaced public subject is
an explicit lifecycle interval, never permission to invent its pose. Frame timestamps map depicted-world time
to source-video presentation time; retain synchronization error and missing frames.

Tuning, untouched holdout and reserve have disjoint seeds and different world plans. Each repeat has a distinct
seed (`listed seed + 10000` for repeat 2); paired arms use the identical tape for that repeat. Holdouts may be
materialized and hashed without inspecting candidate footage. After a failed holdout informs tuning, it is
consumed; confirmation uses untouched reserve. Exhausted reserves require a coordinator-frozen new set.

The JSON matrices are explicit Cartesian cells, not a claim they all fit a later issue's ceiling. Declare the
selected cells and wall-clock recording total before dispatch; amend/split tasks for additional device or mode
coverage. Unrun required coverage stays unknown. Do not shrink durations, bars or repeats to fit a clock.

- Focused comparisons: current/selected candidate, each frozen profile, two repeats, separate cold/warm and
  portrait/landscape cells on desktop and physical mobile. The default short recipe is 180 seconds.
- CAM-36: desktop warm landscape, current/candidate × active/quiet × two 15-minute repeats = 120 recorded minutes.
- CAM-40 initial: one physical mobile, portrait, disabled/current/economical candidate × two 20-minute repeats =
  120 recorded minutes plus 30–60 minutes setup/warmup/cooldown. Each mixed cell has 14 minutes Follow and six
  Broadcast. State actual mode/effort/orientation coverage; this is not 20 minutes per mode or landscape proof.
- CAM-05: two original 60-minute desktop current mixed controls. CAM-43: two candidate repeats of the same frozen
  schedule. Reuse controls only after explicit source/input/assets/render/protocol applicability review. If
  invalidated, separately bound re-recording; do not silently exceed the task ceiling.
- CAM-42: untouched holdout comparisons; use reserve after any holdout-driven repair. Record exact cells run.

Retain each arm/repeat separately. Alternate current/candidate order in repeat 2 to expose drift. Cool mobile
between arms to the same declared thermal starting band; record throttling and ambient/power changes. Cold is a
fresh test context and empty camera caches, with startup recorded separately; warm uses an identical five-minute
prelude. Keep the same depicted tape, viewport, DPR, browser, rendering backend, graphics/shadows, initial lens,
zoom/preferences, light hour, reduced-motion policy and recording/profiling overhead within paired cells. Record
actual refresh and capture rate. No inference of identical cross-device pixels or timing is promised.

## Measurements and absolute verdicts

Use nearest-rank median/p95/p99 with the raw sample count, clock resolution and covered interval. Empty or missing
samples are unknown. Report each repeat/cell separately, including startup and recovery tails; never pool away a
failed device/mode. Keep browser/display frame intervals separate from video frames (encoding may duplicate or
drop frames). A recording too sparse to see the motion is inadequate, even when its nominal rate is high.

Camera foreground time includes observation conversion, all geometry/query/scoring/search, scheduling, transition
and final pose work, including unsuccessful/cancelled work. Measure per displayed frame, including zero-work
frames; also retain each camera main-thread task for the 8 ms maximum. Attribute main/worker CPU separately and
sum CPU consumed in one-second steady-state windows, including transfers and worker copies. Report rendering and
overall frame pacing separately (median/p95/p99 frame interval, missed-refresh proportion and long tasks);
unchanged graphics and matched disabled controls expose whole-page effects. A worker is not a CPU saving by itself.

Memory is the additional resident camera allocation against the matched disabled control: geometry, plans,
queues, caches, worker copies, peak and post-cleanup retention. Heap-only or process-wide estimates must state
scope/error and cannot certify total resident memory when unobservable. Declare numeric queue/cache/inflight
caps before runs, measure peaks and overflow behavior. Measure absent, distant/irrelevant and in-use states,
including many irrelevant objects; report CPU, memory, requests/bytes and background wakeups. Cold transfer,
decode and startup costs are separate from steady state. No camera feature means no new camera background work.

A readable frame shows the declared subject and relevant action/object/partners at useful scale and without
material clipping/occlusion; the shot's intended medium/full extent must actually fit. A face can turn away when
that preserves the action; a chest-only crop never passes as a medium/full shot. Count readable feasible source
frames / all feasible source frames, with dropped/uninspectable coverage unknown. Report any sampled estimate,
its denominator and uncertainty separately; do not claim a full-frame 95% result from sparse samples. Geometry
facts may support a count, but do not establish readability or aesthetics without actual pixel inspection.

All feasible-frame readability must reach 95%, with zero hard failures in `budgets.json`. Apply cut limits in
rolling 60-second windows, with minimum consecutive discretionary spacing. Log actual executed discontinuities,
including mode/subject changes; classify discretionary, emergency recovery and explicit user takeover before
review, with cause. Emergency recoveries are counted and reviewed individually and in totals. Never hide a burst
by averaging cuts per session. Manual ownership, no movement authority and public audience limits are hard bars.

For optional server compilation, use matched compiler-off/on tapes and even/uneven/quiet/edit load, two repeats.
Record raw tick/API/archive distributions, errors, durability, restarts, effective CPU/memory/I/O controls and
noise. The regression allowance is `max(5% of baseline, 2 ms)`, not both added together. Inconclusive attribution
is unknown. Missing effective controls disables the optional compiler; no compiler is required for core completion.

## Real input and temporal pixel review

On the built served native page, verify readiness/depicted tick, select a scripted Soul via visible UI, click
Follow, retain selection while legal world acts run, orbit/zoom with pointer or physical touch, take over with
Orbit/Free and keyboard movement, then return with the visible Broadcast control. Observe selection, active mode,
input ownership, reconnect/seek and interruption behavior. Use real pointer/touch/keyboard events; observation
hooks may read state but cannot set poses, teleport actors, skip the clock or substitute the user journey.
Pair scripted E2E assertions with a real-input walkthrough. A blocked or changed selector is a failed attempt,
not permission to call an internal camera setter. Preserve existing shoot/look exact-eye behavior separately.

Retain original full-resolution, uncut, normal-speed video for every arm/repeat, including failed/partial takes.
Hash originals; retain codec, pixel dimensions, actual frame timestamps, duration, capture gaps, source/assets,
world/tape seed, variant/effort, render settings and synchronization marks. Keep full long-session originals
separately from ordinary proof clips of at most 90 seconds. Derived previews/sheets/excerpts are labelled and
point to original hash and exact timestamps; never overwrite or pass them off as original footage.

Review the original at normal speed with a capable viewer. Log exactly which intervals were actually played and
which source frames were inspected; sampled frames alone are not a claim of watching video. For every run:

1. Inspect chronological full-resolution frames uniformly: one every five seconds across the entire run, and
   normal-speed windows `[30k, min(30k+10, duration))` for every nonnegative integer `k` before the end. Include
   the final ten seconds. These provide broad coverage, not a full-session playback claim.
2. Add normal-speed windows at every turn, doorway, cut, occlusion, recovery, group/scene change and detected
   failure: at least two seconds before through three seconds after. Use all event timestamps, not only a
   handpicked successful subset. Dense overlapping events may merge into one continuous reviewed interval.
3. Inspect sequential original-resolution frames at at least 10 Hz over each event window. For a suspect snap,
   near-plane strike, crop, oscillation or recovery, inspect **every source frame** from one second before to one
   second after (extend until resolved), then replay at normal speed. Missing source frames remain unknown.
4. Record timestamped pass/fail/unknown and reasons for each rubric dimension: readability/action, comfort,
   intentional motion/slack, face/context compromise, room/carrier behavior, scene choice/continuity, pacing,
   variety and cut discipline. A sheet indexes frames; it cannot prove temporal comfort. Metrics cannot override
   an observed hard failure. Where possible anonymize variant labels before the reviewer sees the comparison.
5. Record reviewer/tool capability, original hash, exact video intervals, frame timestamps/ranges, unreviewed
   gaps and disagreements. Uninspected intervals remain unknown; extrapolated scores never turn them into a
   visual pass. Independent review at Follow selection, Broadcast selection and final qualification inspects
   actual pixel/temporal evidence, not only code or traces.

The absolute rubric applies even if the incumbent looks worse. Every proposed complexity increase needs a named
observed failure, a frozen minimum useful visible/resource gain with units or timestamped defect criteria,
measurement resolution/noise, control cases, no hard regression and bounded cost. Use the method-specific tests
in `budgets.json`; do not adopt a planner, worker or compiler merely because it was implemented. Retain failed
methods and select the simpler qualified fallback when a trial does not earn adoption. Unmet required outcomes
stay unfinished; optional-method rejection is not an outcome pass.

## Evidence record and maintenance

CAM-05's manifest must retain the facts above plus per-frame trace coverage, failed attempts, cleanup outcome and
review records. Use `pass`, `fail`, `unknown`, `unavailable`, or `not-selected` with explicit scope; absent evidence
is never pass. Private runtime bindings and logs stay under ignored `.local/`; portable source provenance, checks,
limitations and links belong in the PR. Scan exact outgoing text/JSON with `node tools/proof/publication.mjs` and
inspect video pixels/audio/metadata for device details before upload. No personal paths, device identities,
addresses, local endpoints, resource identifiers or process numbers belong in public proof.

Changing a frozen definition requires an explicit coordinator decision before new comparison runs, its reason,
a new protocol version and affected-evidence applicability review. Preserve previous failed results. Validation:
`node --test tools/playtest/camera/definitions.test.mjs`. These declarations add no runtime code, bundle bytes,
network calls or idle work; runtime cost still requires later actual measurements.

## Owned native-page capture prerequisite (CAM-05a)

`tools/proof/owned-attempt.mjs` accepts `world.kind: 'native-page'` with the committed
`tools/proof/drivers/camera-native-page.mjs` driver. A thin ignored wrapper supplies the owner, immutable attempt
ledger/cycle, clean product/helper/driver checkouts, reserved-port-safe entry port, explicit repository-owned
browser cache/executable, and a portrait or desktop viewport. There is no existing-world URL or personal-profile
option. Existing attempt limits and independent third-attempt review still apply; do not create a new ledger to
hide a failed slot.

Before running, create a private `native-page-proof-artifacts/1` receipt with `createNativePageArtifacts` from
`tools/proof/native-page-fixture.mjs`. Save it under ignored scratch and pass its relative `file`, containing
`root`, and SHA-256 `hash` as `world.artifacts`. The receipt identifies the selected product source, tracked world
template, source hashes, exact web/viewer/replica trees, native binaries and Caddy executable. The product may be
an older pinned build and must be labelled as such; it is never relabelled with the newer helper commit. Both
native startup and the outer front door use the pinned Caddy; `V2_WEB` prevents an unowned rebuild of the product.
Mutable world, launcher, routing, client bundle, browser profile and outputs live only in the fresh owned attempt.

Startup process groups and finite commands register with the owner before waiting. Finite children respond to
abort/deadline with bounded TERM/KILL escalation. Teardown checks the owned process group even if its leader has
already exited; disappearance is required. Derived native ports and the launcher's allocation range are checked
against reserved ports. Boot/browser/timeout/interruption failures retain evidence and never qualify.

The native-page browser first renders a neutral calibration, checks raw capture dimensions, and if needed grows
the browser window by the **measured** deficit without changing the CSS viewport. If window minimum dimensions
leave a raw-size mismatch, it explicitly sizes the visible render surface to the same declared viewport. Each
correction waits for bounded compositor presentation; unchanged CSS dimensions and exact raw pixels remain
mandatory. It then checks encoded frames at 0.25, 0.5 and 0.75 seconds for intended resolution and all four colored corner
markers. A crop, rescale or gray padded edge fails. No fixed browser-decoration offset is assumed. Calibration
is isolated from the product page; the original actual-page recording begins afterward and uses no product
pose injection or calibration overlay. Test desktop and portrait separately; a successful desktop calibration
does not qualify portrait, physical mobile, or another browser configuration.

The driver retains the exact initial navigation response and verifies its supplied native stream, successful
matching stream requests and a nonempty finite depicted tick; it never restores a consumed configuration global.
It waits for the native apps/web world to draw and snapshots accessible controls before each real input. It uses
the visible direct Camera control or responsive Menu → Camera route, pointer dragging and keyboard input, then
returns to Broadcast. It changes no actor or camera pose through a test hook. The original actual-page take and calibration files remain under the attempt with their hashes,
console/network evidence and cleanup outcome. Inspect encoded full-resolution frames and actual-page pixels
before relying on this capability. Normal-speed perceptual playback is a separate capability; extracted frames
alone do not demonstrate it. This short journey qualifies capture/input access only, not camera aesthetics,
physical-mobile performance, causal matched comparisons or CAM-05's two 60-minute controls.

The experimental Follow slice uses `?camera-follow=experimental`; ordinary Follow remains the default. `camera-follow-test=1` enables bounded, read-only completed-draw diagnostic rows for either comparison variant. Without that flag the experiment retains only the observation needed by the next control step, not the diagnostic trace. `window.__followExperiment()` returns raw frame rows, overflow counts, whole synchronous controller/observation/setup costs and separately named row-recording cost. Export overhead, deferred GC and resident memory are not inferred from those synchronous spans.

The experiment follows a selected human Soul only. Capture/shot tracks, eyes and generic thing Follow retain their existing owners. Its input is the previous completed draw, keyed to world, scene, seek and subject; stale, missing or unsupported inputs hold explicitly. Cold geometry preparation, structural checks, vertices, triangles and instances have finite limits. Unknown geometry is not an unobstructed candidate. A collision or unavailable-input hold is a reported safety exception to smooth motion, never proof of useful tracking.

For visual comparison, retain legal public history, choose Follow before Time, seek through the actual minute control and bounded slider keys, and use Camera → Camera controls → Reset view. Verify the requested depicted tick and finite starting camera matrices before playback. Freeze the failure and the comparison interval before running the candidate; inspect original portrait clips and chronological full-resolution frames. Commands accepted, positional motion summaries and a passing scripted journey do not establish a good camera or an outdoor route. The first source route approaches the existing presentation-hall door, returns to the plaza, and heads to the orchard flag; actual exterior/turn/stop/corner pixels still decide admission.

For a candidate-first measured pair, the legal source recording may finish with a paused historical calibration at the route start: normal Reset and a three-second settle, without playing that interval. Freeze this actual composition before either measured outcome. The candidate uses the bounded matching inputs; the later legacy arm uses normal Reset and verifies the same strict tolerances without corrective gestures. This calibration is not a measured legacy comparison arm.


The fixed `camera-follow-lifecycle.mjs` journeys exercise ordinary real controls against one legally moving native actor. `moving-handover-1` enters Follow during motion, drags across twelve pointer steps, waits for tracking to resume, zooms, waits again and uses Reset. Cold-entry and each pre-Reset resumption are checked separately. Manual camera input changes the stored orbit by its actual displacement; automatic root following continues through the same bounded movement and safety sweep. Missing or stale depicted input resets velocity against the actual displayed camera. Geometry warming can hold the eye while the existing bounded aim turns toward fresh depicted input; it cannot authorize a translation or override manual orientation.

`lifecycle-transitions-1` exits and reenters Follow, resizes the actual viewport from portrait to landscape and back, pauses, seeks one historical tick, resumes playback and resets. Its square recording envelope encloses both orientations with visible padding; the product viewports remain their actual dimensions. CSS/canvas measurements alone cannot prove complete encoded pixels. Intermediate screenshots are omitted because an earlier recording reverted to a clipped native render surface after resizing; the exact cause is unproved. Inspect original frames across every resize and the remainder of the clip. The native Follow framing path consumes existing measured edge insets and eight projected depicted-bound corners, retaining a nonzero framing slack and the ordinary projection. Infeasible bounds are reported, never counted as visible. This does not establish group/lens composition, physical touch/mobile performance, full-speed comfort or missing-subject/scene-change E2E behavior.

`eyes-ownership-1` uses the supported `edenEyes.where()` and `capture()` API with an actual depicted subject identity. It retains the requested job, all raw rows, the two matched capture rows and returned JPEG. Check the actual eye, direction, centered projection, vertical field of view, aspect and result frame count while experimental Follow is inactive. This is API pose ownership evidence, not manual navigation, map/track capture or general capture qualification.


Experimental Follow validates its actual smoothed eye displacement with a swept sphere enclosing the previous and intended final near planes, including the renderer’s actual latched near-plane fitter at the current and proposed eye. The sphere is independent of orientation, so a clear sweep also covers intermediate turns, including a stationary eye. World-space triangle distances cover faces, edges and degenerate edges; inverse-transform row norms conservatively inflate local broadphase bounds under nonuniform scale. The existing traversal, triangle, instance, construction and retained-block budgets remain unchanged. The envelope is deliberately conservative and can reject a narrow opening that an orientation-specific near plane would fit.

This is swept **surface** clearance, not a closed-solid containment test. Initial surface overlap reports `camera-envelope-overlap` and holds eye and aim without searching; an indefinite hold is not successful recovery. Deep containment remains unproved. Unknown geometry still allows the previous bounded aim-reacquisition behavior with the eye held; those turns are explicitly outside the clearance guarantee. Manual pose changes remain separately owned. Actual displayed transforms are queried immediately, but unit examples of moving geometry do not qualify a real moving carrier or crossing foreground actor.

`camera-follow-comparison.mjs` can declare `experimentalPair: true` for a pinned old/new experimental product comparison: the first arm retains its actual reference, and the second verifies it with the existing strict composition tolerances and no adaptive corrections. Optional `closeApproach: true` applies exactly one real wheel input of −1600 after paused Reset in each arm, then waits three seconds before retaining the start. This lowers the camera toward the existing hall walls without editing geometry or injecting poses. Preserve nondiscriminating outcomes and reject start mismatches; a passing route with all clear sweeps is a regression control, not proof of a visible clipping repair. Geometric counterexamples, actual original clips, synchronous cost spans and unproved recovery/foreground cases remain separate evidence.

The private projection adapter reuses the renderer’s near fitter, starts from its actual near latch, and covers both an accepted and refused move; optional candidate passages also retain the accepted movement envelope. It does not update the shared camera or global ground binding. Parented cameras are unsupported. The earlier fixed −1000 comparison is retained as invalidated: its two actual starts differed in latched depth coefficients beyond the unchanged projection tolerance. The replacement fixed −1600 protocol reaches the fitter’s lower clamp; it does not relax the threshold or retroactively qualify the failed pair.


The experimental Follow policy can use a small future visibility cue derived only from past completed-draw travel. Finite, confident horizontal travel must remain directionally stable for 0.3 seconds; the fixed 1.5-second projection is capped at two metres. Missing input, stops, reversals, discontinuities, manual gestures and resets clear the cue. It adds at most two bounds-centre sight queries and two ground samples inside the existing shared limits. The incumbent is queried first; a maximal or unknown incumbent skips the alternative. Only a known blocked-to-clear future centre comparison can justify anticipation, and current two-anchor visibility cannot worsen. Actual movement still passes the existing smoothed-eye envelope sweep. A projected centre is a procedural cue, not a future actor position or visibility certificate.

If whole depicted bounds cannot fit the available rectangle, bounded aim can fall back to the observed head anchor and bounds centre, retaining a distinct framing reason alongside any movement refusal. These points do not certify anatomical extent or action visibility; manual zoom is unchanged. The discarded slow-orbit method is not part of the selected policy.

The close portrait experiment remains unqualified. The cue reduced a retained arrival failure from several frames of complete head/core loss to a shorter substantial edge crop, but did not remove it. A roughly one-metre step in the depicted subject coincided with the remaining loss; its engine or locomotion cause is unproved, and no source state was changed. Earlier relocation also produces substantial background motion. Complete short-event frame inspection establishes the crop, not normal-speed comfort. Required final matched repeats, ordinary-distance and relevant manual/orientation qualification remain unfinished; this mechanism stays default-off.

`camera-interior-source.mjs` records a legal native room journey: runtime exact-name lookup of the existing presentation desk, receipt-confirmed arrival, a six-second hold, and return to the plaza. Follow selection and Reset use ordinary visible controls. The original portrait clip, receipts, depicted positions, context input bindings and source interval are retained. A successful context journey does not establish indoor visibility: the retained first take loses the body behind the exterior wall during the indoor stop and departure.

Generated building clones expose a frozen `building-camera/1` subset on their canonical inner group. Experimental Follow acquires it through the existing bounded geometry collection and resolves the previous completed subject position using that group's world matrix exactly once. Each context records its consumed tick, identity and position separately from the newly completed draw. The selected immutable `region` contains the authored polygon, floor and vertical span; nominal points and a world-space margin are proposals requiring full authored geometry validation. Neither room membership nor those points establish camera containment, clearance or visibility. Typed openings do not certify current door leaves or connectivity. Render-cut callbacks are never invoked for these queries, and a cut draw range is not an authored-geometry oracle.

Acquisition retains at most 64 building references; each building's metadata is capped at 32 rooms, 512 polygon vertices and 128 openings. Resolution allows 2,048 edge visits and retains one prior membership. Entry and exit use a 0.15-metre world boundary margin; nominal viewing points require a 0.4-metre horizontal margin. Missing metadata is unknown, and `outside` means only outside the examined authored rooms. Overlap, unsupported deformation without a conservative extent and incomplete collection remain uncertain. Node, metadata, source-revision, transform, seek and subject-lifecycle changes invalidate hysteresis. These limits can refuse otherwise useful context; they are not claims of complete world coverage.

Metadata allocation occurs when any generated building clone is created, including with experimental Follow disabled. Active `enclosureMs` is inside the controller span and does not include that generation cost. Bounded diagnostic recording may retain the selected room descriptor; ordinary experimental control does not retain raw rows. Serialized metadata size is not retained heap or GC cost. Full authored floor fixtures, nonuniform transforms, multiple storeys, narrow rooms, pavilions, boundary lingering and invalidation supplement the native journey; they do not qualify interior compositions, cut destinations, physical-phone performance or normal-speed comfort.
