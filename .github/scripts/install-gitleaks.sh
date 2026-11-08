#!/usr/bin/env bash
# Installs gitleaks $GITLEAKS_VERSION into "$1" for security.yml (#1373). GitHub release downloads can fail for runners for
# hours (HTTP 504, Nov 8 2026), so the same pinned version is tried from three sources in turn, each verified on its own:
#   release  the GitHub release tarball, with retries; sha256 must equal $GITLEAKS_SHA256
#   image    the official container image, pinned by digest in $GITLEAKS_IMAGE (docker verifies it); the binary is copied out
#   module   go install from the Go module proxy; the module's h1: sum must equal $GITLEAKS_MODULE_SUM
# Whatever the source, the binary must then report $GITLEAKS_VERSION. If no source gives one, this exits 1: the scan never
# runs without a verified binary, and it is never skipped.
set -uo pipefail
dir=${1:?usage: install-gitleaks.sh <dir>}
: "${GITLEAKS_VERSION:?}" "${GITLEAKS_SHA256:?}" "${GITLEAKS_IMAGE:?}" "${GITLEAKS_MODULE_SUM:?}"
bin="$dir/gitleaks" tarball="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" module=github.com/zricethezav/gitleaks/v8

from_release() {
  curl -sSfL --retry 8 --retry-delay 15 --retry-all-errors --max-time 120 -o "$dir/$tarball" \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/$tarball" &&
    echo "$GITLEAKS_SHA256  $dir/$tarball" | sha256sum -c - &&
    tar -xzf "$dir/$tarball" -C "$dir" gitleaks
}
from_image() {
  local i cid ok=1
  for i in 1 2 3; do docker pull -q "$GITLEAKS_IMAGE" && break; [ "$i" = 3 ] && return 1; sleep 20; done
  cid=$(docker create "$GITLEAKS_IMAGE") || return 1
  docker cp "$cid:/usr/bin/gitleaks" "$bin" && ok=0
  docker rm "$cid" >/dev/null
  return $ok
}
from_module() {
  GOBIN="$dir/gobin" GOTOOLCHAIN=auto go install -ldflags "-X $module/version.Version=v${GITLEAKS_VERSION}" "$module@v${GITLEAKS_VERSION}" &&
    [ "$(go version -m "$dir/gobin/gitleaks" | awk -v m="$module" '$1 == "mod" && $2 == m { print $3, $4 }')" = "v${GITLEAKS_VERSION} ${GITLEAKS_MODULE_SUM}" ] &&
    cp "$dir/gobin/gitleaks" "$bin"
}

for src in release image module; do
  rm -f "$bin"
  if "from_$src" && [ -x "$bin" ] && [ "$("$bin" version)" = "$GITLEAKS_VERSION" -o "$("$bin" version)" = "v$GITLEAKS_VERSION" ]; then
    echo "gitleaks $GITLEAKS_VERSION installed from the $src"
    exit 0
  fi
  echo "::warning::gitleaks $GITLEAKS_VERSION from the $src failed or did not verify; trying the next source"
done
rm -f "$bin"
echo "::error::no verified gitleaks $GITLEAKS_VERSION from any source; the scan cannot run"
exit 1
