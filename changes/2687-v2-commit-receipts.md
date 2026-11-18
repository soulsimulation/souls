---
type: internal
---
Engine v2: the world process takes intents from the gateway's socket, checks them off the clock, commits them at the next tick and answers only once the tick's record is on the disk. A receipt names the log entries the intent caused, a repeat gets the answer it had (also after a restart), an expired act ends `intent.expired` and an act still open at its deadline ends `act.timed-out`.
