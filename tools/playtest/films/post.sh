#!/bin/bash
# post.sh <tag>: stop the tag's cameras (if still running), wait for them, and make a 30 fps H.264 mp4 of each take.
set -u
cd "$(dirname "$0")/$1"
for w in *.webm; do touch "$w.stop"; done
for i in $(seq 120); do pgrep -f "cam.mjs.*$1/" > /dev/null || break; sleep 2; done
for w in *.webm; do
  m=${w%.webm}.mp4
  [ -f "$m" ] || (nice -n 5 ffmpeg -y -loglevel error -i "$w" -vf fps=30 -c:v libx264 -crf 18 -preset fast -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart "$m" && rm -f "$w") &
done
wait
for j in *.webm.json; do echo "$j start=$(cat "${j%.json}.start" 2>/dev/null) $(ffprobe -v error -show_entries format=duration -of csv=p=0 "${j%.webm.json}.mp4") $(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('pacing'))" $j)"; done
