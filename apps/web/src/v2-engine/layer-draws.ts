// Which stream nodes the old page's entity layer draws itself (the captured scene, or stream-scene.ts's) and which are
// CreatorKinds' (creator-kinds.ts, with take-parts.ts handing it kinds' own entries). Its own module with no imports, so
// the chunks that read it (take-parts.ts) pull in nothing else.

/** An old entity's id (world-compiler `nextId`: `e_` and eight hex digits), as the captured scene and stream-scene.ts
 *  have it: a node whose origin is one is the entity layer's to draw. */
export const OLD_ENTITY = /^[eh]_[a-z0-9]{4,12}$/;
/** A building's own parts and the world's frames (import-eden's floors, rooms and windows, places, the ground, the world):
 *  their building or the layer's ground draws them; none is a thing of its own. */
const FRAMES = /:(world|ground|floor|room|window|place|extent)$/;
/** Whether the entity layer draws a node itself: a thing of the captured scene (its origin, import-eden's field 1, is its
 *  old entity's id) or a frame. A thing named in that same field after the import is not in the layer: furnish names
 *  each piece as today does (`<room>-<item>`, `e_…/bedroom-bed`), and an import may keep ids the old page never had
 *  (`yard-frame-1`). CreatorKinds draws those, as any thing placed while the world runs. */
export const layerDraws = (n: { kind: string; origin?: string }): boolean =>
  !!n.origin && (OLD_ENTITY.test(n.origin) || FRAMES.test(n.kind.split('@')[0]));
