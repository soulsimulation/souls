/** #1437: runtime-policy flags the host logs and reads itself; the engine never reads them, so they stay out of the engine's
 *  registry (`RUNTIME_POLICY_FLAGS` in packages/engine-mars/src/engine.ts) and never enter `cfg` or a physical binding.
 *  A key the host adopts with `runtimePolicy:{...,K:true}` is in one list or the other, or runtime-policy-host.test.ts fails. */
export const HOST_RUNTIME_POLICY_FLAGS = [
  'quarantineV1',       // #1369 quarantine/1: a rule fault the ladder cannot undo stops and contains only its bodies
  'humanRestNeedsV1',
  'nonFiniteHoldV1',    // #1496 nonfinite-hold/1: a non-finite number in the hashed head is put back to its last good value, logged   // human rest needs: recognize enacted rest
] as const;
