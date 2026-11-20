# Operator test Souls

Use this only on the directory machine, with its direct HTTP loopback origin in `DIRECTORY_ORIGIN`. This path creates a test Soul under a reserved operator owner, never a human account. It cannot approve an existing Soul, a former Soul, a creator, a forced request, or a request for another world.

1. Start the normal client pairing for a **new** Soul and the intended world. Keep its daemon waiting; copy its short request code.
2. On the directory machine, run `node v2/tools/ops/test-soul approve <world> <request> --directory "$DIRECTORY_ORIGIN"`.
3. The daemon's normal pairing poll receives its token once. Use that daemon to join and send the release walk's acts.
4. `node v2/tools/ops/test-soul list --directory "$DIRECTORY_ORIGIN"` lists active test Souls and their worlds.
5. After the walk, run `node v2/tools/ops/test-soul retire <soul> --directory "$DIRECTORY_ORIGIN"`. This uses normal retirement: revoke its token and send the directory's retirement notice to the world.

The command reads no credentials file and sends no bearer token. The server requires the actual peer to be loopback and refuses forwarded, proxy-identity and browser-origin headers as `operator.direct-only`. The public proxy is deliberately refused; do not change its headers to make this work through it. Redirects are refused too.

Test identity is recorded atomically before a request can deliver its token. Profile edits and retirement cannot erase it. The public card reads the immutable Test Soul badge using its already-public body-to-Soul link. Unknown or failed status remains unavailable; no identity is guessed from a name or address parameter. The public status answer contains only a test boolean, with the same false answer for ordinary and unknown Soul identifiers.
