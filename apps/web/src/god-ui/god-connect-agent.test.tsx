// #5006 rows 2, 3 and 5: on a world the new engine runs, God Mode shows its creator the one line for its agent, with
// the creator grant it pairs with, until the agent is connected; the agent's creator request comes up on the page as an
// approval card, for that world's owner alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

Object.assign(globalThis, { location: { origin: 'https://soul.example', pathname: '/w/hamlet/', search: '', hash: '', href: 'https://soul.example/w/hamlet/' } });
const { Connect, OwnerGod } = await import('./GodModal.tsx');
const { creatorPrompt } = await import('./god-api.ts');
const { agentPaired, godAgentState } = await import('./god-agent-state.ts');
const { isCreatorRequest, nextWaiting, waitingOf } = await import('./V2PairDialog.tsx');

const GRANT = `creator-${'2b'.repeat(16)}-7`, GUIDE = 'https://soul.example/w/hamlet/creator.md';

test('the line for the agent names the world\'s creator guide and the creator grant it pairs with', () => {
  assert.equal(creatorPrompt(GUIDE, GRANT), `Read ${GUIDE} and follow it to build this world as its creator, pairing with --creator ${GRANT}.`);
  const html = renderToStaticMarkup(<Connect url={GUIDE} grant={GRANT} state="not-connected" />);
  assert.ok(html.includes(`data-connect-line="${creatorPrompt(GUIDE, GRANT)}"`), 'the copied line is the whole prompt');
  assert.match(html, new RegExp(`data-creator-grant="${GRANT}"`));
  assert.match(html, /data-gateway-state="not-connected"[^>]*>Not connected</);
  assert.match(html, /a card comes up on this page/, 'the step says where the approval is');
  // an old-engine world keeps its line and steps
  const old = renderToStaticMarkup(<Connect url={GUIDE} state="not-paired" />);
  assert.ok(old.includes(`data-connect-line="Read ${GUIDE} and follow it to build this world as its god."`));
  assert.doesNotMatch(old, /--creator/);
});

test('#5006: on a new-engine world the creator\'s own tools (Build among them) show without the agent; elsewhere they wait for it', () => {
  const tools = <button data-build-open="place">Place</button>;
  const v2 = renderToStaticMarkup(<OwnerGod connectUrl={GUIDE} grant={GRANT} tools={tools} forsake={null} paired={false} ownTools />);
  assert.match(v2, /data-gateway-state="not-connected"/, 'the line for the agent is still there');
  assert.match(v2, /data-god-tools="1"[^>]*><button data-build-open="place"/, 'and Build beside it');
  assert.doesNotMatch(v2, /data-god-console/, 'the command box waits for the agent');
  const old = renderToStaticMarkup(<OwnerGod connectUrl={GUIDE} tools={tools} forsake={null} paired={false} />);
  assert.doesNotMatch(old, /data-build-open/, 'an old-engine world\'s tools wait for its agent, as before');
});

test('on a new-engine world the agent is paired while the creator\'s mailbox says it is connected, and only then', () => {
  const v2 = (connected: boolean) => ({ v2: true as const, connected });
  assert.equal(agentPaired(0, v2(false)), false, 'not connected: the panel shows the line to give it');
  assert.equal(agentPaired(0, v2(true)), true, 'connected: the command box');
  assert.equal(agentPaired(0, null), false, 'not known yet');
  assert.equal(agentPaired(1, { connected: false }), true, 'an old-engine world counts its paired agents as before');
  assert.equal(godAgentState(agentPaired(0, v2(false)), v2(false)).live, 'off', 'the God button is not green');
  assert.equal(godAgentState(agentPaired(0, v2(true)), v2(true)).live, 'on');
});

test('the creator\'s agent request shows only on its own world\'s page, for its owner; Soul requests as before', () => {
  const list = waitingOf({ waiting: [
    { code: 'BCDF-GHJK', device: 'laptop', label: 'souls-god.mjs', soul: GRANT, age: 3, former: null, name: null },
    { code: 'LMNP-QRST', device: 'laptop', label: 'Claude Code on this computer', soul: null, age: 9, former: null, name: 'Fern' },
  ] });
  assert.equal(list.length, 2, 'a creator grant is a well-formed request');
  assert.equal(isCreatorRequest(list[0]!), true);
  assert.equal(isCreatorRequest(list[1]!), false);
  assert.equal(nextWaiting(list, new Set(), GRANT)?.code, 'BCDF-GHJK', 'the owner: its agent\'s request first');
  assert.equal(nextWaiting(list, new Set(), null)?.code, 'LMNP-QRST', 'anyone else: never a creator\'s request');
  assert.equal(nextWaiting(list, new Set(), `creator-${'3c'.repeat(16)}-1`)?.code, 'LMNP-QRST', 'another world\'s creator grant is not this page\'s');
  assert.equal(nextWaiting(list, new Set(['BCDF-GHJK']), GRANT)?.code, 'LMNP-QRST', 'a closed card stays closed');
});
