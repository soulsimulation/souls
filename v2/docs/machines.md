# The machines, written down and sized (O14)

What Souls runs on, what the Engine v2 goal costs to run, and whether today's system and the new one fit on the
production machine together for the cut-over's rollback window. Task O14, #2696; tranche #2635. This page records and
prices. It buys nothing and touches no machine.

**Privacy.** Machines appear under neutral labels only. This page never names a machine's host, address, user,
provider or provider id; those stay in the owner's private record. The prices below come from public price lists,
and the page does not say which provider, if any, a machine on it is with.

## The facts line

`v2/tools/ops/machine-facts.sh` prints one line of a Linux machine's facts. It only reads (`/proc`, `/sys`, `nproc`,
`df`, `uname`, `stat`, `systemctl`) and writes nothing. It prints no host name, address, interface name or mount path,
and cuts the kernel release to its version number, since a provider's kernel release can name the provider. The owner
runs it on each machine and returns the line:

```sh
bash v2/tools/ops/machine-facts.sh
```

| Field | Meaning |
|---|---|
| `cores` | Processors online (`nproc --all`) |
| `mem_gb` | Memory, GiB |
| `disks` | Whole disks of 1 GB or more: size in GB, `ssd` or `hdd` as the kernel reports it |
| `fs_gb` | Real filesystems: `size:free` in GiB, largest first, no mount paths |
| `root_free_gb` | Free space on the root filesystem, GiB |
| `link_mbit` | Fastest physical interface's speed, Mbit/s (`unknown` for virtual links) |
| `kernel`, `systemd`, `cgroup` | Kernel version, systemd version (`none` if absent), cgroup `v2` or `v1` |

Its output on a Linux test machine (Ubuntu 24.04 with systemd, run read-only, 18 Nov 2026):

```text
machine-facts/1 cores=2 mem_gb=1.9 disks=107G-hdd,21G-hdd fs_gb=97:92 root_free_gb=92 link_mbit=unknown kernel=6.8.0 systemd=255 cgroup=v2
```

## The machines

From the coordinator's list. No facts line has come back yet; a returned line replaces "not yet recorded" in its row.

