# Lane V · Viewers, history and drawing

Draft, local only, 16 Nov 2026; final pass applied 17 Nov. Sixteen tasks (V1 to V16), written to
`v2/docs/tranche/FORMAT.md`. The trunk (`v2/docs/TRUNK.md`) is fixed; T6, T7 and T8 bind this lane most. This
file is the lane's shared notes: a lane opens it at `v2/docs/tranche/V-viewers-and-history.md` (K15 puts it
there). Read "Words" and "Checked facts" once; the tasks cite the facts as Fact 1 to Fact 10.

## Changes at the final pass

Applied from `FINAL-AUDIT.md`, the three audit reports and rules 11 to 18 of the format. IDs, titles, stages,
kinds and ceilings are unchanged. Main purposes are unchanged except V2's, narrowed as ruled.

**In every task**

- An `**Acceptance.**` checklist of at most five boxes ends the task (rule 11). V11 and V16 are gates and carry
  the four gate boxes, with the bars (V16: the declared readings) named in the first.
- Step 0 says which result means "stop and hand back" (rule 12).
- The shared checked facts were labelled F1 to F10, the labels of lane F's tasks. They are now "Fact 1" to
  "Fact 10" everywhere, and each task gives this file's repository path where it first cites one.
- Every citation of the design document, the outline, the local `TRUNK.md` and `FORMAT.md` is replaced by a
  repository path or by the fact itself. "Goal A8" and "agenda A3" (which read as acceptance ids) are stated in
  plain words.
- Touches name modules, not whole crates (rule 17). The module names under `v2/` are proposals for folders that
  do not exist yet; a lane may rename one and say so under "Deviations".
- Today's files are cited by full repository path (several had moved: the body and pose code is under
  `mars/viewer/app/engine-view/`, the model builders under `apps/web/src/gen-mesh/`).
- The lines "Amended at the final audit" that closed seven tasks and the preamble are moved out of the task bodies into the table
  at the end of this section; what they said is in the tasks' own fields.

**By task**

| Task | Change |
|---|---|
| V1 | Step 0 has its hand-back. The settled header rule is stated (once per bundle, parts name it by hash). A footgun says no task builds the text store. Touches narrowed to three modules |
| V2 | The lane's part is the origin, the cache rules and a measured test of a named CDN. Choosing the CDN, accepting its terms, opening the account, paying and writing to the vendor moved to the line "Waits for the owner's checklist: the CDN and its price". The outcome no longer hangs on a vendor's written answer; the lane drafts the question and the owner sends it. Step 0 says what to do when the line is not ticked. Main purpose narrowed to match |
| V3 | The storage bar is now "under $2 a month in writes for a busy world, and near nothing for a quiet one", counted with O3's shipping included; "near nothing" is declared as under 1 cent a month so that it can be checked. Its committed segment and bundle are stated as the first entry of the recording corpus that V18 replays. Step 0 redoes the sum for $2 and has a hand-back. A footgun on the path guard (fixtures as hex text). It runs on a local stand-in for the object store unless the owner's checklist lists a scratch bucket |
| V4 | Step 0 has a hand-back (sizes that no bundle length brings under 4 MB). The reference link is stated in the task |
| V5 | Step 0's hand-back worded. Visitor counts are named as O19's. If W1 or W2 already made a small project under `v2/web`, V5 builds on it. A box for "imports nothing from today's app". Touches narrowed |
| V6 | The reference devices are stated in the task and declared in an issue comment before the run |
| V7 | No change of substance |
| V8 | V17 is a plain dependency (the header already said so): Step 0 checks V17's pictures and hands back without them. A note that V17's models reach the page through `tools/cdn`'s licence records, which is V17's work |
| V9 | "A link made yesterday" is tested as a link into a recording of an earlier day, so the task fits one session |
| V10 | The fact sheet is defined in the task (it cited a local document). `factsAt(t)` is an export of the WASM library, since this task does not touch the page. Ordinary speech is public with a short reach; a whisper has an audience of one and is not on a public sheet (ruling) |
| V11 | All bars in one block. Gains "Waits for the owner's checklist: the CDN and its price" (the spend and a test window). Results are posted on the task's own issue, not "the tranche issue" |
| V12 | Step 0 has a hand-back. Touches narrowed |
| V13 | The earlier amendment is folded in: the session exchange is built once, shared with W5; this socket is the one exception to "viewers are served as files" |
| V14 | The proof is the clip of the scripted run in this task's own pull request; N15 makes its own with the view |
| V15 | No change of substance |
| V16 | The declaration goes in an issue comment; results on the task's own issue |

