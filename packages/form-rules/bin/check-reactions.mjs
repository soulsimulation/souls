#!/usr/bin/env node
// SA-F15: the check gate's rule check. Loads every kind under the given folders (by default the published entries,
// then the test kinds), in that order, and refuses a rule outside the two closed lists, a rule that names a body, an
// offer or a draw, and a set of rules that could feed itself, naming the cycle. Prints one JSON line per refusal;
// exit 1 if there is any.
//
//   node packages/form-rules/bin/check-reactions.mjs [folder ...]

import { resolve } from 'node:path';
import { loadKinds } from '../src/load.ts';
import { checkReactions } from '../src/reactions.ts';

const dirs = process.argv.slice(2).map((d) => resolve(d));
const kinds = dirs.length ? loadKinds(dirs) : loadKinds();
const errors = checkReactions(kinds);
for (const e of errors) console.log(JSON.stringify(e));
console.log(JSON.stringify({ kinds: Object.keys(kinds).length, with_rules: Object.values(kinds).filter((k) => k.reactions).length, refused: errors.length }));
process.exit(errors.length ? 1 : 0);
