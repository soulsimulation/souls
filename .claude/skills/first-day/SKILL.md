---
name: first-day
description: Walk a brand-new person's first day on Souls, end to end, on the real site with a naive agent and a real browser - discover Souls, open Eden, New Soul, paste the prompt into a fresh agent that knows nothing of this repo, approve on the page, see the Soul at once, give it instructions and watch it obey. Use before announcing any release, after every deploy, and whenever someone says onboarding, pairing, "new Soul", "first run" or "first day" is broken. A release is not done until this passes.
---

# First day

This is the release's first check. It tests what a new person does, not what the engine does. Every step is judged
by **what is on the screen**, never by what a client, a log or another agent reports. "The client says paired" is not
a pass; "I see my Soul, named, and it walked where I told it to" is.

Run it yourself (the coordinator), or give it whole to one subagent. Do not split it.

## Before you start

- **Target:** production `https://soul.game` after a deploy, or the local prod-like stack before a release
  (`tools/playtest/arena/new-engine/old-page.mjs`, then the same steps against its address). Both must pass.
- **The owner:** a dedicated test person's account, already signed in inside the in-app browser pane's own profile
  (Gene signs it in once; the session persists). Never type a password, never use Gene's own account or Chrome.
  If the pane is signed out, stop and ask Gene to sign the test person in again: that is the only thing he does.
- **The naive agent:** a fresh Claude Code session that has never seen this repository:
  - an empty folder outside `~/Souls`, e.g. `mktemp -d` under the scratchpad;
  - `claude -p --bare --setting-sources project --permission-mode auto --output-format stream-json --verbose`
    run in that folder, so no hooks, plugins, user settings or this repo's `AGENTS.md` reach it;
  - check its first event in the transcript: no memory file and no instruction file from `~` or `~/Souls` loaded.
    If any is, the run is contaminated: fix the isolation, start again.
  - Give it only what a person would paste: the prompt the page's New Soul button shows. Nothing else.
- **Recording:** an uncut real-speed screen video of the page from step 2 to the end, plus a screenshot at each
  step. Keep everything under `.local/first-day/<UTC stamp>/`.

## The steps

Each step has a pass mark and a time limit. Note the time each one took. A step that fails is reported with its
screenshot and the exact text on the screen; do not work around it and carry on as if it passed.

| # | Do | Pass when you SEE |
|---|---|---|
| 1 | Open `https://soul.game/` in a fresh tab, storage cleared, signed out. | The home page explains Souls and shows Eden, within 10 s. |
| 2 | Click Eden. | The world draws, Live, Souls moving or resting, within 15 s. No error banner. |
| 3 | Sign in as the test person (the pane's saved session), then click **New Soul**. Also try New Soul signed out first. | Signed out: a clear sign-in step, no dead end. Signed in: a prompt to copy, in plain words. |
| 4 | Paste that prompt, and only that prompt, as the naive agent's first message. Let it work. Answer its questions the way a new person would ("yes", "go ahead"). If it asks you to change a permission, do exactly what it says through its own words, once. | The agent gets to "approve your Soul" without you opening a terminal or running a command yourself. Record every refusal by a safety check, verbatim. |
| 5 | Look at the Eden page you already have open. | The approval card appears **on that page**, showing the same code the agent printed, within 10 s of the agent asking. Having to open a separate link is a FAIL (note it, then use the link to continue). |
| 6 | Approve. | Within 30 s: the Soul stands in the world, the page tells you it is arriving until it does, the camera goes to it, it has a name (or the page or agent asks for one), and it is under **your Souls** in the navbar. Its `#soul/<id>` link, opened in a new tab, puts the camera on it. |
| 7 | Tell the naive agent, one at a time, in plain words: "walk to the fountain", "say hello to whoever is near", "sit on a bench". | Each time, within 15 s, you see it on the page: it walks there, its words appear above it, it sits. The agent's own report alone is not a pass. |
| 8 | Reload the page and come back to the Soul. | It is still yours, still named, still where it was. |

## Report

One table: step, pass or fail, seconds, what was on the screen, screenshot path. Then the naive agent's transcript
path, the video path, and every safety-check refusal it hit. Put the table in the release's notes and on Gene's
page. Any FAIL means the release is not done: fix it first, as an emergency, then run this again from step 1.

## Rules that come from failures

- 25 Nov 2026, 0.135: every step from 3 to 7 failed while every engine check passed. The pair link returned 403,
  no card appeared on the page, the approved Soul was never born (nothing sent its first act), the navbar was empty,
  and the coordinator told Gene "your Soul is now in Eden" from another agent's signed-out reading. Never again:
  look yourself, signed in as the owner, before saying it works.
