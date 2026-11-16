// #2466: the signed-in account's Souls across this launcher's worlds, for the homepage's My Souls section.
// Each world's own store is read read-only, as worldOwner and tokenLabel do, so a sleeping world stays asleep. Ownership is
// the world's own rule (apps/server/src/souls.ts `owns`): a world without accounts goes by the row's owner; a world with
// them (its account tables exist) by apps/server/src/accounts/service.ts `owns`: an account membership decides; without
// one the row's owner does, and a local dev account (dev:<name>) only with its captured legacy authority. Only public
// fields leave: never the owner id, a token or its hash.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const HASH = /^[a-f0-9]{64}$/;
const has = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);

/** A humanoid look (core/humanoid@2, what the homepage can draw) from a body-assignment payload, else null. */
function lookOf(payload) {
  let b; try { b = JSON.parse(payload ?? 'null')?.body; } catch { return null; }
  return b?.family === 'humanoid' && /^humanoid2-[0-9a-f]{16}$/.test(b.model ?? '') && b.params && typeof b.params === 'object' && !Array.isArray(b.params) ? { family: 'humanoid', model: b.model, params: b.params } : null;
}
/** The live Souls `account` owns in one world's store: [{id, entityId, name, description, bornAt, photoHash, body}]. */
export function ownedSouls(file, worldId, account) {
  if (typeof account !== 'string' || !account || !existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!has(db, 'souls')) return [];
    const members = has(db, 'account_soul_memberships_v1'), legacy = has(db, 'account_legacy_authority_v1'), auto = has(db, 'soul_auto_portraits_v1');
    const rows = db.prepare(`SELECT id, owner, entity_id, name, description, created_at, token_hash FROM souls WHERE world_id=? AND retired_at IS NULL AND (owner=?${members ? ' OR id IN (SELECT soul_id FROM account_soul_memberships_v1 WHERE world_id=? AND account_id=?)' : ''}) ORDER BY created_at`)
      .all(...(members ? [worldId, account, worldId, account] : [worldId, account]));
    const member = members ? db.prepare('SELECT account_id FROM account_soul_memberships_v1 WHERE world_id=? AND soul_id=?') : null;
    const authority = legacy ? db.prepare('SELECT 1 FROM account_legacy_authority_v1 WHERE world_id=? AND soul_id=? AND legacy_owner_id=? AND revoked_at IS NULL') : null;
    const portrait = auto ? db.prepare('SELECT hash FROM soul_auto_portraits_v1 WHERE world_id=? AND soul_id=?') : null;
    // its body: the latest body assignment the world journaled for it (events_soul index), a humanoid look or nothing
    const assigned = has(db, 'events') ? db.prepare("SELECT payload FROM events WHERE world_id=? AND soul_id=? AND kind='body-assignment-v1' ORDER BY seq DESC LIMIT 1") : null;
    const owns = (r) => {
      if (!members) return r.owner === account;
      const m = member?.get(worldId, r.id), validLegacy = r.owner === account && r.token_hash !== null && !!authority?.get(worldId, r.id, account);
      return m ? m.account_id === account || validLegacy : r.owner === account && (!account.startsWith('dev:') || validLegacy);
    };
    return rows.filter(owns).map((r) => {
      const hash = portrait?.get(worldId, r.id)?.hash;
      return { id: r.id, entityId: r.entity_id, name: r.name, description: r.description, bornAt: r.created_at, photoHash: typeof hash === 'string' && HASH.test(hash) ? hash : null, body: lookOf(assigned?.get(worldId, r.id)?.payload) };
    });
  } finally { db.close(); }
}

/** A live Soul's profile photo bytes by content address (its uploaded photo or its automatic portrait), or null. */
export function soulPhoto(file, worldId, soulId, hash) {
  if (!HASH.test(hash ?? '') || !existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!has(db, 'souls') || !db.prepare('SELECT 1 FROM souls WHERE id=? AND world_id=? AND retired_at IS NULL').get(soulId, worldId)) return null;
    for (const t of ['soul_profile_photos_v1', 'soul_auto_portraits_v1']) {
      const r = has(db, t) ? db.prepare(`SELECT image FROM ${t} WHERE world_id=? AND soul_id=? AND hash=?`).get(worldId, soulId, hash) : null;
      if (r?.image) return Buffer.from(r.image);
    }
    return null;
  } finally { db.close(); }
}

/** The account's Souls grouped by Soul id, each with the worlds it lives in. `photo(world, soul)` names its picture's URL.
 *  `current(world, ids)` may give a running world's own current photo hashes (an uploaded photo outranks the portrait). */
export function accountSouls(worlds, account, { file, worldId, url, photo, current = new Map() }) {
  const out = new Map();
  for (const w of worlds) {
    let rows; try { rows = ownedSouls(file(w), worldId(w), account); } catch { continue; } // a world's unreadable store hides only its own Souls
    for (const r of rows) {
      const hash = current.get(w.slug)?.get(r.id) ?? r.photoHash;
      const s = out.get(r.id) ?? { id: r.id, name: r.name, description: r.description, bornAt: r.bornAt, photoUrl: null, body: null, worlds: [] };
      if (!s.photoUrl && hash) s.photoUrl = photo(w, r.id, hash);
      s.body ??= r.body;
      if (r.bornAt < s.bornAt) s.bornAt = r.bornAt;
      s.worlds.push({ slug: w.slug, name: w.name, url: url(w) });
      out.set(r.id, s);
    }
  }
  return [...out.values()].sort((a, b) => a.bornAt - b.bornAt);
}
