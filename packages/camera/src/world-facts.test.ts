// 0.135 P3a: the camera's solids from a new-engine world's facts are the solids today's world model gives the same
// genesis. The facts are exported as `worldd seed` takes them (v2/tools/import-eden/export/export.ts --template).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { WorldModel, applyBatch, coreLibrary, correctKitDefines } from '../../world-compiler/src/index.ts';
import { heightAt } from '../../ground/src/index.ts';
import { obstaclesOf, obstaclesOfFacts, type FactsThing } from './world.ts';

const root = resolve(import.meta.dirname, '../../..'), TEMPLATE = join(root, 'worlds/templates/hello-hamlet.json');

test("a world's facts give the camera the same solids as today's model of its genesis", () => {
  const dir = mkdtempSync(join(tmpdir(), 'camera-facts-'));
  try {
    const out = join(dir, 'facts.json');
    execFileSync(process.execPath, [join(root, 'v2/tools/import-eden/export/export.ts'), '--template', TEMPLATE, '--out', out], { cwd: root, stdio: 'ignore' });
    const facts = JSON.parse(readFileSync(out, 'utf8')) as { things: FactsThing[]; ground: { recipe: string } };
    const recipe = JSON.parse(facts.ground.recipe);
    const fromFacts = obstaclesOfFacts(facts, (x, z) => heightAt(recipe, x, z));

    const g = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    const m = new WorldModel({ constants: { ground: 'land', extent: 1000, ...g.constants }, seed: 'eden-local-lifecycle:genesis' });
    m.library = coreLibrary();
    let tick = 1;
    if (g.state) applyBatch(m, { ops: [{ op: 'world', state: g.state }], group: 'genesis' }, 'genesis', tick++, { trusted: true });
    for (const b of g.batches) applyBatch(m, correctKitDefines({ ops: b.ops, group: b.group ?? 'genesis' }).batch, 'genesis', tick++, { trusted: true });
    const fromModel = obstaclesOf(m);

    assert.ok(fromModel.length > 20, `hello-hamlet has solids: ${fromModel.length}`);
    assert.equal(fromFacts.length, fromModel.length, 'one solid for each of the model\'s');
    const byId = new Map(fromFacts.map((o) => [o.id, o]));
    for (const o of fromModel) {
      const f = byId.get(o.id);
      assert.ok(f, `${o.id} is in the facts' solids`);
      const near = (a: number, b: number) => Math.abs(a - b) < 2e-3;
      const turn = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 2e-3 || Math.abs(Math.atan2(Math.sin(a - b + Math.PI), Math.cos(a - b + Math.PI))) < 2e-3;
      assert.ok(near(f.obb.c[0], o.obb.c[0]) && near(f.obb.c[1], o.obb.c[1]) && near(f.y0, o.y0) && near(f.y1, o.y1), `${o.id}: ${JSON.stringify(f)} vs ${JSON.stringify(o)}`);
      assert.ok(near(f.obb.half[0], o.obb.half[0]) && near(f.obb.half[1], o.obb.half[1]) && turn(f.obb.yaw, o.obb.yaw), `${o.id} extent and turn`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
