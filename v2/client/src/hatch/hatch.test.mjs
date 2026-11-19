// The code hatch in the daemon's runtime (Engine v2 F8, #2823): replica's WASM build in Node runs the world's 1,000
// chess-move cases, at the kit's budget and over it, and gives the world's table byte for byte (same verdicts, same
// counted steps, the same named refusal). Needs v2/tools/ci.sh's WASM build (target/wasm-load/pkg) and the cases the
// world's test wrote (`cargo test -p sim --test hatch`, target/tmp/hatch). Run: node --test v2/client/src/hatch/
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const target = fileURLToPath(new URL('../../../target/', import.meta.url));

test('the daemon gives the world its verdicts and steps on 1,000 cases', async () => {
  const pkg = `${target}wasm-load/pkg/`;
  const r = await import(pathToFileURL(`${pkg}replica.js`).href);
  r.initSync({ module: readFileSync(`${pkg}replica_bg.wasm`) });
  const doc = readFileSync(`${target}tmp/hatch/run.json`, 'utf8');
  const want = readFileSync(`${target}tmp/hatch/native.txt`, 'utf8');
  const got = r.hatch_run_cases(doc);
  const rows = got.trim().split('\n').map((l) => l.split(' '));
  const yes = rows.filter((w) => w[0] === '20000' && w[2] === '1').length;
  const over = rows.filter((w) => w[2] === 'refused' && w[3] === 'hatch-over-budget').length;
  const table = createHash('sha256').update(got).digest('hex').slice(0, 16);
  console.log(`daemon (WASM in Node ${process.version}): ${rows.length} rows, ${yes} yes, ${over} hatch-over-budget, table ${table}`);
  assert.equal(got, want);
});
