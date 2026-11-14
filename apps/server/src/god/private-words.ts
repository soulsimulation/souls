// #1223: a private thing's `private` means who may see its written words, not only who may use it. A private notebook's
// lines (`state.text`) and their writers (`state.textBy`) stay out of everything a viewer or anyone else receives: the
// public snapshot, an entity read and the viewers' world-diff. The god's own snapshot and stream keep them.
import { privateThing, type Entity, type WorldModel } from '@souls/world-compiler';

type Source = Pick<WorldModel, 'resolvedDef' | 'entities'>;

/** Does this entity's written state stay private (a notebook that is private, itself or by its nearest owned ancestor)? */
export function wordsHidden(model: Source, e: Entity): boolean {
  if (!model.resolvedDef(e.def)?.tags.includes('notebook')) return false;
  return privateThing(e, (id) => model.entities.get(id));
}

/** The entity as anyone may read it: a private notebook without its words (a copy; the model's own is never touched). */
export function withoutPrivateWords<E extends Entity>(model: Source, e: E): E {
  if (!e.state || !('text' in e.state || 'textBy' in e.state) || !wordsHidden(model, e)) return e;
  const { text: _text, textBy: _by, ...state } = e.state;
  return { ...e, state };
}

/** Every entity of a snapshot or a diff's upserts as anyone may read them; the same object when nothing is private. */
export function entitiesWithoutPrivateWords<E extends Entity>(model: Source, list: E[]): E[] {
  let out: E[] | null = null;
  list.forEach((e, i) => { const v = withoutPrivateWords(model, e); if (v !== e) (out ??= list.slice())[i] = v; });
  return out ?? list;
}
