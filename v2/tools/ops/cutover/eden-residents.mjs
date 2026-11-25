#!/usr/bin/env node
// Old Eden's residents come back as real Souls (25 Nov). The import of old Eden into the new engine exported its 22
// resident Souls' bodies as plain things of kind core/humanoid@1 (facts entries 4997–5018, ids h_<old Soul id>):
// unnamed, standing, and owned by nobody. A Soul is not a thing. import-eden now leaves those bodies out of the tree
// (a world seeded or reseeded on a build carrying it has none of them), and this brings each resident back as a real,
// unpaired Soul in the directory, under its owner's account, so its owner can pair an agent to it again:
//
//   node eden-residents.mjs [--apply] --facts <world facts.json> --old <old world sim.db>
//        --registry <old accounts.sqlite>... --store <new accounts.sqlite> --world-dir <world folder>
//
// Without --apply it is a dry run: every file is opened read-only, nothing is written, and it prints what it would do.
// With --apply, in one transaction on the store, for each resident not yet brought: its owner's account there (found
// by sign-in, issuer and subject, from the old registry; made with its old id when the person has none yet), a new
// Soul id, the Soul's saved name and description, its look (its old body whole, kept private in legacy_looks_v1) and
// its imported row for its old id and old world, which R18's pairing (`souls.mjs upgrade`) and the account page's
// adoption (W15) read. Then births.json in the world's folder (B15's private birth file): each resident's body is born
// wearing its old look the first time its agent joins. A second run changes nothing. A resident whose owner has no
// sign-in in the old registry cannot be paired by anyone: it is listed, never brought.
//
// The directory must be stopped (it holds its store), and the world restarted afterwards (it reads births.json at its
// start). Output names Souls, never people: an owner is "owner 1", "owner 2" by sign-in, with no id or address.
import { createHash, randomBytes } from 'node:crypto';
import { chownSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isMain } from '../../../../tools/lib/is-main.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const FAMILY = 'eden:humanoid';
/** The most bytes a look's params take (skills::wear::LOOK_MOST). */
export const LOOK_MOST = 2048;
const BODY_DEF = /^core[-/]humanoid@\d+$/;
const STORE_TABLES = `
CREATE TABLE IF NOT EXISTS souls_v1(soul TEXT PRIMARY KEY, account_id TEXT NOT NULL
  REFERENCES provider_accounts_v1(account_id), name TEXT NOT NULL, description TEXT NOT NULL, family TEXT NOT NULL,
  preset TEXT NOT NULL, look TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS imported_souls_v1(world TEXT NOT NULL, old_soul TEXT NOT NULL, soul TEXT NOT NULL UNIQUE,
  PRIMARY KEY(world, old_soul));
CREATE TABLE IF NOT EXISTS legacy_looks_v1(soul TEXT PRIMARY KEY REFERENCES souls_v1(soul), reason TEXT NOT NULL,
  body TEXT NOT NULL);`;

/** Read-only: a file with no write-ahead log opens immutable (nothing appears beside it); else through its log. */
function open(file) {
  if (!existsSync(file)) throw new Error(`${file}: no such file`);
  if (existsSync(`${file}-wal`)) return new DatabaseSync(file, { readOnly: true });
  const url = pathToFileURL(resolve(file));
  url.search = 'immutable=1';
  return new DatabaseSync(url, { readOnly: true });
}
const tables = (db) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));

/** The residents: the facts' things that are Souls' bodies, each with its old Soul id (h_<x> is the body of s_<x>). */
export function residentsOf(facts) {
  return (facts.things ?? []).filter((t) => BODY_DEF.test(t.def ?? '') || BODY_DEF.test(t.ref ?? ''))
    .map((t) => ({ entity: t.id, soul: `s_${String(t.id).replace(/^h_/, '')}`, thingName: t.name ?? null }));
}

/** The entity's body in the old world's latest snapshot (null: none recorded). */
function bodies(db, entities) {
  const row = db.prepare('SELECT snapshot FROM snapshots ORDER BY tick DESC LIMIT 1').get();
  const out = new Map();
  if (!row) return out;
  const walk = (v) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    if (v.entities && typeof v.entities === 'object') for (const e of entities) if (v.entities[e]?.body !== undefined) out.set(e, v.entities[e].body);
    for (const x of Object.values(v)) walk(x);
  };
  walk(JSON.parse(String(row.snapshot)));
  return out;
}

