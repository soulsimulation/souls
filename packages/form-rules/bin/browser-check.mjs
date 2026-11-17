#!/usr/bin/env node
// SA-F2 A2: the same verdicts in Node and in a browser build.
// Bundles src/rules.ts for the browser with esbuild, runs it in headless Chromium on the hand-written
// cases and on N generated ones, and compares every verdict with Node's. Exit 1 on any difference.
//
//   node packages/form-rules/bin/browser-check.mjs [--count 1000] [--seed 2843]
//
// FORM_RULES_CHROME may name a Chrome or Chromium executable; otherwise Playwright's own Chromium is used.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { generate } from '../src/generate.ts';
import { loadCases, loadKinds, mismatches, PACKAGE, ROOT, same } from '../src/load.ts';
import { decide } from '../src/rules.ts';

const { values } = parseArgs({ options: { count: { type: 'string', default: '1000' }, seed: { type: 'string', default: '2843' } } });
const count = Number(values.count), seed = Number(values.seed);
const kinds = loadKinds();
const handWritten = loadCases().map(([, c]) => c);
const generated = generate(kinds, count, seed);
const inputs = [...handWritten.map(({ name: _n, expect: _e, ...input }) => input), ...generated];

// Tooling borrowed from the workspace package that already depends on it; the library itself has none.
const require = createRequire(join(ROOT, 'mars/viewer/package.json'));
const esbuild = require('esbuild');
const { chromium } = require('@playwright/test');

const build = await esbuild.build({
  entryPoints: [join(PACKAGE, 'src/rules.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'FormRules',
  platform: 'browser',
  target: 'es2020',
});
const bundle = build.outputFiles[0].text;

const browser = await chromium.launch({ headless: true, ...(process.env.FORM_RULES_CHROME ? { executablePath: process.env.FORM_RULES_CHROME } : {}) });
let inBrowser, userAgent;
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>form-rules</title>');
  await page.addScriptTag({ content: bundle });
  userAgent = await page.evaluate(() => navigator.userAgent);
  inBrowser = await page.evaluate(({ kinds, inputs }) => inputs.map((i) => globalThis.FormRules.decide({ kinds, ...i })), { kinds, inputs });
} finally {
  await browser.close();
}
const inNode = inputs.map((i) => decide({ kinds, ...i }));

const disagreements = [];
inputs.forEach((_, i) => {
  if (!same(inNode[i], inBrowser[i])) disagreements.push({ index: i, node: inNode[i], browser: inBrowser[i] });
});
const expectedMisses = handWritten.flatMap((c, i) => (mismatches(c.expect, inBrowser[i]).length ? [c.name] : []));
const tally = {};
for (const v of inNode.slice(handWritten.length)) {
  const key = v.verdict === 'no' ? `no:${v.reason}` : v.verdict;
  tally[key] = (tally[key] ?? 0) + 1;
}
const digest = (list) => createHash('sha256').update(JSON.stringify(list)).digest('hex');
const report = {
  handWritten: handWritten.length,
  generated: generated.length,
  seed,
  browser: userAgent.replace(/^.*?(HeadlessChrome\/[\d.]+|Chrome\/[\d.]+).*$/, '$1'),
  bundleBytes: bundle.length,
  disagreements: disagreements.length,
  handWrittenMissedInBrowser: expectedMisses,
  generatedVerdicts: tally,
  nodeDigest: digest(inNode),
  browserDigest: digest(inBrowser),
};
console.log(JSON.stringify(report, null, 2));
if (disagreements.length) console.error(JSON.stringify(disagreements.slice(0, 5), null, 2));
process.exit(disagreements.length || expectedMisses.length ? 1 : 0);
