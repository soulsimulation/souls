// A finite re-read of already-held public records for clients that synced before optional name metadata existed.
import { decode, publicNameRecords, rememberPublicNames } from '../brief/copy.mjs';

const uint = (n) => {
  n = BigInt(n);
  if (n < 24n) return Buffer.from([Number(n)]);
  const size = n <= 255n ? 1 : n <= 65535n ? 2 : n <= 4294967295n ? 4 : 8;
  const out = Buffer.alloc(size + 1); out[0] = 24 + Math.log2(size);
  for (let k = size; k > 0; k--) { out[k] = Number(n & 255n); n >>= 8n; }
  return out;
};
export function recordsRequest(n, hashes) {
  if (hashes.length > 64 || hashes.some((hash) => !/^[0-9a-f]{68}$/.test(hash))) throw new Error('public-name-request');
  const count = uint(hashes.length); count[0] |= 0x80;
  return Buffer.concat([Buffer.from([0xa2, 20]), uint(n), Buffer.from([22]), count, ...hashes.map((hash) => Buffer.concat([Buffer.from([0x58, 34]), Buffer.from(hash, 'hex')]))]);
}

export function publicNameHydration(copy, nextNumber, currentSocket) {
  const attempted = new WeakMap();
  let running = null, pending = null;
  const finish = (owner, result) => {
    if (!owner || pending !== owner) return;
    const { resolve, timer } = owner; pending = null; clearTimeout(timer); resolve(result);
  };
  return {
    cancel(sock) { if (pending?.sock === sock) finish(pending, { ok: false, reason: 'public-names-disconnected' }); },
    answer(sock, n, refused, bytes) {
      if (!pending || pending.n !== n || pending.sock !== sock) return false;
      const owner = pending;
      try {
        if (currentSocket() !== sock || refused !== '-') throw new Error('public-names-refused');
        const records = decode(bytes).get(22), expected = pending.records;
        if (!Array.isArray(records) || records.length !== expected.length) throw new Error('public-name-records');
        const reachable = new Map(publicNameRecords(copy, false).map((r) => [r.hash, r]));
        for (let k = 0; k < records.length; k++) {
          const now = reachable.get(expected[k].hash);
          if (!now || !(records[k] instanceof Uint8Array) || !Buffer.from(records[k]).equals(Buffer.from(expected[k].bytes)) || !Buffer.from(now.bytes).equals(Buffer.from(expected[k].bytes))) throw new Error('public-name-current-record');
        }
        rememberPublicNames(copy, bytes, new Set(expected.map((r) => r.reference)));
        finish(owner, { ok: true });
      } catch { finish(owner, { ok: false, reason: 'public-names-refused' }); }
      return true;
    },
    hydrate(sock, deadline) {
      if (running?.sock === sock) return running.promise;
      if (!sock || currentSocket() !== sock) return Promise.resolve({ ok: false, reason: 'public-names-disconnected' });
      if (pending && pending.sock !== sock) finish(pending, { ok: false, reason: 'public-names-disconnected' });
      const pass = { sock };
      pass.promise = (async () => {
        let seen = attempted.get(sock);
        if (!seen) attempted.set(sock, (seen = new Set()));
        const wanted = publicNameRecords(copy).filter((r) => !seen.has(r.hash));
        for (let at = 0; at < wanted.length; at += 64) {
          if (currentSocket() !== sock) return { ok: false, reason: 'public-names-disconnected' };
          const left = deadline - performance.now();
          if (left <= 0) return { ok: false, reason: 'public-names-timeout' };
          const records = wanted.slice(at, at + 64), n = nextNumber();
          const result = await new Promise((resolve) => {
            const owner = { sock, n, records, resolve };
            owner.timer = setTimeout(() => finish(owner, { ok: false, reason: 'public-names-timeout' }), left);
            pending = owner;
            try { sock.send(recordsRequest(n, records.map((r) => r.hash))); } catch { finish(owner, { ok: false, reason: 'public-names-disconnected' }); }
          });
          if (!result.ok) return result;
          for (const r of records) seen.add(r.hash);
        }
        return { ok: true };
      })().finally(() => { if (running === pass) running = null; });
      running = pass;
      return pass.promise;
    },
  };
}
