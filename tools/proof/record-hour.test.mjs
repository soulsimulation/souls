// 0.135 P5: on a page on the new engine the recorder's time of day goes on the address as `?hour=HH:MM`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { hourOf, namesV2Stream, withHour } from '../../.claude/skills/proof/record.mjs';

test('--time-of-day becomes the page\'s hour', () => {
  assert.equal(hourOf('12'), '12:00');
  assert.equal(hourOf('6.5'), '06:30');
  assert.equal(hourOf('19:45'), '19:45');
  assert.equal(hourOf('24'), null);
  assert.equal(hourOf('noon'), null);
  assert.equal(withHour('http://127.0.0.1:1/w/a/?hour=03:00&x=1', '12:00'), 'http://127.0.0.1:1/w/a/?hour=12%3A00&x=1');
});

test('a page whose inline config names v2Stream is on the new engine; another is not', async () => {
  const server = createServer((req, res) => res.end(req.url.includes('v2') ? '<script>window.__simConfig={"worldKey":"a","v2Stream":"/s/a/"}</script>' : '<html></html>'));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const at = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await namesV2Stream(`${at}/v2/`), true);
    assert.equal(await namesV2Stream(`${at}/old/`), false);
    assert.equal(await namesV2Stream('http://127.0.0.1:1/'), false);
  } finally { server.close(); }
});
