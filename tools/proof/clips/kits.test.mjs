// 0.135 P6: the clip kits run on the new engine. A kit that still drives the old world's client (`eden.mjs`, the god
// CLI) is listed with `skip` in its kit.json, saying what has no new-engine form; every other kit acts only through the
// shared cast (the new client, and the rides' _shared/ride.mjs over it), and nothing names the old server.
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const here = import.meta.dirname;
const OLD = /tools\/world-launcher\/soul\/eden\.mjs|eden-god\.mjs|god-skill\/dev-world|apps\/server|'tools\/world-launcher\/soul'/;

test('each kit either acts through the new client or is listed and skipped, by name', () => {
  const kits = readdirSync(here).filter((d) => existsSync(join(here, d, 'kit.json')));
  assert.ok(kits.length >= 15, `${kits.length} kits`);
  const skipped = [];
  for (const k of kits) {
    const kit = JSON.parse(readFileSync(join(here, k, 'kit.json'), 'utf8'));
    let steps = readFileSync(join(here, k, 'steps.mjs'), 'utf8');
    const reuse = /export \{ default \} from '\.\.\/([^/]+)\/steps\.mjs'/.exec(steps);
    if (reuse) steps = readFileSync(join(here, reuse[1], 'steps.mjs'), 'utf8');
    if (kit.skip !== undefined) { assert.ok(typeof kit.skip === 'string' && kit.skip.length > 20, `${k}: skip says why`); skipped.push(k); continue; }
    assert.doesNotMatch(steps, OLD, `${k} drives the old world: list it with skip, or port it to the shared cast`);
  }
  for (const f of ['_shared/cast.mjs', '_shared/ride.mjs']) assert.doesNotMatch(readFileSync(join(here, f), 'utf8'), OLD, `${f} acts through the new client`);
  assert.deepEqual(skipped.sort(), ['classroom-tv', 'ride-wheel', 'tv-channels', 'tv-channels-noon']);
});