/** A look the default body can wear: the old body's params, as JSON text, when they fit (null otherwise). */
export function lookOf(body) {
  const params = body && typeof body === 'object' && body.family === 'humanoid' ? body.params : null;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const text = JSON.stringify(params);
  return Buffer.byteLength(text) <= LOOK_MOST ? text : null;
}

/** The world's lineage and zone from world.json's name, `<lineage hex>-<zone scope hex>-<counter>`. */
function worldOf(dir) {
  const meta = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8'));
  const m = /^([0-9a-f]{32})-([0-9a-f]{32})-(\d+)$/.exec(meta.name ?? '');
  if (!m) throw new Error(`${dir}/world.json: its name is not <lineage>-<zone>-<n>`);
  return { lineage: m[1], zone: `${m[2]}:${m[3]}` };
}

/** Everything the conversion needs, read-only, and what it would do. */
export function plan({ facts, old, registries, store, worldDir }) {
  const residents = residentsOf(JSON.parse(readFileSync(facts, 'utf8')));
  const accounts = new Map();
  for (const file of registries) {
    const db = open(file);
    try { for (const r of db.prepare('SELECT account_id, issuer, subject FROM provider_accounts_v1').all()) if (!accounts.has(r.account_id)) accounts.set(r.account_id, { issuer: r.issuer, subject: r.subject }); } finally { db.close(); }
  }
  const odb = open(old);
  let rows, looks;
  try {
    const q = odb.prepare('SELECT id, world_id, owner, entity_id, name, description, retired_at FROM souls WHERE id = ?');
    rows = residents.map((r) => ({ ...r, row: q.get(r.soul) ?? null }));
    looks = bodies(odb, residents.map((r) => r.entity));
  } finally { odb.close(); }
  const sdb = open(store);
  let have, imported;
  try {
    have = tables(sdb);
    for (const t of ['provider_accounts_v1', 'account_principals_v1', 'account_grants_v1']) if (!have.has(t)) throw new Error(`${store}: no ${t}: not a directory account store`);
    const byPerson = sdb.prepare('SELECT account_id FROM provider_accounts_v1 WHERE issuer = ? AND subject = ?');
    const isImported = have.has('imported_souls_v1') ? sdb.prepare('SELECT soul FROM imported_souls_v1 WHERE world = ? AND old_soul = ?') : null;
    const idTaken = sdb.prepare('SELECT 1 FROM provider_accounts_v1 WHERE account_id = ?');
    const people = new Map();
    imported = rows.map((r) => {
      const out = { entity: r.entity, soul: r.soul, name: r.row?.name ?? r.thingName ?? r.soul, description: r.row?.description ?? '' };
      if (!r.row) return { ...out, state: 'no-soul', why: 'the old world has no Soul for this body' };
      if (r.row.retired_at !== null) return { ...out, state: 'retired', why: 'retired in the old world' };
      const body = looks.get(r.entity) ?? null;
      const look = lookOf(body);
      const base = { ...out, world: r.row.world_id, body, look, lookWhy: look ? null : body ? 'its old body has no look the default body can wear' : 'no body recorded' };
      const already = isImported?.get(r.row.world_id, r.soul)?.soul;
      const signIn = accounts.get(r.row.owner);
      const person = signIn ? `${signIn.issuer}\n${signIn.subject}` : `old ${r.row.owner}`;
      if (!people.has(person)) people.set(person, people.size + 1);
      const owner = people.get(person);
      if (already) return { ...base, owner, state: 'already', newSoul: already };
      if (!signIn) return { ...base, owner, state: 'no-sign-in', why: "its owner has no sign-in in the old registry, so nobody could pair it" };
      const account = byPerson.get(signIn.issuer, signIn.subject)?.account_id ?? null;
      return { ...base, owner, signIn, oldAccount: r.row.owner, account, state: account ? 'bring' : 'bring-new-account', oldIdFree: !idTaken.get(r.row.owner) };
    });
  } finally { sdb.close(); }
  const world = worldOf(worldDir);
  const catalogue = join(worldDir, 'bodies.json');
  const births = join(worldDir, 'births.json');
  return { residents: imported, world, catalogue: existsSync(catalogue) ? sha(readFileSync(catalogue)) : null,
    births: existsSync(births) ? JSON.parse(readFileSync(births, 'utf8')) : null };
}

