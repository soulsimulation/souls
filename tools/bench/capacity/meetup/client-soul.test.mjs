// #2077: a call whose deadline leaves less than one try's time (a fractional number of ms) still reaches the world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { clientCall } from './client-soul.mjs';

test('a call with less than one try of its deadline left still asks the world (#2077)', async () => {
  let asked = 0;
  const srv = createServer((req, res) => { asked++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"accepted":true}'); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    // 20 s is under the 25 s read try, so the try's timeout is the deadline less the time already spent: a fraction
    const x = await clientCall(`http://127.0.0.1:${srv.address().port}/v1/edge/here`, { deadlineMs: 20_000 });
    assert.equal(x.status, 200); assert.equal(x.failed, 0); assert.equal(asked, 1);
  } finally { srv.close(); }
});
