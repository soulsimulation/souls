// #1386: the world page never shows a selection or tap highlight on a press, long-press, double-tap or drag; fields,
// code and the copyable start prompt keep their text. A guard on the stylesheet rules (the clip proves the behaviour).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/world-chrome.css', import.meta.url), 'utf8');
const rule = (selectorPart: string) => css.split('}').find(r => r.includes(selectorPart)) ?? '';

test('the world page, its menus, its dialogs and the boot arrival select nothing and show no tap highlight', () => {
  const r = rule('body:has(.human-world),');
  for (const s of ['body:has(.human-world)', ':is(dialog,[popover])', '.human-world', '.navbar-popover', '#boot-arrival']) assert.ok(r.includes(s), s);
  for (const d of ['-webkit-tap-highlight-color:transparent', '-webkit-touch-callout:none', '-webkit-user-select:none', 'user-select:none']) assert.ok(r.includes(d), d);
});

test('fields, code and the start prompt stay selectable', () => {
  const r = rule(':is(input,textarea,');
  for (const s of ['input', 'textarea', '[contenteditable]', 'pre', 'code', '.soul-prompt']) assert.ok(r.includes(s), s);
  assert.ok(r.includes('user-select:text') && r.includes('-webkit-touch-callout:default'));
});
