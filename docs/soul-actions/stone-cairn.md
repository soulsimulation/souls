# Reversible stone cairns

`core/stone-cairn@1` is a ground-set landmark with three integral stones. Use normal current `inspect` facts
(`cairn`) for lower/middle/upper arrangements, maker, remaining supplied stones and requirements. Build the
lower tier before the middle, and middle before upper. Each tier independently accepts flat or upright; an
existing tier can be rearranged without changing the other choices. Undo returns only the top stone to the
supplied set; dismantle returns all three. The same entity and chosen profile persist.

Every operation needs two completed native craft seconds, permission, nearby same-floor native body,
empty hands and unchanged target pose/profile. Cancellation makes no state change. Existing craft uses a
visual brush proxy; no tool custody, loose-stone handling, physical balancing or stability simulation is claimed.
All visible stones belong to the same landmark entity. No fresh objects are created.
