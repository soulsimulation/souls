# Streaming a world to X

A live stream of one world runs on a Mac at an event: Chrome for Testing shows the world in its own window, OBS
captures that window and its sound and sends them to X. Nobody works the OBS window; a script starts, checks and stops it.

## Stream tool

`tools/stream/stream.mjs` is one dependency-free Node script (Node 22 or later). It runs **on the stream machine**,
so copy that one file there; it needs nothing else from the repo.

### One-time setup on the stream machine

1. Install OBS (tested with 33.0.1 on macOS 26). The tool downloads its own browser (below).
2. In OBS, open **Tools → WebSocket Server Settings**, tick **Enable WebSocket server**, keep port 4455, and set a
   password.
3. In **System Settings → Privacy & Security → Screen & System Audio Recording**, allow OBS.
4. On X, live streaming needs a Premium account. In Media Studio, open **Producer** (X Live Studio), create a source
   and copy its server URL and stream key.
5. Put the secrets in a file **outside the repository**, readable only by you, by default `~/.souls/stream.env`:

   ```sh
   OBS_WEBSOCKET_PASSWORD=...
   X_STREAM_SERVER=rtmps://...
   X_STREAM_KEY=...
   ```

   Environment variables of the same names win over the file; `SOULS_STREAM_SECRETS` names another file. The tool
   refuses a secrets file inside the repository and never prints or logs these values (any that would appear in
   a log line is replaced by `***`). OBS keeps the server and key in its own `souls-stream` profile.

### Commands

```sh
node stream.mjs start https://soul.game/w/<world>/            # stream to X
node stream.mjs start https://soul.game/w/<world>/ --record   # record to a file instead (a test; needs no X key)
node stream.mjs status
node stream.mjs stop
```

`start`:

- On first run, downloads the stable [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/)
  build into `<state dir>/browser` (about 150 MB) and reads its bundle id from its `Info.plist`
  (`com.google.chrome.for.testing`). Your own Chrome is never used, so nothing you play in it reaches the stream.
- Opens Chrome for Testing by path with its own profile (`<state dir>/chrome`) in an `--app` window on `<world-url>?stream=1`, with
  autoplay allowed and background, occlusion and timer throttling off, and a DevTools port on localhost
  (`SOULS_STREAM_CDP_PORT`, default 9333). It moves the window to the sharpest screen with room and sizes it so the
  page is exactly 1920×1080 device pixels (960×540 on a 2× screen). With no such screen it warns and OBS scales.
- Waits for OBS to answer, launching it if it is not running. It remembers your current OBS profile and scene
  collection, then switches to its own, both named `souls-stream` (reused on every run).
- Sets 1920×1080 at 30 fps and OBS's simple output mode, all over the websocket (`SetProfileParameter` on its own
  profile; the tool never touches OBS's files): Apple's hardware H.264 encoder (`apple_h264`) at 8000 kbps CBR, AAC
  at 128 kbps and 48 kHz, and recordings that reuse the stream encoder. Simple mode fixes the keyframe interval at
  2 s. X recommends 3 s; 2 s works.
- Captures that window (`screen_capture`, window mode) with the title bar cropped, and its sound
  (`sck_audio_capture`, application set to Chrome for Testing's bundle id). Every other audio input in the collection
  is muted.
- Starts the stream (or the recording) and checks that OBS reports it active within 5 s; if not (OBS shows a dialog,
  for example about the recording path), `start` fails and says so. Then it starts the watchdog in the background
  and exits.

`status` prints the output state and elapsed time, OBS's frame rate, frames skipped in rendering and encoding,
frames dropped on the network (streaming only), the bitrate over 3 s, the peak level of the window's sound, and the
page's frame rate from `window.__soulsStream.frames`:

```text
recording: active  elapsed 00:00:51.033  world https://soul.game/w/eden/
obs fps 30.0  render skipped 581/42240  encoder skipped 0/1541
bitrate 8103 kbps  audio -15.1 dBFS peak  cpu 3.4%
page 107.9 frames/s (rAF probe; page has no __soulsStream)
```

`stop` stops the watchdog, ends the output (printing a recording's path), closes the Chrome window and switches OBS
back to your own profile and collection. Switching back can take about 30 s after an output ends; the tool waits and
retries. If `start` failed halfway, `stop` still undoes what it did.

### Watchdog

`start` leaves `node stream.mjs watch` running in the background until `stop`. Every 2 s it reads the page's frame
counter over DevTools. It reloads the page in place when the counter has not moved for 10 s (a page that does not
answer counts as stalled), and every 4 h regardless. If the stream (or recording) has been stopped for 5 s and OBS is
not reconnecting it by itself, the watchdog starts it again: at most 3 times (at once, then after 30 s, then after
120 s), because every failed start opens an OBS dialog on the screen. Then it logs that it gave up and stops trying;
the count resets once the output has run for a minute. So stop a stream with `stop`, not with OBS's button.
Each action is a timestamped line in `<state dir>/watch.log`:

```text
2026-11-16T03:21:22.199Z watchdog: warning: the page has no __soulsStream counter; using a requestAnimationFrame probe instead
2026-11-16T03:22:06.294Z watchdog: reload page: page frames stalled for 10 s
2026-11-16T03:23:13.173Z watchdog: restart recording: output stopped or disconnected
```

When the page has no `window.__soulsStream` (soul.game before `?stream=1` shipped), the watchdog counts
`requestAnimationFrame` callbacks it adds to the page itself and logs that warning once.

### Settings

| Variable | Default | What |
| --- | --- | --- |
| `SOULS_STREAM_SECRETS` | `~/.souls/stream.env` | the secrets file |
| `SOULS_STREAM_DIR` | `~/.souls/stream` | state, Chrome for Testing and its profile, `watch.log` |
| `SOULS_STREAM_CDP_PORT` | `9333` | Chrome's DevTools port (localhost only) |
| `SOULS_STREAM_RECORD_DIR` | OBS's recording folder | where `--record` files go (`.mkv`); created if missing |
| `OBS_WEBSOCKET_URL` | `ws://127.0.0.1:4455` | OBS's websocket |

### OBS 33 faults the tool works around

- **The browser source draws nothing** on macOS 26, so the tool captures a real Chrome window instead.
- **Listing apps for app audio crashes OBS** (`GetInputPropertiesListPropertyItems` on `sck_audio_capture`,
  `application`). The tool never lists them; it sets Chrome for Testing's bundle id directly. Listing windows for the window
  capture is safe; the tool marks its window by giving it a unique title for a moment.
- **OBS freezes for about 30 s after launch** and answers requests with status 207 until it is ready; the tool
  polls.
- **Scene collections cannot be deleted over the websocket**, so the tool reuses one profile and one collection
  named `souls-stream` and clears the scene each run.
- **After a crash**, relaunch OBS on your own collection, not on `souls-stream` (it may hold the source that
  crashed): `open -a OBS --args --collection <yours> --profile <yours> --disable-shutdown-check`.

### Known limits

- Sound is captured by app, so anything else running in Chrome for Testing on the stream machine would be heard too;
  the tool's window is normally the only one.
- soul.game starts a world's sound only after a click and keeps it muted by default; until the page's stream mode
  turns sound on by itself, a stream carries no world sound.
- macOS only; one stream per machine.
