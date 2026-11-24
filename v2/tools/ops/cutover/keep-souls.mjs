#!/usr/bin/env node
// Real people's Souls survive the move (0.133 W5). Gene's own Souls are tests and may go; every other person's live
// Soul in the old engine's worlds is listed, saved whole to one private, checksummed file on the host, and copied into
// the new system unpaired, so its owner can pair it again. Nothing in the old worlds is changed or deleted: every old
// file is opened read-only.
//
//   node keep-souls.mjs list    [--data <stage data dir>]... [--out <dir>] [--json]
//        Every live Soul on every world, by world, name and owner, and the candidate list of Gene's own accounts (with
//        why each is one). Once confirmed, the list marks Gene's Souls and the real people's.
//   node keep-souls.mjs confirm [--data …]... [--out <dir>] [--drop <account>]... [--add <account>]...
//        Prints the candidates, then records them, the drops and adds and the data folders in <out>/gene-accounts.json
//        (less --drop, plus --add). Souls on the operator's list of Gene's Souls are always his.
//   node keep-souls.mjs save    [--data …]... [--out <dir>]
//        Refuses unless confirmed for the same data folders and the same candidates. One save of every real person's
//        Soul (identity, body, memories, relationships; only the tables and columns in SAVED) as <out>/save-<time>.tar,
//        mode 0600, with manifest.json (each file's SHA-256) inside and <tar>.sha256 beside it.
//   node keep-souls.mjs copy    [--saved <tar>, default the newest in <out>] [--out <dir>] [--args <directory.args>] [--store <accounts.sqlite>]
//        [--import-accounts <program>] [--bodies <bodies.json>]
//        Checks the save against its checksums, then copies each Soul into the new system's account store unpaired:
//        X11's import-accounts brings them (old id kept as `formerly`, no token, no pairing), and each joins its
//        owner's account there by sign-in (issuer, subject), made if the person has none yet. Run it with the directory
//        stopped (it holds its store). A second run changes nothing. Ends with the plain list, <out>/reconcile-<time>.txt.
//
// Defaults are the production host's: --data /srv/sim-worlds-data/production and /srv/sim-worlds-data/legacy (those
// that exist), --out /srv/sim-worlds-data/kept-souls, --args /etc/souls/directory.args, --import-accounts
// /usr/local/lib/souls/import-accounts. Site owners come from /etc/sim-worlds/<stage>.conf (SIM_SITE_OWNERS,
// CATALOG_GENE_OWNER_ID). Output names people and Souls: it stays on the host, never in GitHub text.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isMain } from '../../../../tools/lib/is-main.mjs';
import { deniedSoul } from '../../../../tools/world-launcher/op-souls.mjs';

const FORMAT = 'souls/kept-souls/1';
const OPERATOR = 'op:test-operator';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
/** Read-only. A file with no write-ahead log (a world not running) opens immutable, so not even an empty -wal or -shm
 *  appears beside it; a running world's file reads through its log, which is already there. */
const open = (file) => {
  if (existsSync(`${file}-wal`)) return new DatabaseSync(file, { readOnly: true });
  const url = pathToFileURL(resolve(file));
  url.search = 'immutable=1';
  return new DatabaseSync(url, { readOnly: true });
};
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
const columns = (db, t) => db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);

// --- Reading the old stages ----------------------------------------------------------------------------------------

/** The registries of one stage: account id -> {issuer, subject}. */
function registry(file) {
  if (!existsSync(file)) return new Map();
  const db = open(file);
  try { return new Map(db.prepare('SELECT account_id, issuer, subject FROM provider_accounts_v1').all().map((r) => [r.account_id, { issuer: r.issuer, subject: r.subject }])); } finally { db.close(); }
}

/** The site owners a stage's launcher is configured with (its /etc/sim-worlds/<stage>.conf), if readable. */
function siteOwners(conf) {
  let text = '';
  try { text = readFileSync(conf, 'utf8'); } catch { return []; }
  const v = (k) => (new RegExp(`^\\s*${k}=["']?([^"'\\n]*)`, 'm').exec(text)?.[1] ?? '');
  return (v('SIM_SITE_OWNERS') || v('CATALOG_GENE_OWNER_ID')).split(',').map((s) => s.trim()).filter(Boolean);
}

