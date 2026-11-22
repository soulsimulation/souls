---
type: fix
---
Engine v2: a creator can set a thing's state field 29 (a planter's stage and 91 other entries' fields). The door leaf's owned geometry moves from field 29 to 100, and one list in `replica::fields` names every node field the engine keeps, with the node it lives on; the entries test refuses a state field that takes one.
