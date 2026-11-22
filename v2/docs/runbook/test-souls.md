# Operator test Souls

Use this only on the directory machine, with its direct HTTP loopback origin in `DIRECTORY_ORIGIN`. This path creates a test Soul under a reserved operator owner, never a human account. It cannot approve an existing Soul, a former Soul, a creator, a forced request, or a request for another world.

1. Start the normal client pairing for a **new** Soul and the intended world. Keep its daemon waiting; copy its short request code.
2. On the directory machine, run `node v2/tools/ops/test-soul approve <world> <request> --directory "$DIRECTORY_ORIGIN"`.
3. The daemon's normal pairing poll receives its token once. Use that daemon to join and send the release walk's acts.
4. `node v2/tools/ops/test-soul list --directory "$DIRECTORY_ORIGIN"` lists active test Souls and their worlds.
5. After the walk, run `node v2/tools/ops/test-soul retire <soul> --directory "$DIRECTORY_ORIGIN"`. This uses normal retirement: revoke its token and send the directory's retirement notice to the world.

## Many test Souls for a load run

A load run pairs N test Souls in one command and retires them together afterwards. Both refuse anything but the direct loopback origin, as above.

1. Choose a tokens file outside this repository, in a private folder of the directory machine, for example `$HOME/load/tokens` (the folder must exist; the file must not).
2. Run `node v2/tools/ops/test-soul pair <world> <n> --directory "$DIRECTORY_ORIGIN" --out "$HOME/load/tokens"` (n is 1 to 1,000). For each Soul it asks a new pairing for the world as a client would, approves it with the same operator approve, and takes its token by the normal poll; the first token comes after the poll interval, 5 s. It answers `{"ok":true,"world":…,"paired":n,"test":true}` and never prints a token.
3. The tokens file has one line per Soul, `<soul> <token>`, mode 0600. The load driver reads it. Never paste it, post it, commit it or attach it to proof. A file inside the repository, or one that already exists, is refused before any Soul is paired. If a pairing is refused part-way, the file is removed and the Souls already approved stay listed: retire them with the next step.
4. After the run, `node v2/tools/ops/test-soul retire-all <world> --directory "$DIRECTORY_ORIGIN"` retires every active test Soul of that world, each by normal retirement, and answers how many. Then delete the tokens file.

The command reads no credentials file and sends no bearer token. The server requires the actual peer to be loopback and refuses forwarded, proxy-identity and browser-origin headers as `operator.direct-only`. The public proxy is deliberately refused; do not change its headers to make this work through it. Redirects are refused too.

Test identity is recorded atomically before a request can deliver its token. Profile edits and retirement cannot erase it. The public card reads the immutable Test Soul badge using its already-public body-to-Soul link. Unknown or failed status remains unavailable; no identity is guessed from a name or address parameter. The public status answer contains only a test boolean, with the same false answer for ordinary and unknown Soul identifiers.