| Machine | Role | Cores | Memory | Disks, free | Link | Kernel, systemd, cgroup | Source |
|---|---|---|---|---|---|---|---|
| production host | Today's soul.game server; the new system's first home (X7) | not yet recorded | 31 GB, of which worlds may use 24 GB | not yet recorded | not yet recorded | not yet recorded | `docs/operations.md` (#2241) |
| runner host | Shared CI and timing machine | 48 CPUs, 4 GPUs | not yet recorded | not yet recorded | not yet recorded | not yet recorded | coordinator, 18 Nov 2026 |
| laptop A | Owner's development laptop | not yet recorded | not yet recorded | not yet recorded | not yet recorded | not yet recorded | |
| laptop B | Owner's development laptop | not yet recorded | not yet recorded | not yet recorded | not yet recorded | not yet recorded | |

The script reads Linux only; on macOS it prints `unsupported=Darwin`. O9's second machine, a faster link and O6's 24-hour runner are purchases on the owner's
checklist, not machines on this list.

**What the production host already covers** (`docs/operations.md`, nothing it does not publish): its worlds may use
24 GB of its 31 GB. At 24 GB that is 90 small worlds or 39 Eden-class worlds settled at once (250 and 575 MB each,
#2240), with up to 180 worlds known to it; unloaded worlds cost only disk. So today's host already carries the "100
quiet worlds" column in memory, with still worlds unloaded. Its cores, disk and link are not published.

## The goal, priced

Prices re-fetched 18 Nov 2026 from each source's live page; monthly, excluding tax. Sizing is carried from "Checked
facts" in `v2/docs/tranche/O-operations.md`: worked out when the engine was designed, none of it measured.

| Item | Price (18 Nov 2026) | Source |
|---|---|---|
| Dedicated server, 8 cores, 64 GB, 1 Gbit, unlimited traffic | €79 to €99 a month, €49 set-up | https://www.hetzner.com/dedicated-rootserver/matrix-ax/ |
| Dedicated server, 6 cores, 64 GB, 1 Gbit | €59 a month, no set-up | same |
| Dedicated server, 16 cores, 128 GB, 1 Gbit | €159 to €259 a month, €129 set-up | same |
| 10 Gbit link add-on for those servers | €43 a month; 20 TB out included, then €1 a TB; the addresses change | https://docs.hetzner.com/robot/general/pricing/price-list-for-additional-products https://docs.hetzner.com/robot/dedicated-server/network/10g-uplink/ |
| Dedicated server, 8 cores, 64 GB, 3 Gbit unmetered and guaranteed | $198 a month; set-up $198 | https://us.ovhcloud.com/bare-metal/advance/ |
| Object storage A | $0.015 a GB-month; writes $4.50 a million, reads $0.36 a million; no charge for bytes out; free each month 10 GB, 1 million writes, 10 million reads | https://developers.cloudflare.com/r2/pricing/ |
| Object storage B | $6.95 a TB-month; ordinary calls free; bytes out free to three times what is stored, then $0.01 a GB | https://www.backblaze.com/cloud-storage/pricing |
| Object storage C | €6.49 a month with 1 TB stored and 1 TB out; requests free; then €1 a TB out | https://www.hetzner.com/storage/object-storage/ |

| | One world: 1,000 agents, 20,000 viewers | 100 quiet worlds |
|---|---|---|
| Simulation and gateway | Under 2 cores (worked out), about 1 GB (a guess): one 8-core, 64 GB server, €79 to €99 | The same server. Asleep: nothing. All awake at 60 to 100 MB each: 6 to 10 GB of 64 |
| Viewers | 20,000 at 10 kB/s is 1.6 Gbit/s at peak; one 1 Gbit link carries about 12,000. 52 to 65 TB a month (worked out). Either the 10 Gbit add-on (€43 + €32 to €45 over 20 TB = €75 to €88), or one 3 Gbit server carrying everything ($198), or two to three 1 Gbit cache servers (€59 to €99 each), or a CDN with no request fee (V2 decides) | None |
| History | 0.75 GB a day, 274 GB a year: $4.11 a month on storage A, $1.90 on storage B, for each year kept | Under $1 |
| Uploads, one every 10 s while busy | 259,200 a month: inside storage A's free million (else $1.17); free on B and C | Near nothing |
| **Total a month** | **About €155 to €190 with the 1 Gbit server and the 10 Gbit add-on, or about $200 to $205 with the 3 Gbit server** | **About €80 to €100** |

Changed since 16 Nov: none of the prices. Corrected: uploads at goal load fit inside storage A's free million writes a
month. Carried over: today's capacity table (`docs/operations.md`). Changed in kind: for the goal, the link and requests
a second matter more than memory.

## Do both fit on the production host for the rollback window?

During X7's rollback window (proposed 72 hours) today's launcher still runs every world but Eden, and the new system
runs Eden. Each figure is marked **recorded** (published in `docs/operations.md`), **worked out** (arithmetic from the
design) or **not yet recorded**.

| Resource | Today's system, every world but Eden | New system, Eden | Sum | Production host has | Fits? |
|---|---|---|---|---|---|
| Memory | At most 26 GB: the unit's MemoryMax at the 24 GB setting (recorded) | About 1 GB at goal load (guess); Eden today settles at 575 MB (recorded) | At most 27 GB | 31 GB (recorded) | Yes on paper: 4 GB left for the system, Caddy and the gateway (worked out) |
| Cores | Not recorded | Under 2 at goal load (worked out) | Not known | Not yet recorded | Not known |
| Disk | Every world's data, with a 4,096 MB free-space guard (recorded) | Eden's content a second time, plus the new log: 0.75 GB a day, 2.25 GB in 72 h at goal load (worked out) | Today's use + Eden's size + 2.25 GB + 4 GB guard | Not yet recorded | Not known |
| Link | Today's viewers (not recorded) | Up to 1.6 Gbit/s at goal load (worked out); Eden's real viewers are far fewer during the window | Not known | Not yet recorded | Not known |

**Answer: not known until** the production host's facts line comes back (cores, free disk, link speed) and Eden's
content size on disk is recorded. Memory fits on paper. Both fit for the window at today's viewer load if the free disk is at
least Eden's content size plus about 6.5 GB (72 hours of log and the 4 GB guard) and two cores are free beyond today's
use; the goal's viewer load needs more than one 1 Gbit link whichever machine carries it.

## The owner's checklist

1. On the production host and the runner host (and the laptops, if wanted, where Linux), run `bash v2/tools/ops/machine-facts.sh` from a checkout and return the
   one line.
2. Return Eden's content size on disk on the production host.
3. Yes or no to the priced table.
4. Any purchase: a second machine for O9, a faster link, a 24-hour runner for O6.
