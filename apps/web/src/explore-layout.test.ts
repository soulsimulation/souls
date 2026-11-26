import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Release 0.138: Explore searches its locations each time it opens and the dialog grows when they come. Centred, it moved
// its Soul rows up under the cursor, and a click aimed at a Soul hit the locations line. Anchored at the top a full
// dialog would have, it grows downward: the Souls above the locations stay where they are.
test('the Explore dialog is anchored at its top, so its Souls do not move when the locations come in', () => {
  const css = readFileSync(new URL('./Explore.css', import.meta.url), 'utf8');
  const rule = css.match(/\.explore-modal\{([^}]*)\}/)?.[1] ?? '';
  const margin = rule.match(/(?:^|;)margin:([^;]+)/)?.[1]?.trim() ?? '';
  assert.match(margin, / auto auto$/, `margin "${margin}": the bottom must be auto (not centred)`);
  const top = margin.replace(/ auto auto$/, '');
  // the top depends on the viewport and the dialog's maximum height only, never on its content
  assert.match(top, /^max\(24px,calc\(\(100dvh - min\(720px,100dvh - 48px\)\)\/2\)\)$/);
  assert.match(rule, /max-height:min\(720px,calc\(100dvh - 48px\)\)/, 'the top is computed from this maximum height');
});
