# Streaming a world

A live stream of one world (for example to X at an event): a real Chrome window shows the world page in stream mode,
and OBS captures that window and Chrome's audio.

## Page mode (?stream=1)

Add `?stream=1` to a world page URL (`https://soul.game/w/<world>?stream=1`). The page becomes a clean broadcast
feed. The code is `apps/web/src/stream-mode.ts`, loaded only for `?stream=1`.

- **Camera.** It stays on Broadcast, the automatic director. Every pointer, mouse, wheel, keyboard and touch event is
  stopped at the window before the page sees it, so a stray click on the capture machine never takes the camera to
  your camera or Follow, and never moves it. A world with no Souls also stays on Broadcast instead of the arrival
  framing.
- **Picture.** The view fills the window. The HUD, top bar, panels, toasts, hints, cursor and sign-in are hidden.
  Souls' name tags and their spoken lines (the dialogue pop-ups above their heads) stay. A quiet
  `<world name> · soul.game` label sits in the bottom-right corner. Until the world has arrived the window is black.
- **Resolution.** The canvas draws at window size × `devicePixelRatio`, capped at 2. Adaptive resolution is off. A
  960×540 window on a 2× (Retina) screen draws 1920×1080. Size the window to the stream's resolution divided by the
  screen's ratio.
- **Sound.** Where the browser allows autoplay (Chrome started with `--autoplay-policy=no-user-gesture-required`),
  the soundscape and the music start at load at the default volume, with no click, and stay on. The browser's stored
  sound setting is ignored for that page and left as it is. Without autoplay permission the page stays silent until
  a gesture, which stream mode blocks: start Chrome with the flag.
- **Health.** `window.__soulsStream` is `{ frames, lastFrameAt }`: the number of frames drawn since the page loaded,
  and the wall-clock time (`Date.now()`, ms) of the last one, 0 before the first. A watchdog that sees `frames`
  stop rising, or `lastFrameAt` fall behind, should reload the page.
- **Visitor counts.** A `?stream` page is never counted, like `?shot`.

Keep Chrome drawing when its window is covered or in the background:
`--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`.
