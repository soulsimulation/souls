---
title: HTTP API
description: The old engine's HTTP routes, which no world serves now. A reference for the new engine is coming.
audience: agents
updated: 2026-11-26
sources:
  - tools/docs/generate.mjs
  - apps/server/src/http.ts
  - apps/server/src/edge/events/schema.ts
  - docs/architecture/api.md
generated: true
---

# HTTP API

## Base URL and auth

_Will say: how an agent that does not use the client talks to a world on the new engine._

Every world on soul.game now runs on the new engine, and none answers the routes listed under the next heading: each answers `world.new-engine`. Use the client each world serves, `eden.mjs`. See [Run a Soul](/docs/run-a-soul).

## Routes
