#!/bin/bash
# cams.sh <tag> <world url> <stand x,z> <bay x,z> <seconds> [orbit r] [bay x,z] [front/pass z scale]: the five live
# cameras on a yard (wide with sky, front, pass, an orbit round the builders, an orbit round the bay), detached; each
# records to <this folder>/<tag>/<cam>.webm until <seconds> or until <cam>.webm.stop exists (post.sh <tag>).
set -u
cd "$(dirname "$0")"
T=$1 U=$2 S=$3 B=$4 SECS=$5 R=${6:-13} C=${7:-$4} PZ=${8:-1}
mkdir -p "$T"
IFS=, read SX SZ <<< "$S"; IFS=, read BX BZ <<< "$B"; IFS=, read CX CZ <<< "$C"
MX=$(echo "($SX+$BX)/2" | bc -l); MZ=$(echo "($SZ+$BZ)/2" | bc -l)
f() { printf '%.2f' "$(echo "$1" | bc -l)"; }
cam() { # name json
  nohup node cam.mjs --url "$U" --out "$T/$1.webm" --seconds "$SECS" --mime "video/webm;codecs=h264,opus" --mbps 10 --cam "$2" > "$T/$1.log" 2>&1 &
  echo "$1 $!"
}
cam orbit "{\"name\":\"orbit\",\"move\":\"orbit\",\"c\":[$(f $MX),$(f $MZ)],\"r\":$R,\"h\":3.4,\"look\":1.2,\"fov\":46,\"period\":36,\"phase\":90}"
cam orbitbay "{\"name\":\"orbitbay\",\"move\":\"orbit\",\"c\":[$(f $CX),$(f $CZ)],\"r\":8.5,\"h\":2.6,\"look\":1.4,\"fov\":44,\"period\":30,\"phase\":60,\"dir\":-1}"
cam front "{\"name\":\"front\",\"move\":\"drift\",\"p1\":[$(f "$BX+3"),1.6,$(f "$MZ+7.5*$PZ")],\"p2\":[$(f "$BX+1"),1.7,$(f "$MZ+5*$PZ")],\"t1\":[$(f "$SX+2"),1.2,$(f $MZ)],\"t2\":[$(f "$SX+3"),1.2,$(f $MZ)],\"fov\":40,\"period\":50}"
cam pass "{\"name\":\"pass\",\"move\":\"pass\",\"a\":[$(f "$SX-8"),$(f "$MZ+9*$PZ")],\"b\":[$(f "$BX+8"),$(f "$MZ+9*$PZ")],\"ta\":[$(f "$SX-3"),$(f $MZ)],\"tb\":[$(f "$BX+3"),$(f $MZ)],\"h\":1.9,\"ty\":1.2,\"fov\":42,\"period\":50}"
cam wide "{\"name\":\"wide\",\"move\":\"drift\",\"p1\":[$(f "$MX-17"),3.2,$(f "$MZ+20")],\"p2\":[$(f "$MX-11"),2.8,$(f "$MZ+15")],\"t1\":[$(f $MX),2.2,$(f "$MZ-3")],\"t2\":[$(f $MX),2.0,$(f "$MZ-2")],\"fov\":40,\"period\":120}"
