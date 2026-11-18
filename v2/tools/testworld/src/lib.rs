//! Engine v2 N2 (#2650): a small test world, generated from a seed, that every lane can build and measure on.
//!
//! It is written as N1's facts file (`souls/import-eden/1`, read by `import_eden::load`), so it goes into K2's tree
//! the same way Eden 2026 does: through `Tree::commit`, with T2's checks, T3 ids in a scope of its own (the file's
//! `world`), and every heading through T4's `Quat::from_yaw_mdeg`. Every number is a whole millimetre or millidegree.
//!
//! The parts (lane notes, "The test world in numbers", `v2/docs/tranche/N-space-and-movement.md`), world frame, +z
//! to the front:
//!
//! - **The square**, 60 m by 60 m round the origin, open on four sides: an area thing and a place.
//! - **The hall**, 30 m by 40 m clear, 12 m north of the square: one room, 300 seats as plain slots of the hall
//!   (15 rows of 20, two blocks of 10, facing +z) with a centre aisle, two side aisles and two cross aisles (each a
//!   place), a 2.4 m door front and back and a 0.9 m side door square to the axes.
//! - **The ring**, east of the square: a solid middle 22 m across and a walkway 4 m wide round it (a place: a closed
//!   line with its width).
//! - **The building**, west of the square, turned 33 degrees: two floors of four rooms, a corridor 0.9 m wide and
//!   6 m long upstairs, one straight stair 1.0 m wide whose top lands 1.5 m from the 0.9 m door into that corridor, a
//!   ladder to the flat roof (floor 2). Walls are solids with a gap at each doorway.
//! - **Twelve doors**, all placed shut, each a door thing in its doorway: two of 0.9 m, six of 1.2 m, two of 1.5 m,
//!   two of 2.4 m. One more doorway (1.2 m, between two ground-floor rooms) is an arch with no door.
//! - **Things**: none unless asked. [`generate`] with `things = N` scatters N small boxes on a lattice in the rooms,
//!   the hall and the square, each lattice point moved by a seeded jitter, the N chosen by a seeded shuffle. None is
//!   in a doorway, an aisle, a seat row, the stair or the ladder; the corridor is left clear; the ring has none.
//!
//! One seeded generator (SplitMix64) and lists in a fixed order: the same seed and count give the same bytes.

use import_eden::json::Json;
use replica::ids::sha256;
use std::collections::BTreeMap;

// ---- The named constants (mm, mdeg or counts). The manifest prints each by its name. ----------------------------------
pub const SQUARE_SIDE: i64 = 60_000;
pub const HALL_WIDTH: i64 = 30_000;
pub const HALL_DEPTH: i64 = 40_000;
pub const HALL_HEIGHT: i64 = 6_000;
pub const HALL_Z: i64 = 62_000;
pub const HALL_SEATS: i64 = 300;
pub const HALL_ROWS: i64 = 15;
pub const SEATS_PER_ROW: i64 = 20;
pub const SEAT_PITCH: i64 = 550;
pub const ROW_PITCH: i64 = 900;
pub const SEAT_HEIGHT: i64 = 450;
pub const BACK_ROW_Z: i64 = -6_000;
pub const CENTRE_AISLE: i64 = 2_000;
pub const SIDE_AISLE: i64 = 1_200;
pub const CROSS_AISLE: i64 = 1_500;
pub const RING_MIDDLE: i64 = 22_000;
pub const RING_WALKWAY: i64 = 4_000;
pub const RING_X: i64 = 75_000;
pub const BUILDING_X: i64 = -60_000;
pub const BUILDING_YAW_MDEG: i64 = 33_000;
pub const BUILDING_LENGTH: i64 = 16_000;
pub const BUILDING_WIDTH: i64 = 12_000;
pub const STOREY: i64 = 3_000;
pub const FLOORS: i64 = 2;
pub const ROOMS_PER_FLOOR: i64 = 4;
pub const STAIR_WIDTH: i64 = 1_000;
pub const STAIR_RUN: i64 = 3_600; // its foot 0.36 m clear of the end wall: a body stands in front of it (N4, #2652)
pub const STAIR_TOP_TO_DOOR: i64 = 1_500;
pub const LADDER_WIDTH: i64 = 500;
pub const CORRIDOR_WIDTH: i64 = 900;
pub const CORRIDOR_LENGTH: i64 = 6_000;
pub const WALL: i64 = 200;
pub const DOOR_HEIGHT: i64 = 2_100;
pub const DOORS: i64 = 12;
pub const DOOR_NARROW: i64 = 900;
pub const DOOR_ROOM: i64 = 1_200;
pub const DOOR_WIDE: i64 = 1_500;
pub const DOOR_HALL: i64 = 2_400;
pub const THING_PITCH: i64 = 600;
pub const THING_JITTER: i64 = 100;
pub const THING_HALF: i64 = 150;
pub const DOORWAY_CLEAR: i64 = 1_000;
// The yard and the build site (B17, #3338): rack parts, sizes from `content/kinds/construction/` (today's catalog).
pub const YARD_Z: i64 = -24_000;
pub const YARD_X: i64 = 40_000;
pub const SITE_X: i64 = 65_000;
pub const YARD_WIDTH: i64 = 12_000;
pub const YARD_DEPTH: i64 = 8_000;
pub const SITE_SIDE: i64 = 6_000;
pub const YARD_FRAMES: i64 = 2;
pub const YARD_BEAMS: i64 = 4;
pub const FRAME_HEIGHT: i64 = 2_438;
pub const FRAME_COLUMNS: i64 = 1_144;
pub const FRAME_COLUMN: i64 = 76;
pub const STAND_SLOT_Y: i64 = 100;
pub const STAND_SLOT_Z: i64 = 150;
pub const BEAM_LENGTH: i64 = 2_743;
pub const BEAM_HEIGHT: i64 = 102;
pub const BEAM_DEPTH: i64 = 51;
pub const BEAM_PITCH: i64 = 300;

