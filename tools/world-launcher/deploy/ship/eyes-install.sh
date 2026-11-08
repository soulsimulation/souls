#!/usr/bin/env bash
# release.sh's stage, on the host, after the release's dependencies are installed (#1340): give Eyes the Chromium this
# release's Playwright expects, so a release that bumps Playwright never goes live with Eyes unable to launch.
#   bash -s -- <staged release dir> <stage> < eyes-install.sh
# Eyes' settings are the running keeper's own (sim-worlds@<stage>'s main process): only EDGE_EYES, PLAYWRIGHT_BROWSERS_PATH
# and EDGE_EYES_CHROME are read from its environment, and nothing else is printed. Eyes off: nothing to do. Eyes on:
# eyes-browser.mjs --install, as the worlds' user, installs the expected revision when it is missing (never removes one)
# and checks it. Exit 0: Eyes has its browser (or is off); 1: the install or the check failed, and the stage stops.
set -uo pipefail
REL="${1:?release dir}"; STAGE="${2:?stage}"
case "$STAGE" in *[!a-z0-9-]*) echo "eyes: bad stage"; exit 1;; esac
PID="$(systemctl show -p MainPID --value "sim-worlds@$STAGE" 2>/dev/null)"
if [ -z "$PID" ] || [ "$PID" = 0 ] || [ ! -r "/proc/$PID/environ" ]; then echo "eyes: sim-worlds@$STAGE is not running; its Eyes settings are unknown, so the browser is not checked"; exit 0; fi
key() { tr '\0' '\n' < "/proc/$PID/environ" | sed -n "s/^$1=//p" | tail -1; }
EYES="$(key EDGE_EYES)"; BROWSERS="$(key PLAYWRIGHT_BROWSERS_PATH)"; CHROME="$(key EDGE_EYES_CHROME)"
if [ "$EYES" != world ]; then echo "eyes: off on $STAGE (EDGE_EYES=${EYES:-unset}); no browser needed"; exit 0; fi
[ -n "$BROWSERS" ] || { echo "eyes: on, but PLAYWRIGHT_BROWSERS_PATH is not set for sim-worlds@$STAGE: set it in the unit, so the browser has a known home"; exit 1; }
echo "eyes: on; browsers in $BROWSERS"
sudo -u simworlds -H env PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" ${CHROME:+EDGE_EYES_CHROME="$CHROME"} \
  node "$REL/tools/world-launcher/deploy/eyes-browser.mjs" --tree "$REL" --install
