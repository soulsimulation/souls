# Solo peg solitaire

Place `core/peg-solitaire@1` on an accessible work surface. Its fifteen holes form five triangular rows: `1`; `2,3`; `4,5,6`; `7,8,9,10`; `11,12,13,14,15`. The top hole starts empty. Jump an occupied peg over one adjacent occupied peg into an empty hole. The middle peg disappears; leaving one peg wins.

Normal current `inspect` facts include `pegSolitaire`, with remaining count, solved/stuck status, wins, last player and actual directed legal moves. Each `jump-A-C` action names an endpoint pair and its middle hole; current board state determines which occupied endpoint moves into the empty endpoint. Two completed native craft seconds apply a move. Illegal moves refuse. Reset uses the same completed-work timing, restores the top-empty layout and preserves wins.

Set the board down, stand nearby on the same native floor and empty your hands before playing. Interruption, changed state/support, lost access or duplicate completion leaves the board unchanged. Integral pegs are not separate transferable entities. Native pickup, carry and putdown preserve the same board and game. Ground placement is not a playing surface: pick it up and use the normal `put-on:<table>` offer to resume play on a table. Normal current inspection provides live game facts; this does not repair the generic object reader.

The short existing craft motion uses a visual tool proxy; no exact peg contact, loose-token physics, multiplayer or optimal-play agent is supplied. Nearby action planning reuses existing request-time custody checks; no new idle/background world scan is introduced. Named additive God hooks require serial steward integration.