/** Every world of every stage, with its live Souls, the accounts and the site owners. Read-only. */
export function readStages(dataDirs, { etc = '/etc/sim-worlds' } = {}) {
  const accounts = new Map(), worlds = [], site = new Set();
  for (const data of dataDirs) {
    for (const [id, a] of registry(join(data, 'accounts.sqlite'))) accounts.set(id, { ...a, registry: `${basename(data)}/stage` });
    for (const [id, a] of registry(join(data, 'forks', 'accounts.sqlite'))) if (!accounts.has(id)) accounts.set(id, { ...a, registry: `${basename(data)}/forks` });
    for (const s of siteOwners(join(etc, `${basename(data)}.conf`))) site.add(s);
    const reg = readJson(join(data, 'worlds.json'), []);
    const entries = Array.isArray(reg) ? reg : Array.isArray(reg?.worlds) ? reg.worlds : [];
    const byDir = new Map(entries.map((w) => [w.dataSlug ?? w.slug, w]));
    const dir = join(data, 'worlds');
    for (const d of existsSync(dir) ? readdirSync(dir).sort() : []) {
      const file = join(dir, d, 'sim.db');
      if (!existsSync(file)) continue;
      const entry = byDir.get(d) ?? {};
      const db = open(file);
      try {
        const names = tables(db);
        if (!names.includes('souls')) continue;
        const souls = db.prepare('SELECT id, world_id, owner, entity_id, name, description, created_at, native FROM souls WHERE retired_at IS NULL ORDER BY created_at, id').all();
        const emails = new Map(names.includes('users') ? db.prepare('SELECT id, email FROM users').all().map((u) => [u.id, u.email]) : []);
        const creator = entry.owner ?? null;
        worlds.push({ data, slug: entry.slug ?? d, dir: d, file, name: entry.name ?? d, creator, fork: !!entry.fork,
          souls: souls.map((s) => ({ ...s, email: emails.get(s.owner) ?? null, denied: deniedSoul(data, s.id, s.name) })) });
      } finally { db.close(); }
    }
  }
  return { accounts, worlds, site: [...site] };
}

/** The person behind an account: its sign-in (issuer, subject), so one person's ids in two registries are one. */
const personOf = (stages, id) => { const a = stages.accounts.get(id); return a ? `${a.issuer} ${a.subject}` : `id ${id}`; };

/** Candidates for Gene's own accounts, each with why. Gene confirms them; nothing is decided by these alone. */
export function candidates(stages) {
  const why = new Map(), add = (id, reason) => { if (!id || id === OPERATOR) return; if (!why.has(id)) why.set(id, new Set()); why.get(id).add(reason); };
  for (const id of stages.site) add(id, 'a site owner in the launcher settings');
  const created = new Map();
  for (const w of stages.worlds) {
    if (w.creator) created.set(w.creator, [...(created.get(w.creator) ?? []), w.slug]);
    if (w.creator && /^eden(-|$)/.test(w.slug)) add(w.creator, `made the world ${w.slug}`);
    for (const s of w.souls) if (s.denied) add(s.owner, `owns ${s.name} in ${w.slug}, on the operator's list of Gene's Souls`);
  }
  for (const [id, slugs] of created) if (slugs.length >= 3) add(id, `made ${slugs.length} worlds`);
  const count = new Map();
  for (const w of stages.worlds) for (const s of w.souls) count.set(s.owner, (count.get(s.owner) ?? 0) + 1);
  for (const [id, n] of count) if (n >= 6) add(id, `owns ${n} live Souls`);
  // The same person under another id (the other registry, or the other stage).
  const people = new Map([...why.keys()].map((id) => [personOf(stages, id), id]));
  for (const id of new Set([...stages.accounts.keys(), ...count.keys()])) if (!why.has(id) && people.has(personOf(stages, id))) add(id, `the same sign-in as ${people.get(personOf(stages, id))}`);
  return [...why].map(([account, r]) => ({ account, signIn: stages.accounts.get(account) ?? null, souls: count.get(account) ?? 0, why: [...r] }));
}

const confirmedFile = (out) => join(out, 'gene-accounts.json');
function confirmed(out) {
  const v = readJson(confirmedFile(out), null);
  return Array.isArray(v?.accounts) ? new Set(v.accounts) : null;
}

/** Every live Soul, marked: Gene's (a confirmed account, or the same sign-in), the operator's test Souls, or a real person's. */
export function classify(stages, gene) {
  const genePeople = new Set([...(gene ?? [])].map((id) => personOf(stages, id)));
  const rows = [];
  for (const w of stages.worlds) for (const s of w.souls) {
    // A Soul on the operator's list of Gene's Souls is always his, whatever the confirmed accounts say.
    const who = s.owner === OPERATOR ? 'operator test' : s.denied ? 'Gene' : !gene ? '?' : gene.has(s.owner) || genePeople.has(personOf(stages, s.owner)) ? 'Gene' : 'real';
    const a = stages.accounts.get(s.owner);
    rows.push({ world: w.slug, worldId: s.world_id, file: w.file, soul: s.id, name: s.name, owner: s.owner,
      signIn: a ? `${a.issuer} ${a.subject}` : null, email: s.email, who, pairable: !!a });
  }
  return rows;
}

// --- Saving one Soul ------------------------------------------------------------------------------------------------

/**
 * What is saved: only these tables, and in each only these columns (an allowlist; a column a world added later is not
 * saved). `by` are the columns that name the Soul; `owner` matches its owner's account; `mentions` matches a body
 * that names it. Every other table is never read: in particular the sign-in and pairing tables (account requests,
 * approvals, agent grants and logins, window codes, token tombstones), webhook subscriptions (their URL can be a
 * credential), idempotency keys, model calls and snapshots.
 */
