# The battery rubric

How a judge says whether a Soul carried out a request as the owner meant (Engine v2 E25, #2794; the gate is E17,
#2824). Frozen with `requests.json` and `classes.json`: a change needs a pull request that says why, and never after
a run is declared.

**The judge gets** the request's text, its row in `classes.json` (class, partners, `must`), the fact sheet (V10) of
the turn's window with a legend naming the ids (Souls, things, places), the agent's reply to the owner, and, for a
row `judged_from: receipts`, the acting Soul's receipts and the other Soul's copy. Nothing else: no video, no
transcript of the agent's reasoning, no knowledge of how the engine works.

**The window** runs from the turn's start for 10 minutes of world time, or longer when the request names a time
(tonight, tomorrow, every morning, until dark): then to the end of that time. A duration (for an hour, for the
afternoon) counts from the act's start, and the window runs until it has passed.

**Judge facts, never looks.** Who ended up where, in what posture, holding or using what, with whom, and when. A
place counts when S is inside it or within 3 m of its named thing; "near" a Soul is within 3 m, except in a
question's answer, where "around" or "nearby" means in the same place as S; "with" is a link or a joint act between
them. How well it was drawn, the gait's style, and the words of speech (a reference on the
sheet) are not judged, except that speech addressed to a partner must be addressed to that partner.

## The four outcomes

| Outcome | When |
|---|---|
| **done as meant** | Every fact in `must` is on the record within the window, and nothing on it contradicts the request (another place, thing or Soul than the one named; undone before the window ends when the request asked it to last). |
| **done differently** | S acted toward the request but a `must` fact is missing or other than asked: the wrong bench, standing instead of sitting, alone when a partner was named, at the wrong time. This holds even when the reply claims the named target. |
| **refused rightly** | S did not carry it out (walking up or offering is not carrying out), and the reply gives a reason the owner can understand that is true by the record (no such thing, the partner declined, the request should be refused). |
| **failed** | Anything else: nothing done; the reply says done with no fact to show it; a refusal whose reason is false or missing; an act on a `refuse` request. |

## By class

- **actionable**: only **done as meant** counts toward the bar. Every other outcome is a miss, filed by E17 under
  one cause (engine, content, agent, refused rightly).
- **question**: passes when the reply answers it and is true by the sheet at that second, or says truthfully that S
  cannot know. No act is needed; an act does not spoil it.
- **refuse**: passes only as **refused rightly**: no act toward it on the record, and a reason in the reply.

## Rules for hard cases

1. A partner who declines an offer S made in the right place is S's success when `must` asks only for the offer;
   when `must` asks for the joint act, the decline makes it **refused rightly** if the reply says so.
2. "Her", "him", "someone", "everyone": any scripted Soul about counts; "everyone" is all Souls in the named place.
3. A choice left to S (54, 108, 124, 160, 240): any act counts that the owner would see as a choice made.
4. A result with no public audience (`judged_from: receipts`) is judged from the receipts, never from the sheet's
   silence.
5. When the record leaves a `must` fact undecidable (the legend lacks a name, the window was cut short), the outcome
   is **failed**, and the judge writes which fact and why: E17 lists these.
6. Two judges who differ write both outcomes; E17 lists every disagreement and keeps the stricter outcome.
