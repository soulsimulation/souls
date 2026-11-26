# Archive and restore a world

A current creator can archive from the world page, in God Mode's **Forsake world**, by typing the exact world name and selecting **Archive world**. A directory with no archive initializer (`DIRECTORYD_PLACEMENT` unset) refuses `archive-unavailable` and changes nothing. While Souls of other people live in the world (unretired, paired for it, held by another account), archive is refused `archive-others-live-here` with their count: the creator hands the world on, or waits until they have left. The creator's own Souls do not count. An offered or accepted unfinished handoff must finish or be cancelled first. A pending answer is not a completed archive: **Check archive** reads the same operation. The world is omitted from the public list while the operation is pending; the name and aliases stay reserved.

The existing finite placement initializer installs a root-owned restart fence, stops both the world and its gateway, verifies both inactive, and publishes a named archive refusal at its known addresses. It then commits `archived` on the same conditional row as ownership. It never deletes world data, Souls, accounts, logs, checkpoints, retained history or the immutable name. An interrupted operation retains its request and can be retried.

## Operator command

On the installed Souls machine, an authenticated root operator runs:

```sh
node /usr/local/lib/souls/ops/archive-world.mjs list
node /usr/local/lib/souls/ops/archive-world.mjs restore <world-name>
```

The command reads only fixed installed configuration. It refuses non-root execution, an occupied address, mismatching identity or missing retained data. It queues the exact conditional request into the existing placement inbox and starts only `souls-place.service`; that oneshot serializes lifecycle operations. The command waits up to 90 seconds for its own result. A pending result means retry this same command; it does not authorize a second operation or manual metadata change.

Restore uses the world's existing pin, normal world startup and existing readiness observer. The existing clock catch-up contract applies. Known addresses remain archive tombstones until advancing readiness; route markers remain reserved throughout. A failed start, probe, publication or final conditional write re-installs the fence first, stops both units and re-tombstones the route. If the final write committed but its reply was lost, containment returns that same request to pending. If the Store is unavailable, the exact protected fence remains authoritative for physical startup; retry revalidates it and resumes the same request. A containment refusal requires operator attention; it is never a successful restore. Other worlds are untouched.

Do not remove a fence, edit the list, re-fork, reseed, rename the world or repair its log as a substitute for retrying the bounded operation.

## Restart and backup

The authoritative archive phase, request generation and captured current-owner generation are fields of the existing `world-list` object, covered by the world-directory backup. Small root-owned fences and route receipts live under the installed placement metadata directory. The fences are readable by the Souls service group and writable only by root; both existing world and gateway unit templates test their exact instance fence before starting. Supervisor direct launch also checks the fence. A known or malformed fence refuses even during a Store outage; unrelated active worlds retain their existing valid pin-cache outage behavior.

The existing private placement-backup mirror carries the saved routes, immutable identity, content fingerprints and pinned build, with no raw tokens or world content. If a root receipt is absent after backup restore, the operator command validates that mirror against the durable row, protected topology, actual retained data/build and exact current addresses before reinstalling protected metadata. A forged or mismatching mirror refuses. Keep this mirror and the normal world-directory, log/checkpoint, text and account backups together; it does not replace them.

An archive is retained data, not deletion or a retention-policy change. This runbook does not authorize production operations.
