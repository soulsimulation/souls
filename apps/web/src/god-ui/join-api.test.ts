// First day, 27 Nov: the prompt a person pastes to their agent said 'the Eden world "Verdelis Eden"' (and 'the Eden
// world "Eden 2026"'), so an agent could not tell the product, Eden and another world called Verdelis Eden apart. A
// world is named once, by its own name; "Eden" is one world's name, never a kind of world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
(globalThis as { location?: unknown }).location ??= new URL('https://soul.game/w/x/');   // world-path.ts reads it at import
const { joinPrompt, reconnectPrompt } = await import('./join-api.ts');

test('the join and reconnect prompts name the world by its own name only', () => {
  for (const world of ['Eden 2026', 'Verdelis Eden', 'RnA Studio']) {
    for (const text of [joinPrompt('https://soul.game/w/x', world), joinPrompt('https://soul.game/w/x', world, 'Ana'),
      reconnectPrompt('https://soul.game/w/x', world, { id: 's_1', name: 'Ana' })]) {
      assert.match(text, new RegExp(`in the world "${world}"`));
      assert.doesNotMatch(text, /\bEden world\b/);
    }
  }
});
