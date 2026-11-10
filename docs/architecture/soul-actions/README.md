# Soul Actions family documentation

Put each new family in its own `<family>.md` file in this directory. Use a stable descriptive filename and link it
from that family's issue or PR; adding a family does not require appending to the shared architecture page or this
README. Existing sections and plain-word tables in [Soul Actions](../soul-actions.md) remain historical records until
cutover; this change does not migrate or requalify them.

Each family file should briefly describe:

- The capability and its library kinds/revisions, declared acts, parameters and state, with source links.
- Offer ID forms, requirements, outcomes and the state that changes, including relevant ownership, custody and
  interruption limits.
- How agents discover the actual objects, available acts and current state, following the current Soul Client
  contract rather than adding plain-word rules.
- The issue, implementation PR and proof links, identifying tested behavior and unmet dependencies without claiming
  unproved acceptance.

Follow the [canonical Soul Actions direction](https://github.com/soulsimulation/souls/blob/647d04a5ce5621717c2fad78c153d082e3dffcb2/docs/design/soul-actions-direction.md)
and the current discovery/binding work in [#1737](https://github.com/soulsimulation/souls/issues/1737) and
[#1751](https://github.com/soulsimulation/souls/issues/1751). These are references to the owning contracts, not new
client, action or proof requirements. See [#1681](https://github.com/soulsimulation/souls/issues/1681) for the remaining
independent family-registration and service-hook work.
