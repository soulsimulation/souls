// #1145: instructions.md is what a new Soul's agent follows first. `act` takes an offered id and refuses words.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const guide = readFileSync(new URL('./soul/instructions.md', import.meta.url), 'utf8');

test('the guide shows act with an offered id, never with quoted words', () => {
  assert.doesNotMatch(guide, /\bact\s+["']/);
  assert.match(guide, /`node eden\.mjs act wave:here --wait`/);
});

// An onboarding in a read-only agent sandbox failed noisily on the skill copy: it is optional, so a folder the agent
// cannot write falls back to ./SKILL.md.
test('step 1 copies the skill where the harness reads skills, or reads ./SKILL.md when that folder is not writable', () => {
  const step1 = guide.slice(guide.indexOf('1. **This folder'), guide.indexOf('2. **Name.**')).replace(/\s+/g, ' ');
  assert.match(step1, /Put a copy of SKILL\.md where your harness reads skills/);
  assert.match(step1, /if that folder is not writable \(a read-only sandbox\), skip the copy and read `\.\/SKILL\.md`/);
});

// #3376: a new Soul arrives whole: a character's own name and, at once, a look; its picture follows the look.
test('#3376 the create step names the Soul as a character and gives it a look before anything else', () => {
  const step2 = guide.slice(guide.indexOf('2. **Name.**'), guide.indexOf('3. **Create')).replace(/\s+/g, ' ');
  assert.match(step2, /a name of its own, a character's name such as "Mira Vale"/);
  assert.match(step2, /never this device's name, your human's name or anything personal/);
  const step3 = guide.slice(guide.indexOf('3. **Create'), guide.indexOf('4. **Start listening')).replace(/\s+/g, ' ');
  assert.match(step3, /The moment the Soul exists, before it does anything else, give it a look that suits its name/);
  assert.match(step3, /body look --set key=value …` \(or `--random`\)/);
  assert.match(step3, /picture is drawn from its look/);
  const cli = readFileSync(new URL('./soul/eden.mjs', import.meta.url), 'utf8');
  const said = (re) => cli.split('\n').filter((l) => re.test(l));
  assert.equal(said(/^A new Soul gets a character's name of its own \(never the device's, the owner's or anything personal\), then at once a look .*body look --set .*--random.*picture comes from the look/).length, 1, 'one guide line');
  assert.equal(said(/^\s+`\(create: a character's own name, never the device's, the owner's or anything personal; then at once body look --set .*--random: the picture comes from the look\)`,$/).length, 1, 'one help row');
});
