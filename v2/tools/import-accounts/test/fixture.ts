// Engine v2 X11 (#2820): the fixture, a stage's accounts and two worlds' Souls made by today's own code, then backed up
// by today's nightly backup. Never committed: made by the test.
//
// - Accounts: today's AccountRegistry binds three people in the stage's registry (`<data>/accounts.sqlite`); the old
//   worlds' own registry (`<data>/forks/accounts.sqlite`) binds one of them again (a second id for the same person) and
//   one person only it knows.
// - Worlds: two worlds, each booted by today's WorldHost on its own SQLite file (`<data>/worlds/<slug>/sim.db`), with
//   Souls created through today's Souls.create: one retired, one holding an agent token, one wearing a creature
//   body (today's body assignment). `<data>/worlds.json` names each world's creator, as the launcher writes it.
// - Then today's backup (tools/world-launcher/deploy/backup.mjs) copies the stage, and the set's folder is returned.
//
//   node v2/tools/import-accounts/test/fixture.ts [<dir>]     (from the repository root; default .local/import-accounts/fixture)
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AccountRegistry } from '../../../../apps/server/src/account-registry.ts';
import { BODY_PRESETS } from '../../../../apps/server/src/edge/body/routes.ts';
import { accept, fixture } from '../../../../apps/server/test/native-owner-fixture.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
export const ISSUER = 'https://clerk.fixture.test';
export const WORLDS = ['x11-hamlet', 'x11-garden'];

export type Fixture = {
  set: string;
  /** The stage's account ids and the old worlds' own ids, by person. */
  stage: Record<string, string>;
  forks: Record<string, string>;
  /** Per world: its live Souls (id, owner, name, description), its retired Soul ids, and its creator. */
  worlds: Record<string, { live: { id: string; owner: string; name: string; description: string }[]; retired: string[]; creator: string }>;
  /** The agent tokens issued (the importer must copy none). */
  tokens: string[];
  /** The Soul wearing a creature body, and its preset. */
  creature: { soul: string; preset: string };
};

export async function makeFixture(dir: string): Promise<Fixture> {
  const data = join(dir, 'data');
  mkdirSync(join(data, 'forks'), { recursive: true });
  const reg = new AccountRegistry(join(data, 'accounts.sqlite'));
  const stage = { alice: reg.bind(ISSUER, 'user_alice'), bob: reg.bind(ISSUER, 'user_bob'), dana: reg.bind(ISSUER, 'user_dana') };
  reg.close();
  const old = new AccountRegistry(join(data, 'forks', 'accounts.sqlite'));
  const forks = { alice: old.bind(ISSUER, 'user_alice'), carol: old.bind(ISSUER, 'user_carol') };
  old.close();

  const worlds: Fixture['worlds'] = {};
  const tokens: string[] = [];
  let creature = { soul: '', preset: '' };
  const preset = BODY_PRESETS.find((p) => (p.body as { family?: string } | null)?.family === 'creature' || 'creature' in p)!;
  const plan: Record<string, { creator: string; souls: [string, string, string][] }> = {
    'x11-hamlet': { creator: stage.alice, souls: [[stage.alice, 'Oriel', 'A keeper of lamps.'], [stage.alice, 'Bram', 'A baker.'], [stage.bob, 'Wren', 'Sings at dusk.'], [stage.bob, 'Tamsin', 'Retired early.']] },
    'x11-garden': { creator: forks.carol, souls: [[forks.carol, 'Ivo', 'Tends the beds.'], [forks.alice, 'Oriel', 'The same name in another world.']] },
  };
  for (const slug of WORLDS) {
    mkdirSync(join(data, 'worlds', slug), { recursive: true });
    const f = fixture(join(data, 'worlds', slug, 'sim.db'), undefined, { worldId: slug });
    try {
      f.brain.quiesce();
      const live: Fixture['worlds'][string]['live'] = [], retired: string[] = [];
      for (const [owner, name, description] of plan[slug]!.souls) {
        const s = await accept(f.host, f.souls.create(owner, { name, description }));
        live.push({ id: s.id, owner, name, description });
      }
      if (slug === 'x11-hamlet') {
        // One retired, one with an agent token, one in a creature body.
        const gone = live.pop()!;
        await accept(f.host, f.souls.retire(f.db.soul(gone.id)!));
        retired.push(gone.id);
        const token = randomBytes(24).toString('base64url');
        tokens.push(token);
        f.db.setSoulToken(live[0]!.id, createHash('sha256').update(token).digest('hex'), 'fixture agent');
        const s = f.db.soul(live[2]!.id)!;
        await accept(f.host, f.host.enqueueChecked('body-assignment-v1', 'world:body', { contract: 'body-assignment/1', worldId: slug, soulId: s.id, entityId: s.entity_id, body: structuredClone(preset.body) }, () => true));
        creature = { soul: s.id, preset: preset.id };
      }
      f.host.saveSnapshot(true);
      worlds[slug] = { live, retired, creator: plan[slug]!.creator };
    } finally { f.host.stop(); f.db.close(); }
  }
  writeFileSync(join(data, 'worlds.json'), JSON.stringify(WORLDS.map((slug) => ({ slug, name: slug, owner: worlds[slug]!.creator, template: 'empty', createdAt: 0 })), null, 2));

  const out = join(dir, 'backup');
  execFileSync(process.execPath, [join(ROOT, 'tools/world-launcher/deploy/backup.mjs'), data, out], { stdio: 'pipe' });
  const day = readdirSync(out).filter((d) => /^\d{8}$/.test(d)).sort().at(-1)!;
  return { set: join(out, day), stage, forks, worlds, tokens, creature };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  console.log(JSON.stringify(await makeFixture(resolve(process.argv[2] ?? '.local/import-accounts/fixture')), null, 1));
}
