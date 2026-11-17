#!/usr/bin/env node
// Proof script (not a CI job): the hand's positions from pose.mjs in headless Chromium and in Node, compared byte for byte.
//
//   node tools/entry/pose-browser-check.mjs
//
// Loads pose.mjs as an inline script (its `export`s removed) into a blank page, evaluates every golden position of
// cases/moves.json there and here, and fails unless the two JSON texts are identical. Needs Playwright with Chromium.
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {loadMoves} from './move.mjs';
import * as P from './pose.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cases = JSON.parse(readFileSync(new URL('./cases/moves.json', import.meta.url), 'utf8'));
const moves = Object.fromEntries(loadMoves(root + 'content/moves').map(r => [r.move.move, r.move]));
const src = readFileSync(new URL('./pose.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
const req = createRequire(import.meta.url);
const {chromium} = (() => { try { return req('playwright'); } catch { return req('playwright-core'); } })();

// Every golden time, plus a sweep of each move's whole length every 5000 microseconds, so the easing is compared throughout.
const jobs = [];
for (const c of cases.pose) {
  const times = new Set(c.at_us.map(([t]) => t));
  for (let t = c.record.start_us - 10000; t <= c.record.start_us + 1200000; t += 5000) times.add(t);
  jobs.push({move: moves[c.move], record: c.record, times: [...times].sort((a, b) => a - b)});
}
const run = (P, jobs) => jobs.map(j => j.times.map(t => P.handAt(j.move, j.record, t)));
const here = JSON.stringify(run(P, jobs));

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>pose</title>');
  await page.addScriptTag({content: `${src}\nwindow.__pose = {handAt, timesOf, eased};`});
  const there = await page.evaluate(jobs => {
    const P = window.__pose;
    return JSON.stringify(jobs.map(j => j.times.map(t => P.handAt(j.move, j.record, t))));
  }, jobs);
  const goldens = cases.pose.every((c, i) => c.at_us.every(([t, want]) => JSON.stringify(P.handAt(moves[c.move], c.record, t)) === JSON.stringify(want)));
  const count = jobs.reduce((n, j) => n + j.times.length, 0);
  const same = here === there;
  console.log(JSON.stringify({browser: browser.version(), positions: count, bytes: here.length, identical: same, goldens}));
  process.exitCode = same && goldens ? 0 : 1;
} finally { await browser.close(); }
