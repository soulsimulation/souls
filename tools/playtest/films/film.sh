#!/bin/bash
# film.sh <run dir> <scene tag> <scene> <spec.json>: once the camera host's post.sh has made the scene's five mp4s, cut
# the film there from the run's step log (plan.mjs + cut.mjs) and copy the film and its contact sheet to <run dir>/films/.
#   bash tools/playtest/films/film.sh .local/films/run1 p1- racks4 tools/playtest/films/specs/racks4.json
# The camera host as films.mjs reaches it: FILM_SSH (default ssh), FILM_HOST, FILM_DIR (default souls-films).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
RUN=$1 S=$3 SPEC=$4 T=$2$3
SSH=${FILM_SSH:-ssh} FDIR=${FILM_DIR:-souls-films}
at() { $SSH -o BatchMode=yes ${FILM_HOST:-} "$1"; }
mkdir -p "$RUN/films"
for i in $(seq 120); do
  n=$(at "cd $FDIR/$T 2>/dev/null && ls *.mp4 2>/dev/null | wc -l; pgrep -f '[p]ost.sh $T' >/dev/null && echo busy" | tr -d ' \n')
  [ "$n" = 5 ] && break
  sleep 10
done
at "cd $FDIR/$T && for f in *.webm.start; do printf '%s %s\n' \"\${f%.webm.start}\" \"\$(cat \$f)\"; done" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o={};for(const l of s.trim().split("\n")){const[k,v]=l.split(" ");o[k]=Number(v)}console.log(JSON.stringify(o))})' > "$RUN/films/starts-$S.json"
ARGS=$(node "$HERE/plan.mjs" "$RUN/films.json#$S" "$RUN/films/starts-$S.json" "$SPEC" "$T")
echo "$ARGS" > "$RUN/films/$S.args"
at "cd $FDIR && mkdir -p films && node cut.mjs films/$T.mp4 $ARGS"
at "cat $FDIR/films/$T.mp4" > "$RUN/films/$T.mp4"
at "cat $FDIR/films/$T.sheet.jpg" > "$RUN/films/$T.sheet.jpg"
ls -la "$RUN/films/$T.mp4" "$RUN/films/$T.sheet.jpg"
