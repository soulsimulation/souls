import test from 'node:test';
import assert from 'node:assert/strict';
import { coreLibrary } from '../index.ts';
import { contactStateKey } from '../contact.ts';

test('the poetry folio uses one gated contact inscription and no erasure', () => {
  const def = coreLibrary().get('core-poetry-folio@1')!;
  assert.ok(def);
  assert.equal(contactStateKey(def, 'write'), 'text');
  assert.deepEqual(def.actions.map(a => a.name), ['write']);
  assert.deepEqual(def.actions[0].when, [{ field: 'text', is: '' }]);
  const text = def.actions[0].params.text;
  assert.equal(text.type, 'string');
  assert.equal(text.type === 'string' && text.max, 100);
  assert.equal(def.state.text.default, '');
  assert.equal(def.state.textBy.default, '');
  assert.ok(def.components.readable);
  assert.ok(def.tags.includes('sign-text'));
});
