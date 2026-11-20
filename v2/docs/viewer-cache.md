# Viewer cache

Engine v2 V2 (#2711). How the viewer's stream (V1, `replica::stream`, written by `worldd::view_out`) reaches readers
through caches: the origin, the headers it sends, what a cache in front of it must do, the tools that measure it, and
the question for a CDN. Code: `v2/tools/origin/` (the origin, a stand-in cache node, the header test) and
`v2/tools/readers/` (the reader tool, the check through a cache, the local pilot). The CDN itself, its terms and its
price are the owner's (C4 on #2636).

## The origin

1. **A plain file server over the stream writer's directory**, apart from the world process: `node
   v2/tools/origin/origin.mjs <dir> [port] [host]`. The world writes files (whole, then renamed); the origin only reads
   them. A world that stops or restarts never stops the origin, and an origin under load never slows the world.
2. **Three kinds of answer, and nothing else:**

   | Request | Status | `Cache-Control` |
   |---|---|---|
   | A part (`<stream>/<n>`) or a bundle's header (`…/headers/<hash>`) | 200 | `public, max-age=31536000, immutable, no-transform` |
   | The pointer (`<stream>/pointer`) | 200 | `public, max-age=1, no-transform` |
   | Anything not there, a temporary file (`*.tmp`), a URL with a query string, a path outside the directory | 404 | `no-store` |

   Every 200 is `application/octet-stream` with a strong `ETag`: the SHA-256 of its bytes, in hex.
3. **The pointer's max-age is half a period, rounded up to a whole second.** `max-age` takes whole seconds
   (RFC 9111), and half of V1's 0.5 s period rounds down to 0, which would send every pointer read to the origin. One
   second is the shortest that keeps the origin's pointer reads per cache node at about one a second whatever the
   readers. The cost is up to one second of extra lateness, which the two-second playback delay absorbs (the pilot
   below). A period of 2 s or more gets `max-age` of half of it.
4. **A part is never asked for before it exists, except by the check.** Readers ask for the pointer, then only parts
   it names, so a 404 is rare; it is never kept, so part N+1 asked a moment early is still served once written.
5. **No query strings.** A query string would multiply a cache's keys; the origin answers it with a 404.

`v2/tools/origin/origin.test.mjs` asserts the table (CI's `v2` job, step `origin-headers`).

## Checkpoint continuity

Checkpoint-backed public streams use the explicit generation/baseline extension in `replica::stream` (#3639).
The pointer selects immutable `g/<baseline digest>/baseline`, `baseline.text` and numbered part/text files. These
files use the same immutable cache treatment as earlier parts; old numbered files and headers remain unchanged.
A public baseline preserves the actual pinned root, authorized local frames, motion, slots and timers. It is
reconciled as a non-advancing snapshot, with no fabricated part timestamp, motion samples or replayed events. An opaque
reference to a private frame supplies no transform: it remains queryable while drawing waits for a real public
frame chain. It never supplies private ancestor records or the world's private arrival ledger.

The canonical producer validates whole durable source parts before publishing public observations beside their
original effects and events. The browser and native reader share the observer implementation. A protocol handoff
drains an open legacy reader to its exact public terminal version and digest before installing the new baseline;
physical record and public-effect cursors are checked independently. Ordinary restarts retain one generation.
Exact source/checkpoint/public objects reach the world's existing private Store before a conditional recovery head
and then the public pointer. A Store-only restore reconstructs those immutable bytes, even when the ordinary
checkpoint has advanced. This private recovery data is outside the origin's exported views; missing or corrupt
required source produces a named refusal instead of a false-ready stream. History archives remain a separate
required release prerequisite (#3634).

## What a cache in front must do

| Rule | Why | On nginx |
|---|---|---|
| Key on the path alone | one entry per part | `proxy_cache_key $uri;` |
| Honour the origin's `Cache-Control`; keep no error | a kept 404 hides a part that now exists (Fact 3: Cloudflare keeps a 404 3 min, CloudFront 10 s, Bunny 5 s by default) | the default honours it; `proxy_cache_valid 404 0;` |
| Collapse concurrent misses into one origin request | 2,000 readers asking for a new part at once are one origin request a node | `proxy_cache_lock on;` and, for the pointer's expiry, `proxy_cache_use_stale updating; proxy_cache_background_update on;` |
| Keep extensionless binary files | parts and the pointer have no extension (Fact 3: Cloudflare does not cache them by default; a cache rule must make them eligible) | the default |
| Never recompress or transform | the ETag is the bytes' hash; parts are already packed (Fact 8) | `no-transform` is sent; `gzip off;` |
| Keep connections open | a reader makes about three requests a second | `keepalive` to the origin, HTTP/1.1 or 2 to readers |

**Origin requests per part are at most the number of cache nodes**, not one: each edge location (or nginx machine)
fetches a part once. A CDN with one shield node that fetches for all its edges makes it one. The pointer costs each
node about one origin request a second.

The owner's alternative to a CDN is two or three unmetered machines running nginx with the settings above (Fact 2:
Hetzner's ports). The stand-in below proves the rules, not nginx: nginx was not run here.

## Tools

- **Readers** (`v2/tools/readers/readers.mjs <base URL[,…]> <stream path> <readers> <seconds> [processes]`): each
  reader holds one connection (one TLS connection on `https`), and once a second on its own clock asks for the pointer,
  then every part it names that the reader has not had, in order, starting at the newest when it joins. Every part is
  checksummed (its SHA-256 equals its ETag, and every reader gets the same bytes for a number). Lateness is the time a
  part arrives after the wall time its world-time end fell at (the pointer's anchor); past the page's two-second
  playback delay it counts as late. Prints `readers {json}`.
- **The check** (`v2/tools/readers/check.mjs <base URL> <stream path>`): the headers a reader sees on a part, the
  pointer and a 404 through the cache, and the early ask: part N+1 asked before the pointer names it must be a
  `no-store` 404, and asked again once the pointer names it, through the same address, must arrive whole.
- **The local pilot** (`v2/tools/readers/pilot.mjs <stream-check binary> <work dir> <readers> <seconds> [nodes]
  [processes]`): V1's live world (`stream-check world`, even load) writes; the origin serves; stand-in cache nodes
  (`v2/tools/origin/cache.mjs`: keeps a 200 for its max-age, never keeps `no-store` or an error, collapses concurrent
  misses as `proxy_cache_lock` does) sit in front; the check runs, then the readers.

## The pilot, on a local stand-in

Run of 18 Nov 2026, declared on #2711: V1's world at even load (200 bodies), the origin, two stand-in nodes, 600 s
per arm, one run each, readers in 4 processes, all on one laptop with other work running (timing rows indicative).

| | 200 readers | 2,000 readers |
|---|---|---|
| Parts written and read (every one checksummed: SHA-256 = ETag, one digest per number) | 1,200 | 1,200 |
| Reader requests (pointer + parts); a second per reader | 359,822; 3.00 | 3,597,422; 3.00 |
| Errors, bad checksums, numbers with two digests | 0, 0, 0 | 0, 0, 0 |
| **Origin requests per part, max (mean); bar: at most 2, the nodes** | **2 (1.998)** | **2 (1.998)** |
| Origin pointer requests (about one a second a node) | 1,196 | 1,202 |
| **Origin processor seconds; bar: under 10 % apart** | **0.894** | **0.832** (7 % below) |
| Misses collapsed at the nodes | 180 | 4,634 |
| Lateness after the part's end, p50 / p90 / p99 / max | 1.02 / 1.58 / 1.89 / 2.52 s | 1.01 / 1.57 / 1.91 / 5.18 s |
| Late past the 2 s playback delay | 0.11 % | 0.56 % |
| Body bytes a reader second; header bytes a response | 17,836; 294 | 17,830; 294 |
| The check (headers through node 1; part N+1 early: 404 `no-store`; on time, 1.0 s later: 200, whole) | pass | pass |

Lateness is about one second at the median because the pointer may be one second old and a reader asks once a
second; the tail at 2,000 is this laptop serving 6,000 requests a second to itself. The stand-in shows the rules hold
(origin load flat in readers, nothing kept that should not be); it says nothing about a CDN's own behaviour.

## Fact 1, recomputed from V1's part period

V1 kept the period at 0.5 s, so the request count is Fact 1's: two parts and one pointer a second is 3 requests a
viewer-second (the pilot measured 3.00), 60,000 a second for 20,000 viewers, and 19.4 billion a month for 1.8
million viewer-hours (3 h a day). Quarter-second parts with two pointer reads would double it: 120,000 a second, 39
billion a month.

Bytes: response headers measured 294 bytes, so 0.9 kB a viewer-second, 5.7 TB a month. With Fact 1's 8 to 10 kB/s
of parts that is 58 to 71 TB a month. V1's own test world (200 bodies, 40 motion samples a tick) measured 17.8 kB/s
of parts (8.9 kB a part), which would be 121 TB a month and 3.0 Gbit/s at peak; Fact 10's caveat stands (the real
stream's size is not known until a world of Eden's kind runs on it). The question below uses about 60 to 120 TB.

## The question for the CDN (drafted for the owner to send)

To: the CDN's sales or support. From: the owner (a lane never writes to a vendor).

> We serve live data to web viewers as small immutable binary files: about 5 to 10 kB each, no file extension,
> `Cache-Control: public, max-age=31536000, immutable, no-transform`, and per stream one small pointer file with
> `max-age=1`. A viewer asks for two files and the pointer each second. At our goal of 20,000 concurrent viewers,
> about 3 hours a day, that is 60,000 requests a second at peak (120,000 if we halve the file period), 19 to 39
> billion requests a month and about 60 to 120 TB a month, response headers included.
>
> 1. Is this traffic within your terms on the plan you would suggest, and what would it cost a month, requests and
>    bytes?
> 2. Can errors be left uncached, honouring the origin's `no-store` on a 404?
> 3. Are concurrent misses for one URL collapsed into one origin request, and is there a shield, so a file is fetched
>    from the origin once rather than once per edge location?
> 4. Can extensionless files be cached, with the query string left out of the cache key?
> 5. Will the bytes be served as sent (no recompression), given `no-transform`?
> 6. May we run a load test of 200 and then 2,000 scripted readers for ten minutes each, in a window you agree, and
>    what notice do you need?
> 7. Are response headers billed as bytes?

## The test through a named CDN (the owner's steps)

A3 and A4 wait for C4 (#2636). With a CDN named and its test window given:

1. On a machine the CDN can reach, start a live world and the origin over its files, a fresh origin for each arm (it
   prints its counts when stopped): `v2/target/release/stream-check world <work dir> 700 even` (it prints
   `stream <path>`), and `node v2/tools/origin/origin.mjs <work dir>/www <port> <listen address>`.
2. Point a pull zone at that origin with the rules in "What a cache in front must do": key on the path, errors not
   kept, misses collapsed, the shield on if there is one, extensionless files cached, no transform.
3. From another machine: `node v2/tools/readers/check.mjs https://<CDN address> <stream path>` must print
   `"pass":true` (A4 and the header check).
4. From one or more other machines: `node v2/tools/readers/readers.mjs https://<CDN address> <stream path> 200 600 4`,
   then stop the origin with Ctrl-C and keep its `stats` line; then the same with 2,000 readers on a fresh world and
   origin. A3 holds when `perPartMax` is at most the number of edge locations that served (1 with a shield) in both
   arms and the two `cpuSeconds` differ by under 10 %.
5. Post the table on #2711 in the form of the pilot's. The CDN's name may be published; an account id, an address
   or a machine's name may not.
