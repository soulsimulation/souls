# The MCP endpoint on the new engine

An app that takes only a URL (an MCP host, or a connector app) runs a Soul through `<origin>/w/<slug>/mcp`. The
service behind it is `v2/client/src/mcp/server.mjs` (Engine v2 R21, #3334). Its six tools, `eden_status`,
`eden_look`, `eden_find`, `eden_act`, `eden_wait` and `eden_stop`, are R7's daemon requests one to one. Each answers
with exactly what the command `souls.mjs` prints for the same request. The public page is
[v2/docs/site/mcp.md](../site/mcp.md), generated from the tool table in `v2/client/src/mcp/tools.mjs`.

## Running it

```
node v2/client/src/mcp/server.mjs --listen <host:port> --worlds worlds.json --root <private folder> \
  --pkg <replica wasm-bindgen pkg> --origin https://soul.game --version <build> --max-mb 2048
```

- `worlds.json` maps each world's slug to its gateway: `{ "eden-2026": "ws://<gateway>/v2/ws" }`.
- `--root` is a folder only this service's user can read (it is made with mode 0700). Each open session has a
  folder there.
- It prints `mcp: listening <host:port>` once ready. SIGTERM closes every session and exits.

## What the front door routes here

Route `/w/<slug>/mcp` and `/w/<slug>/mcp/<token>` (POST) and `/.well-known/mcp/server.json` (GET) to the service,
unchanged. The owner's checklist (O19) lists these routes.

**The front door must not log these paths.** The path form carries the Soul's token, for connector apps that
cannot send a header. A proxy's access log of `/w/*/mcp/*` would hold the token. Turn the access log off for these
routes, or log them without the path. The service itself logs no path, no token, no world and no hash. It logs only
what happened: `session opened (n open)`, `session closed: idle|stopped|gone|token refused`, `refused: 413`,
`refused: sessions-full`, `refused: a token the world refused`.

## Sessions

- One session per token in each world, keyed by the hash of the world and the token. The first call opens it. It
  closes after 10 minutes with no call, or when the host calls `eden_stop`.
- A session is the Soul's resident daemon (R6), in a folder of its own under `--root`. The token is written to that
  folder's `credentials.json` (mode 0600) until the daemon has read it at start, then removed. After that it is
  held only in memory.
- A token the world refuses gets 401 and is refused for a minute without opening another session.
- Open sessions are capped by memory (`--max-mb`). Each counts as its daemon's resident size when it opened. Past the
  cap a new session is refused with 503 `sessions-full`, never queued. One daemon measured 71 MB resident with a
  copy of 102 records, and 96 MB with 1,102.
- `eden_act` keeps the answers to its last 64 JSON-RPC ids, so a host's retry of the same request gets the first
  answer and sends nothing.

## Checking it

```
cd v2 && cargo build -p gatewayd -p worldd --locked && node --test client/src/mcp/*.test.mjs
```

Each of the six tools runs against a local world, and each answer is compared with the thin command's. The test
also checks 401, 405 and 413, that no token or path reaches any log, and that the card and the page match the table.
After changing the table, run `node v2/client/src/mcp/tools.mjs --write` to regenerate the page.