macro_rules! named {
    ($($c:ident $u:literal $w:literal;)*) => {
        /// Each named constant: its name, value, unit and what it measures.
        pub const NAMED: &[(&str, i64, &str, &str)] = &[$((stringify!($c), $c, $u, $w)),*];
    };
}
named! {
    SQUARE_SIDE "mm" "the square's side, open on four sides";
    HALL_WIDTH "mm" "the hall's clear width (x)";
    HALL_DEPTH "mm" "the hall's clear depth (z)";
    HALL_HEIGHT "mm" "the hall's height";
    HALL_Z "mm" "the hall's centre, world z";
    HALL_SEATS "seats" "seats in the hall, plain slots";
    HALL_ROWS "rows" "rows of seats";
    SEATS_PER_ROW "seats" "seats a row, two blocks";
    SEAT_PITCH "mm" "seat to seat in a row";
    ROW_PITCH "mm" "row to row";
    SEAT_HEIGHT "mm" "a seat slot's height";
    BACK_ROW_Z "mm" "the back row, hall frame z";
    CENTRE_AISLE "mm" "the centre aisle's width";
    SIDE_AISLE "mm" "each side aisle's width";
    CROSS_AISLE "mm" "each cross aisle's width, front and back of the seats";
    RING_MIDDLE "mm" "the ring's solid middle, across (a square block)";
    RING_WALKWAY "mm" "the ring's walkway width";
    RING_X "mm" "the ring's centre, world x";
    BUILDING_X "mm" "the building's centre, world x";
    BUILDING_YAW_MDEG "mdeg" "the building's turn";
    BUILDING_LENGTH "mm" "the building along its own x, wall centre to wall centre";
    BUILDING_WIDTH "mm" "the building along its own z, wall centre to wall centre";
    STOREY "mm" "floor to floor";
    FLOORS "floors" "floors with rooms (the roof is floor 2)";
    ROOMS_PER_FLOOR "rooms" "rooms a floor, the corridor not counted";
    STAIR_WIDTH "mm" "the one straight stair's width";
    STAIR_RUN "mm" "the stair's run, foot to top";
    STAIR_TOP_TO_DOOR "mm" "the stair's top to the 0.9 m door's face";
    LADDER_WIDTH "mm" "the ladder to the roof";
    CORRIDOR_WIDTH "mm" "the corridor, clear";
    CORRIDOR_LENGTH "mm" "the corridor, clear";
    WALL "mm" "wall thickness";
    DOOR_HEIGHT "mm" "every doorway's height";
    DOORS "doors" "doors, all placed shut";
    DOOR_NARROW "mm" "two doors: one in the turned building, one square to the axes";
    DOOR_ROOM "mm" "six doors";
    DOOR_WIDE "mm" "two doors";
    DOOR_HALL "mm" "two doors, the hall's double doors";
    THING_PITCH "mm" "the things' lattice";
    THING_JITTER "mm" "a thing's seeded move off its lattice point, at most";
    THING_HALF "mm" "a thing's half size (a box)";
    DOORWAY_CLEAR "mm" "no thing this near a doorway, either side of its wall";
    YARD_Z "mm" "the yard's and the site's centre, world z (east of the square, south of the ring)";
    YARD_X "mm" "the yard's centre, world x";
    SITE_X "mm" "the build site's centre, world x: 25 m east of the yard";
    YARD_WIDTH "mm" "the yard, along x";
    YARD_DEPTH "mm" "the yard, along z";
    SITE_SIDE "mm" "the build site, a clear square";
    YARD_FRAMES "frames" "8 ft rack frames standing on the yard's stand";
    YARD_BEAMS "beams" "9 ft rack beams lying loose in the yard";
    FRAME_HEIGHT "mm" "a frame's height (8 ft)";
    FRAME_COLUMNS "mm" "a frame's column centre to column centre";
    FRAME_COLUMN "mm" "a frame's column, square (3 in)";
    STAND_SLOT_Y "mm" "a frame's foot above the ground, on the stand";
    STAND_SLOT_Z "mm" "each stand slot off the stand's centre, stand frame z";
    BEAM_LENGTH "mm" "a beam (9 ft), along its own z";
    BEAM_HEIGHT "mm" "a beam's section, tall (4 in)";
    BEAM_DEPTH "mm" "a beam's section, deep (2 in)";
    BEAM_PITCH "mm" "beam to beam, lying side by side";
}

/// A rectangle in some frame, mm: x0 <= x1, z0 <= z1.
#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub x0: i64,
    pub z0: i64,
    pub x1: i64,
    pub z1: i64,
}
const fn rect(x0: i64, z0: i64, x1: i64, z1: i64) -> Rect {
    Rect { x0, z0, x1, z1 }
}
impl Rect {
    fn holds(&self, x: i64, z: i64, margin: i64) -> bool {
        x >= self.x0 - margin
            && x <= self.x1 + margin
            && z >= self.z0 - margin
            && z <= self.z1 + margin
    }
    fn poly(&self) -> Vec<[i64; 2]> {
        vec![
            [self.x0, self.z0],
            [self.x1, self.z0],
            [self.x1, self.z1],
            [self.x0, self.z1],
        ]
    }
}

