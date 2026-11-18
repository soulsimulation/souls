// What a world costs (O11, #2721): the scripted hour, the sum check, a stopped world, the not-metered rule, the page.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { check, money, PARTS, PRICES, price, priceEntries, readProcess, sample, tableRows, useFromSamples, writePage } from './cost.mjs';

const prices = JSON.parse(readFileSync(PRICES, 'utf8'));
const MIN = 60_000;
const GIB = 2 ** 30;

/** Samples of one world every `step` ms over `ms`, from a function of elapsed ms. */
function script(world, ms, step, at) {
  const out = [];
  for (let t = 0; t <= ms; t += step) out.push({ at_ms: 1_000_000 + t, world, ...at(t) });
  return out;
}

test('A2: a scripted hour with known use, uploads and bytes gives the hand-worked figure to the cent', () => {
  // Half a core, 1 GiB resident, 2 GB on disk, 5 GB stored, an upload every 10 s and 10 MB/s served, for one hour.
  const hour = script('w', 3_600_000, MIN, (t) => ({
    pid: 7, cpu_s: t / 2000, rss_bytes: GIB, disk_bytes: 2e9, stored_bytes: 5e9,
    store: 1, uploads: t / 10_000, origin: 1, served_bytes: (t / 1000) * 1e7,
  }));
  const { rows } = price(prices, useFromSamples(hour));
  // By hand, prices of 18 Nov 2026: the machine's day is 79 EUR x 1.0968 / 30.4375 days = $2.846725.
  const want = {
    processor: (2.846725 * 0.5) / (8 * 86_400) * 1800, // its half of the day over 8 cores' seconds, x 1,800 core-s: $0.0037067
    memory: (2.846725 * 0.4) / (30.6 * 24) * 1, // x 1 GiB-hour: $0.0015505
    local_disk: (2.846725 * 0.1) / (245 * 24) * 2, // x 2 GB-hours: $0.0000968
    stored_bytes: (0.015 / (30.4375 * 24)) * 5, // $0.015 a GB-month, x 5 GB-hours: $0.0001027
    uploads: 360 * 4.5e-6, // 360 uploads at $4.50 a million: $0.00162
    bytes_served: 36e9 * (1.0968 / 1e12), // 36 GB at 1 EUR a TB: $0.0394848
  };
  for (const part of PARTS) assert.ok(Math.abs(rows.w[part] - want[part]) < 1e-6, `${part}: ${rows.w[part]} vs ${want[part]}`);
  const total = PARTS.reduce((a, part) => a + rows.w[part], 0);
  assert.equal(money(total), '$0.05');
  assert.ok(Math.abs(total - 0.0465615) < 1e-5, `total ${total}`);
});

test('A3: all worlds plus "unused" equal the machine\'s price for the day within 1 %', () => {
  const day = 86_400_000;
  const samples = [
    // A busy world (a core and a half, 6 GiB), a quiet one, one restarted mid-day (its counter starts again), one stopped.
    ...script('busy', day, 5 * MIN, (t) => ({ pid: 1, cpu_s: t * 0.0015, rss_bytes: 6 * GIB, disk_bytes: 40e9 })),
    ...script('quiet', day, 5 * MIN, (t) => ({ pid: 2, cpu_s: t * 0.00002, rss_bytes: 0.1 * GIB, disk_bytes: 1e9 })),
    ...script('restarted', day, 5 * MIN, (t) => ({ pid: t < day / 2 ? 3 : 4, cpu_s: (t % (day / 2)) * 0.0005, rss_bytes: 2 * GIB, disk_bytes: 5e9 })),
    ...script('stopped', day, 5 * MIN, () => ({ pid: null, cpu_s: 0, rss_bytes: 0, disk_bytes: 3e9 })),
  ];
  const priced = price(prices, useFromSamples(samples));
  const c = check(priced);
  assert.ok(Math.abs(priced.machine - 2.846725) < 1e-5, `the machine's day ${priced.machine}`);
  assert.ok(c.ok && c.off <= 0.01, JSON.stringify(c));
  for (const v of Object.values(priced.unused)) assert.ok(v >= 0, 'no part over the machine');
  // The check is not a remainder: shares that do not add to one are caught.
  const skewed = { ...prices, split: { ...prices.split, memory: 0.45 } };
  assert.equal(check(price(skewed, useFromSamples(samples))).ok, false);
  // The busy world's processor: 1.5 cores of 8 for the day is 1.5/8 of the processor's half.
  assert.ok(Math.abs(priced.rows.busy.processor - (2.846725 * 0.5 * 1.5) / 8) < 1e-4);
});

