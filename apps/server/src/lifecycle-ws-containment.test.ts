import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
for(const boundary of ['hello','periodic','broadcast','refresh'])for(const damaged of ['body','event_hash'])test(`actual child WS ${boundary} contains authorized corrupt ${damaged} and preserves other viewers`,()=>{
  // The child ends by itself once its sockets reach their boundaries; the timeout only stops a hung child. A loaded
  // CI host can take several times the 2-5 s a child takes on a quiet one.
  // L5 (srv-boot item 1): boot prints its `[boot] <phase>` lines on stdout, so the child's receipt is its last line
  const result=spawnSync(process.execPath,[new URL('../test/lifecycle-ws-fault.ts',import.meta.url).pathname,boundary,damaged],{encoding:'utf8',timeout:120_000});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout.trim().split('\n').at(-1)!) as {contained:boolean;otherViewersAlive:boolean;paid:number};assert.equal(receipt.contained,true);assert.equal(receipt.otherViewersAlive,true);assert.equal(receipt.paid,0);
});
