import test from 'node:test';
import assert from 'node:assert/strict';
import { suppliedNativeStream, nativeCameraMode, beforeNavigation, displayedNativeTick } from './camera-native-page.mjs';
import { EventEmitter } from 'node:events';
test('native stream comes from the supplied document config, not unrelated mentions or executable text', () => {
  assert.equal(suppliedNativeStream('<head><script>window.__simConfig={"v2Stream":"/s/fixture/live/"}</script></head>'), '/s/fixture/live/');
  for (const html of ['<script>window.__simConfig=alert(1)</script>', '<script>const v2Stream="/s/w/"</script>', '<script>window.__simConfig={"v2Stream":"https://example.com/s/w/"}</script>', '<script>window.__simConfig={"v2Stream":"/s/w/../x/"}</script>', '<script>window.__simConfig={}</script>']) assert.throws(() => suppliedNativeStream(html));
  assert.throws(() => suppliedNativeStream('<script>window.__simConfig={}</script><script>window.__simConfig={}</script>'), /ambiguous/);
});
test('the observer listens to the real navigation and detaches without fetching or injecting configuration', async () => {
  const page = new EventEmitter(), stop = beforeNavigation({ page, base: 'https://example.com' });
  assert.equal(page.listenerCount('response'), 1); await stop(); assert.equal(page.listenerCount('response'), 0);
});
test('responsive camera input uses visible direct controls or Menu then Camera, with snapshots before clicks', async () => {
  for (const visible of [false, true]) for (const mode of ['manual', 'broadcast']) {
    const events = [];
    const locator = (role, name) => ({ isVisible: async () => visible, click: async () => events.push(`click:${role}:${name}`), getByRole: (r, o) => locator(r, o.name) });
    const page = { getByRole: (role, o) => locator(role, o.name) };
    await nativeCameraMode(page, mode, async name => events.push(`snapshot:${name}`));
    const clicks = events.filter(s => s.startsWith('click:'));
    assert.equal(clicks.length, visible ? 2 : 3);
    assert.equal(clicks[0], visible ? 'click:button:Camera modes and help' : 'click:button:Menu');
    if (!visible) assert.match(clicks[1], /^click:menuitem:/);
    assert.equal(clicks.at(-1), `click:button:${mode === 'manual' ? 'Free' : 'Broadcast'}`);
    for (let i = 0; i < events.length; i++) if (events[i].startsWith('click:')) assert.match(events[i - 1], /^snapshot:/);
  }
});

test('depicted native ticks may be fractional, but absent, nonfinite or negative values are not readiness', () => {
  for (const tick of ['0', '42.25', '1024.0001']) assert.equal(displayedNativeTick(tick), true);
  for (const tick of [null, '', ' ', 'Infinity', 'NaN', '-0.1', 'not-a-tick']) assert.equal(displayedNativeTick(tick), false);
});
