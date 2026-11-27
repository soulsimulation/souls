#!/usr/bin/env node
// Cuts shots into one film: hard cuts, a short audio fade at each cut, a fade in from black and out at the end.
//   node cut.mjs <out.mp4> <clip.mp4>[@start+seconds] ...
// Then a contact sheet beside it (<out>.sheet.jpg, one frame every --every seconds) to check by eye.
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2), every = (() => { const i = args.indexOf('--every'); return i >= 0 ? Number(args.splice(i, 2)[1]) : 4; })();
const [out, ...specs] = args;
const dur = (f) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim());
const clips = specs.map((s) => { const m = /^(.*?)(?:@([\d.]+)\+([\d.]+))?$/.exec(s); const file = m[1], full = dur(file); const start = m[2] ? Number(m[2]) : 0; return { file, start, seconds: m[3] ? Math.min(Number(m[3]), full - start) : full - start }; });
const inputs = clips.flatMap((c) => ['-ss', String(c.start), '-t', String(c.seconds), '-i', c.file]);
const f = [];
clips.forEach((c, i) => {
  f.push(`[${i}:v]setpts=PTS-STARTPTS,fps=30,format=yuv420p,scale=1920:1080:flags=lanczos[v${i}]`);
  f.push(`[${i}:a]asetpts=PTS-STARTPTS,aresample=48000,afade=t=in:d=0.25,afade=t=out:st=${(c.seconds - 0.25).toFixed(3)}:d=0.25[a${i}]`);
});
const total = clips.reduce((s, c) => s + c.seconds, 0);
f.push(`${clips.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${clips.length}:v=1:a=1[vc][ac]`);
f.push(`[vc]fade=t=in:d=1,fade=t=out:st=${(total - 1.2).toFixed(3)}:d=1.2[vo]`);
f.push(`[ac]afade=t=in:d=1,afade=t=out:st=${(total - 1.2).toFixed(3)}:d=1.2[ao]`);
const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', f.join(';'), '-map', '[vo]', '-map', '[ao]', '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], { encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
const sheet = out.replace(/\.mp4$/, '') + '.sheet.jpg', n = Math.ceil(total / every), cols = 5, rows = Math.ceil(n / cols);
spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', out, '-vf', `fps=1/${every},scale=384:-1,tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '4', sheet]);
console.log(JSON.stringify({ out, seconds: +dur(out).toFixed(2), clips: clips.length, sheet }));
