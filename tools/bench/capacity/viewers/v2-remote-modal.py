# #4985: one arm of remote readers on Modal. --viewers readers split into shares of at most --per-share, one machine
# each (its own address and link), all starting at one moment; each share runs v2-remote.mjs and returns its 10 s
# lines, written to --out as JSON lines tagged with the share. Summarise with v2-remote-report.mjs.
#
#   REMOTE_PKG=<replica wasm-bindgen pkg dir> modal run tools/bench/capacity/viewers/v2-remote-modal.py \
#       --base https://stream.example --stream /s/w/<world>/views/.../everyone/ --viewers 1000 --arm even \
#       [--secs 240] [--per-share 500] [--slow 20] --out <file.jsonl>
import json
import os
import subprocess
import time

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "../../../.."))
PKG = os.environ.get("REMOTE_PKG", "")  # the page's replica package (replica.js, replica_bg.wasm), as the world serves it

image = modal.Image.from_registry("node:22-bookworm-slim", add_python="3.12")
for f in ("v2-remote.mjs", "v2-readers.mjs", "v2-stats.mjs"):
    image = image.add_local_file(os.path.join(HERE, f), f"/app/tools/bench/capacity/viewers/{f}", copy=True)
image = image.add_local_file(os.path.join(ROOT, "apps/web/src/v2-engine/source/clock.ts"), "/app/apps/web/src/v2-engine/source/clock.ts", copy=True)
if PKG:
    image = image.add_local_dir(PKG, "/app/pkg", copy=True)

app = modal.App("souls-remote-readers", image=image)


@app.function(cpu=2.0, memory=2048, timeout=1200)
def share(a: dict) -> list:
    cmd = ["node", "/app/tools/bench/capacity/viewers/v2-remote.mjs", "--base", a["base"], "--stream", a["stream"], "--pkg", "/app/pkg",
           "--viewers", str(a["viewers"]), "--arm", a["arm"], "--secs", str(a["secs"]), "--procs", str(a["procs"]),
           "--slow", str(a["slow"]), "--start-at", str(a["start_at"])]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=a["secs"] + 600)
    lines = [json.loads(x) for x in out.stdout.splitlines() if x.startswith("{")]
    return [{"share": a["i"], **x} for x in lines] + ([{"share": a["i"], "stderr": out.stderr[-2000:]}] if out.returncode else [])


@app.local_entrypoint()
def main(base: str, stream: str, viewers: int, arm: str, out: str, secs: int = 240, per_share: int = 500, slow: int = 0):
    n = max(1, -(-viewers // per_share))
    start_at = int(time.time() * 1000) + 75_000
    shares = [{"i": i, "base": base, "stream": stream, "arm": arm, "secs": secs, "start_at": start_at,
               "viewers": viewers // n + (1 if i < viewers % n else 0), "procs": 2, "slow": slow // n + (1 if i < slow % n else 0)} for i in range(n)]
    with open(out, "w") as f:
        f.write(json.dumps({"arm": arm, "viewers": viewers, "shares": n, "secs": secs, "start_at": start_at, "slow": slow}) + "\n")
        for rows in share.map(shares):
            for r in rows:
                f.write(json.dumps(r) + "\n")
