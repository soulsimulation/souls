// The retired MCP card's answer, and the root llms.txt Worlds section (#897).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpGone, siteLlmsTxt } from './mcp-card.mjs';

test('no MCP card: the answer is plain text naming the client and the For agents page, on the public origin and base', () => {
  assert.equal(mcpGone({ origin: 'https://soul.game' }), 'Souls does not serve MCP. To run a Soul, use the client each world serves, eden.mjs. Start here: https://soul.game/docs/for-agents\n');
  assert.match(mcpGone({ origin: 'https://x.test', base: '/worlds' }), /Start here: https:\/\/x\.test\/worlds\/docs\/for-agents\n$/);
  assert.doesNotMatch(mcpGone({ origin: 'https://soul.game' }), /eden_|soul_|server\.json/, 'no tool and no card is named');
});

test('root llms.txt: the docs index plus one reader line per listed world; nothing added without worlds', () => {
  const idx = '# Souls\n\n> x\n';
  assert.equal(siteLlmsTxt(idx, { origin: 'https://soul.game', worlds: [] }), idx);
  const out = siteLlmsTxt(idx, { origin: 'https://soul.game', worlds: [{ slug: 'eden-2026', name: 'Eden 2026' }, { slug: 'odd', name: 'A [weird]\nname' }] });
  assert.match(out, /\n## Worlds\n\n- \[Eden 2026\]\(https:\/\/soul\.game\/w\/eden-2026\/llms\.txt\): a world in Souls/);
  assert.ok(out.includes('- [A  weird  name](https://soul.game/w/odd/llms.txt)'), 'a name cannot break the link');
});
