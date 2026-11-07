// knowledge/1 (R13, knowledge at several scales): what a Soul knows of the world beyond what it sees.
//
//  - near   : `here` already lists what is in sight (people, things, talk) in detail;
//  - district: the district the Soul is in (the top-level place holding it) is summarised: how many people are out in
//              it, its busiest outdoor places and what is on there now — counts and place names, never who;
//  - far    : other districts are names and compass directions only, unless the Soul has been there: then it also
//              knows how far, and which places in it it has visited (memory of visits, durable per Soul);
//  - explore: `GET /v1/edge/around` (look around) lists more of what is near (descriptions, the people and things a
//              little farther off).
//
// Read-mostly and deterministic for a given world state; writes are small upserts on place change or discovery.
import type {Place} from '../ledger/places.ts';
import {centroid, happenings} from '../ledger/places.ts';
import type {EdgeLedger} from '../ledger/ledger.ts';
import {compassOf, compassPoint, dist2} from './geometry.ts';

type V2 = [number, number];
export type Known = {visits: number; firstTick: number; lastTick: number; how: 'visited' | 'found'};
const FAR_LISTED = 6;
const parentOf = (p: Place) => p.semanticParent === undefined ? p.parent : p.semanticParent;
const area = (p: V2[]) => Math.abs(p.reduce((s, [x, z], i) => {const [x2, z2] = p[(i + 1) % p.length]; return s + x * z2 - x2 * z;}, 0)) / 2;

export class PlaceKnowledge {
  private readonly L: EdgeLedger;
  private readonly memo = new Map<string, Map<string, Known>>();
  constructor(L: EdgeLedger) {
    this.L = L;
    L.db.db.exec(`CREATE TABLE IF NOT EXISTS edge_place_knowledge_v1 (world_id TEXT NOT NULL, soul_id TEXT NOT NULL, place_id TEXT NOT NULL,
      how TEXT NOT NULL, visits INTEGER NOT NULL, first_tick INTEGER NOT NULL, last_tick INTEGER NOT NULL, PRIMARY KEY (world_id, soul_id, place_id)) WITHOUT ROWID;`);
  }
  private get w() {return this.L.host.worldId;}

  /** Read worker: main writes visits; forget what was read so the next read sees the database (WAL). */
  reload() {this.memo.clear();}

  // ------------------------------------------------------------ memory of visits
  memory(soulId: string): Map<string, Known> {
    let m = this.memo.get(soulId); if (m) return m;
    m = new Map((this.L.db.db.prepare('SELECT place_id, how, visits, first_tick, last_tick FROM edge_place_knowledge_v1 WHERE world_id=? AND soul_id=?').all(this.w, soulId) as {place_id: string; how: string; visits: number; first_tick: number; last_tick: number}[])
      .map(r => [r.place_id, {visits: r.visits, firstTick: r.first_tick, lastTick: r.last_tick, how: r.how === 'found' ? 'found' : 'visited'} as Known]));
    this.memo.set(soulId, m); return m;
  }
  /** Read worker (L.readOnly): the visits/finds a read records, for main to merge (the worker's database is read-only). */
  readonly outbox: {soulId: string; placeId: string; k: Known}[] = [];
  /** Main: a read worker's recorded visits/finds, merged as touch/find would (a visit beats a find; never downgraded). */
  merge(rows: readonly {soulId: string; placeId: string; k: Known}[]) {
    for (const r of rows) {
      const have = this.memory(r.soulId).get(r.placeId);
      if (have?.how === 'visited' || (have && r.k.how === 'found')) continue;
      this.write(r.soulId, r.placeId, have ? {...r.k, firstTick: have.firstTick} : r.k);
    }
  }
  private write(soulId: string, placeId: string, k: Known) {
    this.memory(soulId).set(placeId, k);
    if (this.L.readOnly) {if (this.outbox.length < 4096) this.outbox.push({soulId, placeId, k}); return;}
    this.L.db.db.prepare(`INSERT INTO edge_place_knowledge_v1 (world_id, soul_id, place_id, how, visits, first_tick, last_tick) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(world_id, soul_id, place_id) DO UPDATE SET how=excluded.how, visits=excluded.visits, last_tick=excluded.last_tick`).run(this.w, soulId, placeId, k.how, k.visits, k.firstTick, k.lastTick);
  }
  /** The Soul arrived in these places (innermost first): a visit to each it was not already in. */
  arrive(soulId: string, placeIds: readonly string[], tick: number, previous: readonly string[] = []) {
    const before = new Set(previous);
    for (const id of placeIds) {
      if (!memorable(this.L.places.byId.get(id))) continue;
      const k = this.memory(soulId).get(id);
      if (k && before.has(id)) continue;
      this.write(soulId, id, {visits: (k?.how === 'visited' ? k.visits : 0) + 1, firstTick: k?.firstTick ?? tick, lastTick: tick, how: 'visited'});
    }
  }
  /** Being somewhere counts as having been there (a Soul standing in a place since before this feature). */
  touch(soulId: string, placeIds: readonly string[], tick: number) {
    const mem = this.memory(soulId);
    for (const id of placeIds) if (memorable(this.L.places.byId.get(id)) && mem.get(id)?.how !== 'visited') this.write(soulId, id, {visits: 1, firstTick: mem.get(id)?.firstTick ?? tick, lastTick: tick, how: 'visited'});
  }

