import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { pairAddress, worldOf } from './address.mjs';
import { worldOf as cliWorldOf, pairAddress as cliPairAddress } from '../cli/souls.mjs';

test('the CLI keeps the shared resolver and explicit isolated-loopback contract', async () => {
  assert.equal(cliWorldOf, worldOf);
  assert.equal(cliPairAddress, pairAddress);
  const url = 'http://localhost/local?gateway=' + encodeURIComponent('ws://localhost:45678/v2/ws');
  assert.deepEqual(await pairAddress(url, () => { throw new Error('local route has no bootstrap'); }), {
    directory: 'http://localhost', world: 'local', gateway: 'ws://localhost:45678/v2/ws',
  });
  assert.throws(() => worldOf('https://user:secret@example.invalid/w/eden/'), { code: 'pair-names-a-world' });
  assert.throws(() => worldOf('http://localhost/local?gateway=wss://example.invalid/v2/ws'), { code: 'pair-names-a-world' });
});