/** The plain lines: per resident, what it is and what it needs. Names Souls, never people. */
export function report(p, applied) {
  const lines = [];
  const by = (s) => p.residents.filter((r) => r.state === s).length;
  lines.push(`residents in the facts: ${p.residents.length} Souls' bodies listed as things (core/humanoid)`);
  for (const r of p.residents) {
    const what = {
      already: `already in the directory as ${r.newSoul}`,
      bring: applied ? `brought as ${r.newSoul}, unpaired, under owner ${r.owner}'s account` : `to bring, unpaired, under owner ${r.owner}'s account (it is in the store)`,
      'bring-new-account': applied ? `brought as ${r.newSoul}, unpaired, under owner ${r.owner}'s account (made from the old sign-in)` : `to bring, unpaired, under owner ${r.owner}'s account (made from the old sign-in: the person has not signed in to the new system yet)`,
      'no-sign-in': `NOT brought: ${r.why}`, retired: `not brought: ${r.why}`, 'no-soul': `not brought: ${r.why}`,
    }[r.state];
    const look = r.look ? `look ${Buffer.byteLength(r.look)} bytes${r.state === 'already' || r.state.startsWith('bring') ? ', born wearing it' : ''}` : r.lookWhy ? `no look: ${r.lookWhy}` : '';
    lines.push(`  ${r.name} (old ${r.soul}, body ${r.entity}${r.world ? `, ${r.world}` : ''}): ${what}${look ? `; ${look}` : ''}`);
  }
  const owners = new Map();
  for (const r of p.residents) if (r.owner) owners.set(r.owner, (owners.get(r.owner) ?? 0) + 1);
  lines.push(`owners: ${[...owners].map(([o, n]) => `owner ${o} ${n} Souls`).join(', ') || 'none'}`);
  lines.push(`summary: ${by('bring') + by('bring-new-account')} to bring (${by('bring-new-account')} with an account made), ${by('already')} already brought, ${by('no-sign-in')} without an owner's sign-in, ${by('retired') + by('no-soul')} not live`);
  lines.push(`world: lineage ${p.world.lineage}, zone ${p.world.zone}; catalogue ${p.catalogue ? `bodies.json ${p.catalogue.slice(0, 16)}…` : 'NONE (births.json needs the world\'s bodies.json)'}; births.json ${p.births ? `has ${p.births.births?.length ?? 0} rows` : 'none yet'}`);
  return lines.join('\n');
}