  // ------------------------------------------------------------ scales
  /** Districts: the places directly under the world's root — except a ground cover (a place spanning half the world or
   *  more, like a god world's "Green field"), whose own children stand in for it. */
  private tops(): {list: Place[]; covers: Set<string>} {
    const all = [...this.L.places.byId.values()], root = all.find(p => p.parent === null); if (!root) return {list: [], covers: new Set()};
    const authored = all.filter(p => p.semanticRole === 'district' || p.semanticRole === 'quarter');
    if (authored.length) return {list: authored, covers: new Set()};
    const kids = (id: string) => all.filter(p => parentOf(p) === id && !p.carrier), whole = area(root.polygon), covers = new Set<string>(), list: Place[] = [];
    for (const p of kids(root.id)) {const inner = kids(p.id); if (whole > 0 && area(p.polygon) >= whole / 2 && inner.length) {covers.add(p.id); list.push(...inner);} else list.push(p);}
    return {list, covers};
  }
  /** The district holding this place (on a ground cover outside any district: the cover itself). */
  districtOf(placeId: string | null): Place | null {
    const {list, covers} = this.tops(), ids = new Set(list.map(p => p.id));
    let p = placeId ? this.L.places.byId.get(placeId) : undefined, cover: Place | null = null; const seen = new Set<string>();
    while (p && !seen.has(p.id)) {seen.add(p.id); if (ids.has(p.id)) return p; if (covers.has(p.id)) cover = p; const parent = parentOf(p); p = parent ? this.L.places.byId.get(parent) : undefined;}
    return cover;
  }
  private districts(): Place[] {return this.tops().list;}
  private within(p: Place, ancestor: string): boolean {
    let q: Place | undefined = p; const seen = new Set<string>();
    while (q && !seen.has(q.id)) {if (q.id === ancestor) return true; seen.add(q.id); const parent = parentOf(q); q = parent ? this.L.places.byId.get(parent) : undefined;}
    return false;
  }
  /** Who is where, counted: innermost outdoor (not enclosed) place → people. Enclosed rooms are never counted. */
  private crowd(exclude: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const m of this.L.host.minds.values()) {
      if (m.soulId === exclude || this.L.faded.has(m.soulId)) continue;
      if (this.L.enclosureOf(m.soulId)) continue;
      const path = this.L.placePathOf(m.soulId).filter(p => p.kind !== 'occupier' && p.kind !== 'carrier');
      const inner = path.find(p => this.L.places.byId.get(p.id)?.parent); if (inner) out.set(inner.id, (out.get(inner.id) ?? 0) + 1);
    }
    return out;
  }
  /** The district summary and the far-away names, for `here`. Short: a few dozen tokens. */
  scales(soulId: string, placePath: readonly string[], pos: V2 | null, minuteOfDay: number | null) {
    this.touch(soulId, placePath, this.L.mw.world.tick);
    const district = this.districtOf(placePath[0] ?? null), mem = this.memory(soulId);
    let summary: {name: string; people: number; busy?: string[]; on?: string[]} | undefined;
    if (district) {
      const crowd = this.crowd(soulId), counts = new Map<string, number>(); let people = 0;
      for (const [id, n] of crowd) {
        const p = this.L.places.byId.get(id); if (!p || !this.within(p, district.id)) continue;
        people += n; if (id !== district.id && id !== placePath[0]) counts.set(p.name, (counts.get(p.name) ?? 0) + n);
      }
      const busy = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([name, n]) => `${name} ${n}`);
      const inside = [...this.L.places.byId.values()].filter(p => this.within(p, district.id));
      const on = minuteOfDay === null ? [] : happenings(inside, minuteOfDay, pos, 2, 0).filter(h => h.now).map(h => `${h.label} @ ${h.place}`);
      summary = {name: district.name, people, ...(busy.length ? {busy} : {}), ...(on.length ? {on} : {})};
    }
    const landmarks = [...this.L.places.byId.values()].filter(p => p.semanticRole === 'landmark' && (p.salience ?? 0) >= 2);
    const farPlaces = [...new Map([...this.districts(), ...landmarks].map(p => [p.id,p])).values()];
    const others = farPlaces.filter(d => d.id !== district?.id).map(d => {const at = centroid(d.polygon); return {d, at, m: pos ? dist2(pos, at) : 0};})
      .sort((a, b) => { const nearA = a.m <= 160, nearB = b.m <= 160; return Number(nearB) - Number(nearA) || (nearA ? a.m - b.m : (b.d.salience ?? 0) - (a.d.salience ?? 0) || a.m - b.m) || a.d.id.localeCompare(b.d.id); });
    const far = others.slice(0, FAR_LISTED).map(({d, at, m}) => {
      const dir = pos ? compassPoint(compassOf(at[0] - pos[0], at[1] - pos[1])) : '?';
      const districtName = d.semanticRole === 'landmark' ? this.districtOf(d.id)?.name : undefined;
      const name = districtName && districtName !== d.name ? `${d.name} (${districtName})` : d.name;
      if (!mem.has(d.id)) return `${name} · ${dir}`;
      const been = [...mem].filter(([id, k]) => id !== d.id && k.how === 'visited' && this.L.places.byId.get(id) && this.within(this.L.places.byId.get(id)!, d.id))
        .sort((a, b) => b[1].lastTick - a[1].lastTick || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, 2).map(([id]) => this.L.places.byId.get(id)!.name);   // ties (a room and its house, one tick) in id order, not memory order
      return `${name} · ${dir} ${Math.round(m / 10) * 10}m${been.length ? ` · been: ${been.join(', ')}` : ' · been'}`;
    });
    return {...(summary ? {district: summary} : {}), far, ...(others.length > FAR_LISTED ? {farMore: others.length - FAR_LISTED} : {})};
  }
}

/** Places worth remembering: not the world itself, not a personal sleeping mat. */
const memorable = (p: Place | undefined) => !!p && p.parent !== null && p.kind !== 'sleeping-mat' && !/(^|-)mat-\d+$/.test(p.id);
