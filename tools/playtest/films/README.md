# Films of crews building together

Broadcast-style films of Souls carrying and building together in a real world on a real site, shot live, so the
same scenes can be filmed again after a change (a before and an after). Every step is one Soul's own command through
its own agent client (`eden.mjs`, fetched from the world as an agent fetches it); the cameras only watch the page.

The scenes (from `tools/playtest/rack-bay`, `shade` and `loading-spot`):

| scene | what happens |
| --- | --- |
| `racks4` | four build a rack bay from the template yard's stand of frames and beams, change a crew, take it down |
| `shade` | four raise the timber shade's bents and rails, all six lift the cloth on, four take it down |
| `loading` | loads carried to the loading spot: a pallet by two, the generator by four (two are refused), the timber bundle by six, a pallet by two |
| `racks6` | a second yard (staged by the creator, titled "six …") where crews of six carry the tall frame |

## What it needs

- A Playwright Chromium profile signed in to the site as the world's owner (`--profile`). Never installed Chrome.
- A camera host with a GPU (Vulkan by default, `cam.mjs --gpu egl` otherwise), ffmpeg, Node 20 or later, and a
  folder (`FILM_DIR`, default `souls-films` under its home) holding `cam.mjs`, `cams.sh`, `post.sh` and `cut.mjs`
  with `@playwright/test` and its Chromium installed there (`npm i @playwright/test && npx playwright install chromium`).
- `FILM_SSH` (default `ssh`) runs a command on the camera host, with `FILM_HOST` as its host argument when set.
- With `--agents host` the six agents' folders and daemons run on the camera host too (`FILM_NODE`, Node 22.18 or
  later), so a command answers in a second or two. Use it when this machine is loaded: a crew's offer lapses if its
  members take too long to accept.

## A shoot

```sh
node tools/playtest/films/films.mjs --dir .local/films/run1 --profile .local/first-day/profile \
  --agents host --front-only --generator-first --tag f1- --scenes racks4,shade,loading,racks6
bash tools/playtest/films/film.sh .local/films/run1 f1- racks4 tools/playtest/films/specs/racks4.json
```

- The first run makes the world (New world, the Mars camp template) and logs its create key and slug. Later runs
  re-open it with `--slug <slug> --key <key>`.
- `--tag` names the agents' folders on the camera host: a later run with the same tag resumes the same Souls instead of
  pairing new ones. `--scene-tag` gives a re-take its own camera folder.
- `--front-only`: only a crew's front sends `carry to`; the crew walks with it.
- A take-down that stops short can leave Souls holding the shade's bents up (they cannot let go of a bent nothing
  braces). `--free-shade ada:<crew>,cy:<crew>` has Bo and Di carry the bents down before the scenes.
- `--staged6` with `--no-creator` reuses a six's yard an earlier run staged; `--six-tall-only` then films only the six
  carrying the tall frame (when an earlier take built bay 1). `specs/racks6-bay.json` and `specs/racks6-tall.json` cut
  such split takes; `cut.mjs` joins two takes' arguments into one film.
- `--generator-first` hauls the generator first and pallet 1 last: on soul.game's Mars camp, pallet 1's back grip
  could not be reached while the generator stood beside it.
- When a lift or take is refused because a carrier stopped short of its grip, the driver asks again every 3 s (up to
  ten times) and sends that carrier to its grip again, as its agent would.
- `--local` runs the same scenes on the prod-like local stack instead (the test owner, the template exported with the
  Mars map).

`films.json` in the run's folder holds each scene's step log with times. `film.sh` waits for the scene's five takes,
cuts the film on the camera host from a shot list in `specs/` (camera, event of the run such as `take#2` or `built`,
offset, length: `plan.mjs`), and copies the film and a contact sheet back. Check the sheet by eye before using a film.