**Could not resolve**

1. **No task builds the text store.** V1 writes references into it, and V10, W4 and W7 read through it. The
   consistency audit asked (its question 11) and `FINAL-AUDIT.md` has no ruling. V1 says not to build it here.
2. **The reference laptop, phone and link are still not named.** V4, V6, V12 and W3 fall back to the #2554
   harness's presets and 20 Mbit/s with 50 ms, declared before each run.
3. **V3's "near nothing"** is my number (under 1 cent a month, about 2,200 writes). The planner may change it.
4. **A scratch bucket** for V3 is not on `FINAL-AUDIT.md`'s list of approvals. V3 uses a local S3-compatible
   stand-in unless the checklist lists one.
5. **V2 before the checklist line is ticked.** The origin, the rules and the tools need no CDN, and V4, V12 and
   O17 use them. V2 as written delivers those and hands back with the CDN box open. If the planner would rather
   not dispatch V2 until the line is ticked, Step 0 is the place to say so.
6. **V11 runs each arm once.** Two one-hour arms fill a three-hour ceiling, so rule 8's two repeats do not fit.
   Left as it was.

**Amendments made earlier in the final audit, moved here from the task bodies**

| Task | What was amended |
|---|---|
| Preamble | V17 and V18 are no longer missing (both are tasks in the reconciliation file); the question about T6's header is settled as `v2/docs/TRUNK.md` has it; "public" is defined as an audience id |
| V1 | "Human text" became "all free text, whoever wrote it"; the text path is one file per stretch of stream, because W4 allows no fetch per sentence. A view may carry text inline; parts still do not, because they are cached for a year |
| V3 | Depends on gained R3 and K5 (bundles are a view the view tier builds; the rebuild to a state hash is K5's restart fed from fetched objects). Step 0 no longer treats a missing history level as a failed premise. The archive is named beside bundles as never holding words |
| V4 | "Acting Soul" became "actor (a Soul, a creator or the world)"; "public audience only" became an index keyed by audience id with only the public one built, because R16 later reads the same index for what one Soul may see |
| V8 | The header said "V17 (proposed)"; V17 exists, so it is a plain dependency |
| V12 | Depends on gained V2 and V8; a footgun added, because an upload cached as unchanging for a year contradicts T8's removal and W9's one-minute bar |
| V13 | Step 0 assumed W1 hands the page a gateway token, which W1 does not build; the exchange is one piece shared with W5 |
| V14 | A scripted run of 1,000 bodies closes the task, because its only dependency is K2 and no walker exists until N7 |

## Changes made when the lane was written

Against the first plan of the lane. Kept as a record.

| Task | Change | Reason |
|---|---|---|
| V1 | Depends on R3, **R1, T8** | Its outcome applies effects in a browser (R1). Parts are cached for a year, so words must be references from the first part (T8) |
| V2 | Outcome sharpened: origin requests per part at most the number of cache nodes and flat in readers; a header check passes | "Serves each part once" is false on any CDN with more than one edge location |
| V3 | Ceiling 3 to **4 h**; depends on T7, K4, **T8**; seeds the recording corpus | Packer, bundles, restore and a cost count are four pieces; bundles must never hold words |
| V4 | Depends on V3, **R1**; outcome is "ready to draw", 95th percentile of 100 seeks, on a declared link | "On screen" needs V9's page; seeking needs the library |
| V5 | Depends on V1, R1, **N1** | "Eden's content" has to be in the tree |
| V6 | Outcome names what is measured; the reference devices are declared in Step 0 | No document defines the reference laptop or phone |
| V8 | Depends on V5, K3, N1 and **V17** | Nothing else imports the *pictures* of Eden's kinds |
| V10 | Depends on V3, **V1, R1** | The live arm reads the stream |
| V11 | Depends on V2, V6, O11, **V16** | The gate must serve a goal-size stream, and its byte bar comes from V16 |
| V13 | Depends on I1, V5, **R4, W1** | It is a subscription with an audience, for a signed-in owner |
| V15 | Depends on V7, V9, **V10** | Its outcome is stated in fact sheets |
| V16 | Ceiling 2 to **3 h**; depends on V1, I10, **V3** | One of the two reviewer measures is about history tracks, which V3 writes |

**Added since.** V17 (Eden's kinds drawn once and kept by hash) and V18 (a recording from every release still
plays) are tasks in the reconciliation file. V3 seeds V18's first entry.

**Should not exist:** none.

**Notes, not changed here.**
- T6 says each segment's header names build, schema and kinds. Settled (`v2/docs/TRUNK.md`, "Settled at
  reconciliation"): the header is written once per bundle and parts name it by hash. V1 does so.
- O3 (not this lane) ships sealed pieces every ten seconds as one object write each: 259,200 writes a month,
  $1.17 on R2 (Fact 2). V3's bar of $2 holds that and leaves $0.83.
- The planning estimate for a CDN was $100 to $325 a month; the lowest list figure found is $260 (Fact 2).
- The three fixed audiences of the earlier design (public, owner, creator) are replaced by T8's audience ids
  throughout this lane. "Public" below always means the one audience id whose set is everyone, never a fixed
  value.

## Words

**Part:** one numbered file holding half a second of the public view. **Pointer:** the one small file that
changes; it names the newest part. **Snapshot:** the public state at a part boundary, so a reader can start
without the past. **Bundle:** minutes of history in one file. **Level:** how much detail a view carries (T7).
**Playback clock:** the page's own clock, set about two seconds behind the world. **LOD:** a simpler model used
when far away. **Fact sheet:** per second, who is where (to 10 cm), in what posture, holding or using what, which
things are in which visible state, and which acts start and end (to 100 ms). **Reference laptop, phone and
link:** not yet written down; until the coordinator names them, the desktop and phone presets of the #2554
harness and 20 Mbit/s with 50 ms.

## Checked facts (16 Nov 2026; web sources read that day)

**Fact 1 · Traffic at the goal** (arithmetic). 20,000 viewers for 3 h a day is 1.8 million viewer-hours a month.
At 8 to 10 kB/s that is 52 to 65 TB, 29 to 36 MB per viewer-hour, 1.3 to 1.6 Gbit/s at peak. Half-second parts
and one pointer fetch a second are 3 requests a second each: 60,000 a second, 19 billion a month.
Quarter-second parts and two pointer fetches: 120,000 a second, 39 billion. Response headers are billed bytes
too.

**Fact 2 · Prices.**

| Provider | Bytes | Requests | The goal, a month |
|---|---|---|---|
| Bunny | $0.01/GB Europe and North America; $0.005/GB on its 10-location "volume" network | none listed | $260 to $650 |
| CloudFront | $0.085 falling to $0.06/GB | $0.0100 per 10,000 HTTPS (US), $0.0120 (Europe) | $19,000 to $47,000 in requests, about $4,500 in bytes; flat plans stop at 6 billion requests |
| Fastly | $0.12/GB to 10 TB, then $0.08 | $0.01 per 10,000 | the same order |
| Cloudflare CDN | no fee | no fee | terms let it limit a site serving video or "a disproportionate percentage of pictures, audio files, or other large files" outside its paid storage products |
| Cloudflare R2 | $0.015/GB-month stored, no egress fee | writes $4.50, reads $0.36 a million | one write a second is $11.70 |
| Own caches (Hetzner) | 1 Gbit port unlimited; 10 Gbit add-on €43 with 20 TB, then €1/TB | none | two or three machines; request rate untested |

Sources: bunny.net/pricing/cdn · aws.amazon.com/cloudfront/pricing/pay-as-you-go · fastly.com/pricing ·
cloudflare.com/service-specific-terms-application-services · developers.cloudflare.com/r2/pricing ·
docs.hetzner.com/robot/general/traffic

**Fact 3 · Cache defaults that bite.** Cloudflare caches by a list of file extensions (no HTML or JSON; `.wasm`,
`.glb` and extensionless names are not on it) and, with no header from the origin, keeps a 404 for 3 minutes
(developers.cloudflare.com/cache/concepts/default-cache-behavior). CloudFront keeps errors 10 s by default
(docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/custom-error-pages-expiration.html). Bunny kept
errors 5 s by default in 2019 (bunny.net/blog/protecting-against-cache-cdn-poisoning); not re-verified. Whether a
query string is part of a cache's key is a setting on each: use none.

**Fact 4 · Low-latency segmented video (LL-HLS).** Segments are cut into parts of about a third of a second; the
playlist names each; a player may ask for a playlist that does not exist yet and the server holds the answer
("blocking reload"); a "preload hint" names the next part. Chunked transfer sends a response while it is still
being made. For data: numbered parts that never change, one small file that does, and a ladder of levels all
apply. Held requests and chunked responses do not (caches differ, and two seconds is accepted). A joiner needs a
snapshot as video needs a keyframe.
developer.apple.com/documentation/http-live-streaming/enabling-low-latency-http-live-streaming-hls

**Fact 5 · Today's page, measured** (#2554; headless, hardware GPU; compare rows only). 12 Souls: 60 frames a
second. 200: 13 to 24, main thread 99 to 100 % busy. 500: about 10. At 200, posing bodies takes 27 to 32 %,
three's matrix updates 15 to 29 %, draw submission about 20 %. Heap 0.8 to 1.0 GB at 200, 1.2 to 1.7 GB at 500.
Why: each body is a clone of its model with its own `AnimationMixer` and its own tree of bone objects
(`createRig` in `mars/viewer/app/engine-view/people.ts`), and `mars/viewer/app/engine-view/humans.ts` layers
posture and arm solving over the clip, forcing a matrix update of the body's tree after each layer (33 call
sites).

