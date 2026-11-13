import { registerMesh } from './registry.ts';
import { creatureObject } from './creatures/creature.mesh.ts';
import { bindMotionModel } from './motion.ts';
import { seedOf } from './creatures/behavior.ts';
// Opt-in fixed-place rabbit: reuse the existing kit rig and idle/sleep presentation.
registerMesh({ gen: 'tag:garden-rabbit', build(ctx) { bindMotionModel(ctx.model); return creatureObject(ctx.def, ctx.params, ctx.tint, ctx.materials, ctx.model, ctx.entity.seed ?? seedOf(ctx.entity.id))?.obj ?? null; }, instanceKey(ctx) { return ctx.def.hash + ':' + JSON.stringify(ctx.params); } });
