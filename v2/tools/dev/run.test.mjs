import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '../../..');
const predicate = readFileSync(join(root, 'v2/tools/dev/run.sh'), 'utf8').split('\n').find(line => line.startsWith('until_ready gatewayd '));
assert.ok(predicate);
const endpoint = 'gateway.test:19446';
for (const [name, log, accepted] of [
 ['ordinary', `listening ${endpoint}\n`, true],
 ['actual concatenation', `gatewayd: the world is reachable; 0 unanswered intents sent againlistening ${endpoint}\n`, true],
 ['other records', `noise\nlistening ${endpoint}\nnoise\n`, true],
 ['wrong endpoint', 'listening gateway.test:19447\n', false],
 ['wrong address', 'listening other-gateway.test:19446\n', false],
 ['truncated endpoint', 'listening gateway.test:1944\n', false],
 ['longer port', `listening ${endpoint}0\n`, false],
 ['trailing text', `listening ${endpoint} pending\n`, false],
 ['missing terminator', `listening ${endpoint}`, false],
 ['unrelated text', `gateway forwarding ${endpoint}\n`, false],
 ['absent', '', false],
]) test(`owned gateway readiness: ${name}`, () => {
 mkdirSync(join(root, '.local'), {recursive:true});
 const dir=mkdtempSync(join(root,'.local/gateway-ready-'));
 try {mkdirSync(join(dir,'logs'));writeFileSync(join(dir,'logs/gatewayd.log'),log);
 let passed=true;try{execFileSync('bash',['-c',`until_ready() { shift; "$@"; }; GATEWAY='${endpoint}'; ${predicate}`],{cwd:dir,stdio:'pipe'});}catch{passed=false;}
 assert.equal(passed,accepted);
 } finally {rmSync(dir,{recursive:true});}
});