export const SAVED = {
  identity: {
    account_soul_memberships_v1: { by: ['soul_id'], cols: ['world_id', 'soul_id', 'account_id', 'attribution', 'created_at'] },
    account_legacy_authority_v1: { by: ['soul_id'], cols: ['world_id', 'soul_id', 'legacy_owner_id', 'captured_at', 'revoked_at', 'revoked_reason'] },
    travel_incarnations_v1: { by: ['soul_id'], cols: ['world_id', 'soul_id', 'traveller', 'home', 'state', 'at', 'updated_at'] },
    soul_now_v1: { by: ['soul_id'], cols: ['world_id', 'soul_id', 'text', 'at'] },
    soul_profile_photos_v1: { by: ['soul_id'], cols: ['world_id', 'soul_id', 'hash', 'image'] },
  },
  body: {
    edge_body_v1: { by: ['soul_id'], cols: ['world_id', 'soul_id', 'state', 'doing', 'since', 'anchor_x', 'anchor_z', 'rule', 'slept'] },
    legacy_looks_v1: { by: ['soul_id'], cols: ['world_id', 'seq', 'soul_id', 'entity_id', 'owner', 'body', 'rolled_back_seq'] },
    soul_auto_portraits_v1: { by: ['soul_id'], cols: ['world_id', 'soul_id', 'look_key', 'hash', 'width', 'height', 'image'] },
    body_definitions_v1: { by: ['creator_soul'], cols: ['asset_id', 'descriptor', 'creator_soul', 'owner', 'source_world', 'license', 'rights_confirmed', 'status', 'created_at'] },
    body_collection_v1: { by: ['saved_by_soul'], cols: ['owner', 'asset_id', 'saved_by_soul', 'saved_at'] },
    edge_body_owners_v1: { owner: true, cols: ['world_id', 'owner', 'asset_id', 'descriptor'] },
  },
  memories: {
    events: { by: ['soul_id', 'author'], cols: ['world_id', 'seq', 'tick', 'kind', 'author', 'payload', 'at', 'soul_id'] },
    edge_timeline_v1: { by: ['soul_id'], cols: ['world_id', 'receipt_id', 'soul_id', 'kind', 'tick', 'at', 'world_day', 'time', 'place_id', 'title', 'world', 'object_id'] },
    edge_place_knowledge_v1: { by: ['soul_id'], cols: ['world_id', 'soul_id', 'place_id', 'how', 'visits', 'first_tick', 'last_tick'] },
    edge_lore_visits_v1: { by: ['soul_id'], cols: ['world_id', 'soul_id', 'place_id', 'source', 'tick'] },
    edge_reading_progress_v1: { by: ['soul_id'], cols: ['world_id', 'soul_id', 'book_id', 'content_version', 'next_passage'] },
    edge_receipts_v1: { by: ['soul_id'], cols: ['world_id', 'receipt_id', 'soul_id', 'capability', 'phase', 'accepted_tick', 'started_tick', 'ended_tick', 'code', 'reason', 'created_at'] },
    edge_outcomes_v1: { by: ['soul_id'], cols: ['world_id', 'receipt_id', 'soul_id', 'body'] },
    edge_refusals_v1: { by: ['soul_id'], cols: ['world_id', 'at', 'tick', 'soul_id', 'verb', 'capability', 'code'] },
    edge_written_objects_v1: { by: ['soul_id'], cols: ['world_id', 'id', 'soul_id', 'receipt_id', 'body'] },
    edge_comms_speech: { by: ['soul_id'], cols: ['world_id', 'id', 'soul_id', 'tick', 'at', 'channel', 'text', 'heard_by'] },
    edge_plans_v1: { by: ['soul_id'], cols: ['world_id', 'plan_id', 'soul_id', 'state', 'body', 'created_at', 'updated_at'] },
    edge_personal_reminders_v1: { by: ['soul_id'], cols: ['world_id', 'soul_id', 'id', 'request', 'kind', 'due_world_minute', 'due_real_ms', 'state', 'created_at', 'created_tick', 'delivered_at'] },
    edge_items_v1: { by: ['holder'], cols: ['world_id', 'item_id', 'state', 'holder', 'place_id', 'body', 'updated_at'] },
    soul_inbox_queue_v1: { by: ['scope'], cols: ['world_id', 'scope', 'n', 'text', 'sent_at', 'delivered_at', 'acknowledged_at', 'reply', 'outcome', 'result', 'result_at'] },
  },
  relationships: {
    edge_comms_turns: { by: ['soul_id'], cols: ['world_id', 'conversation_id', 'seq', 'soul_id', 'tick', 'at', 'text'] },
    edge_comms_conversations: { mentions: true, cols: ['world_id', 'id', 'state', 'created_at', 'updated_at', 'body'] },
    edge_mail_v1: { by: ['sender', 'recipient'], cols: ['world_id', 'id', 'sender', 'recipient', 'created_tick', 'body'] },
    talks: { by: ['from_id', 'to_id'], cols: ['id', 'world_id', 'tick', 'at', 'from_id', 'to_id', 'body'] },
    edge_follows_v1: { mentions: true, cols: ['world_id', 'receipt_id', 'body'] },
    edge_invites_v1: { mentions: true, cols: ['world_id', 'invite_id', 'state', 'body', 'created_at'] },
  },
};
const SOUL_ROW = ['id', 'world_id', 'owner', 'entity_id', 'name', 'description', 'created_at', 'retired_at', 'native'];

