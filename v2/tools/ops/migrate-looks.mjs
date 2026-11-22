#!/usr/bin/env node
// Souls get their humanoid looks back (#3998): the operator's one-time migration from the account store's
// `legacy_looks_v1` (import-accounts keeps each look the catalogue could not carry, #3997) to the worlds.
//
// It reads the rows whose reason is `custom-humanoid` (a look made in today's humanoid editor, `{family: "humanoid",
// model: "humanoid2-<16 hex>", params}`), checks `params` against core/humanoid@2 (the page's own check, `checkLook`),
// and writes one `look <grant> <params hex>` line per valid look to each `--out` file, whole, then renamed into place.
// Each `--out` is a world's looks file, beside the directory's Souls file the world reads (`<Souls file>.looks`,
// `worldd::directory::looks_beside`). The world, at its next tick and at each later birth, gives each Soul with a body
// there its look as its own `life:look` (field 33), only while the body wears no hash (field 32) and does not already
// carry it; it prints `looks (#3998): <n> written, <n> skipped (the body wears a hash), <n> already worn`. Nothing
// here writes a world's store or log.
//
//   node v2/tools/ops/migrate-looks.mjs --accounts <accounts.sqlite> --out <looks file> [--out <looks file>]... [--json]
//
// Idempotent: the same rows give the same bytes, an unchanged file is left alone, and a world writes a look once.
// Counts only: no Soul, account or look is printed. The store is opened read-only.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { checkLook } from '../../web/src/crowd/humanoid/look.ts';

/** The most bytes a look's params take on the body (`skills::wear::LOOK_MOST`). */
export const LOOK_MOST = 2048;
const MODEL = /^humanoid2-[0-9a-f]{16}$/;

/** The grant text of a Soul's id (`<hex>:<counter>` -> `soul-<hex>-<counter>`), or null. */
export const grantOf = (id) => {
  const m = /^([0-9a-f]{32}):(\d+)$/.exec(id);
  return m ? `soul-${m[1]}-${m[2]}` : null;
};

/** A legacy row's look params as the body carries them (compact JSON), or null when it is not a valid look. */
export function paramsOf(body) {
  try {
    const b = JSON.parse(body);
    if (b?.family !== 'humanoid' || typeof b.model !== 'string' || !MODEL.test(b.model)) return null;
    const text = JSON.stringify(checkLook(b.params));
    return Buffer.byteLength(text) <= LOOK_MOST ? text : null;
  } catch { return null; }
}

/** {rows, other, invalid, looks, text}: the looks file's text from the store, and the counts. */
export function migrate(accounts) {
  const db = new DatabaseSync(accounts, { readOnly: true });
  try {
    const rows = db.prepare('SELECT soul, reason, body FROM legacy_looks_v1 ORDER BY soul').all();
    let other = 0, invalid = 0;
    const lines = [];
    for (const { soul, reason, body } of rows) {
      if (reason !== 'custom-humanoid') { other += 1; continue; }
      const grant = grantOf(soul), params = paramsOf(body);
      if (!grant || params === null) { invalid += 1; continue; }
      lines.push(`look ${grant} ${Buffer.from(params).toString('hex')}\n`);
    }
    const text = '# #3998: humanoid looks from legacy_looks_v1 (look <grant> <params hex>)\n' + lines.join('');
    return { rows: rows.length, other, invalid, looks: lines.length, text };
  } finally { db.close(); }
}

/** Writes `text` to `file` whole (a temporary file renamed into place); false when it already holds it. */
export function put(file, text) {
  try { if (readFileSync(file, 'utf8') === text) return false; } catch { /* not there yet */ }
  writeFileSync(file + '.tmp', text);
  renameSync(file + '.tmp', file);
  return true;
}

function main(args) {
  const at = (key) => args.flatMap((a, i) => (a === key ? [args[i + 1]] : []));
  const [accounts] = at('--accounts'), outs = at('--out');
  if (!accounts || !outs.length || outs.some((o) => !o)) {
    console.error('usage: migrate-looks.mjs --accounts <accounts.sqlite> --out <looks file> [--out <looks file>]... [--json]');
    return 2;
  }
  const { text, ...counts } = migrate(accounts);
  const written = outs.filter((o) => put(o, text)).length;
  const report = { ...counts, files: outs.length, filesWritten: written, filesUnchanged: outs.length - written };
  if (args.includes('--json')) console.log(JSON.stringify(report));
  else {
    console.log(`legacy looks: ${report.rows} rows; custom-humanoid ${report.rows - report.other} (other reasons ${report.other})`);
    console.log(`looks: ${report.looks} valid, given to the worlds; ${report.invalid} invalid, left out`);
    console.log(`files: ${report.filesWritten} written, ${report.filesUnchanged} unchanged`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
