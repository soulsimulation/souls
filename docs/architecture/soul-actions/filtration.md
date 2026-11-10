# Finite camp filtration

Issue [#1826](https://github.com/soulsimulation/souls/issues/1826), PR [#1828](https://github.com/soulsimulation/souls/pull/1828).

`core-camp-water-filter@1` supplies three cloudy-water portions, two installed cartridge uses and one spare cartridge.
`core-filter-carafe@1` is a real portable carafe holding zero or one integral clear-water portion. Clarity is simulated:
there is no drinking, potability, health or liquid-physics claim.

The filter kind declares three literal offer forms:

| Offer | Effect after completed native work |
|---|---|
| `object:<filter-id>:filter-water` | Spend one cloudy portion and one use; fill the selected empty carafe. |
| `object:<filter-id>:empty-carafe` | Drain its one portion without recovering supply or cartridge life. |
| `object:<filter-id>:replace-cartridge` | Consume one spare only when the installed cartridge is spent; restore two uses. |

All take `text`, the exact selected carafe ID. Use normal catalog/find to discover the named filter and carafe, then
send the offer ID with that parameter. The catalog publishes kind acts, parameter schema and numeric state defaults;
live publishes changed finite values. Current inspection supplies requirements, full state facts and the historical
participant snapshot. No plain-word resolver is required.

Work requires empty hands and the same carafe resting on a fixed table within five metres of the filter, on its native
floor. Permission, definitions, owner/access, relevant full state, transforms, body, support and matching receipt bind
completion. A cold exact ID plans ordinary native walking or gives its own useful refusal. Filtering a full carafe,
draining an empty carafe, replacing an unspent cartridge and exhausted material are refused. Cancellation or stale,
changed, failed, duplicated or refused completion gives no material or credit. Completion uses `commitSoulWork`,
keeps unrelated God Undo/redo intact and atomically updates filter plus carafe.

Filter state is `cloudy`, `capacity`, `spares`, `filtered`, `drained` and bounded completion history. Carafe state is
`water` plus bounded participant/receipt history. Native pickup/carry/placement retains this same object and its water.
Both persist as entity state; draining is deliberate loss. Only active receipts are sampled; there is no idle object
scan. Here-frame measurements cover absent, 100 distant, nearby and native-in-use cases; details live in the PR proof.

Motion reuses native walking and approximate operation near the carafe, followed by existing release/idle cleanup.
It does not claim hand-to-pump grip, animated pumping or physical transfer. Proof and the uncut real-speed actual clip
are attached to PR #1828; current-facts restart equality does not imply physical pose/support equality. Claude alone
owns T3 sign-off, CI allocation, integration and release. The explicit dependency base is recorded in that PR.
