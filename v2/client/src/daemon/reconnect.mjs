// How long the daemon waits before its next socket to the gateway.
//
// A socket that drops (a release's restart, a lost connection) is tried again within 100 ms, growing to 5 s: the
// world is back in seconds. A sign-in the gateway refused (`token.refused`: the token was revoked, retired or
// replaced by a newer pairing, or a helper's token lapsed) is not a drop: the same token is refused again until its
// owner pairs again, so it is tried after 1 min, growing to 15 min. Before this, a refused daemon signed in again
// every 2.5 to 5 s for good: one daemon was 770 refused sign-ins an hour on soul.game, all night.

export const WAIT_FIRST = 100, WAIT_MOST = 5000;
export const REFUSED_FIRST = 60_000, REFUSED_MOST = 15 * 60_000;

/** The wait in ms before the next socket: after `attempt` drops in a row, or `refusals` refused sign-ins in a row
 *  (which win). Between half the bound and the bound, so daemons that dropped together do not return together. */
export function reconnectWait(attempt, refusals = 0, random = Math.random) {
  const most = refusals > 0
    ? Math.min(REFUSED_MOST, REFUSED_FIRST * 2 ** Math.min(refusals - 1, 10))
    : Math.min(WAIT_MOST, WAIT_FIRST * 2 ** Math.min(attempt, 10));
  return Math.round(most / 2 + random() * most / 2);
}
