# Committing completed Soul work

Native receipt handling owns when work finishes. A server-owned family validates the started target, actor, input
state, support, access and actual completion body, then commits its operations with this callback in `EngineBridge`:

```ts
commit: (ops, note, _receiptRef) => this.commitSoulWork(ops, note),
```

`commitSoulWork` uses `commitSoulCompletion` and the existing `GodMode.engineAct` transaction. The complete batch is
engine-authored with no inverse, cannot become the next God Undo target, does not clear a pending God Redo, and does
not run God edit admission. Compiler validation, durable atomic commit and build-root consistency still apply.
The family must perform its own Soul permission, policy, support, reach and input checks before calling it.

Unlike ordinary native motion, a finished authored state/output may change derived geometry. The adapter opts into
the existing post-commit context/perception notification and passes only that committed sequence's diff to the
bridge's ordinary geometry queue. Normal bridge flush handles it; no second movement path or special renderer is
introduced. Refused batches neither notify nor mirror. The temporary observer is removed when the call finishes;
there is no new idle listener or scan.

Do not use `god.act({ops, clientRef: ...})` for this callback. That is a God edit: it records an undo inverse, clears
redo and runs God admission. Do not substitute the bridge's ordinary `engineAct` movement helper either: it records
what the native engine already knows and intentionally avoids echoing geometry back. Existing engine participants
such as painting keep their own atomic transaction hooks; this template does not replace those.

The adapter does **not** implement receipt replay or action admission. A family still binds its accepted/started
receipt, rechecks authority and inputs on completion, and durably records its completion identity with its state
change. Interrupted, failed or replaced work must not call it. A duplicate completion must be rejected by that
service's existing completion guard. The optional callback receipt reference above is deliberately not a God
`clientRef`; it is not a substitute for those checks. No mid-work restart or Godundo replay guarantee is added.

God Undo/Redo remains authoritative over actual God edits. For example, undoing a God edit that created the work
surface can still affect that surface; this adapter does not make overlapping authored edits commute or bypass
ordinary ownership/support checks.

## Integration scope

The repeated callback pattern was identified in #1621, #1628, #1629, #1634, #1637, #1652, #1660, #1674, #1679, #1692,
#1698, #1725, #1734 and #1746, and recent #1758, #1759 and #1761. Their owners or the Claude integrator can replace
the callback with this template and retain each service's completion validation/dedup guards. Those branches are
not migrated by this shared change. #1681 independently owns family registration; this adds no registry mechanism.
Cold exact-ID binding and catalog publication remain separate requirements under #1751/#1754.

The focused regression covers state-only planter progress and newly placed bowl output, engine journal provenance,
God Undo/Redo and completed-state restore, atomic refusal, and the production bridge's native physics propagation.
These are commit-seam regressions, not new action choreography, cold-ID acceptance, or a substitute for each
consumer's complete native/actual proof and Claude's T3 review.
