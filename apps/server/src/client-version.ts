// #1936: which client each Soul runs. Every client request says `x-soul-client: <version>`; an authenticated Soul request
// is counted here in memory, one count per Soul, client and UTC day, and the counts go to edge_clients_v1 at most once a
// minute and at shutdown. No request waits on the database. A request without the header counts as client `none`; any
// other value (a tool's `bench/1`, say) is kept as given.
import type {Context, Hono, MiddlewareHandler} from 'hono';
import type {DatabaseSync} from 'node:sqlite';

export const CLIENT_HEADER = 'x-soul-client';
export const CLIENT_FLUSH_MS = 60_000;

type Count = {soul: string; client: string; day: string; first: number; last: number; n: number};

export class EdgeClients {
  private counts = new Map<string, Count>();
  private timer: ReturnType<typeof setInterval> | null;
  private db: DatabaseSync;
  constructor(db: DatabaseSync, everyMs = CLIENT_FLUSH_MS) {
    this.db = db;
    this.timer = everyMs > 0 ? setInterval(() => this.flush(), everyMs) : null; this.timer?.unref();
  }
  note(soul: string, header: string | undefined, at = Date.now()): void {
    const client = header || 'none', day = new Date(at).toISOString().slice(0, 10), key = `${soul}\n${client}\n${day}`;
    const c = this.counts.get(key);
    if (c) { c.last = at; c.n++; } else this.counts.set(key, {soul, client, day, first: at, last: at, n: 1});
  }
  /** Adds the counts so far to their rows: a row that exists keeps its first_at and gains n. */
  flush(): void {
    if (!this.counts.size) return;
    const rows = [...this.counts.values()]; this.counts.clear();
    try {
      const up = this.db.prepare(`INSERT INTO edge_clients_v1 (soul_id, client, day, first_at, last_at, n) VALUES (?,?,?,?,?,?)
        ON CONFLICT(soul_id, client, day) DO UPDATE SET last_at = MAX(last_at, excluded.last_at), n = n + excluded.n`);
      this.db.exec('BEGIN');
      try { for (const r of rows) up.run(r.soul, r.client, r.day, r.first, r.last, r.n); this.db.exec('COMMIT'); }
      catch (e) { this.db.exec('ROLLBACK'); throw e; }
    } catch (e) { console.error('[clients] counts not written', (e as Error).message); }
  }
  close(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.flush(); }
}

export function clientCounter(counts: EdgeClients, soulOf: (c: Context) => string | null): MiddlewareHandler {
  return async (c, next) => { const soul = soulOf(c); if (soul) counts.note(soul, c.req.header(CLIENT_HEADER)); await next(); };
}

/** One line in http.ts: counts every authenticated Soul request; main.ts closes it (a last flush) at shutdown. */
export function mountClientCounter(app: Hono, db: DatabaseSync, soulOf: (c: Context) => string | null): EdgeClients {
  const counts = new EdgeClients(db);
  app.use('*', clientCounter(counts, soulOf));
  return counts;
}
