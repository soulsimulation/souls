#!/usr/bin/env node
// Who owns what in the new system, saved and wiped before a switch (0.134 F5-ready). Pre-release, accounts and Souls are
// disposable: no migration, the owners pair again. Before they go they are saved, whole, to one file.
//
//   node v2/tools/ops/cutover/souls-state.mjs save --world <world folder> --out <file.tar> [--args <directory.args>]
//        [--accounts <accounts.sqlite>] [--pairing <pairing.sqlite>] [--tokens <gateway tokens file>]
//   node v2/tools/ops/cutover/souls-state.mjs wipe --saved <file.tar> [--args <directory.args>] [--accounts …] [--pairing …]
//        [--tokens …]
//
// --args (default /etc/souls/directory.args) supplies the directory's --store (accounts), --pairing and --gateway-tokens
// when they are not given. Both commands need the directory stopped: it holds its stores while it runs.
//
// save: the account and pairing stores (each copied whole by SQLite, `VACUUM INTO`, read-only), the gateway's tokens file
// and the world's Soul files (world.json, tokens, souls.tokens, births.json, whichever are there) go into one tar file,
// mode 0600, with manifest.json: when, each file's SHA-256 and size, and counts (accounts, Souls paired, the world's
// Souls). Nothing is changed.
// wipe: refuses unless --saved is a save of exactly these files as they are now (each store's rows and the tokens file
// match its manifest). Then each store (with its -wal and -shm) and the tokens file are renamed aside, `<file>.wiped-<time>`,
// and an empty tokens file takes the tokens file's place: every agent pairs again. The world is not touched: its Souls'
// bodies stay where they are. Nothing is deleted.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isMain } from '../../../../tools/lib/is-main.mjs';
import { storesOf } from './count.mjs';

const FORMAT = 'souls/saved-owners/1';
const WORLD_FILES = ['world.json', 'tokens', 'souls.tokens', 'births.json'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The directory's three files: flags win over directory.args. */
export function pathsOf({ args, accounts, pairing, tokens }) {
  let named = {};
  try {
    const text = readFileSync(args ?? '/etc/souls/directory.args', 'utf8');
    const words = (/DIRECTORYD_ARGS="?([^"\n]*)"?/.exec(text)?.[1] ?? '').trim().split(/\s+/);
    const at = (k) => { const i = words.indexOf(k); return i >= 0 ? words[i + 1] : undefined; };
    named = { ...storesOf(text), tokens: at('--gateway-tokens') };
  } catch { /* only the flags */ }
  return { accounts: accounts ?? named.accounts, pairing: pairing ?? named.pairing, tokens: tokens ?? named.tokens };
}

/** A store's rows that say who owns what, as one hash: the same rows, the same hash, whatever SQLite's pages hold. */
function rowsHash(path, tables) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const h = createHash('sha256');
    for (const t of tables) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) continue;
      for (const r of db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()) h.update(`${t}\0${JSON.stringify(r)}\n`);
    }
    return h.digest('hex');
  } finally { db.close(); }
}
const ACCOUNT_TABLES = ['provider_accounts_v1', 'account_principals_v1', 'account_grants_v1'];
const PAIRING_TABLES = ['pair_requests_v1', 'paired_souls_v1'];
const count = (path, sql) => { const db = new DatabaseSync(path, { readOnly: true }); try { return Number(db.prepare(sql).get().n); } catch { return null; } finally { db.close(); } };