**Fact 6 · Crowds in three.js, as reported.** Own-mixer skinned meshes fall below 60 past about 200; one shared
posed skeleton per animation: 1,000 at 60 on an old laptop; instanced skinning took 2,000 from 10 to 144
(discourse.threejs.org/t/optimization-of-large-amounts-100-1000-of-skinned-meshes-cpu-bottlenecks/58196).
`InstancedMesh2` (github.com/agargaro/instanced-mesh, MIT) has skinning, culling and LOD and a "3k instances"
demo, no published numbers. `BatchedMesh` draws many shapes in one call; its documentation offers no skinning.

**Fact 7 · WebGPU.** Chrome desktop and Android 12+, Safari 26, Firefox on Windows and Apple-silicon Macs; not
Firefox on Linux or Android (web.dev/blog/webgpu-supported-major-browsers). three's WebGPU renderer is reported
two to four times slower in many-object scenes (github.com/mrdoob/three.js/issues/30560 and a forum report on
r183). It does not help a CPU-bound page.

**Fact 8 · Compression of small parts.** Brotli's built-in dictionary is web text; small binary files need a
trained one. Dictionary transport over HTTP is Chrome-only (developer.chrome.com/blog/shared-dictionary-compression).
So compress inside the file and decode in the WASM library.

**Fact 9 · Frame-exact capture.** Chrome's `HeadlessExperimental.beginFrame` works only in the old headless shell
on Linux; screencast capture is real-time and drops frames (blog.replit.com/browsers-dont-want-to-be-cameras).
WebCodecs `VideoEncoder`: Chrome 94, desktop Firefox 130, Safari 26 (caniuse.com/webcodecs). No published cost
per minute was found.

**Fact 10 · Not real yet.** The stream's 8 to 10 kB/s (400 walkers of 1,000) and history tracks of 0.4 to 5 bytes
a second per walker (45 jostling) came from synthetic walkers in a reviewer's model. V16 measures both.

---
