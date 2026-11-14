import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const DESCRIPTION = 'Souls is a multiplayer simulation whose characters, called Souls, are run by AI agents. Watch a world live, pair your agent with a Soul, or create a world and be its god.';

test('social crawlers receive the Souls identity and the large starburst card without JavaScript', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const [attribute, key, value] of [
    ['property', 'og:title', 'Souls'], ['property', 'og:description', DESCRIPTION],
    ['name', 'twitter:title', 'Souls'], ['name', 'twitter:description', DESCRIPTION], ['name', 'description', DESCRIPTION],
  ]) assert.ok(html.includes(`<meta ${attribute}="${key}" content="${value}"`));
  const images = [...html.matchAll(/<meta (?:property="og:image"|name="twitter:image") content="([^"]+)"/g)].map(m => m[1]);
  assert.equal(images.length, 2);
  assert.equal(images[0], images[1]);
  // the card is pwa/icon-social.png, which the build emits as assets/sim-social-<sha256 prefix>.png (vite.config.ts pwa())
  const card = readFileSync(new URL('../pwa/icon-social.png', import.meta.url));
  assert.equal(images[0], `https://soul.game/assets/sim-social-${createHash('sha256').update(card).digest('hex').slice(0, 10)}.png`);
  assert.deepEqual([card.readUInt32BE(16), card.readUInt32BE(20)], [1200, 630], 'the PNG is 1200x630');
  for (const [attribute, key, value] of [
    ['property', 'og:image:width', '1200'], ['property', 'og:image:height', '630'], ['name', 'twitter:card', 'summary_large_image'],
    ['property', 'og:image:alt', 'A white starburst of light'], ['name', 'twitter:image:alt', 'A white starburst of light'],
  ]) assert.ok(html.includes(`<meta ${attribute}="${key}" content="${value}"`), key);
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)![1]);
  assert.deepEqual([ld.description, ld.image], [DESCRIPTION, images[0]]);
  assert.ok(html.includes('<link rel="canonical" href="https://soul.game/"'));
});

// The world list's bar lives in styles.css (#2190: the loading state draws it before launcher-home.css arrives).
test('the top-left Souls halo always sits in a solid black circle, in a world and on the world list (#1034)', () => {
  const css = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [path, selector] of [['./world-chrome.css', '.human-world .eden-mark'], ['./styles.css', '.lh-title .eden-mark']]) {
    const rules = [...css(path).matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter(m => m[1].split(',').some(s => s.trim() === selector));
    assert.ok(rules.length > 0, `${path} styles ${selector}`);
    const backgrounds = rules.flatMap(m => [...m[2].matchAll(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/g)].map(b => b[1].trim()));
    assert.deepEqual(backgrounds, ['#000'], `${selector} has one background, solid black, not a theme token`);
    assert.ok(rules.some(m => /border-radius:\s*50%/.test(m[2])), `${selector} is a circle`);
  }
});