/** A row as JSON: bytes as base64. */
const clean = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? { base64: Buffer.from(v).toString('base64') } : typeof v === 'bigint' ? Number(v) : v]));

/** The entity's body in the world's latest snapshot (null: the default body). */
function snapshotBody(db, worldId, entity) {
  const row = db.prepare('SELECT tick, snapshot FROM snapshots WHERE world_id = ? ORDER BY tick DESC LIMIT 1').get(worldId);
  if (!row) return { tick: null, body: null };
  const find = (v) => {
    if (Array.isArray(v)) { for (const x of v) { const f = find(x); if (f !== undefined) return f; } return undefined; }
    if (v && typeof v === 'object') {
      if (v.entities && typeof v.entities === 'object' && v.entities[entity]?.body !== undefined) return v.entities[entity].body;
      for (const x of Object.values(v)) { const f = find(x); if (f !== undefined) return f; }
    }
    return undefined;
  };
  return { tick: Number(row.tick), body: find(JSON.parse(String(row.snapshot))) ?? null };
}

/** Everything the world keeps about one Soul, in four parts. One read transaction: a consistent view of a live file. */
export function saveSoul(row, stages) {
  const db = open(row.file);
  try {
    db.exec('BEGIN');
    const present = new Set(tables(db));
    const pick = (t, cols) => { const have = new Set(columns(db, t)); return cols.filter((c) => have.has(c)).map((c) => `"${c}"`).join(', '); };
    const soul = clean(db.prepare(`SELECT ${pick('souls', SOUL_ROW)} FROM souls WHERE id = ?`).get(row.soul));
    const names = new Map(db.prepare('SELECT id, name FROM souls').all().map((s) => [s.id, s.name]));
    const out = { identity: { soul, owner: { account: row.owner, signIn: row.signIn, email: row.email } }, body: { snapshot: snapshotBody(db, row.worldId, soul.entity_id) }, memories: {}, relationships: {} };
    const conversations = new Set();
    for (const [part, saved] of Object.entries(SAVED)) for (const [t, spec] of Object.entries(saved)) {
      if (!present.has(t)) continue;
      const have = new Set(columns(db, t));
      const by = (spec.by ?? []).filter((c) => have.has(c));
      const where = [...by.map((c) => [`"${c}" = ?`, row.soul]), ...(spec.owner ? [['"owner" = ?', row.owner]] : []), ...(spec.mentions && have.has('body') ? [['"body" LIKE ?', `%${row.soul}%`]] : [])];
      if (!where.length) continue;
      const rows = db.prepare(`SELECT ${pick(t, spec.cols)} FROM "${t}" WHERE ${where.map((w) => w[0]).join(' OR ')}`).all(...where.map((w) => w[1]));
      if (t === 'edge_comms_turns') for (const r of rows) conversations.add(r.conversation_id);
      if (rows.length) out[part][t] = rows.map(clean);
    }
    // The whole of each conversation it spoke in: who else was there, and what they said.
    const people = new Map(), met = (id, how) => { if (!id || id === row.soul || !names.has(id)) return; const p = people.get(id) ?? { soul: id, name: names.get(id), turns: 0, mail: 0, talks: 0, follows: 0 }; p[how]++; people.set(id, p); };
    if (conversations.size) {
      const all = db.prepare(`SELECT ${pick('edge_comms_turns', SAVED.relationships.edge_comms_turns.cols)} FROM edge_comms_turns WHERE conversation_id IN (${[...conversations].map(() => '?').join(',')}) ORDER BY conversation_id, seq`).all(...conversations);
      out.relationships.edge_comms_turns = all.map(clean);
      for (const r of all) met(r.soul_id, 'turns');
    }
    for (const r of out.relationships.edge_mail_v1 ?? []) met(r.sender === row.soul ? r.recipient : r.sender, 'mail');
    for (const r of out.relationships.talks ?? []) met(r.from_id === row.soul ? r.to_id : r.from_id, 'talks');
    for (const r of out.relationships.edge_follows_v1 ?? []) for (const id of String(r.body).match(/s_[A-Za-z0-9_-]+/g) ?? []) met(id, 'follows');
    out.relationships.people = [...people.values()].sort((a, b) => a.soul.localeCompare(b.soul));
    db.exec('COMMIT');
    return { format: FORMAT, world: { slug: row.world, id: row.worldId }, soul: { id: row.soul, name: row.name }, ...out };
  } finally { db.close(); }
}

// --- The save file --------------------------------------------------------------------------------------------------

