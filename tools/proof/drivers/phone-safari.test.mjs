import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { capabilities, touchPath, privateAddress, privateAddresses, privateDoor, phoneSafari } from './phone-safari.mjs';

test('the session asked for is a real iPhone, never the simulator', () => {
  assert.deepEqual(capabilities().capabilities.alwaysMatch, { browserName: 'safari', platformName: 'iOS', 'safari:useSimulator': false });
});
test('a touch is one finger: down at the first point, through the rest, up', () => {
  const [finger] = touchPath([[10.4, 20], [30, 40], [50, 60]], 400).actions;
  assert.equal(finger.parameters.pointerType, 'touch');
  assert.deepEqual(finger.actions.map(a => a.type), ['pointerMove', 'pointerDown', 'pointerMove', 'pointerMove', 'pause', 'pointerUp']);
  assert.deepEqual([finger.actions[0].x, finger.actions[0].duration, finger.actions[2].duration], [10, 0, 200]);
  assert.throws(() => touchPath([[1, NaN]]), /touch-points/);
});
test('only private addresses may carry a local page; a public one is refused', async () => {
  for (const ip of ['10.0.0.5', '172.16.4.1', '172.31.255.1', '192.168.1.20', '100.64.0.1', '100.127.9.9', '169.254.3.3']) assert.equal(privateAddress(ip), true, ip); // scrub-guard: allow (made-up private-range fixtures)
  for (const ip of ['198.51.100.7', '172.32.0.1', '100.128.0.1', '192.169.1.1', '1.2.3', 'example.org']) assert.equal(privateAddress(ip), false, ip); // scrub-guard: allow (documentation-range fixtures)
  assert.deepEqual(privateAddresses({ a: [{ family: 'IPv4', internal: false, address: '100.70.1.1' }, { family: 'IPv4', internal: false, address: '203.0.113.9' }], b: [{ family: 'IPv4', internal: false, address: '192.168.1.7' }, { family: 'IPv4', internal: true, address: '127.0.0.1' }] }), ['192.168.1.7', '100.70.1.1']); // scrub-guard: allow (documentation-range fixtures)
  await assert.rejects(privateDoor('http://127.0.0.1:9', '203.0.113.9'), /not-private/); // scrub-guard: allow (documentation-range fixtures)
  await assert.rejects(privateDoor('http://example.org', '192.168.1.7'), /not-local/);
});
test('the session opens an address, sends a touch and saves a screenshot through WebDriver', async () => {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c; seen.push([req.method, req.url, body && JSON.parse(body)]);
    const value = req.url === '/session' ? { sessionId: 's1', capabilities: { 'safari:deviceType': 'iPhone' } } : req.url.endsWith('/screenshot') ? Buffer.from('png').toString('base64') : null;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ value }));
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  try {
    const phone = await phoneSafari({ driver: `http://127.0.0.1:${server.address().port}` });
    await phone.open('http://192.168.1.7:1/w/x/'); await phone.touch([[1, 2], [3, 4]]);
    const { mkdtempSync, readFileSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'phone-safari-')), 'a.png'); await phone.screenshot(file); await phone.close();
    assert.equal(readFileSync(file, 'utf8'), 'png'); assert.equal(phone.device.type, 'iPhone');
    assert.deepEqual(seen.map(s => s[0] + ' ' + s[1]), ['POST /session', 'POST /session/s1/url', 'POST /session/s1/actions', 'GET /session/s1/screenshot', 'DELETE /session/s1']);
    assert.equal(seen[2][2].actions[0].parameters.pointerType, 'touch');
  } finally { server.close(); }
});
