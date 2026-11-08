#!/usr/bin/env bash
# ship.sh's rehearse step, on the host (#1402; first run by hand for 4.16 and 4.16.1): boot a COPY of every world's database
# with the STAGED release tree, before anything goes live, with boot-rehearsal.mjs (#1323).
#   bash -s -- <staged release dir> <data dir> <scratch parent> [<meminfo file, default /proc/meminfo: a test seam>] < host-rehearse.sh
# Read-only on production: each world's sim.db is opened read-only and copied (SQLite online backup) into a new
# directory of this run's own (mktemp -d under <scratch parent>), removed with everything in it when the run ends; nothing
# else is ever deleted. No database byte or row leaves the host: stdout carries one JSON
# summary line per world (ids, rules headers, hashes, timings, verdicts) and a final REHEARSE line.
# The world's reader, as its process would open it:
#   running main.ts child  -> --from-pid <its pid> (its spawn environment, read in the tool's process only, never printed)
#   main.ts world asleep   -> the launcher's own defaultCommand() environment for it, from the staged tree's children.mjs
#   eden fork              -> the descriptor's worldId + the Eden core readers edge-server.mjs opens, SIM_SOULS_REPAIR=0
#   other fork, or a data directory the registry doesn't name -> "approximate": recorded, never a verdict
# Each rehearsal runs in a transient scope (systemd-run --scope, MemoryMax = MemAvailable - 3 GB, above the launcher's
# 2.5 GB --min-free-mb wake floor; no swap; CPUQuota 150%) with oom_score_adj 1000 (choom), so under memory pressure the
# kernel takes the rehearsal first, never the launcher or a world; fallback prlimit --as, said so.
# Verdict per world: pass (exit 0, running); stop (refused, halted, would not boot, out of memory or a tool failure:
# unknown is never a pass); approximate worlds are reported, never stop. A boot over 60 s is flagged slow (activate.sh
# allows 90 s), not stopped. Exit 0: every verdict world passed; 2: at least one stop; 1: the rehearsal could not run.
# Reads no operator variable: everything comes from its arguments (tests: tools/world-launcher/ship-root.test.mjs).
set -uo pipefail
REL="${1:?release dir}"; DATA="${2:?data dir}"; PARENT="${3:?scratch parent}"; MEMINFO="${4:-/proc/meminfo}"
for f in tools/world-launcher/deploy/boot-rehearsal.mjs tools/world-launcher/children.mjs apps/server/src/main.ts node_modules; do
  [ -e "$REL/$f" ] || { echo "the staged tree has no $f"; exit 1; }
