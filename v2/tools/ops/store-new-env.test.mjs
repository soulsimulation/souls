// store-new-env.sh: plan prints no key, apply writes store-switch.sh's file (mode 600) through stdin, undo removes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./store-new-env.sh', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'store-new-env-'));
const secrets = join(dir, 'r2.env'), dest = join(dir, 'store-new.env');
writeFileSync(secrets, 'ASSETS_ACCESS_KEY_ID=aaa\nWORLDS_ACCESS_KEY_ID=worlds-id-123\nWORLDS_SECRET_ACCESS_KEY="worlds-secret-456"\nR2_ENDPOINT=https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com\n');
chmodSync(secrets, 0o600);
const env = { ...process.env, STORE_NEW_REMOTE: 'bash -c', STORE_NEW_DEST: dest };
const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8' });

test('plan shows the shape and no key', () => {
  const r = run('plan', secrets);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /STORE_BASE=s3:https:\/\/<account endpoint>\/soul-game-worlds\n/);
  assert.match(r.stdout, /AWS_SECRET_ACCESS_KEY=<set>/);
  assert.ok(!/worlds-id-123|worlds-secret-456|0123456789abcdef/.test(r.stdout + r.stderr));
  assert.ok(!existsSync(dest));
});

test('apply writes the file store-switch.sh reads, mode 600, and prints no key; undo removes it', () => {
  const r = run('apply', secrets);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/worlds-id-123|worlds-secret-456/.test(r.stdout + r.stderr));
  assert.equal(statSync(dest).mode & 0o777, 0o600);
  const text = readFileSync(dest, 'utf8');
  const base = /^STORE_BASE=(.*)$/m.exec(text)[1];
  // store-switch.sh check_new's own test of STORE_BASE.
  assert.match(base, /^s3:https?:\/\/[^/@]+\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
  assert.equal(base, 's3:https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/soul-game-worlds');
  assert.match(text, /^AWS_ACCESS_KEY_ID=worlds-id-123$/m);
  assert.match(text, /^AWS_SECRET_ACCESS_KEY=worlds-secret-456$/m);
  assert.match(text, /^AWS_DEFAULT_REGION=auto$/m);
  assert.ok(!/aaa/.test(text), 'the assets token stays out');
  // store-switch.sh's reader takes the values back out as written.
  const value = (k) => execFileSync('awk', ['-v', `k=${k}`, '{ sub(/^export /, "") } index($0, k "=") == 1 { v = substr($0, length(k) + 2); gsub(/^["\\047]|["\\047]$/, "", v); print v; exit }', dest], { encoding: 'utf8' }).trim();
  assert.equal(value('AWS_SECRET_ACCESS_KEY'), 'worlds-secret-456');
  assert.equal(run('undo').status, 0);
  assert.ok(!existsSync(dest));
});

test('a secrets file others can read is refused', () => {
  const loose = join(dir, 'loose.env');
  writeFileSync(loose, readFileSync(secrets));
  chmodSync(loose, 0o644);
  const r = run('plan', loose);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /mode 600/);
});
