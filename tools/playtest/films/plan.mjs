#!/usr/bin/env node
// The cut list for a film from a run's step log and the cameras' start times: each shot is a camera, an event of the run
// (take#n, put#n, unseat#n, to#n, offer#n, offer-on#n, built, end, or a number of seconds after the play start), an
// offset and a length. Prints cut.mjs's arguments (files on the camera host, seconds into each camera's take).
//   node plan.mjs <run dir> <starts.json {cam: startMs}> <spec.json> [dir on the camera host]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [runDir, startsFile, specFile, sdir = '.'] = process.argv.slice(2);
// a staged run's folder (report.json), or films.json#<scene>
const [file, tag] = runDir.split('#');
const rep = tag ? JSON.parse(readFileSync(file, 'utf8')).scenes[tag] : JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'));
const starts = JSON.parse(readFileSync(startsFile, 'utf8')), spec = JSON.parse(readFileSync(specFile, 'utf8'));
const play0 = rep.play0Ms ?? (Date.parse(rep.started) + rep.readyS * 1000);
const steps = (rep.steps ?? []).filter((s) => typeof s.at === "number" && s.ok);
const kind = (s) => { const [a, b] = s.words; if (a === 'part') return b; if (a === 'carry' && b === 'offer') return s.words.includes('--on') ? 'offer-on' : 'offer'; if (a === 'carry') return b; return a; };
const eventAt = (e) => {
  if (typeof e === 'number') return e;
  if (e === 'built') return rep.builtAtS;
  if (rep.marks && e in rep.marks) return rep.marks[e];
  if (e.includes('@')) { const [ev, m] = e.split('@'); const from = rep.marks?.[m] ?? 0; const [k, n] = ev.split('#'); const hits = steps.filter((s) => kind(s) === k && s.at >= from).map((s) => s.at).filter((t, i, a) => i === 0 || t - a[i - 1] > 0.5); const t = hits[Number(n ?? 1) - 1]; if (t === undefined) throw Error(`no event ${e}`); return t; }
  if (e === 'end') return steps.at(-1).at;
  const [k, n] = e.split('#'), hits = steps.filter((s) => kind(s) === k).map((s) => s.at).filter((t, i, a) => i === 0 || t - a[i - 1] > 0.5);
  const t = hits[Number(n ?? 1) - 1];
  if (t === undefined) throw Error(`no event ${e} (${hits.length} of ${k})`);
  return t;
};
const args = [], rows = [];
for (const s of spec) {
  const t = eventAt(s.at) + (s.off ?? 0), into = (play0 + t * 1000 - starts[s.cam]) / 1000;
  if (into < 0) throw Error(`${s.cam} at ${s.at}: before that camera started (${into.toFixed(1)} s)`);
  args.push(`${sdir}/${s.cam}.mp4@${into.toFixed(2)}+${s.dur}`);
  rows.push(`${s.cam.padEnd(9)} ${String(s.at).padEnd(10)} run ${t.toFixed(1)} s -> ${into.toFixed(1)} s in, ${s.dur} s`);
}
console.error(rows.join('\n'));
console.log(args.join(' '));