/// One seeded generator, the only source of chance here.
struct SplitMix(u64);
impl SplitMix {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

struct Room {
    id: &'static str,
    name: &'static str,
    floor: i64,
    poly: Vec<[i64; 2]>,
    things: bool,
}

struct Opening {
    id: &'static str,
    door: bool,
    floor: i64,
    at: [i64; 2],
    along_x: bool,
    width: i64,
    from: &'static str,
    to: &'static str,
}
impl Opening {
    fn yaw(&self) -> i64 {
        if self.along_x { 0 } else { 90_000 }
    }
    /// The space no thing may stand in: the gap and its margin along the wall, `DOORWAY_CLEAR` either side.
    fn clear(&self) -> Rect {
        let (along, across) = (self.width / 2 + 2 * THING_HALF, DOORWAY_CLEAR);
        let [x, z] = self.at;
        if self.along_x {
            rect(x - along, z - across, x + along, z + across)
        } else {
            rect(x - across, z - along, x + across, z + along)
        }
    }
}

/// A floor: (level, y, the polygons of its surfaces).
type Floor = (i64, i64, Vec<Vec<[i64; 2]>>);
/// A stair or ladder: (id, kind, from floor, to floor, path, width, y0, y1).
type Stair = (
    &'static str,
    &'static str,
    i64,
    i64,
    Vec<[i64; 2]>,
    i64,
    i64,
    i64,
);

/// A walled thing with rooms: the building or the hall, in its own frame.
struct Built {
    id: &'static str,
    def: &'static str,
    at: [i64; 3],
    yaw: i64,
    rooms: Vec<Room>,
    openings: Vec<Opening>,
    floors: Vec<Floor>,
    /// Wall centre lines: (floor, from, to); each is cut at the doorways on its line.
    walls: Vec<(i64, [i64; 2], [i64; 2])>,
    wall_height: i64,
    stairs: Vec<Stair>,
    /// Per floor: where no thing goes beyond the doorways (the stair, its ends, the ladder, the seats, the aisles).
    keep_clear: Vec<(i64, Rect)>,
    slots: Vec<Json>,
}

fn building() -> Built {
    let (hx, hz) = (BUILDING_LENGTH / 2, BUILDING_WIDTH / 2);
    let w = WALL / 2;
    let split = -2_000; // the wall between the stair hall (landing above) and the rest
    let top = split - w - STAIR_TOP_TO_DOOR; // the stair's top, STAIR_TOP_TO_DOOR from the narrow door's face
    let foot = top - STAIR_RUN;
    let (cx0, cx1) = (split + w, split + w + CORRIDOR_LENGTH); // the corridor, clear
    let cz = CORRIDOR_WIDTH / 2;
    let ext = |f: i64| {
        [
            (f, [-hx - w, -hz], [hx + w, -hz]),
            (f, [-hx - w, hz], [hx + w, hz]),
            (f, [-hx, -hz], [-hx, hz]),
            (f, [hx, -hz], [hx, hz]),
        ]
    };
    let mut walls: Vec<_> = ext(0).into_iter().chain(ext(1)).collect();
    walls.extend([
        (0, [split, -hz], [split, hz]),
        (0, [3_000, -hz], [3_000, hz]),
        (0, [split, 0], [3_000, 0]),
        (1, [split, -hz], [split, hz]),
        (1, [split, -cz - w], [cx1 + w, -cz - w]),
        (1, [cx1 + w, -cz - w], [cx1 + w, cz + w]),
        (1, [split, cz + w], [hx, cz + w]),
        (1, [1_500, cz + w], [1_500, hz]),
    ]);
    let (ix, iz) = (hx - w, hz - w); // the outer walls' inner faces
    let room = |id, name, floor, poly: Vec<[i64; 2]>, things| Room {
        id,
        name,
        floor,
        poly,
        things,
    };
    let rooms = vec![
        room(
            "r0a",
            "stair hall",
            0,
            rect(-ix, -iz, split - w, iz).poly(),
            true,
        ),
        room(
            "r0b",
            "south room",
            0,
            rect(split + w, -iz, 3_000 - w, -w).poly(),
            true,
        ),
        room(
            "r0c",
            "north room",
            0,
            rect(split + w, w, 3_000 - w, iz).poly(),
            true,
        ),
        room(
            "r0d",
            "east room",
            0,
            rect(3_000 + w, -iz, ix, iz).poly(),
            true,
        ),
        room(
            "r1a",
            "landing",
            1,
            rect(-ix, -iz, split - w, iz).poly(),
            true,
        ),
        room(
            "corridor",
            "corridor",
            1,
            rect(cx0, -cz, cx1, cz).poly(),
            false,
        ),
        room(
            "r1b",
            "south room above",
            1,
            vec![
                [cx0, -iz],
                [ix, -iz],
                [ix, cz],
                [cx1 + WALL, cz],
                [cx1 + WALL, -cz - WALL],
                [cx0, -cz - WALL],
            ],
            true,
        ),
        room(
            "r1c",
            "north room above",
            1,
            rect(cx0, cz + WALL, 1_500 - w, iz).poly(),
            true,
        ),
        room(
            "r1d",
            "east room above",
            1,
            rect(1_500 + w, cz + WALL, ix, iz).poly(),
            true,
        ),
    ];
    let op = |id, door, floor, at, along_x, width, from, to| Opening {
        id,
        door,
        floor,
        at,
        along_x,
        width,
        from,
        to,
    };
    let openings = vec![
        op(
            "front",
            true,
            0,
            [-5_000, -hz],
            true,
            DOOR_WIDE,
            "r0a",
            "outside",
        ),
        op("back", true, 0, [hx, 0], false, DOOR_WIDE, "r0d", "outside"),
        op(
            "a-b",
            true,
            0,
            [split, -3_000],
            false,
            DOOR_ROOM,
            "r0a",
            "r0b",
        ),
        op(
            "a-c",
            true,
            0,
            [split, 3_000],
            false,
            DOOR_ROOM,
            "r0a",
            "r0c",
        ),
        op(
            "b-d",
            true,
            0,
            [3_000, -3_000],
            false,
            DOOR_ROOM,
            "r0b",
            "r0d",
        ),
        op(
            "c-d",
            false,
            0,
            [3_000, 3_000],
            false,
            DOOR_ROOM,
            "r0c",
            "r0d",
        ),
        op(
            "narrow",
            true,
            1,
            [split, 0],
            false,
            DOOR_NARROW,
            "r1a",
            "corridor",
        ),
        op(
            "to-b",
            true,
            1,
            [1_000, -cz - w],
            true,
            DOOR_ROOM,
            "corridor",
            "r1b",
        ),
        op(
            "to-c",
            true,
            1,
            [-250, cz + w],
            true,
            DOOR_ROOM,
            "corridor",
            "r1c",
        ),
        op(
            "to-d",
            true,
            1,
            [2_800, cz + w],
            true,
            DOOR_ROOM,
            "corridor",
            "r1d",
        ),
    ];
    let sw = STAIR_WIDTH / 2;
    let footprint = rect(-hx, -hz, hx, hz).poly();
    let (lx, lz0) = (ix - 500, iz - 1_000); // the ladder in the east room, its top 0.4 m inside the roof's edge
    Built {
        id: "building",
        def: "testworld-building@1",
        at: [BUILDING_X, 0, 0],
        yaw: BUILDING_YAW_MDEG,
        rooms,
        openings,
        floors: vec![
            (0, 0, vec![footprint.clone()]),
            // Floor 1 round the stairwell over the stair.
            (
                1,
                STOREY,
                vec![
                    rect(-hx, -hz, hx, -sw).poly(),
                    rect(-hx, sw, hx, hz).poly(),
                    rect(top, -sw, hx, sw).poly(),
                ],
            ),
            (2, 2 * STOREY, vec![footprint]),
        ],
        walls,
        wall_height: STOREY,
        stairs: vec![
            (
                "stair",
                "stairs",
                0,
                1,
                vec![[foot, 0], [top, 0]],
                STAIR_WIDTH,
                0,
                STOREY,
            ),
            (
                "ladder",
                "ladder",
                1,
                2,
                vec![[lx, lz0], [lx, lz0 + 600]],
                LADDER_WIDTH,
                STOREY,
                2 * STOREY,
            ),
        ],
        keep_clear: vec![
            (0, rect(-ix, -sw - 500, top + 1_000, sw + 500)),
            (1, rect(-ix, -sw - 500, split - w, sw + 500)),
            (1, rect(lx - 500, lz0 - 1_000, ix, iz)),
        ],
        slots: Vec::new(),
    }
}

/// The hall's aisles, in its frame: centre, west, east, back, front.
pub fn hall_aisles() -> [(&'static str, Rect); 5] {
    let block = CENTRE_AISLE / 2 + SEATS_PER_ROW / 2 * SEAT_PITCH;
    let (z0, z1) = (
        BACK_ROW_Z - ROW_PITCH / 2,
        BACK_ROW_Z + HALL_ROWS * ROW_PITCH - ROW_PITCH / 2,
    );
    let outer = block + SIDE_AISLE;
    [
        ("centre", rect(-CENTRE_AISLE / 2, z0, CENTRE_AISLE / 2, z1)),
        ("west", rect(-outer, z0, -block, z1)),
        ("east", rect(block, z0, outer, z1)),
        ("back", rect(-outer, z0 - CROSS_AISLE, outer, z0)),
        ("front", rect(-outer, z1, outer, z1 + CROSS_AISLE)),
    ]
}

fn hall() -> Built {
    let (hx, hz, w) = (HALL_WIDTH / 2, HALL_DEPTH / 2, WALL / 2);
    let mut slots = Vec::new();
    for r in 0..HALL_ROWS {
        for c in 0..SEATS_PER_ROW {
            let k = c % (SEATS_PER_ROW / 2);
            let x = CENTRE_AISLE / 2 + SEAT_PITCH / 2 + k * SEAT_PITCH;
            let x = if c < SEATS_PER_ROW / 2 { -x } else { x };
            slots.push(obj([
                ("n", Json::Int(1 + r * SEATS_PER_ROW + c)),
                ("id", Json::Str(format!("seat-{}-{}", r + 1, c + 1))),
                ("kind", Json::Str("seat".into())),
                ("at", ints(&[x, SEAT_HEIGHT, BACK_ROW_Z + r * ROW_PITCH])),
                ("yaw", Json::Int(0)),
                ("capacity", Json::Int(1)),
            ]));
        }
    }
    let block = CENTRE_AISLE / 2 + SEATS_PER_ROW / 2 * SEAT_PITCH;
    let aisles = hall_aisles();
    let (z0, z1) = (aisles[0].1.z0, aisles[0].1.z1);
    let mut keep_clear: Vec<(i64, Rect)> = aisles.iter().map(|(_, r)| (0, *r)).collect();
    keep_clear.push((0, rect(-block, z0, block, z1))); // the seats
    let op = |id, at, along_x, width| Opening {
        id,
        door: true,
        floor: 0,
        at,
        along_x,
        width,
        from: "hall",
        to: "outside",
    };
    Built {
        id: "hall",
        def: "testworld-hall@1",
        at: [0, 0, HALL_Z],
        yaw: 0,
        rooms: vec![Room {
            id: "hall",
            name: "the hall",
            floor: 0,
            poly: rect(-hx, -hz, hx, hz).poly(),
            things: true,
        }],
        openings: vec![
            op("front", [0, -hz - w], true, DOOR_HALL),
            op("back", [0, hz + w], true, DOOR_HALL),
            op("side", [hx + w, 10_000], false, DOOR_NARROW),
        ],
        floors: vec![(0, 0, vec![rect(-hx, -hz, hx, hz).poly()])],
        walls: vec![
            (0, [-hx - WALL, -hz - w], [hx + WALL, -hz - w]),
            (0, [-hx - WALL, hz + w], [hx + WALL, hz + w]),
            (0, [-hx - w, -hz - w], [-hx - w, hz + w]),
            (0, [hx + w, -hz - w], [hx + w, hz + w]),
        ],
        wall_height: HALL_HEIGHT,
        stairs: Vec::new(),
        keep_clear,
        slots,
    }
}

// ---- JSON out: the facts file's own little dialect (whole numbers, no floats), in a fixed order. -----------------
fn obj<const N: usize>(kv: [(&str, Json); N]) -> Json {
    Json::Obj(kv.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}
fn ints(v: &[i64]) -> Json {
    Json::Arr(v.iter().map(|n| Json::Int(*n)).collect())
}
fn pts(v: &[[i64; 2]]) -> Json {
    Json::Arr(v.iter().map(|p| ints(p)).collect())
}
fn text(t: &str) -> Json {
    Json::Str(t.to_owned())
}

/// Writes JSON with no spaces. Strings here are plain ASCII without quotes or backslashes, but both are escaped.
pub fn write(j: &Json, out: &mut String) {
    match j {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Int(n) => out.push_str(&n.to_string()),
        Json::Str(s) => {
            out.push('"');
            for ch in s.chars() {
                if ch == '"' || ch == '\\' {
                    out.push('\\');
                }
                out.push(ch);
            }
            out.push('"');
        }
        Json::Arr(a) => {
            out.push('[');
            for (k, v) in a.iter().enumerate() {
                if k > 0 {
                    out.push(',');
                }
                write(v, out);
            }
            out.push(']');
        }
        Json::Obj(o) => {
            out.push('{');
            for (k, (key, v)) in o.iter().enumerate() {
                if k > 0 {
                    out.push(',');
                }
                write(&Json::Str(key.clone()), out);
                out.push(':');
                write(v, out);
            }
            out.push('}');
        }
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn centre(poly: &[[i64; 2]]) -> [i64; 2] {
    let (x0, x1) = (
        poly.iter().map(|p| p[0]).min().unwrap_or(0),
        poly.iter().map(|p| p[0]).max().unwrap_or(0),
    );
    let (z0, z1) = (
        poly.iter().map(|p| p[1]).min().unwrap_or(0),
        poly.iter().map(|p| p[1]).max().unwrap_or(0),
    );
    [(x0 + x1) / 2, (z0 + z1) / 2]
}

/// Even-odd point in a polygon, on whole numbers.
fn inside(poly: &[[i64; 2]], x: i64, z: i64) -> bool {
    let mut odd = false;
    for k in 0..poly.len() {
        let ([ax, az], [bx, bz]) = (poly[k], poly[(k + 1) % poly.len()]);
        if (az > z) != (bz > z) {
            // x < ax + (z - az) * (bx - ax) / (bz - az), multiplied out by (bz - az) with its sign.
            let lhs = i128::from(x - ax) * i128::from(bz - az);
            let rhs = i128::from(z - az) * i128::from(bx - ax);
            if (bz > az && lhs < rhs) || (bz < az && lhs > rhs) {
                odd = !odd;
            }
        }
    }
    odd
}

/// A lattice point that may hold a thing: which parent, its position in the parent thing's frame, its floor's y.
struct Spot {
    parent: Option<(&'static str, &'static str, [i64; 2], i64)>, // (thing, room, room centre, floor y)
    x: i64,
    z: i64,
    yaw: i64,
}

/// What [`generate`] wrote: the facts file's text and the counts it states.
pub struct World {
    pub text: String,
    pub counts: BTreeMap<String, i64>,
}

/// The test world for `seed`, with `things` small things, as N1's facts file. Refused when the lattice has fewer
/// free points than `things`.
pub fn generate(seed: u64, things: usize) -> Result<World, String> {
    let mut rng = SplitMix(seed);
    let built = [building(), hall()];
    let defs: [(&str, &str, &str); 9] = [
        ("testworld-square@1", "testworld:square", "area"),
        ("testworld-hall@1", "testworld:hall", "point"),
        ("testworld-ring@1", "testworld:ring", "point"),
        ("testworld-building@1", "testworld:building", "point"),
        ("testworld-door@1", "testworld:door", "point"),
        ("testworld-box@1", "testworld:box", "point"),
        ("testworld-frame-stand@1", "mars:frame_stand", "point"),
        ("testworld-rack-upright@1", "mars:rack_upright", "point"),
        ("testworld-rack-beam@1", "mars:rack_beam", "point"),
    ];
    let kinds = defs
        .iter()
        .map(|(r, n, form)| {
            obj([
                ("ref", text(r)),
                (
                    "hash",
                    Json::Str(hex(&sha256(format!("souls/testworld/{r}").as_bytes()))),
                ),
                ("name", text(n)),
                ("form", text(form)),
            ])
        })
        .collect();

    let mut out_things: Vec<Json> = Vec::new();
    let mut doors: Vec<Json> = Vec::new();
    let mut by_ref: BTreeMap<&str, i64> = BTreeMap::new();
    let (mut solids_n, mut rooms_n, mut floors_n, mut surfaces_n, mut slots_n, mut doorways_n) =
        (0, 0, 0, 0, 0, 0);
    let mut stairs_n = 0;
    let half = SQUARE_SIDE / 2;
    let square = rect(-half, -half, half, half);
    let thing =
        |id: &str, def: &str, parent: Option<&str>, pose: [i64; 4], more: Vec<(&str, Json)>| {
            let mut kv = vec![
                ("id".to_owned(), text(id)),
                ("def".to_owned(), text(def)),
                ("ref".to_owned(), text(def)),
                ("parent".to_owned(), parent.map_or(Json::Null, text)),
                ("pose".to_owned(), ints(&pose)),
                ("scale_ppm".to_owned(), Json::Int(1_000_000)),
            ];
            kv.extend(more.into_iter().map(|(k, v)| (k.to_owned(), v)));
            Json::Obj(kv)
        };

    // The square: an area thing.
    out_things.push(thing(
        "square",
        "testworld-square@1",
        None,
        [0; 4],
        vec![
            ("name", text("the square")),
            ("shape", obj([("area", pts(&square.poly()))])),
        ],
    ));
    // The ring: its solid middle.
    let m = RING_MIDDLE / 2;
    out_things.push(thing(
        "ring",
        "testworld-ring@1",
        None,
        [RING_X, 0, 0, 0],
        vec![
            ("name", text("the ring")),
            (
                "solids",
                Json::Arr(vec![ints(&[0, 0, m, m, 0, 0, STOREY, 1, 0])]),
            ),
        ],
    ));
    solids_n += 1;
    *by_ref.entry("testworld-square@1").or_default() += 1;
    *by_ref.entry("testworld-ring@1").or_default() += 1;

    // The building and the hall.
    let mut spots: Vec<Spot> = Vec::new();
    for b in &built {
        let mut solids = Vec::new();
        for (f, a, z) in &b.walls {
            let along_x = a[1] == z[1];
            let (fixed, s, e) = if along_x {
                (a[1], a[0], z[0])
            } else {
                (a[0], a[1], z[1])
            };
            let mut gaps: Vec<(i64, i64)> = b
                .openings
                .iter()
                .filter(|o| o.floor == *f && o.along_x == along_x)
                .filter(|o| {
                    if along_x {
                        o.at[1] == fixed
                    } else {
                        o.at[0] == fixed
                    }
                })
                .map(|o| {
                    let c = if along_x { o.at[0] } else { o.at[1] };
                    (c - o.width / 2, c + o.width / 2)
                })
                .filter(|(g0, g1)| *g0 > s && *g1 < e)
                .collect();
            gaps.sort();
            let (y0, mut from) = (*f * b.wall_height, s);
            for (g0, g1) in gaps.into_iter().chain([(e, e)]) {
                if g0 > from {
                    let (c, h) = ((from + g0) / 2, (g0 - from) / 2);
                    let row = if along_x {
                        [c, fixed, h, WALL / 2]
                    } else {
                        [fixed, c, WALL / 2, h]
                    };
                    solids.push(ints(&[
                        row[0],
                        row[1],
                        row[2],
                        row[3],
                        0,
                        y0,
                        y0 + b.wall_height,
                        1,
                        0,
                    ]));
                }
                from = g1;
            }
        }
        solids_n += solids.len() as i64;
        let floor_y = |lv: i64| {
            b.floors
                .iter()
                .find(|f| f.0 == lv)
                .map_or(lv * STOREY, |f| f.1)
        };
        let rooms: Vec<Json> = b
            .rooms
            .iter()
            .map(|r| {
                let c = centre(&r.poly);
                let rel: Vec<[i64; 2]> =
                    r.poly.iter().map(|p| [p[0] - c[0], p[1] - c[1]]).collect();
                obj([
                    ("id", text(r.id)),
                    ("name", text(r.name)),
                    ("floor", Json::Int(r.floor)),
                    ("pose", ints(&[c[0], floor_y(r.floor), c[1], 0])),
                    ("height", Json::Int(b.wall_height)),
                    ("polygon", pts(&rel)),
                ])
            })
            .collect();
        rooms_n += rooms.len() as i64;
        let mut floors = Vec::new();
        for (lv, y, polys) in &b.floors {
            floors_n += 1;
            for p in polys {
                surfaces_n += 1;
                floors.push(obj([
                    ("level", Json::Int(*lv)),
                    ("y", Json::Int(*y)),
                    ("polygon", pts(p)),
                ]));
            }
        }
        let openings: Vec<Json> = b
            .openings
            .iter()
            .map(|o| {
                obj([
                    ("id", text(o.id)),
                    ("kind", text(if o.door { "door" } else { "arch" })),
                    ("at", ints(&o.at)),
                    ("yaw", Json::Int(o.yaw())),
                    ("width", Json::Int(o.width)),
                    ("height", Json::Int(DOOR_HEIGHT)),
                    ("level", Json::Int(o.floor)),
                    ("from", text(o.from)),
                    ("to", text(o.to)),
                ])
            })
            .collect();
        doorways_n += openings.len() as i64;
        let stairs: Vec<Json> = b
            .stairs
            .iter()
            .map(|(id, kind, f, t, path, w, y0, y1)| {
                if *kind == "stairs" {
                    stairs_n += 1;
                }
                obj([
                    ("id", text(id)),
                    ("kind", text(kind)),
                    ("from", Json::Int(*f)),
                    ("to", Json::Int(*t)),
                    ("path", pts(path)),
                    ("width", Json::Int(*w)),
                    ("y0", Json::Int(*y0)),
                    ("y1", Json::Int(*y1)),
                ])
            })
            .collect();
        slots_n += b.slots.len() as i64;
        let mut more = vec![
            (
                "name",
                text(if b.id == "hall" {
                    "the hall"
                } else {
                    "the building"
                }),
            ),
            ("solids", Json::Arr(solids)),
            ("floors", Json::Arr(floors)),
            ("rooms", Json::Arr(rooms)),
            ("openings", Json::Arr(openings)),
        ];
        if !stairs.is_empty() {
            more.push(("stairs", Json::Arr(stairs)));
        }
        if !b.slots.is_empty() {
            more.push(("slots", Json::Arr(b.slots.clone())));
        }
        out_things.push(thing(
            b.id,
            b.def,
            None,
            [b.at[0], b.at[1], b.at[2], b.yaw],
            more,
        ));
        *by_ref.entry(b.def).or_default() += 1;

        // Its doors, each a thing standing shut in its doorway.
        for o in b.openings.iter().filter(|o| o.door) {
            let id = format!("door-{}-{}", b.id, o.id);
            let pose = [o.at[0], floor_y(o.floor), o.at[1], o.yaw()];
            out_things.push(thing(
                &id,
                "testworld-door@1",
                Some(b.id),
                pose,
                vec![("door", obj([("open", Json::Bool(false))]))],
            ));
            *by_ref.entry("testworld-door@1").or_default() += 1;
            doors.push(obj([
                ("door", Json::Str(id)),
                ("thing", text(b.id)),
                ("opening", text(o.id)),
            ]));
        }

        // Its lattice points, in its frame.
        for r in b.rooms.iter().filter(|r| r.things) {
            let c = centre(&r.poly);
            let (x0, x1) = (
                r.poly.iter().map(|p| p[0]).min().unwrap_or(0),
                r.poly.iter().map(|p| p[0]).max().unwrap_or(0),
            );
            let (z0, z1) = (
                r.poly.iter().map(|p| p[1]).min().unwrap_or(0),
                r.poly.iter().map(|p| p[1]).max().unwrap_or(0),
            );
            let mut x = x0 + THING_PITCH / 2;
            while x < x1 {
                let mut z = z0 + THING_PITCH / 2;
                while z < z1 {
                    let (jx, jz) = (jitter(&mut rng), jitter(&mut rng));
                    let yaw = rng.below(360) as i64 * 1_000;
                    let (px, pz) = (x + jx, z + jz);
                    let h = THING_HALF;
                    let corners = [
                        [px - h, pz - h],
                        [px + h, pz - h],
                        [px + h, pz + h],
                        [px - h, pz + h],
                    ];
                    let free = corners.iter().all(|q| inside(&r.poly, q[0], q[1]))
                        && !b
                            .openings
                            .iter()
                            .any(|o| o.floor == r.floor && o.clear().holds(px, pz, h))
                        && !b
                            .keep_clear
                            .iter()
                            .any(|(f, k)| *f == r.floor && k.holds(px, pz, h));
                    if free {
                        spots.push(Spot {
                            parent: Some((b.id, r.id, c, 0)),
                            x: px,
                            z: pz,
                            yaw,
                        });
                    }
                    z += THING_PITCH;
                }
                x += THING_PITCH;
            }
        }
    }
    // The square's lattice points, in the world frame.
    let mut x = square.x0 + THING_PITCH / 2;
    while x < square.x1 {
        let mut z = square.z0 + THING_PITCH / 2;
        while z < square.z1 {
            let (jx, jz) = (jitter(&mut rng), jitter(&mut rng));
            let yaw = rng.below(360) as i64 * 1_000;
            spots.push(Spot {
                parent: None,
                x: x + jx,
                z: z + jz,
                yaw,
            });
            z += THING_PITCH;
        }
        x += THING_PITCH;
    }
    if things > spots.len() {
        return Err(format!(
            "{things} things asked for, {} free lattice points",
            spots.len()
        ));
    }
    // A seeded partial shuffle picks which points; they are written in lattice order.
    let mut pick: Vec<usize> = (0..spots.len()).collect();
    for k in 0..things {
        let j = k + rng.below((spots.len() - k) as u64) as usize;
        pick.swap(k, j);
    }
    let mut chosen = pick[..things].to_vec();
    chosen.sort_unstable();
    let box_solid = Json::Arr(vec![ints(&[
        0,
        0,
        THING_HALF,
        THING_HALF,
        0,
        0,
        2 * THING_HALF,
        5,
        0,
    ])]);
    for (n, k) in chosen.iter().enumerate() {
        let sp = &spots[*k];
        let id = format!("box-{:05}", n + 1);
        let (parent, pose, mut more) = match sp.parent {
            Some((t, room, c, y)) => (
                Some(t),
                [sp.x - c[0], y, sp.z - c[1], sp.yaw],
                vec![("slot", obj([("room", text(room))]))],
            ),
            None => (None, [sp.x, 0, sp.z, sp.yaw], Vec::new()),
        };
        more.push(("solids", box_solid.clone()));
        out_things.push(thing(&id, "testworld-box@1", parent, pose, more));
        solids_n += 1;
        *by_ref.entry("testworld-box@1").or_default() += 1;
    }

    // The yard: a stand with two frames standing in its slots, four beams lying loose beside it; the site is clear.
    let solid = |cx, cz, hx, hz, y0, y1| ints(&[cx, cz, hx, hz, 0, y0, y1, 5, 0]);
    let stand_slots: Vec<Json> = (1..=YARD_FRAMES)
        .map(|n| {
            let z = if n == 1 { -STAND_SLOT_Z } else { STAND_SLOT_Z };
            obj([
                ("n", Json::Int(n)),
                ("id", Json::Str(format!("frame_{n}"))),
                ("kind", text("frame")),
                ("at", ints(&[0, STAND_SLOT_Y, z])),
                ("yaw", Json::Int(0)),
                ("capacity", Json::Int(1)),
            ])
        })
        .collect();
    slots_n += stand_slots.len() as i64;
    let stand_half = (FRAME_COLUMNS + FRAME_COLUMN) / 2 + 100;
    out_things.push(thing(
        "yard-stand",
        "testworld-frame-stand@1",
        None,
        [YARD_X, 0, YARD_Z, 0],
        vec![
            ("name", text("the yard's frame stand")),
            ("slots", Json::Arr(stand_slots.clone())),
            (
                "solids",
                Json::Arr(vec![solid(0, 0, stand_half, 300, 0, STAND_SLOT_Y)]),
            ),
        ],
    ));
    // A frame: two columns and three braces, in its own frame (columns along x, faces +z and -z).
    let (cx, ch) = (FRAME_COLUMNS / 2, FRAME_COLUMN / 2);
    let frame = Json::Arr(vec![
        solid(-cx, 0, ch, ch, 0, FRAME_HEIGHT),
        solid(cx, 0, ch, ch, 0, FRAME_HEIGHT),
        solid(0, 0, cx, ch / 2, 300, 300 + FRAME_COLUMN / 2),
        solid(
            0,
            0,
            cx,
            ch / 2,
            FRAME_HEIGHT / 2,
            FRAME_HEIGHT / 2 + FRAME_COLUMN / 2,
        ),
        solid(
            0,
            0,
            cx,
            ch / 2,
            FRAME_HEIGHT - 150,
            FRAME_HEIGHT - 150 + FRAME_COLUMN / 2,
        ),
    ]);
    for (k, sl) in stand_slots.iter().enumerate() {
        let at: Vec<i64> = sl
            .get("at")
            .map(Json::arr)
            .unwrap_or(&[])
            .iter()
            .filter_map(Json::int)
            .collect();
        out_things.push(thing(
            &format!("yard-frame-{}", k + 1),
            "testworld-rack-upright@1",
            Some("yard-stand"),
            [at[0], at[1], at[2], 0],
            vec![
                ("name", Json::Str(format!("rack frame {}", k + 1))),
                ("slot", obj([("n", Json::Int(k as i64 + 1))])),
                ("solids", frame.clone()),
            ],
        ));
    }
    let beam = Json::Arr(vec![solid(
        0,
        0,
        BEAM_DEPTH / 2,
        BEAM_LENGTH / 2,
        0,
        BEAM_HEIGHT,
    )]);
    for k in 0..YARD_BEAMS {
        let x = YARD_X + 2_000 + k * BEAM_PITCH;
        out_things.push(thing(
            &format!("yard-beam-{}", k + 1),
            "testworld-rack-beam@1",
            None,
            [x, 0, YARD_Z, 0],
            vec![
                ("name", Json::Str(format!("rack beam {}", k + 1))),
                ("solids", beam.clone()),
            ],
        ));
    }
    solids_n += 1 + YARD_FRAMES * 5 + YARD_BEAMS;
    *by_ref.entry("testworld-frame-stand@1").or_default() += 1;
    *by_ref.entry("testworld-rack-upright@1").or_default() += YARD_FRAMES;
    *by_ref.entry("testworld-rack-beam@1").or_default() += YARD_BEAMS;

    // Places: the square, the hall's aisles, the ring's walkway, the yard and the build site.
    let mut places = vec![obj([
        ("id", text("square.area")),
        ("of", text("area")),
        ("kind", text("square")),
        ("name", text("the square")),
        ("polygon", pts(&square.poly())),
    ])];
    for (name, r) in hall_aisles() {
        let world = rect(r.x0, r.z0 + HALL_Z, r.x1, r.z1 + HALL_Z);
        places.push(obj([
            ("id", Json::Str(format!("hall.aisle-{name}"))),
            ("of", text("area")),
            ("kind", text("aisle")),
            ("name", Json::Str(format!("the hall's {name} aisle"))),
            ("polygon", pts(&world.poly())),
        ]));
    }
    let (yw, yd, ss) = (YARD_WIDTH / 2, YARD_DEPTH / 2, SITE_SIDE / 2);
    places.push(obj([
        ("id", text("yard")),
        ("of", text("area")),
        ("kind", text("yard")),
        ("name", text("the yard")),
        (
            "polygon",
            pts(&rect(YARD_X - yw, YARD_Z - yd, YARD_X + yw, YARD_Z + yd).poly()),
        ),
    ]));
    places.push(obj([
        ("id", text("site")),
        ("of", text("area")),
        ("kind", text("site")),
        ("name", text("the build site")),
        (
            "polygon",
            pts(&rect(SITE_X - ss, YARD_Z - ss, SITE_X + ss, YARD_Z + ss).poly()),
        ),
    ]));
    let c = m + RING_WALKWAY / 2;
    places.push(obj([
        ("id", text("ring.walkway")),
        ("of", text("line")),
        ("kind", text("walkway")),
        ("name", text("the ring's walkway")),
        (
            "line",
            pts(&[
                [RING_X - c, -c],
                [RING_X + c, -c],
                [RING_X + c, c],
                [RING_X - c, c],
                [RING_X - c, -c],
            ]),
        ),
        ("width", Json::Int(RING_WALKWAY)),
    ]));

    let counts: BTreeMap<String, i64> = [
        ("things", out_things.len() as i64),
        ("doors", doors.len() as i64),
        ("rooms", rooms_n),
        ("floors", floors_n),
        ("floor surfaces", surfaces_n),
        ("solids", solids_n),
        ("slots", slots_n),
        ("windows", 0),
        ("doorways", doorways_n),
        ("stairs:stairs", stairs_n),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    let facts = obj([
        ("format", text("souls/import-eden/1")),
        ("world", Json::Str(format!("testworld/seed-{seed}"))),
        ("kinds", Json::Arr(kinds)),
        ("things", Json::Arr(out_things)),
        ("doors", Json::Arr(doors)),
        ("places", Json::Arr(places)),
        (
            "bake",
            Json::Obj(
                counts
                    .iter()
                    .map(|(k, v)| (k.clone(), Json::Int(*v)))
                    .collect(),
            ),
        ),
        (
            "byRef",
            Json::Obj(
                by_ref
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), Json::Int(*v)))
                    .collect(),
            ),
        ),
    ]);
    let mut text = String::new();
    write(&facts, &mut text);
    Ok(World { text, counts })
}

fn jitter(rng: &mut SplitMix) -> i64 {
    rng.below(2 * THING_JITTER as u64 + 1) as i64 - THING_JITTER
}

/// The manifest printed beside the file: each named constant, then this file's seed, counts and SHA-256.
pub fn manifest(seed: u64, things: usize, w: &World) -> String {
    let mut s = String::from("# Engine v2 N2 test world (souls/import-eden/1 facts file)\n");
    for (name, v, unit, what) in NAMED {
        s.push_str(&format!("{name} = {v} {unit}  # {what}\n"));
    }
    s.push_str(&format!("seed = {seed}\nthings asked = {things}\n"));
    for (k, v) in &w.counts {
        s.push_str(&format!("count {k} = {v}\n"));
    }
    s.push_str(&format!(
        "bytes = {}\nsha256 = {}\n",
        w.text.len(),
        hex(&sha256(w.text.as_bytes()))
    ));
    s
}