/** Saves the owners of `world` to one tar file at `out`; returns the manifest. */
export function save({ world, out, ...paths }) {
  const p = pathsOf(paths);
  for (const [k, v] of Object.entries(p)) if (!v || !existsSync(v)) throw Error(`souls-state.${k}-missing: ${v ?? 'not configured'}`);
  if (!world || !existsSync(join(world, 'world.json'))) throw Error(`souls-state.world-missing: ${world}`);
  const tmp = mkdtempSync(join(tmpdir(), 'souls-saved-'));
  try {
    const files = {};
    const keep = (name, from) => { const b = readFileSync(from); files[name] = { from, sha256: sha(b), bytes: b.length }; };
    for (const [name, from] of [['accounts.sqlite', p.accounts], ['pairing.sqlite', p.pairing]]) {
      const db = new DatabaseSync(from, { readOnly: true });
      try { db.exec(`VACUUM INTO '${join(tmp, name).replaceAll("'", "''")}'`); }
      catch (e) { throw Error(`souls-state.store-busy: ${name}: ${/locked|busy/i.test(e.message) ? 'held by the directory; stop it first' : e.message}`); }
      finally { db.close(); }
      files[name] = { from, sha256: sha(readFileSync(join(tmp, name))), bytes: statSync(join(tmp, name)).size };
    }
    copyFileSync(p.tokens, join(tmp, 'gateway.tokens'));
    keep('gateway.tokens', p.tokens);
    mkdirSync(join(tmp, 'world'));
    for (const f of WORLD_FILES) if (existsSync(join(world, f))) { copyFileSync(join(world, f), join(tmp, 'world', f)); keep(`world/${f}`, join(world, f)); }
    const souls = (() => { try { return Object.keys(JSON.parse(readFileSync(join(world, 'world.json'), 'utf8')).souls ?? {}).length; } catch { return null; } })();
    const manifest = {
      format: FORMAT, savedAt: new Date().toISOString(), world: basename(world), files,
      rows: { accounts: rowsHash(p.accounts, ACCOUNT_TABLES), pairing: rowsHash(p.pairing, PAIRING_TABLES) },
      counts: {
        accounts: count(p.accounts, 'SELECT COUNT(*) AS n FROM provider_accounts_v1'),
        soulsPaired: count(p.pairing, 'SELECT COUNT(*) AS n FROM paired_souls_v1'),
        worldSouls: souls,
      },
    };
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    mkdirSync(dirname(out), { recursive: true });
    execFileSync('tar', ['-cf', out, '-C', tmp, '.']);
    chmodSync(out, 0o600);
    return manifest;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** The manifest inside a saved file. */
export function manifestOf(file) {
  return JSON.parse(execFileSync('tar', ['-xOf', file, './manifest.json'], { encoding: 'utf8' }));
}

/** Wipes the owners after checking `saved` holds them as they are now; returns what was renamed aside. */
export function wipe({ saved, now = new Date(), ...paths }) {
  if (!saved || !existsSync(saved)) throw Error('souls-state.not-saved: name the saved file with --saved');
  const m = manifestOf(saved);
  if (m.format !== FORMAT) throw Error(`souls-state.not-a-save: ${m.format}`);
  const p = pathsOf(paths);
  for (const [k, v] of Object.entries(p)) if (!v || !existsSync(v)) throw Error(`souls-state.${k}-missing: ${v ?? 'not configured'}`);
  const differs = [];
  if (rowsHash(p.accounts, ACCOUNT_TABLES) !== m.rows.accounts) differs.push('accounts');
  if (rowsHash(p.pairing, PAIRING_TABLES) !== m.rows.pairing) differs.push('pairing');
  if (sha(readFileSync(p.tokens)) !== m.files['gateway.tokens'].sha256) differs.push('tokens');
  if (differs.length) throw Error(`souls-state.changed-since-save: ${differs.join(', ')} (save again)`);
  const stamp = now.toISOString().replace(/[:.]/g, '-'), aside = [];
  for (const f of [p.accounts, `${p.accounts}-wal`, `${p.accounts}-shm`, p.pairing, `${p.pairing}-wal`, `${p.pairing}-shm`, p.tokens]) {
    if (!existsSync(f)) continue;
    renameSync(f, `${f}.wiped-${stamp}`);
    aside.push(`${f}.wiped-${stamp}`);
  }
  writeFileSync(p.tokens, '', { mode: 0o640 });
  return { saved, aside, counts: m.counts };
}

if (isMain(import.meta.url)) {
  const [cmd, ...argv] = process.argv.slice(2);
  const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const paths = { args: flag('args'), accounts: flag('accounts'), pairing: flag('pairing'), tokens: flag('tokens') };
  try {
    if (cmd === 'save') {
      if (!flag('world') || !flag('out')) throw Error('usage: souls-state.mjs save --world <folder> --out <file.tar> [--args …]');
      const m = save({ world: flag('world'), out: flag('out'), ...paths });
      console.log(JSON.stringify({ ok: true, out: flag('out'), counts: m.counts }));
    } else if (cmd === 'wipe') {
      const r = wipe({ saved: flag('saved'), ...paths });
      console.log(JSON.stringify({ ok: true, ...r }));
    } else throw Error('usage: souls-state.mjs save|wipe … (see the top of the file)');
  } catch (e) { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); }
}