export function save({ stages, gene, out, now = stamp() }) {
  const rows = classify(stages, gene).filter((r) => r.who === 'real');
  const work = mkdtempSync(join(out, `.save-${now}-`));
  try {
    const files = {};
    const put = (name, value) => { const bytes = Buffer.from(JSON.stringify(value, null, 1) + '\n'); mkdirSync(dirname(join(work, name)), { recursive: true }); writeFileSync(join(work, name), bytes, { mode: 0o600 }); files[name] = { sha256: sha(bytes), bytes: bytes.length }; };
    const souls = [];
    for (const r of rows) {
      const name = `souls/${r.world}/${r.soul}.json`;
      put(name, saveSoul(r, stages));
      souls.push({ world: r.world, worldId: r.worldId, soul: r.soul, name: r.name, owner: r.owner, signIn: r.signIn, email: r.email, pairable: r.pairable, file: name });
    }
    // What the copy needs to bring them over, from the same reads: each owner's sign-in, each world's creator.
    const owners = Object.fromEntries([...new Set(rows.map((r) => r.owner))].filter((id) => stages.accounts.has(id)).map((id) => [id, stages.accounts.get(id)]));
    const creators = Object.fromEntries(stages.worlds.filter((w) => rows.some((r) => r.file === w.file)).map((w) => [w.slug, w.creator && stages.accounts.has(w.creator) ? { account: w.creator, ...stages.accounts.get(w.creator) } : null]));
    put('souls.json', { souls, owners, creators });
    const manifest = { format: FORMAT, at: now, files, counts: { souls: souls.length, people: new Set(rows.map((r) => r.signIn ?? r.owner)).size, worlds: new Set(rows.map((r) => r.world)).size } };
    writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n', { mode: 0o600 });
    const tar = join(out, `save-${now}.tar`);
    execFileSync('tar', ['-cf', tar, '-C', work, 'manifest.json', ...Object.keys(files)]);
    chmodSync(tar, 0o600);
    const sum = sha(readFileSync(tar));
    writeFileSync(`${tar}.sha256`, `${sum}  ${basename(tar)}\n`, { mode: 0o600 });
    return { tar, sha256: sum, manifest };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/** A save's files, checked against its own checksums and the one beside it. Throws on any difference. */
export function readSave(tar) {
  const want = readFileSync(`${tar}.sha256`, 'utf8').split(/\s+/)[0];
  if (sha(readFileSync(tar)) !== want) throw new Error(`${tar}: its SHA-256 is not the one in ${basename(tar)}.sha256`);
  const dir = mkdtempSync(join(dirname(tar), '.read-'));
  try {
    execFileSync('tar', ['-xf', tar, '-C', dir]);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    if (manifest.format !== FORMAT) throw new Error(`${tar}: not a ${FORMAT} save`);
    const files = {};
    for (const [name, f] of Object.entries(manifest.files)) {
      const bytes = readFileSync(join(dir, name));
      if (sha(bytes) !== f.sha256 || bytes.length !== f.bytes) throw new Error(`${tar}: ${name} does not match its checksum`);
      files[name] = JSON.parse(bytes.toString('utf8'));
    }
    return { manifest, files };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// --- Into the new system --------------------------------------------------------------------------------------------

/** A backup set as today's nightly backup writes it, holding only the saved Souls, for X11's import-accounts. */
function backupSet(saved, dir) {
  const { souls, owners, creators } = saved.files['souls.json'];
  mkdirSync(join(dir, 'worlds'), { recursive: true });
  // One account id per person (sign-in): a person known under two ids is brought under the first.
  const byPerson = new Map(), canon = new Map();
  for (const [id, a] of [...Object.entries(owners), ...Object.values(creators).filter(Boolean).map((c) => [c.account, c])]) {
    const p = `${a.issuer}\n${a.subject}`;
    if (!byPerson.has(p)) byPerson.set(p, { id, ...a });
    canon.set(id, byPerson.get(p).id);
  }
  const reg = new DatabaseSync(join(dir, 'accounts.sqlite'));
  reg.exec('CREATE TABLE provider_accounts_v1(account_id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(issuer, subject))');
  for (const a of byPerson.values()) reg.prepare('INSERT INTO provider_accounts_v1 VALUES (?, ?, ?, 0)').run(a.id, a.issuer, a.subject);
  reg.close();
  const worlds = [];
  for (const slug of [...new Set(souls.map((s) => s.world))]) {
    const mine = souls.filter((s) => s.world === slug && s.pairable);
    if (!mine.length) continue;
    const db = new DatabaseSync(join(dir, 'worlds', `${slug}.db`));
    db.exec('CREATE TABLE worlds(id TEXT PRIMARY KEY); CREATE TABLE souls(id TEXT PRIMARY KEY, world_id TEXT NOT NULL, owner TEXT NOT NULL, entity_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER); CREATE TABLE snapshots(world_id TEXT NOT NULL, tick INTEGER NOT NULL, snapshot TEXT NOT NULL)');
    db.prepare('INSERT INTO worlds VALUES (?)').run(mine[0].worldId);
    const entities = {};
    for (const s of mine) {
      const f = saved.files[s.file], row = f.identity.soul;
      db.prepare('INSERT INTO souls VALUES (?, ?, ?, ?, ?, ?, ?, NULL)').run(s.soul, s.worldId, canon.get(s.owner), row.entity_id, row.name, row.description, row.created_at);
      if (f.body.snapshot.body !== null) entities[row.entity_id] = { body: f.body.snapshot.body };
    }
    db.prepare('INSERT INTO snapshots VALUES (?, 0, ?)').run(mine[0].worldId, JSON.stringify({ entities }));
    db.close();
    worlds.push({ slug, name: slug, owner: creators[slug] ? canon.get(creators[slug].account) : undefined });
  }
  writeFileSync(join(dir, 'worlds.json'), JSON.stringify(worlds));
}

/** The directory's account store, from directory.args (`--store`), unless given. */
function storeOf(args) {
  const text = readFileSync(args, 'utf8');
  const words = (/DIRECTORYD_ARGS="?([^"\n]*)"?/.exec(text)?.[1] ?? '').trim().split(/\s+/);
  const i = words.indexOf('--store');
  return i >= 0 ? words[i + 1] : undefined;
}

/**
 * Each saved Soul into the live account store, unpaired: the import's rows for it, under its owner's account there.
 * The owner is found by sign-in (issuer, subject); a person with no account there yet gets the import's (their old id).
 * Every write is "insert if absent", in one transaction. Returns what each Soul became.
 */
function merge(staging, live) {
  const src = new DatabaseSync(staging, { readOnly: true }), dst = new DatabaseSync(live), owner = statSync(live);
  // Run as root, a log file this makes beside the store stays the directory's, as the store is.
  const keepOwner = () => { for (const f of [`${live}-wal`, `${live}-shm`]) try { if (process.getuid?.() === 0) chownSync(f, owner.uid, owner.gid); } catch { /* not there */ } };
  try {
    dst.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    try {
      for (const { name, sql } of src.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('provider_accounts_v1','account_principals_v1','account_grants_v1','imported_souls_v1','souls_v1','legacy_looks_v1')").all())
        dst.exec(sql.replace(/^CREATE TABLE (IF NOT EXISTS )?/i, 'CREATE TABLE IF NOT EXISTS '));
      const accountIn = (issuer, subject) => dst.prepare('SELECT account_id FROM provider_accounts_v1 WHERE issuer = ? AND subject = ?').get(issuer, subject)?.account_id;
      const result = [];
      for (const i of src.prepare('SELECT world, old_soul, soul FROM imported_souls_v1 ORDER BY world, old_soul').all()) {
        const s = src.prepare('SELECT * FROM souls_v1 WHERE soul = ?').get(i.soul);
        const a = src.prepare('SELECT * FROM provider_accounts_v1 WHERE account_id = ?').get(s.account_id);
        let account = accountIn(a.issuer, a.subject), made = false;
        if (!account) {
          dst.prepare('INSERT INTO provider_accounts_v1 VALUES (?, ?, ?, ?)').run(a.account_id, a.issuer, a.subject, a.created_at);
          for (const p of src.prepare('SELECT * FROM account_principals_v1 WHERE account_id = ?').all(a.account_id)) dst.prepare('INSERT OR IGNORE INTO account_principals_v1 VALUES (?, ?, ?)').run(p.account_id, p.principal_id, p.created_at);
          account = a.account_id; made = true;
        }
        const had = dst.prepare('SELECT soul FROM imported_souls_v1 WHERE world = ? AND old_soul = ?').get(i.world, i.old_soul);
        if (!had) {
          dst.prepare('INSERT INTO souls_v1 VALUES (?, ?, ?, ?, ?, ?, ?)').run(s.soul, account, s.name, s.description, s.family, s.preset, s.look);
          dst.prepare('INSERT INTO imported_souls_v1 VALUES (?, ?, ?)').run(i.world, i.old_soul, i.soul);
          for (const l of src.prepare('SELECT * FROM legacy_looks_v1 WHERE soul = ?').all(i.soul)) dst.prepare('INSERT OR IGNORE INTO legacy_looks_v1 VALUES (?, ?, ?)').run(l.soul, l.reason, l.body);
          // Its own grant (`soul-<id>`, the body the page follows): the owner's, with no token and no pairing.
          const grant = src.prepare('SELECT grant_text, follow FROM account_grants_v1 WHERE account_id = ? AND grant_text = ?').get(s.account_id, `soul-${i.soul.replace(':', '-')}`);
          if (grant) dst.prepare('INSERT OR IGNORE INTO account_grants_v1 VALUES (?, ?, ?)').run(account, grant.grant_text, grant.follow);
        }
        result.push({ world: i.world, old: i.old_soul, soul: had?.soul ?? i.soul, account, madeAccount: made, already: !!had });
      }
      dst.exec('COMMIT');
      return result;
    } catch (e) { dst.exec('ROLLBACK'); throw e; }
  } finally { src.close(); dst.close(); keepOwner(); }
}

export function copy({ tar, store, importAccounts, bodies, out, now = stamp() }) {
  const saved = readSave(tar);
  const work = mkdtempSync(join(out, `.copy-${now}-`));
  try {
    backupSet(saved, join(work, 'set'));
    // One staging folder per save: a second copy reads back the ids the first minted, so each Soul keeps its new id.
    const staging = join(out, `new-${saved.manifest.at}`);
    if (!importAccounts || !existsSync(importAccounts)) throw new Error(`no import-accounts program at ${importAccounts}`);
    const r = spawnSync(importAccounts, [join(work, 'set'), '--out', staging, '--json', ...(bodies ? ['--bodies', bodies] : [])], { encoding: 'utf8' });
    if (r.error) throw new Error(`import-accounts: ${r.error.message}`);
    let row = null;
    try { row = JSON.parse(r.stdout); } catch { /* reported below */ }
    if (!row || typeof row !== 'object') throw new Error(`import-accounts (exit ${r.status}): ${r.stderr || r.stdout || 'no output'}`);
    // The staging folder names people: the directory's only.
    for (const f of ['', ...readdirSync(staging, { recursive: true }).map(String)]) { const p = join(staging, f); chmodSync(p, statSync(p).isDirectory() ? 0o700 : 0o600); }
    // Creators are kept only where the world's creator is a person's account; anything else must be clean.
    if (!row.accountsEqual || row.conflicts || row.worlds.some((w) => !w.equal || w.unowned)) throw new Error(`import-accounts was not clean: ${r.stdout}`);
    const brought = merge(join(staging, 'accounts.sqlite'), store);
    return { saved, brought, staging, row };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/** The plain list: per person, their Souls, and what each needs from them. */
export function reconcile(saved, brought) {
  const { souls } = saved.files['souls.json'];
  const by = new Map();
  for (const s of souls) { const k = s.signIn ?? `no sign-in (old owner ${s.owner})`; by.set(k, [...(by.get(k) ?? []), s]); }
  const lines = [`Real people's Souls: ${souls.length} Souls of ${by.size} people, saved ${saved.manifest.at}.`, ''];
  for (const [person, list] of [...by].sort(([a], [b]) => a.localeCompare(b))) {
    const email = list.find((s) => s.email)?.email;
    lines.push(`${person}${email ? ` (${email})` : ''}`);
    for (const s of list) {
      const b = brought?.find((x) => x.old === s.soul && x.world === s.worldId);
      const state = !s.pairable ? 'saved only: its owner has no sign-in, so it cannot be paired again; tell Gene who it is'
        : !brought ? 'saved; not yet copied'
        : b ? `copied, unpaired${b.madeAccount ? ' (their account made from their old sign-in)' : ''}: they sign in at soul.game and pair it again (their agent: node eden.mjs upgrade)`
        : 'NOT copied: see the copy output';
      lines.push(`  - ${s.name} in ${s.world} (old id ${s.soul}): ${state}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// --- The command ----------------------------------------------------------------------------------------------------

function parse(argv) {
  const o = { data: [], drop: [], add: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--data') o.data.push(resolve(v())); else if (a === '--drop') o.drop.push(v()); else if (a === '--add') o.add.push(v());
    else if (a === '--json') o.json = true; else if (a.startsWith('--')) o[a.slice(2).replace(/-(.)/g, (_, c) => c.toUpperCase())] = v();
    else o.cmd ??= a;
  }
  if (!o.data.length) o.data = ['/srv/sim-worlds-data/production', '/srv/sim-worlds-data/legacy'].filter((d) => existsSync(d));
  o.out = resolve(o.out ?? '/srv/sim-worlds-data/kept-souls');
  return o;
}

function printCandidates(cands, gene, print) {
  for (const c of cands) print(`  ${gene ? (gene.has(c.account) ? '[confirmed] ' : '[not confirmed] ') : ''}${c.account}  ${c.signIn ? `${c.signIn.issuer} ${c.signIn.subject}` : 'no sign-in'}  ${c.souls} Souls: ${c.why.join('; ')}`);
}

export function main(argv, print = console.log) {
  const o = parse(argv);
  if (!['list', 'confirm', 'save', 'copy'].includes(o.cmd)) { print(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, readFileSync(new URL(import.meta.url), 'utf8').split('\n').findIndex((l) => l.startsWith('import'))).join('\n')); return 2; }
  if (o.cmd !== 'list') { mkdirSync(o.out, { recursive: true, mode: 0o700 }); chmodSync(o.out, 0o700); }
  if (o.cmd === 'copy') {
    o.saved ??= readdirSync(o.out).filter((f) => /^save-\d{8}T\d{6}Z\.tar$/.test(f)).sort().map((f) => join(o.out, f)).at(-1);
    if (!o.saved) { print(`keep-souls: no save in ${o.out}: run save first`); return 1; }
    const store = o.store ?? storeOf(o.args ?? '/etc/souls/directory.args');
    if (!store || !existsSync(store)) { print(`keep-souls: no account store at ${store}`); return 1; }
    const now = stamp();
    let done;
    // A refusal (a save that does not match its checksums, an unclean import, the store held by a running directory)
    // changes nothing in the store: the merge is one transaction.
    try { done = copy({ tar: resolve(o.saved), store, importAccounts: o.importAccounts ?? '/usr/local/lib/souls/import-accounts', bodies: o.bodies, out: o.out, now }); }
    catch (e) { print(`keep-souls: refused, nothing copied: ${e.message}`); return 1; }
    const { saved, brought, staging } = done;
    const text = reconcile(saved, brought);
    writeFileSync(join(o.out, `reconcile-${now}.txt`), text, { mode: 0o600 });
    print(`keep-souls: ${brought.filter((b) => !b.already).length} Souls copied into ${store}, ${brought.filter((b) => b.already).length} already there; births and directory records for placing worlds: ${staging}`);
    print(text);
    print(`keep-souls: this list is also in ${join(o.out, `reconcile-${now}.txt`)}`);
    return 0;
  }
  const stages = readStages(o.data, { etc: o.etc ?? '/etc/sim-worlds' });
  const gene = confirmed(o.out);
  if (o.cmd === 'confirm') {
    const cands = candidates(stages), known = new Set([...stages.accounts.keys(), ...stages.worlds.flatMap((w) => w.souls.map((s) => s.owner))]);
    print('keep-souls: the candidates for Gene\'s accounts:');
    printCandidates(cands, null, print);
    for (const d of o.drop) if (!cands.some((c) => c.account === d)) print(`keep-souls: warning: --drop ${d} is not a candidate; ignored`);
    for (const a of o.add) if (!known.has(a)) print(`keep-souls: warning: --add ${a} is no account and owns no Soul in these worlds; added anyway`);
    const ids = new Set([...cands.map((c) => c.account), ...o.add]);
    for (const d of o.drop) ids.delete(d);
    const record = { confirmedAt: new Date().toISOString(), data: [...o.data].sort(), candidates: cands.map((c) => ({ account: c.account, why: c.why })),
      dropped: o.drop, added: o.add, accounts: [...ids].sort() };
    writeFileSync(confirmedFile(o.out), JSON.stringify(record, null, 1) + '\n', { mode: 0o600 });
    print(`keep-souls: Gene's accounts confirmed (${ids.size}): ${[...ids].sort().join(', ')}`);
    print(`keep-souls: ${classify(stages, ids).filter((r) => r.who === 'real').length} real people's Souls; next: keep-souls.mjs save`);
    return 0;
  }
  if (o.cmd === 'save') {
    if (!gene) { print(`keep-souls: Gene's accounts are not confirmed yet: run list, then confirm (${confirmedFile(o.out)})`); return 1; }
    // The confirmation holds only for what Gene was shown: the same data folders and the same candidates.
    const record = readJson(confirmedFile(o.out), {}), now = candidates(stages).map((c) => c.account).sort();
    if (JSON.stringify(record.data) !== JSON.stringify([...o.data].sort())) { print(`keep-souls: refused: confirmed for the data folders ${JSON.stringify(record.data)}, not ${JSON.stringify([...o.data].sort())}; run list and confirm again`); return 1; }
    if (JSON.stringify((record.candidates ?? []).map((c) => c.account).sort()) !== JSON.stringify(now)) { print('keep-souls: refused: the candidates for Gene\'s accounts changed since confirm; run list and confirm again'); return 1; }
    const r = save({ stages, gene, out: o.out });
    print(`keep-souls: saved ${r.manifest.counts.souls} Souls of ${r.manifest.counts.people} people in ${r.manifest.counts.worlds} worlds to ${r.tar} (sha256 ${r.sha256})`);
    print(reconcile(readSave(r.tar), null));
    return 0;
  }
  const rows = classify(stages, gene), cands = candidates(stages);
  if (o.json) { print(JSON.stringify({ confirmed: gene ? [...gene] : null, candidates: cands, souls: rows }, null, 1)); return 0; }
  print(gene ? `Gene's accounts (confirmed): ${[...gene].sort().join(', ')}` : 'Gene\'s accounts: NOT CONFIRMED. Candidates (confirm with: keep-souls.mjs confirm [--drop <account>] [--add <account>]):');
  printCandidates(cands, gene, print);
  print('');
  print(`Live Souls: ${rows.length} in ${stages.worlds.length} worlds (who: Gene, real, operator test, or ? until confirmed)`);
  for (const w of stages.worlds) {
    const mine = rows.filter((r) => r.file === w.file);
    if (!mine.length) continue;
    print(`${w.slug} (${w.name}${w.fork ? ', an old world' : ''})`);
    for (const r of mine) print(`  ${r.who.padEnd(13)} ${r.name}  ${r.soul}  owner ${r.owner}${r.signIn ? ` (${r.signIn})` : ' (no sign-in)'}${r.email ? ` ${r.email}` : ''}`);
  }
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
