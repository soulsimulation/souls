import type {Diff, Op, Result} from '@souls/world-compiler';
import type {GodMode} from './god.ts';

/** Completed Soul work is engine-authored. The service still owns admission and receipt deduplication.
 * Unlike an ordinary engine movement, authored state/output needs the bridge's derived geometry refreshed. */
export function commitSoulCompletion(
  god: Pick<GodMode, 'model' | 'engineAct' | 'onCommit'>,
  mirror: (diff: Diff) => void,
  ops: Op[],
  note: string,
): Result {
  const seq = god.model.editSeq + 1;
  let committed: Diff | undefined;
  const unsubscribe = god.onCommit(event => {
    if (event.by === 'engine' && event.seq === seq) committed = event.diff;
  });
  try {
    // The existing atomic participant path also notifies context/perception after COMMIT.
    // No God clientRef: completion replay is guarded by the service's durable state/receipt binding.
    const result = god.engineAct(ops, note, () => {});
    if (result.accepted && committed) mirror(committed);
    return result;
  } finally {
    unsubscribe();
  }
}