test('A4: a world stopped by hand costs under $0.01 a day', () => {
  // No process all day; its folder (1 GB) stays on the local disk. Stored bytes are not metered until V3.
  const day = script('asleep', 86_400_000, MIN, () => ({ pid: null, cpu_s: 0, rss_bytes: 0, disk_bytes: 1e9 }));
  const row = price(prices, useFromSamples(day)).rows.asleep;
  const total = PARTS.reduce((a, part) => a + (row[part] ?? 0), 0);
  assert.equal(row.processor, 0);
  assert.equal(row.memory, 0);
  assert.ok(total < 0.01 && total > 0, `a stopped world's day: $${total}`);
});

test('A5: every unit price has a date and a source, and a part not metered reads "not metered", never zero', () => {
  for (const [name, entry] of priceEntries(prices)) {
    assert.match(entry.date ?? '', /^\d{4}-\d{2}-\d{2}$/, `${name} has a date`);
    assert.ok(typeof entry.source === 'string' && entry.source.length > 10, `${name} has a source`);
  }
  // What the sampler writes today: no uploads, stored bytes or origin counters.
  const hour = script('w', 3_600_000, MIN, (t) => ({ pid: 1, cpu_s: t / 1000, rss_bytes: GIB, disk_bytes: 1e9 }));
  const priced = price(prices, useFromSamples(hour));
  for (const part of ['stored_bytes', 'uploads', 'bytes_served']) assert.equal(priced.rows.w[part], null);
  const [row] = tableRows(priced);
  assert.deepEqual(row.slice(4, 7), ['not metered', 'not metered', 'not metered']);
  assert.match(row[7], /\+ not metered$/);
  assert.equal(money(null), 'not metered');
  assert.equal(money(0), '$0.00');
});

test('A1: the sampler reads a real process and the page shows dollars by six parts, readable by its owner only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o11-'));
  mkdirSync(join(root, 'worlds', 'alpha'), { recursive: true });
  mkdirSync(join(root, 'worlds', 'beta'), { recursive: true });
  writeFileSync(join(root, 'worlds', 'alpha', 'log'), Buffer.alloc(1 << 20));
  mkdirSync(join(root, 'health'), { recursive: true });
  writeFileSync(join(root, 'health', 'origin-stats.json'), JSON.stringify({ started: 5, bytes: { alpha: 1000 } }));
  // A stand-in world: a process that spins for a moment.
  const child = spawn(process.execPath, ['-e', 'const e=Date.now()+400;while(Date.now()<e);setTimeout(()=>{},60000)']);
  try {
    await new Promise((r) => setTimeout(r, 600));
    const proc = readProcess(child.pid);
    assert.ok(proc && proc.cpu_s > 0 && proc.rss_bytes > 0, JSON.stringify(proc));
    const t0 = Date.UTC(2026, 10, 18, 12);
    sample(root, { alpha: child.pid, beta: null }, t0);
    writeFileSync(join(root, 'health', 'origin-stats.json'), JSON.stringify({ started: 5, bytes: { alpha: 1e9 + 1000 } }));
    sample(root, { alpha: child.pid, beta: null }, t0 + 3_600_000);
  } finally {
    child.kill();
  }
  const { priced, check: c, out } = writePage(root, '2026-11-18');
  assert.ok(c.ok);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const html = readFileSync(out, 'utf8');
  for (const label of ['Processor', 'Memory', 'Local disk', 'Stored bytes', 'Uploads', 'Bytes served', 'unused', 'alpha', 'beta']) {
    assert.ok(html.includes(label), label);
  }
  assert.ok(priced.rows.alpha.bytes_served > 0 && priced.rows.alpha.memory > 0 && priced.rows.alpha.local_disk > 0);
  assert.equal(priced.rows.beta.memory, 0);
});
