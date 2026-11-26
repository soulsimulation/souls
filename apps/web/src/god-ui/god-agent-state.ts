/** #662: the God button's agent state. 'on' (green border) only when the owner's agent is paired and the inbox says it
 * is connected; not paired or away is 'off', and an inbox not known yet (loading, or its fetch failed) is 'unknown', so
 * neither ever looks connected. The words go into the button's accessible name. */
export type GodAgentState = { live: 'on' | 'off' | 'unknown'; words: string };
export function godAgentState(paired: boolean, inbox: { connected: boolean } | null, inboxError = false, pending = 0): GodAgentState {
  const live = !paired ? 'off' : inbox ? (inbox.connected ? 'on' : 'off') : 'unknown';
  const words = live === 'on' ? 'agent connected' : live === 'off' ? 'agent not connected' : inboxError ? 'agent status unavailable' : 'agent status loading';
  return { live, words: pending ? `${words}, ${pending} pairing request${pending === 1 ? '' : 's'}` : words };
}
/** Whether the owner's agent is paired: the old engine's status counts its agents; on a world the new engine runs only
 *  the creator's mailbox knows, and says so while the agent is connected (#5006 rows 2 and 5). */
export const agentPaired = (agents: number | undefined, inbox: { v2?: true; connected: boolean } | null): boolean =>
  (agents ?? 0) > 0 || (!!inbox?.v2 && inbox.connected);
