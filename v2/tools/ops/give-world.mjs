#!/usr/bin/env node
// Gives a world's creator to an account, for a world whose creator no account holds (the 25 Nov 2026 account wipe left
// every imported world so), and installs its gateway's creator flags. Runbook: docs/operations.md, "A world no
// account owns". Root on the directory's machine.
//
//   node give-world.mjs <world> <account id> check    prints what run would change; changes nothing
//   node give-world.mjs <world> <account id> run      the check, then the change, with backups
//
// <world> is the world's name in the world-authority map (or an alias, or its placed instance). Its creator is the
// principal its tokens file names (`# souls-creator/1 <generation> <principal>`, which the directory writes and the
// gateway checks), which must agree with its world.json and its map entry.
//
// The account side (directoryd's store, `account_principals_v1` and `account_grants_v1`; one principal per account):
//   - the principal held by the account already: nothing changes there;
//   - held by another account: refused `principal-held` (that account hands the world off from its page instead);
//   - held by none: the account takes it and its grant `creator-<principal>`. An account that already holds another
//     principal gives that one up, and the grant with it, only when no placed world names it as creator; otherwise
//     refused `account-creates-other-worlds`, as those worlds would be left with no creator.
//   The directory keeps its store locked while it runs, so a change stops souls-directory, backs the store up
//   (`<store>.before-give-<world>-<time>`, VACUUM INTO), writes in one transaction, starts it again and waits for its
//   /healthz; if it does not answer, the backup goes back and the directory starts on it.
// The gateway side (`/etc/souls/gateway-<instance>.env`): `--creator <principal> --directory <the directory's listen>
// --creator-authority-required` added where missing (backup `<env>.before-creator-<time>`), then souls-gateway@ restarts;
// if it is not active after, the backup goes back. A gateway naming another creator is refused `gateway-creator-differs`.
// A refusal prints `refused: <name>: <why>` and exits 3, changing nothing it had not already undone.
//
// GIVE_ROOT=<folder> stands in for /, GIVE_SYSTEMCTL for systemctl and GIVE_STAMP for the time (the test's).
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, chownSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { isMain } from './is-main.mjs';

const R = process.env.GIVE_ROOT ?? '';
const ETC = `${R}/etc/souls`;
const AUTHORITY = `${ETC}/placement-data/authority.json`;
const PRINCIPAL = /^([0-9a-f]{32})[:-]([0-9]+)$/;
const INSTANCE = /^[0-9a-f]{32}-[0-9a-f]{32}-[0-9]+$/;
const ACCOUNT = /^acct_[0-9a-f-]{36}$/;

