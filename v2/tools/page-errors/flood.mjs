// Token buckets (Engine v2 O25, #3336): carried over from today's tools/world-launcher/flood.mjs, the one class the
// page-error module uses. Nothing is imported from today's tree.
export class TokenBuckets {
  constructor(perS, burst, now = Date.now) { this.perS = perS; this.burst = burst; this.now = now; this.b = new Map(); this.calls = 0; }
  /** 0 when allowed, else ms until one token is back. `force`: the request was already let through (counted after
   *  the fact): take the token even when there is none, down to one burst of debt, and answer 0 */
  take(key, force = false) {
    const now = this.now(); let e = this.b.get(key);
    if (!e) { e = { t: this.burst, at: now }; this.b.set(key, e); }
    else { e.t = Math.min(this.burst, e.t + Math.max(0, now - e.at) * this.perS / 1000); e.at = now; }
    if (++this.calls % 5000 === 0) for (const [k, x] of this.b) if (x.t + (now - x.at) * this.perS / 1000 >= this.burst) this.b.delete(k);
    if (e.t >= 1 || force) { e.t = Math.max(-this.burst, e.t - 1); return 0; }
    return Math.max(1, Math.ceil((1 - e.t) * 1000 / this.perS));
  }
}
