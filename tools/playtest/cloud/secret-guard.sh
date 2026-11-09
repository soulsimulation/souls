#!/usr/bin/env bash
# secret-guard.sh <dir>: names the files under <dir> that hold a token-shaped string, and exits 3 if any do (#1131).
# 0 means none was found; anything else means don't publish, including a scan that couldn't run.
set -uo pipefail
[ -d "${1:-}" ] || { echo "usage: secret-guard.sh <dir>" >&2; exit 2; }
# Soul tokens are sim_<soul id>_<digest> (apps/server/src/auth.ts, accounts/store.ts)
grep -rIlE 'sk-ant-[A-Za-z0-9_-]{20,}|sk-or-[A-Za-z0-9_-]{20,}|sim_[A-Za-z0-9_-]{30,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|gho_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----' "$1"
case $? in 0) exit 3 ;; 1) exit 0 ;; *) exit 2 ;; esac