export class Refusal extends Error {
  constructor(name, why) { super(`${name}: ${why}`); this.refusal = name; }
}
const refuse = (name, why) => { throw new Refusal(name, why); };
const say = (line) => console.log(`give-world: ${line}`);
const text = (p) => { const m = PRINCIPAL.exec(p ?? ''); return m ? `${m[1]}:${m[2]}` : null; };
const flagForm = (p) => p.replace(':', '-');
const words = (v) => v.replace(/^(["'])(.*)\1$/, '$2').split(/\s+/).filter(Boolean);
const flag = (v, f) => { const w = words(v), i = w.indexOf(f); return i < 0 ? null : (w[i + 1] ?? ''); };

function systemctl(...args) {
  const r = spawnSync(process.env.GIVE_SYSTEMCTL ?? 'systemctl', args, { encoding: 'utf8' });
  return r.status === 0;
}

// The directory's listen and store, from directory.args (the defaults are the install's).
function directory() {
  const file = `${ETC}/directory.args`;
  const v = existsSync(file) ? (readFileSync(file, 'utf8').match(/^\s*(?:export\s+)?DIRECTORYD_ARGS=(.*)$/m)?.[1] ?? '') : '';
  return { listen: flag(v, '--listen') || '127.0.0.1:7310', store: `${R}${flag(v, '--store') || '/var/lib/souls/directory/accounts.sqlite'}` };
}

// The world: its map entry, its instance, its folder and its creator, which every place naming one must agree on.
export function world(name) {
  const map = JSON.parse(readFileSync(AUTHORITY, 'utf8'));
  if (map.format !== 'souls/world-authority/1') refuse('authority-invalid', `${AUTHORITY} is not a world-authority map`);
  const key = map.worlds?.[name] ? name : map.aliases?.[name] ?? Object.keys(map.worlds ?? {}).find((k) => map.worlds[k].instance === name);
  const entry = key && map.worlds[key];
  if (!entry || !INSTANCE.test(entry.instance ?? '')) refuse('world-unknown', `${name} is not in the world-authority map`);
  const folder = `${R}${map.worldsRoot ?? '/var/lib/souls/worlds'}/worlds/${entry.instance}`;
  const json = JSON.parse(readFileSync(join(folder, 'world.json'), 'utf8'));
  if (json.name !== entry.instance) refuse('world-mismatch', `${folder}/world.json names another world`);
  const marker = existsSync(join(folder, 'tokens')) ? readFileSync(join(folder, 'tokens'), 'utf8').split('\n').find((l) => l.startsWith('# souls-creator/1 ')) : undefined;
  const [, generation, owner] = marker?.split(' ').slice(1) ?? [];
  if (marker && owner === 'none') refuse('handoff-pending', `${key} is being handed off; its recipient accepts it from the page`);
  const named = [marker && text(owner), text(json.creator), text(entry.creator)].filter(Boolean);
  if (!named.length) refuse('creator-unknown', `${key} names no creator`);
  if (new Set(named).size > 1) refuse('creator-differs', `${key}'s tokens file, world.json and map entry name different creators`);
  return { name: key, instance: entry.instance, folder, creator: named[0], generation: Number(generation ?? 0), map };
}

// Every placed world's creator, by name (the map's, else its folder's world.json).
function creators(map) {
  const out = [];
  for (const [name, e] of Object.entries(map.worlds ?? {})) {
    let c = text(e.creator);
    if (!c) try { c = text(JSON.parse(readFileSync(`${R}${map.worldsRoot ?? '/var/lib/souls/worlds'}/worlds/${e.instance}/world.json`, 'utf8')).creator); } catch {}
    if (c) out.push([name, c]);
  }
  return out;
}

// What the account side needs, read from `db`: a list of statements (empty when nothing changes).
export function accountPlan(db, w, account) {
  if (!db.prepare('SELECT 1 FROM provider_accounts_v1 WHERE account_id=?').get(account)) refuse('account-missing', `no account ${account}`);
  const holder = db.prepare('SELECT account_id FROM account_principals_v1 WHERE principal_id=?').get(w.creator)?.account_id;
  if (holder && holder !== account) refuse('principal-held', `another account holds ${w.name}'s creator; it hands the world off from its page`);
  const grant = `creator-${flagForm(w.creator)}`;
  const steps = [];
  if (!holder) {
    const own = db.prepare('SELECT principal_id FROM account_principals_v1 WHERE account_id=?').get(account)?.principal_id;
    if (own) {
      const others = creators(w.map).filter(([, c]) => c === own).map(([n]) => n);
      if (others.length) refuse('account-creates-other-worlds', `${account} creates ${others.join(', ')}; one account holds one principal, so taking ${w.name}'s would leave those with no creator`);
      steps.push(['the account gives up its principal, which creates no placed world, and its grant',
        'UPDATE account_principals_v1 SET principal_id=? WHERE account_id=? AND principal_id=?', [w.creator, account, own]],
      ['', 'DELETE FROM account_grants_v1 WHERE account_id=? AND grant_text=?', [account, `creator-${flagForm(own)}`]]);
    } else {
      steps.push(['the account takes the principal', 'INSERT INTO account_principals_v1(account_id, principal_id, created_at) VALUES(?,?,?)', [account, w.creator, Math.floor(Date.now() / 1000)]]);
    }
  }
  if (!db.prepare('SELECT 1 FROM account_grants_v1 WHERE account_id=? AND grant_text=?').get(account, grant)) {
    steps.push([`the account gets the grant ${grant}`, 'INSERT INTO account_grants_v1(account_id, grant_text, follow) VALUES(?,?,NULL)', [account, grant]]);
  }
  return steps;
}

// The gateway's file with the creator flags it misses (null when it has them all).
export function gatewayPlan(envText, w, listen) {
  const m = envText.match(/^(\s*(?:export\s+)?GATEWAYD_ARGS=)(.*)$/m);
  if (!m) refuse('gateway-invalid', 'its file has no GATEWAYD_ARGS line');
  const v = m[2], has = flag(v, '--creator');
  if (has !== null && text(has) !== w.creator) refuse('gateway-creator-differs', `${w.name}'s gateway names another creator`);
  const more = [has === null ? `--creator ${flagForm(w.creator)}` : '', flag(v, '--directory') === null ? `--directory ${listen}` : '',
    words(v).includes('--creator-authority-required') ? '' : '--creator-authority-required'].filter(Boolean).join(' ');
  if (!more) return null;
  const q = /^(["']).*\1$/.test(v) ? v[0] : '', inner = q ? v.slice(1, -1) : v;
  return { more, text: envText.replace(m[0], `${m[1]}${q}${inner.trimEnd()} ${more}${q}`) };
}

// A read of the store while the directory may hold it: a copy of its files (the WAL with it), opened there.
function snapshot(store, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'give-world-'));
  try {
    for (const s of ['', '-wal', '-shm']) if (existsSync(store + s)) copyFileSync(store + s, join(dir, `db${s}`));
    const db = new DatabaseSync(join(dir, 'db'));
    try { return fn(db); } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function keepOwner(from, to) {
  const st = statSync(from);
  if (process.getuid?.() === 0) chownSync(to, st.uid, st.gid);
}

async function healthy(listen) {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://${listen}/healthz`)).ok) return true; } catch {}
    await new Promise((ok) => setTimeout(ok, 500));
  }
  return false;
}

export async function main(argv) {
  const [name, account, act] = argv;
  if (!name || !ACCOUNT.test(account ?? '') || !['check', 'run'].includes(act)) refuse('usage', 'give-world.mjs <world> <account id> check|run');
  const w = world(name), dir = directory(), env = `${ETC}/gateway-${w.instance}.env`;
  const stamp = process.env.GIVE_STAMP ?? new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  if (!existsSync(dir.store)) refuse('store-missing', `no directory store at ${dir.store}`);
  if (!existsSync(env)) refuse('gateway-missing', `no ${env}`);
  say(`world     ${w.name} (${w.instance}), creator generation ${w.generation}`);
  const steps = snapshot(dir.store, (db) => accountPlan(db, w, account));
  const gw = gatewayPlan(readFileSync(env, 'utf8'), w, dir.listen);
  say(`account   ${steps.length ? steps.map((s) => s[0]).filter(Boolean).join('; ') : 'holds the creator and its grant already; no change'}`);
  say(`gateway   ${gw ? `add ${gw.more}` : 'has the creator flags already; no change'}`);
  if (act === 'check') { say('check only; nothing changed'); return; }
  if (steps.length) {
    const backup = `${dir.store}.before-give-${w.name}-${stamp}`;
    if (existsSync(backup)) refuse('backup-exists', `${backup} exists`);
    say('1. stop souls-directory (it locks its store)');
    if (!systemctl('stop', 'souls-directory.service')) refuse('directory-stop', 'souls-directory did not stop');
    let db;
    try {
      db = new DatabaseSync(dir.store);
      const again = accountPlan(db, w, account);
      if (JSON.stringify(again.map((s) => s.slice(1, 2))) !== JSON.stringify(steps.map((s) => s.slice(1, 2)))) refuse('store-changed', 'the store changed since the check');
      db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
      keepOwner(dir.store, backup);
      say(`2. store backed up: ${backup}`);
      db.exec('BEGIN IMMEDIATE');
      try { for (const [, sql, args] of again) db.prepare(sql).run(...args); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      if (accountPlan(db, w, account).length) { refuse('store-unchanged', 'the account does not hold the creator after the write'); }
      say('3. the account holds the creator and its grant');
    } catch (e) {
      systemctl('start', 'souls-directory.service');
      throw e;
    } finally { db?.close(); }
    systemctl('start', 'souls-directory.service');
    if (!(await healthy(dir.listen))) {
      systemctl('stop', 'souls-directory.service');
      for (const s of ['-wal', '-shm']) rmSync(dir.store + s, { force: true });
      copyFileSync(backup, dir.store);
      systemctl('start', 'souls-directory.service');
      refuse('directory-unhealthy', `souls-directory did not answer /healthz; the store is back from ${backup}`);
    }
    say('4. souls-directory answers /healthz');
  }
  if (gw) {
    const backup = `${env}.before-creator-${stamp}`;
    if (existsSync(backup)) refuse('backup-exists', `${backup} exists`);
    copyFileSync(env, backup);
    keepOwner(env, backup);
    const tmp = `${env}.give.new`;
    writeFileSync(tmp, gw.text, { mode: statSync(env).mode & 0o777 });
    keepOwner(env, tmp);
    renameSync(tmp, env);
    say(`5. gateway file backed up (${backup}) and given ${gw.more}`);
    const unit = `souls-gateway@${w.instance}.service`;
    if (!systemctl('restart', unit) || !systemctl('is-active', '--quiet', unit)) {
      copyFileSync(backup, env);
      systemctl('restart', unit);
      refuse('gateway-unhealthy', `${unit} was not active on its new flags; its file is back from ${backup}`);
    }
    say(`6. ${unit} restarted and active`);
  }
  say(`done: ${w.name} is ${account}'s`);
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    if (!(e instanceof Refusal)) throw e;
    console.error(`refused: ${e.message}`);
    process.exit(3);
  });
}