/** Writes what the plan says, in one store transaction, then births.json. Returns the plan with the new Soul ids. */
export function apply(p, { store, worldDir, now = Math.floor(Date.now() / 1000) }) {
  if (!p.catalogue) throw new Error(`${worldDir} has no bodies.json: births.json is checked against it, so no look could be born`);
  const db = new DatabaseSync(store);
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    try {
      db.exec(STORE_TABLES);
      const byPerson = db.prepare('SELECT account_id FROM provider_accounts_v1 WHERE issuer = ? AND subject = ?');
      for (const r of p.residents) {
        if (!r.state.startsWith('bring')) continue;
        // Read again inside the transaction: the plan was read before it.
        const again = db.prepare('SELECT soul FROM imported_souls_v1 WHERE world = ? AND old_soul = ?').get(r.world, r.soul)?.soul;
        if (again) { Object.assign(r, { state: 'already', newSoul: again }); continue; }
        let account = byPerson.get(r.signIn.issuer, r.signIn.subject)?.account_id;
        if (!account) {
          account = r.oldIdFree ? r.oldAccount : `acct_${randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-')}`;
          db.prepare('INSERT INTO provider_accounts_v1(account_id, issuer, subject, created_at) VALUES (?, ?, ?, ?)').run(account, r.signIn.issuer, r.signIn.subject, now);
          db.prepare('INSERT INTO account_principals_v1(account_id, principal_id, created_at) VALUES (?, ?, ?)').run(account, `${randomBytes(16).toString('hex')}:0`, now);
        }
        const scope = randomBytes(16).toString('hex'), soul = `${scope}:0`;
        const body = r.body === null ? 'null' : JSON.stringify(r.body);
        const preset = (r.body && typeof r.body.model === 'string' && r.body.model) || (r.body?.family ?? 'humanoid');
        db.prepare('INSERT INTO souls_v1(soul, account_id, name, description, family, preset, look) VALUES (?, ?, ?, ?, ?, ?, ?)').run(soul, account, r.name, r.description, FAMILY, preset, sha(body));
        db.prepare('INSERT INTO imported_souls_v1(world, old_soul, soul) VALUES (?, ?, ?)').run(r.world, r.soul, soul);
        if (r.body !== null) db.prepare('INSERT OR IGNORE INTO legacy_looks_v1(soul, reason, body) VALUES (?, ?, ?)').run(soul, 'custom-humanoid', body);
        // Its own grant, the body the page follows for it (V13c): the owner's, with no token and no pairing.
        db.prepare('INSERT OR IGNORE INTO account_grants_v1(account_id, grant_text, follow) VALUES (?, ?, ?)').run(account, `soul-${scope}-0`, `${scope}.0`);
        Object.assign(r, { newSoul: soul, account });
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally { db.close(); }
  // births.json: one row per Soul (kept rows of other Souls as they are), each brought resident born in its look.
  const file = join(worldDir, 'births.json');
  const kept = (p.births?.births ?? []);
  const rows = new Map(kept.map((b) => [b.soul, b]));
  for (const r of p.residents) {
    if (!r.newSoul || !r.look) continue;
    const had = rows.get(r.newSoul);
    if (had?.body) continue; // a body chosen already: a look is only ever worn on the default body
    rows.set(r.newSoul, { soul: r.newSoul, entry: p.world.zone, asked: 0, look: r.look });
  }
  const text = JSON.stringify({ format: 'souls-births/1', world: p.births?.world ?? p.residents.find((r) => r.world)?.world ?? 'eden',
    lineage: p.world.lineage, zone: p.world.zone, catalogueHash: p.catalogue, births: [...rows.values()] }) + '\n';
  if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, text, { mode: 0o600 });
    // Run as root on the host, the file stays the world's, as its folder is.
    try { if (process.getuid?.() === 0) { const o = statSync(worldDir); chownSync(tmp, o.uid, o.gid); } } catch { /* not the host */ }
    renameSync(tmp, file);
  }
  return p;
}

function parse(argv) {
  const o = { registries: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--apply') o.apply = true;
    else if (a === '--registry') o.registries.push(v());
    else if (['--facts', '--old', '--store', '--world-dir'].includes(a)) o[a.slice(2).replace(/-(.)/g, (_, c) => c.toUpperCase())] = v();
    else throw new Error(`unknown argument ${a}`);
  }
  for (const k of ['facts', 'old', 'store', 'worldDir']) if (!o[k]) throw new Error(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  if (!o.registries.length) throw new Error('--registry is required (the old stage\'s accounts.sqlite; repeat for its forks registry)');
  return o;
}

export function main(argv, print = console.log) {
  let o;
  try { o = parse(argv); } catch (e) { print(`eden-residents: ${e.message}`); print(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 20).join('\n')); return 2; }
  let p;
  try { p = plan({ facts: o.facts, old: o.old, registries: o.registries, store: o.store, worldDir: o.worldDir }); } catch (e) { print(`eden-residents: refused, nothing changed: ${e.message}`); return 1; }
  if (!o.apply) {
    print(report(p, false));
    print('eden-residents: dry run; nothing changed (--apply writes the store and births.json, with the directory stopped)');
    return 0;
  }
  try { apply(p, { store: o.store, worldDir: o.worldDir }); } catch (e) { print(`eden-residents: refused, the store is unchanged: ${e.message}`); return 1; }
  print(report(p, true));
  print(`eden-residents: done; births.json written in ${o.worldDir}; restart the world so it reads it`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
