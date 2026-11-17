#!/usr/bin/env node
// SA-D1a A3: the looks function gives the same answer in Node and in a browser build.
// Bundles src/looks.ts for the browser with esbuild, runs it in headless Chromium on the hand-written cases and on N
// generated states of the kinds in cases/looks/kinds, and compares every answer with Node's. Exit 1 on any difference.
//
//   node packages/form-rules/bin/looks-browser-check.mjs [--count 1000]
//
// FORM_RULES_CHROME may name a Chrome or Chromium executable; otherwise Playwright's own Chromium is used.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { looks } from '../src/looks.ts';

const { values } = parseArgs({ options: { count: { type: 'string', default: '1000' } } });
const PACKAGE = join(import.meta.dirname, '..'), ROOT = join(PACKAGE, '../..'), DIR = join(PACKAGE, 'cases/looks');
const kinds = readdirSync(join(DIR, 'kinds')).map((f) => JSON.parse(readFileSync(join(DIR, 'kinds', f), 'utf8')));
const doc = JSON.parse(readFileSync(join(DIR, 'cases.json'), 'utf8'));

const inputs = doc.cases.map((c) => ({ table: c.table ?? kinds.find((k) => k.kind === c.kind).looks.table, state: c.state, prev: c.prev, t_us: c.t_us }));
// generated: a fixed little generator (no Math.random) over every state field of every kind, with a time between two states
let seed = 2885;
const next = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
const pickValue = (f) => (f.type === 'bool' ? next(2) === 1 : f.type === 'enum' ? f.values[next(f.values.length)] : (f.min ?? 0) + next((f.max ?? 1000) - (f.min ?? 0) + 1));
const stateOf = (k) => Object.fromEntries(Object.entries(k.state ?? {}).map(([name, f]) => [name, pickValue(f)]));
for (let i = 0; i < Number(values.count); i++) {
  const k = kinds[i % kinds.length];
  const table = k.looks.table.map((r) => (i % 3 === 0 ? { ...r, over_us: 1000000 } : r));
  inputs.push({ table, state: stateOf(k), prev: stateOf(k), t_us: next(1200000) });
}

const require = createRequire(join(ROOT, 'mars/viewer/package.json'));
const esbuild = require('esbuild');
const { chromium } = require('@playwright/test');
const build = await esbuild.build({ entryPoints: [join(PACKAGE, 'src/looks.ts')], bundle: true, write: false, format: 'iife', globalName: 'Looks', platform: 'browser', target: 'es2020' });
const bundle = build.outputFiles[0].text;

const browser = await chromium.launch({ headless: true, ...(process.env.FORM_RULES_CHROME ? { executablePath: process.env.FORM_RULES_CHROME } : {}) });
let inBrowser, userAgent;
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>looks</title>');
  await page.addScriptTag({ content: bundle });
  userAgent = await page.evaluate(() => navigator.userAgent);
  inBrowser = await page.evaluate((list) => list.map((i) => globalThis.Looks.looks(i)), inputs);
} finally {
  await browser.close();
}
const inNode = inputs.map((i) => JSON.parse(JSON.stringify(looks(i))));
const disagreements = inputs.flatMap((_, i) => (JSON.stringify(inNode[i]) === JSON.stringify(inBrowser[i]) ? [] : [{ index: i, node: inNode[i], browser: inBrowser[i] }]));
const digest = (list) => createHash('sha256').update(JSON.stringify(list)).digest('hex');
console.log(JSON.stringify({
  handWritten: doc.cases.length,
  generated: inputs.length - doc.cases.length,
  browser: userAgent.replace(/^.*?(HeadlessChrome\/[\d.]+|Chrome\/[\d.]+).*$/, '$1'),
  bundleBytes: bundle.length,
  disagreements: disagreements.length,
  nodeDigest: digest(inNode),
  browserDigest: digest(inBrowser),
}, null, 2));
if (disagreements.length) console.error(JSON.stringify(disagreements.slice(0, 5), null, 2));
process.exit(disagreements.length ? 1 : 0);
