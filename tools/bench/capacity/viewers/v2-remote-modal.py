# #4985: one arm of remote readers on Modal. --viewers readers split into shares of at most --per-share, one machine
# each (its own address and link), all starting at one moment; each share runs v2-remote.mjs and returns its 10 s
# lines, written to --out as JSON lines tagged with the share. Summarise with v2-remote-report.mjs.
#
#   REMOTE_PKG=<replica wasm-bindgen pkg dir> modal run tools/bench/capacity/viewers/v2-remote-modal.py \
#       --base https://stream.example --stream /s/w/<world>/views/.../everyone/ --viewers 1000 --arm even \
#       [--secs 240] [--per-share 500] [--slow 20] [--headers browser|bare] --out <file.jsonl>
# REMOTE_CPU (default 2) is each machine's processor share: about 1 per 250 readers.
#
# Like people (#4985, 27 Nov): --machines M --by-address splits the readers evenly over the distinct addresses the
# machines get (Modal gives fewer addresses than machines; each machine reads Cloudflare's own trace, kept as a hash),
# and each address's readers over its machines, so the reads a second from one address are as few as the pool allows.
# --arrive-secs s: each reader arrives at its own random moment within s seconds (even arm). --stop-on-refusal: the
# first 403 or 429 on any machine stops every machine within about 10 s.
import hashlib
import json
import os
import signal
import subprocess
import threading
import time
import urllib.request

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


def address() -> str:
    """This machine's egress address as Cloudflare sees it (its own trace, not the tested zone), hashed."""
    try:
        t = urllib.request.urlopen("https://cloudflare.com/cdn-cgi/trace", timeout=10).read().decode()
        ip = dict(l.split("=", 1) for l in t.splitlines() if "=" in l).get("ip", "")
    except Exception:
        ip = ""
    return hashlib.sha256(ip.encode()).hexdigest()[:10] if ip else "unknown"


@app.function(cpu=float(os.environ.get("REMOTE_CPU", "2")), memory=int(os.environ.get("REMOTE_MEM", "2048")), timeout=1200)
def share(a: dict) -> list:
    i, viewers, addr, board = a["i"], a["viewers"], None, None
    if a.get("board"):
        board = modal.Dict.from_name(a["board"])
        addr = address()
        board[f"addr/{i}"] = addr
        if a.get("by_address"):  # the plan, made once by the launcher from every machine registered in time
            while (plan := board.get("plan")) is None and time.time() * 1000 < a["start_at"]:
                time.sleep(1)
            viewers = (plan or {}).get(str(i), 0)
    if not viewers:
        return [{"share": i, "addr": addr, "viewers": 0}]
    cmd = ["node", "/app/tools/bench/capacity/viewers/v2-remote.mjs", "--base", a["base"], "--stream", a["stream"], "--pkg", "/app/pkg",
           "--viewers", str(viewers), "--arm", a["arm"], "--secs", str(a["secs"]), "--procs", str(min(a["procs"], viewers)),
           "--slow", str(a["slow"]), "--start-at", str(a["start_at"]), "--headers", a["headers"]]
    if a.get("arrive_secs"):
        cmd += ["--arrive-secs", str(a["arrive_secs"])]
    if a.get("stop_on_refusal"):
        cmd += ["--stop-on-refusal"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    rows, stopped = [], None
    for x in proc.stdout:
        if not x.startswith("{"):
            continue
        r = json.loads(x)
        rows.append({"share": i, "addr": addr, **r})
        if board is not None and a.get("stop_on_refusal"):
            refused = [e for e in (r.get("errors") or {}) if " 403" in e or " 429" in e]
            if refused and not board.get("stop"):
                board["stop"] = f"share {i} at {r.get('t')} s: {refused[0]}"
            if board.get("stop"):
                stopped = board["stop"]
                os.killpg(proc.pid, signal.SIGKILL)  # the drivers too: no reader outlives the share
                break
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
    err = proc.stderr.read()[-2000:] if proc.returncode and not stopped else ""
    return rows + ([{"share": i, "stderr": err}] if err else []) + ([{"share": i, "stopped": stopped}] if stopped else [])


@app.local_entrypoint()
def main(base: str, stream: str, viewers: int, arm: str, out: str, secs: int = 240, per_share: int = 500, slow: int = 0, headers: str = "browser",
         machines: int = 0, by_address: bool = False, arrive_secs: int = 0, stop_on_refusal: bool = False, lead: int = 75, procs: int = 2):
    n = machines or max(1, -(-viewers // per_share))
    start_at = int(time.time() * 1000) + lead * 1000
    name = f"souls-remote-readers-{start_at}"
    board = modal.Dict.from_name(name, create_if_missing=True) if (by_address or stop_on_refusal) else None
    shares = [{"i": i, "base": base, "stream": stream, "arm": arm, "headers": headers, "secs": secs, "start_at": start_at,
               "viewers": viewers // n + (1 if i < viewers % n else 0), "procs": procs, "slow": slow // n + (1 if i < slow % n else 0),
               "board": name if board is not None else None, "by_address": by_address, "arrive_secs": arrive_secs, "stop_on_refusal": stop_on_refusal} for i in range(n)]
    head = {"arm": arm, "viewers": viewers, "shares": n, "secs": secs, "start_at": start_at, "slow": slow, "headers": headers, "arriveSecs": arrive_secs or None}
    done = threading.Event()

    def plan_and_watch():
        if by_address:  # 20 s before the start: readers per address, then per machine on it
            while time.time() * 1000 < start_at - 20_000 and not done.is_set():
                time.sleep(1)
            reg = {int(k[5:]): v for k, v in board.items() if k.startswith("addr/")}
            addrs = sorted(set(reg.values()))
            plan = {}
            for j, ad in enumerate(addrs):
                per = viewers // len(addrs) + (1 if j < viewers % len(addrs) else 0)
                mates = sorted(k for k, v in reg.items() if v == ad)
                for m, k in enumerate(mates):
                    plan[str(k)] = per // len(mates) + (1 if m < per % len(mates) else 0)
            board["plan"] = plan
            head.update(registered=len(reg), addresses=len(addrs), perAddressMax=max(viewers // len(addrs) + 1, 0) if addrs else 0)
            print(f"plan: {len(reg)} of {n} machines registered, {len(addrs)} addresses, {viewers} readers", flush=True)
        while not done.wait(10):
            if board is not None and (s := board.get("stop")):
                print(f"STOP {s}", flush=True)
                return

    watcher = threading.Thread(target=plan_and_watch, daemon=True)
    watcher.start()
    rows_all = [r for rows in share.map(shares) for r in rows]
    done.set()
    if board is not None:
        head["stopped"] = board.get("stop")
        try:
            modal.Dict.objects.delete(name)
        except Exception:
            modal.Dict.delete(name)
    with open(out, "w") as f:
        f.write(json.dumps(head) + "\n")
        for r in rows_all:
            f.write(json.dumps(r) + "\n")
