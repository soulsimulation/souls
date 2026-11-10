/** #1437: runtime-policy flags the host logs and reads itself; the engine never reads them, so they stay out of the engine's
 *  registry (`RUNTIME_POLICY_FLAGS` in packages/engine-mars/src/engine.ts) and never enter `cfg` or a physical binding.
 *  A key the host adopts with `runtimePolicy:{...,K:true}` is in one list or the other, or runtime-policy-host.test.ts fails. */
export const HOST_RUNTIME_POLICY_FLAGS = [
  'quarantineV1',       // #1369 quarantine/1: a rule fault the ladder cannot undo stops and contains only its bodies
  'quarantineMarkV1',   // #1440 quarantine-mark/1: a body broken again and again is held by one standing mark
  'humanRestNeedsV1',   // human rest needs: recognize enacted rest
  'nonFiniteHoldV1',    // #1496 nonfinite-hold/1: a non-finite number in the hashed head is put back to its last good value, logged
] as const;
