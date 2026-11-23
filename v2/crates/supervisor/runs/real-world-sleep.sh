#!/usr/bin/env bash
# S3b (0.133; O2, #2731): a real world sleeps. Imported Eden (`v2/tools/import-eden` facts) seeded with 3 Souls and no
# agent acting, served by `worldd serve --sleep`, its gateway with `--wake`, and the machine's alarm daemon
# (`supervisor alarms`) starting the world through SUPERVISOR_WAKE (this script, standing in for systemd's start). The
# wind-down's clocks are shortened (WORLDD_WIND_DOWN, wander after 150 s) so a due change comes a few minutes in. One
# agent waves at S3B_ACT_AT s (default 480) of the driver's clock, while the world sleeps. It prints the timeline
# (each start, sleep and alarm), how late the world's first write came after each alarm's due time, and the wave's
# time to its first answer. Local only: loopback ports, its own folder (S3B_ROOT, default <repo>/.local/s3b); it stops
# only the processes it started, by pid. Build first, from v2/:
#   cargo build --release -p worldd -p gatewayd -p supervisor -p driver
# and export the facts: node v2/tools/import-eden/export/export.ts --out <S3B_ROOT>/eden-2026.facts.json
set -euo pipefail
V2=$(cd "$(dirname "$0")/../../.." && pwd)
ROOT=${S3B_ROOT:-$V2/../.local/s3b}
BIN=${CARGO_TARGET_DIR:-$V2/target}/release
R=$ROOT/run
SELF=$V2/crates/supervisor/runs/real-world-sleep.sh

stamp() { python3 -u -c 'import sys,time
for l in sys.stdin: print("%.3f %s" % (time.time(), l), end="", flush=True)'; }

# A world's start, detached; its pid in worldd.pid.
start() {
  WORLDD_WIND_DOWN=${S3B_WIND:-150,60,20,40,400} "$BIN/worldd" serve --dir "$R/worlds/$1" --socket "$R/w.sock" \
    --sleep "$R/alarms.sock" > >(stamp >> "$R/worldd.log") 2>&1 &
  echo $! > "$R/worldd.pid"
}

# The alarm daemon's SUPERVISOR_WAKE: it runs this with the world's name.
if [ -n "${S3B_WAKER:-}" ]; then
  start "$1"
  exit 0
fi

ACT_AT=${S3B_ACT_AT:-480}
PORT=${S3B_PORT:-47323}
pids=()
cleanup() {
  for p in "${pids[@]}" "$(cat "$R/worldd.pid" 2> /dev/null || true)"; do
    [ -n "$p" ] && kill "$p" 2> /dev/null || true
  done
}
trap cleanup EXIT

rm -rf "$R" && mkdir -p "$R/worlds" "$R/seed"
"$BIN/worldd" seed --facts "$ROOT/eden-2026.facts.json" --dir "$R/seed/w" --souls 3 > "$R/seed.log" 2>&1
NAME=$(sed -n 's/.*"name": *"\([0-9a-f-]*\)".*/\1/p' "$R/seed/w/world.json")
mv "$R/seed/w" "$R/worlds/$NAME"
echo "world: Eden 2026 imported, 3 Souls, no agent acting"

# The log's size, sampled every 50 ms: when the world writes.
python3 -u -c '
import os, sys, time
p, last = sys.argv[1], -1
while True:
    try: n = os.path.getsize(p)
    except OSError: n = -1
    if n != last: print("%.3f %d" % (time.time(), n), flush=True); last = n
    time.sleep(0.05)' "$R/worlds/$NAME/log" > "$R/log-sizes.txt" &
pids+=($!)
WORLDS_ROOT=$R SUPERVISOR_WAKE=$SELF S3B_WAKER=1 S3B_ROOT=$ROOT "$BIN/supervisor" alarms > >(stamp > "$R/alarms.log") 2>&1 &
pids+=($!)
for _ in $(seq 100); do [ -S "$R/alarms.sock" ] && break; sleep 0.1; done
start "$NAME"
for _ in $(seq 1200); do grep -q 'listening' "$R/worldd.log" 2> /dev/null && break; sleep 0.1; done
# The tokens beside a short path: the gateway's control socket goes beside them (a socket path is at most 104 bytes).
cp "$R/worlds/$NAME/tokens" "$R/tokens"
"$BIN/gatewayd" --listen "127.0.0.1:$PORT" --world "$R/w.sock" --tokens "$R/tokens" --build 1220 \
  --wake "$R/alarms.sock" --world-name "$NAME" > >(stamp > "$R/gatewayd.log") 2>&1 &
pids+=($!)
for _ in $(seq 100); do grep -q 'listening' "$R/gatewayd.log" 2> /dev/null && break; sleep 0.1; done
printf '# s3b: one wave at %s s\n%s 0 gesture eden:wave\n' "$ACT_AT" "$((ACT_AT * 1000))" > "$R/schedule.txt"
"$BIN/driver" --schedule "$R/schedule.txt" --dir "$R/driver" --tokens "$R/worlds/$NAME/souls.tokens" \
  --remote "ws://127.0.0.1:$PORT" > >(stamp > "$R/driver.out") 2>&1 || echo "driver exited $?"
sleep 2

python3 - "$R" << 'EOF'
import re, sys
r = sys.argv[1]
log = [(float(l.split(" ", 1)[0]), l.split(" ", 1)[1].rstrip()) for l in open(f"{r}/worldd.log") if " " in l]
t0 = log[0][0]
sizes = [tuple(map(float, l.split())) for l in open(f"{r}/log-sizes.txt")]
starts = [t for t, l in log if l.startswith("listening")]
sleeps = [(t, l) for t, l in log if l.startswith("asleep: next due")]
print("| event | s from the first start | detail |\n|---|---:|---|")
rows = [(t, "serving", "") for t in starts]
for t, l in sleeps:
    m = re.search(r"Some\((\d+)\)", l)
    rows.append((t, "asleep", f"alarm due at {int(m.group(1)) / 1e6 - t0:.1f} s" if m else "nothing due"))
for t, e, d in sorted(rows):
    print(f"| {e} | {t - t0:.1f} | {d} |")
print("\n| wake | due (s) | serving (s) | first write (s) | late (s) |\n|---|---:|---:|---:|---:|")
for k, (st, l) in enumerate(sleeps):
    nxt = [s for s in starts if s > st]
    m = re.search(r"Some\((\d+)\)", l)
    if not nxt:
        continue
    s = nxt[0]
    grow = next((t for (t, n), (_, p) in zip(sizes[1:], sizes) if t >= st + 0.5 and n > p), None)
    due = int(m.group(1)) / 1e6 if m else None
    if due is not None and due <= s + 60:
        print(f"| by its alarm | {due - t0:.1f} | {s - t0:.1f} | {grow - t0:.1f} | {grow - due:+.3f} |")
    else:
        print(f"| by an intent | - | {s - t0:.1f} | {grow - t0:.1f} | - |")
EOF
echo
grep -E 'p50|latency|receipt|refus|unanswered|error' "$R/driver.out" | head -12 || true