done
[ -f "$DATA/worlds.json" ] || { echo "no worlds.json in the data dir"; exit 1; }
case "$PARENT/" in "$DATA"/*) echo "the scratch parent must lie outside the data dir"; exit 1;; esac
W="$(mktemp -d "$PARENT/sim-rehearse-XXXXXX")" || { echo "cannot make a scratch dir"; exit 1; }
# only this run's own directory, created just above, is ever removed
trap 'rm -rf -- "$W"' EXIT
mkdir -p "$W/results" "$W/env" && chmod 700 "$W" || exit 1
cd "$REL" || exit 1
echo "tree $(cat BUILD 2>/dev/null); node $(node --version)"
# the plan: one line per world, Eden first: slug<TAB>kind<TAB>db<TAB>source args
node --no-warnings --input-type=module - "$DATA" "$W/env" > "$W/plan.tsv" <<'JS' || { echo "planning failed"; exit 1; }
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultCommand } from './tools/world-launcher/children.mjs';
const [data, envDir] = process.argv.slice(2);
const worlds = JSON.parse(readFileSync(join(data, 'worlds.json'), 'utf8')).worlds;
const kids = existsSync(join(data, 'children.json')) ? JSON.parse(readFileSync(join(data, 'children.json'), 'utf8')) : {};
const cmdline = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '); } catch { return ''; } };
// secrets never reach the env files: the rehearsal runs fake minds and opens no provider
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;   // a slug names a file below; anything else is written nowhere (the loop stops it)
const envFile = (slug, env) => { if (!SLUG.test(slug)) return '/dev/null'; const f = join(envDir, `${slug}.env`); writeFileSync(f, Object.entries(env).filter(([k, v]) => v != null && k !== 'PATH' && k !== 'HOME' && !/_API_KEY$|SECRET|TOKEN|SITE_KEY|PASSWORD/.test(k)).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 }); return f; };
const rows = [], seen = new Set();
for (const w of [...worlds].sort((a, b) => (b.slug === 'eden') - (a.slug === 'eden'))) {
  const dataSlug = w.dataSlug ?? w.slug, db = join(data, 'worlds', dataSlug, 'sim.db'); seen.add(dataSlug);
  const kid = kids[w.slug], cl = kid?.pid ? cmdline(kid.pid) : '';
  if (w.fork) {
    const d = JSON.parse(readFileSync(resolve(w.fork.descriptor), 'utf8')), key = d.worldKey ?? 'eden';
    const env = key === 'eden'
      ? { WORLD_KEY: 'eden', WORLD_ID: d.worldId, ENGINE: 'mars', ENABLE_EDEN_CORE: '1', ENABLE_EDEN_LIFE: '1', ENABLE_EDEN_NEWCOMER_READER: '1', ENABLE_NATIVE_SLEEP_SNAPSHOT_READER: '1', ENABLE_EDEN_LECTURE_READER: '1', ENABLE_EDEN_EXPANSION_GROUND_READER: '1', MIND_DRIVER: 'edge', SIM_SOULS_REPAIR: '0' }
      : { WORLD_KEY: key, WORLD_ID: d.worldId, ENGINE: 'mars', MIND_DRIVER: 'edge', SIM_SOULS_REPAIR: '0' };
    rows.push([w.slug, key === 'eden' ? 'fork-eden' : `fork-${key}-approximate`, db, `--env-file ${envFile(w.slug, env)}`]);
  } else if (kid?.pid && cl.includes('apps/server/src/main.ts')) rows.push([w.slug, 'main-running', db, `--from-pid ${kid.pid}`]);
  else rows.push([w.slug, 'main-asleep', db, `--env-file ${envFile(w.slug, defaultCommand({ ...w, dataDir: join(data, 'worlds', dataSlug), bodyCollectionPath: join(data, 'body-collections.sqlite') }, 0, {}).env)}`]);
}
for (const dir of existsSync(join(data, 'worlds')) ? readdirSync(join(data, 'worlds')).sort() : []) {
  const db = join(data, 'worlds', dir, 'sim.db');
  if (seen.has(dir) || !existsSync(db)) continue;
  let id = null; try { const c = new DatabaseSync(db, { readOnly: true }); const r = c.prepare('SELECT id FROM worlds').all(); c.close(); id = r.length === 1 ? r[0].id : null; } catch {}
  rows.push([dir, 'unregistered-approximate', db, id ? `--env-file ${envFile(dir, { WORLD_KEY: dir, WORLD_ID: id, ENGINE: 'mars', ENABLE_WORLD_ENGINE: '1', SOUL_LIFECYCLE: '1' })}` : '--env WORLD_KEY=unknown']);
}
for (const r of rows) console.log(r.join('\t'));
JS
echo "plan: $(wc -l < "$W/plan.tsv") world(s)"
if systemd-run --scope --quiet -p MemoryMax=64M -p MemorySwapMax=0 -p CPUQuota=150% -- true < /dev/null 2>/dev/null; then LIMIT=scope; echo "limits: systemd-run scope"
elif command -v prlimit >/dev/null; then LIMIT=prlimit; echo "limits: FALLBACK prlimit --as (caps address space, not resident memory)"
else echo "no systemd-run scope and no prlimit: refusing to rehearse without a memory cap"; exit 1; fi
RESERVE_MB=3072; OOMFIRST=(); command -v choom >/dev/null && OOMFIRST=(choom -n 1000 --)
[ ${#OOMFIRST[@]} -gt 0 ] || echo "no choom: the rehearsal keeps the default OOM score"
stops=0; n=0
while IFS=$'\t' read -r slug kind db src; do
  n=$((n + 1))
  # the slug names files in the scratch dir: anything but a plain slug is a stop, never a path
  if ! [[ "$slug" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then printf '{"slug":"invalid-%s","kind":"invalid","verdict":"stop","flags":["a world slug that is not ^[a-z0-9][a-z0-9_-]*$"]}\n' "$n"; stops=$((stops + 1)); continue; fi
  mem=$(awk '/MemAvailable/{print int($2/1024)}' "$MEMINFO"); cap=$(( mem - RESERVE_MB ))
  if [ "$cap" -lt 1024 ]; then
    printf '{"slug":"%s","kind":"%s","verdict":"stop","flags":["memory: MemAvailable %s MB leaves under 1 GB above the %s MB kept for production"]}\n' "$slug" "$kind" "$mem" "$RESERVE_MB"; stops=$((stops + 1)); continue
  fi
  heap=""; case "$src" in --from-pid*) heap=$(tr '\0' '\n' < "/proc/${src#--from-pid }/cmdline" 2>/dev/null | sed -n 's/^--max-old-space-size=\([0-9]*\)$/\1/p' | head -1);; esac
  [ -n "$heap" ] || heap=$(( cap - 256 < 4096 ? cap - 256 : 4096 ))
  rm -rf "${W:?}/$slug"
  # shellcheck disable=SC2206
  RUN=(${OOMFIRST[@]+"${OOMFIRST[@]}"} nice -n 10 node --no-warnings "--max-old-space-size=$heap" tools/world-launcher/deploy/boot-rehearsal.mjs --db "$db" --scratch "$W/$slug" $src --ticks 1200)
  t0=$(date +%s)
  if [ "$LIMIT" = scope ]; then systemd-run --scope --quiet -p MemoryMax="${cap}M" -p MemorySwapMax=0 -p CPUQuota=150% -- "${RUN[@]}" > "$W/results/$slug.json" 2> "$W/results/$slug.err" < /dev/null
  else prlimit --as=$(( cap * 1048576 )) -- "${RUN[@]}" > "$W/results/$slug.json" 2> "$W/results/$slug.err" < /dev/null; fi
  rc=$?; secs=$(( $(date +%s) - t0 ))
  oom=0; if [ "$rc" = 137 ] || grep -q 'heap out of memory\|Allocation failed' "$W/results/$slug.err" 2>/dev/null; then oom=1; fi
  rm -rf "${W:?}/$slug"
  node -e '
    const [f, slug, kind, rc, secs, oom, cap, heap] = process.argv.slice(1); let o = {};
    try { o = JSON.parse(require("fs").readFileSync(f, "utf8").trim().split("\n").at(-1)); } catch {}
    const b = o.boot ?? {}, a = o.adoption ?? {}, r = o.run ?? {}, err = String(o.error ?? ""), exit = Number(rc);
    const noBoot = /SnapshotError|snapshot\.[a-z-]+|history rules are incompatible|clock-frontier\./.test(err);
    const flags = [b.ms > 60000 ? `slow boot ${b.ms} ms (activate.sh allows 90 s per world)` : null,
      oom === "1" ? `out of memory at the ${cap} MB cap or the ${heap} MB heap` : null,
      exit === 2 ? "refused or halted" : null,
      exit === 1 && noBoot ? `would not boot (${(err.match(/snapshot\.[a-z-]+|clock-frontier\.[a-z-]+|history rules are incompatible/) ?? ["boot"])[0]})` : null,
      exit !== 0 && exit !== 2 && !noBoot && oom !== "1" ? "the rehearsal tool failed" : null].filter(Boolean);
    const verdict = exit === 0 && o.ok === true && o.run?.state === "running" ? "pass" : kind.endsWith("-approximate") ? "approximate" : "stop";
    console.log(JSON.stringify({ slug, kind, verdict, exit, wallS: Number(secs), capMb: Number(cap), heapMb: Number(heap), flags,
      world: o.world && { id: o.world.id, key: o.world.key, header: o.world.header },
      boot: o.boot && { from: b.from, replayed: b.replayed, ms: b.ms, tick: b.head?.tick },
      adoption: o.adoption && { result: a.result, reason: a.reason ?? null, tick: a.tick, header: a.header },
      run: o.run && { ticks: r.ticks, state: r.state, halt: r.halt, msPerTick: r.msPerTick, glitches: r.glitches?.total, rewinds: r.rewinds, repairCount: r.repairCount, violations: r.violations?.length, hashBefore: a.head?.engine, hashAfter: r.head?.engine },
      error: err ? err.split("\n")[0].slice(0, 200) : undefined }));
    process.exit(verdict === "stop" ? 2 : 0);
  ' "$W/results/$slug.json" "$slug" "$kind" "$rc" "$secs" "$oom" "$cap" "$heap" || stops=$((stops + 1))
done < "$W/plan.tsv"
echo "REHEARSE {\"worlds\":$n,\"stops\":$stops}"
[ "$n" -gt 0 ] || { echo "no world to rehearse"; exit 1; }
[ "$stops" = 0 ] || exit 2
exit 0
