# keys

Engine v2 B10 (#2688): drive a Soul by hand from a terminal, through the gateway, with the same intents an agent
sends (`eden:walk` to a point or a chair, `eden:sit`, `eden:rise`). The controller's test rig: no model, no script.

From `v2/`, in a scratch folder under `.local/`:

```sh
cargo build --release -p worldd -p gatewayd -p keys
D=../.local/keys && mkdir -p $D
target/release/keys token --tokens $D/tokens --out $D/token     # the token goes to its own file, never the screen
target/release/worldd gateway-link --socket $D/w.sock --lineage abababababababababababababababab --epoch 1 \
  --rooms 0 --bodies 0 --testworld --log $D/world.log &
target/release/gatewayd --listen 127.0.0.1:7410 --world $D/w.sock --tokens $D/tokens --build 00 &
target/release/keys drive --gateway 127.0.0.1:7410 --token $D/token --log $D/world.log
target/release/keys log $D/world.log                             # every intent the world took, and the most a second
```

Arrows walk 2 m (up is north, +z); held, the next step goes when the last one's receipt is back, and never sooner
than 200 ms after the last intent. `s` lists the chairs, a digit walks to one and sits; `r` rises; `q` quits.

Where the body is comes from the world's log (each move's entries record it), read only; the gateway's stream carries
answers only so far. A terminal sends no key-up: a key counts as released when its repeats stop for 0.6 s.
