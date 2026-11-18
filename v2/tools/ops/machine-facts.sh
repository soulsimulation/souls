#!/usr/bin/env bash
# machine-facts.sh (Engine v2 O14, #2696): prints one line of a Linux machine's facts for v2/docs/machines.md.
# Read-only: it reads /proc, /sys and the output of nproc, df, uname, stat and systemctl, and writes nothing.
# It prints no host name, address, user, interface name, mount path or provider string (the kernel's release is cut
# to its version number, since a provider's kernel names the provider). Run as any user: bash machine-facts.sh
set -u
export LC_ALL=C

if [ "$(uname -s)" != Linux ]; then
  echo "machine-facts/1 unsupported=$(uname -s)"
  exit 0
fi

cores=$(nproc --all 2>/dev/null || getconf _NPROCESSORS_ONLN)
mem_gb=$(awk '/^MemTotal:/ { printf "%.1f", $2 / 1048576 }' /proc/meminfo)

# Whole disks of 1 GB or more: size in GB and ssd or hdd (as the kernel reports it), largest first.
disks=$(
  for d in /sys/block/*; do
    [ -e "$d/device" ] || continue
    gb=$(($(cat "$d/size" 2>/dev/null || echo 0) * 512 / 1000000000))
    [ "$gb" -gt 0 ] || continue
    kind=ssd
    [ "$(cat "$d/queue/rotational" 2>/dev/null)" = 1 ] && kind=hdd
    echo "$gb $kind"
  done | sort -rn | awk '{ printf "%s%sG-%s", (NR > 1 ? "," : ""), $1, $2 }'
)

# Real filesystems: size and free space in GB, largest first, without their mount paths; the root's free space apart.
fs=$(df -P -k -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs 2>/dev/null |
  awk 'NR > 1 && $1 ~ /^\// { printf "%d %d\n", $2 / 1048576, $4 / 1048576 }' | sort -rn | uniq |
  awk '{ printf "%s%s:%s", (NR > 1 ? "," : ""), $1, $2 }')
root_free_gb=$(df -P -k / 2>/dev/null | awk 'NR == 2 { printf "%d", $4 / 1048576 }')

# Link: the fastest physical interface's speed in Mbit/s (virtual interfaces and those with no carrier are skipped).
link=$(
  for n in /sys/class/net/*; do
    [[ $(readlink -f "$n") == */virtual/* ]] && continue
    s=$(cat "$n/speed" 2>/dev/null) || continue
    [ "${s:-0}" -gt 0 ] 2>/dev/null && echo "$s"
  done | sort -rn | head -1
)

kernel=$(uname -r | grep -oE '^[0-9]+\.[0-9]+(\.[0-9]+)?')
systemd=$(systemctl --version 2>/dev/null | awk 'NR == 1 { print $2 }')
case "$(stat -fc %T /sys/fs/cgroup 2>/dev/null)" in
  cgroup2fs) cgroup=v2 ;;
  tmpfs) cgroup=v1 ;;
  *) cgroup=unknown ;;
esac

echo "machine-facts/1 cores=${cores:-unknown} mem_gb=${mem_gb:-unknown} disks=${disks:-unknown}" \
  "fs_gb=${fs:-unknown} root_free_gb=${root_free_gb:-unknown} link_mbit=${link:-unknown}" \
  "kernel=${kernel:-unknown} systemd=${systemd:-none} cgroup=$cgroup"
