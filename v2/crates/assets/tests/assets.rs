//! Uploads and assets by hash, with limits (Engine v2 G6, #2747). Every fixture is built here, byte by byte, so no
//! binary sits in the tree.
//!
//! A1: a fixture over each limit, refused with its code, the measured number and the limit. A2: a clean file keeps
//! its bytes and hash; a photo's location is stripped. A3: the check in a child, its bounds, and the peak on the
//! largest allowed file. A4: one upload call, then a place through G1's gate, in the log and a replica. A5: the hold
//! point.

use assets::check::{Format, Limits, Refused, check};
use assets::child::{Checker, Ran};
use assets::hold::{Classifier, Verdict};
use assets::store::{State, Store, placeable};
use miniz_oxide::deflate::compress_to_vec_zlib;
use replica::apply::Replica;
use replica::edit::{Edit, Op, Ref, Spot, World, check as check_edit};
use replica::effects::{Actor, FIXTURE_HEADER, Header, Part, fixture_bytes};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, KindSource, Minter, Purpose, Scope, name_kinds};
use replica::pose::{Quat, Support, Vec3};
use replica::world_model::{Audience, Kind};
use sim::edit::{commit, plan};
use sim::log::{Log, Mem, Storage, recover};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

/// The child program: this build's, or `ASSETS_CHECK` (to measure an optimised build). Its time bound is 60 s, not
/// the 5 s default: here it only stops a hang, since a loaded runner's debug child can pass 5 s with no fault. A3
/// kills a child at 1 ms to test the bound, and its speed bar holds the largest file to the default.
fn checker() -> Checker {
    Checker {
        time: Duration::from_secs(60),
        ..Checker::new(
            std::env::var("ASSETS_CHECK")
                .unwrap_or_else(|_| env!("CARGO_BIN_EXE_assets-check").into()),
        )
    }
}

// ---------------------------------------------------------------- fixtures

fn crc32(b: &[u8]) -> u32 {
    let mut c = !0u32;
    for &x in b {
        c ^= x as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
    }
    !c
}

fn chunk(out: &mut Vec<u8>, ty: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(ty);
    out.extend_from_slice(data);
    let c = crc32(&out[start..]);
    out.extend_from_slice(&c.to_be_bytes());
}

/// A PNG of `w` by `h` pixels, colour type `color` at 8 bits (1 bit for grey), all zero; `text` adds a tEXt chunk.
fn png(w: u32, h: u32, color: u8, text: Option<&str>) -> Vec<u8> {
    let depth: u8 = if color == 0 { 1 } else { 8 };
    let channels = match color {
        0 => 1,
        2 => 3,
        _ => 4,
    };
    let stride = (w as usize * channels * depth as usize).div_ceil(8) + 1;
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[depth, color, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    if let Some(t) = text {
        chunk(&mut out, b"tEXt", t.as_bytes());
    }
    chunk(
        &mut out,
        b"IDAT",
        &compress_to_vec_zlib(&vec![0u8; stride * h as usize], 9),
    );
    chunk(&mut out, b"IEND", &[]);
    out
}

const EXIF: &[u8] = b"Exif\0\0GPSLatitude 52.5200 N GPSLongitude 13.4050 E";

/// A JPEG of 64 by 48 pixels whose EXIF segment carries a GPS position (its pixels are not decoded by the check).
fn photo() -> Vec<u8> {
    let mut b = vec![0xff, 0xd8];
    let seg = |b: &mut Vec<u8>, marker: u8, data: &[u8]| {
        b.extend_from_slice(&[0xff, marker]);
        b.extend_from_slice(&((data.len() + 2) as u16).to_be_bytes());
        b.extend_from_slice(data);
    };
    seg(&mut b, 0xe0, b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
    seg(&mut b, 0xe1, EXIF);
    seg(&mut b, 0xc0, &[8, 0, 48, 0, 64, 1, 1, 0x11, 0]);
    seg(&mut b, 0xda, &[1, 1, 0, 0, 0x3f, 0]);
    b.extend_from_slice(&[0x12, 0x34, 0x56, 0x78]);
    b.extend_from_slice(&[0xff, 0xd9]);
    b
}

/// A binary glTF of `json` and `bin`.
fn glb(json: &str, bin: &[u8]) -> Vec<u8> {
    let mut j = json.as_bytes().to_vec();
    j.resize(j.len().next_multiple_of(4), b' ');
    let mut bn = bin.to_vec();
    bn.resize(bn.len().next_multiple_of(4), 0);
    let total = 12 + 8 + j.len() + if bn.is_empty() { 0 } else { 8 + bn.len() };
    let mut o = b"glTF".to_vec();
    o.extend_from_slice(&2u32.to_le_bytes());
    o.extend_from_slice(&(total as u32).to_le_bytes());
    o.extend_from_slice(&(j.len() as u32).to_le_bytes());
    o.extend_from_slice(b"JSON");
    o.extend_from_slice(&j);
    if !bn.is_empty() {
        o.extend_from_slice(&(bn.len() as u32).to_le_bytes());
        o.extend_from_slice(b"BIN\0");
        o.extend_from_slice(&bn);
    }
    o
}

/// A mesh: three vertices and `indices` u16 indices (all 0 unless `oob`), `images` PNG textures embedded after them,
/// `pad` unused bytes at the end, and `extra` JSON members at the top.
struct Mesh {
    indices: usize,
    oob: bool,
    images: Vec<Vec<u8>>,
    pad: usize,
    extra: &'static str,
}

impl Default for Mesh {
    fn default() -> Mesh {
        Mesh {
            indices: 3,
            oob: false,
            images: Vec::new(),
            pad: 0,
            extra: "",
        }
    }
}

impl Mesh {
    fn build(&self) -> Vec<u8> {
        let mut bin = vec![0u8; 36];
        let ix = bin.len();
        for i in 0..self.indices {
            let v: u16 = if self.oob && i == self.indices - 1 {
                3
            } else {
                (i % 3) as u16
            };
            bin.extend_from_slice(&v.to_le_bytes());
        }
        bin.resize(bin.len().next_multiple_of(4), 0);
        let mut views = vec![
            format!(r#"{{"buffer":0,"byteOffset":0,"byteLength":36}}"#),
            format!(
                r#"{{"buffer":0,"byteOffset":{ix},"byteLength":{}}}"#,
                self.indices * 2
            ),
        ];
        let mut images = Vec::new();
        for im in &self.images {
            views.push(format!(
                r#"{{"buffer":0,"byteOffset":{},"byteLength":{}}}"#,
                bin.len(),
                im.len()
            ));
            images.push(format!(
                r#"{{"bufferView":{},"mimeType":"image/png"}}"#,
                views.len() - 1
            ));
            bin.extend_from_slice(im);
            bin.resize(bin.len().next_multiple_of(4), 0);
        }
        bin.resize(bin.len() + self.pad, 0);
        let json = format!(
            r#"{{{}"asset":{{"version":"2.0"}},"buffers":[{{"byteLength":{}}}],"bufferViews":[{}],"accessors":[{{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3"}},{{"bufferView":1,"componentType":5123,"count":{},"type":"SCALAR"}}],"meshes":[{{"primitives":[{{"attributes":{{"POSITION":0}},"indices":1}}]}}],"images":[{}]}}"#,
            self.extra,
            bin.len(),
            views.join(","),
            self.indices,
            images.join(",")
        );
        glb(&json, &bin)
    }
}

fn refused(r: Result<assets::check::Checked, Refused>) -> Refused {
    r.expect_err("refused")
}

// ---------------------------------------------------------------- A1

/// A fixture: its name, its bytes, and the code, measured number and limit it is refused with.
type Case = (
    &'static str,
    Vec<u8>,
    &'static str,
    Option<u64>,
    Option<u64>,
);

/// Each limit, printed as the fixture table.
#[test]
fn a1_each_limit_refused_by_name() {
    let l = Limits::default();
    let big = Mesh {
        pad: 3_000_001,
        ..Mesh::default()
    }
    .build();
    let tris = Mesh {
        indices: 240_003,
        ..Mesh::default()
    }
    .build();
    let wide = png(2049, 1, 0, None);
    let many = Mesh {
        images: vec![png(1, 1, 0, None); 65],
        ..Mesh::default()
    }
    .build();
    let pixels = Mesh {
        images: vec![png(2048, 2048, 0, None); 5],
        ..Mesh::default()
    }
    .build();
    let fat = {
        // A PNG over 2 MB, by a private chunk of filler.
        let mut p = png(1, 1, 0, None);
        let end = p.split_off(p.len() - 12);
        chunk(&mut p, b"fiLl", &vec![7u8; 2_000_000]);
        p.extend_from_slice(&end);
        p
    };
    let cases: Vec<Case> = vec![
        (
            "bytes",
            big.clone(),
            "upload.size",
            Some(big.len() as u64),
            Some(l.bytes),
        ),
        (
            "triangles",
            tris,
            "upload.triangle-budget",
            Some(80_001),
            Some(l.triangles),
        ),
        (
            "texture side",
            wide,
            "upload.texture-side",
            Some(2049),
            Some(l.side),
        ),
        (
            "texture count",
            many,
            "upload.texture-count",
            Some(65),
            Some(l.textures),
        ),
        (
            "texture pixels",
            pixels,
            "upload.texture-pixels",
            Some(5 * 2048 * 2048),
            Some(l.pixels),
        ),
        (
            "image bytes",
            fat.clone(),
            "upload.image-size",
            Some(fat.len() as u64),
            Some(l.image_bytes),
        ),
        (
            "malformed: truncated GLB",
            Mesh::default().build()[..40].to_vec(),
            "upload.invalid",
            None,
            None,
        ),
        (
            "malformed: PNG checksum",
            {
                let mut p = png(4, 4, 2, None);
                p[30] ^= 1;
                p
            },
            "upload.image-invalid",
            None,
            None,
        ),
        (
            "malformed: index past its vertices",
            Mesh {
                oob: true,
                ..Mesh::default()
            }
            .build(),
            "upload.invalid",
            None,
            None,
        ),
        (
            "malformed: accessor past its view",
            glb(
                r#"{"asset":{"version":"2.0"},"buffers":[{"byteLength":8}],"bufferViews":[{"buffer":0,"byteLength":8}],"accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3"}],"meshes":[{"primitives":[{"attributes":{"POSITION":0}}]}]}"#,
                &[0; 8],
            ),
            "upload.invalid",
            None,
            None,
        ),
        (
            "malformed: not a known format",
            b"GIF89a....".to_vec(),
            "upload.format",
            None,
            None,
        ),
        (
            "outside resource: buffer",
            glb(
                r#"{"asset":{"version":"2.0"},"buffers":[{"byteLength":36,"uri":"https://elsewhere/mesh.bin"}]}"#,
                &[],
            ),
            "upload.external-resource",
            None,
            None,
        ),
        (
            "outside resource: image",
            glb(
                r#"{"asset":{"version":"2.0"},"images":[{"uri":"face.png"}]}"#,
                &[],
            ),
            "upload.external-resource",
            None,
            None,
        ),
        (
            "Draco mesh",
            glb(
                r#"{"asset":{"version":"2.0"},"extensionsUsed":["KHR_draco_mesh_compression"]}"#,
                &[],
            ),
            "upload.compressed-mesh",
            None,
            None,
        ),
    ];
    let child = checker();
    println!("| fixture | code | measured | limit |\n|---|---|---|---|");
    for (case, file, code, measured, limit) in cases {
        let r = refused(check(&file, &l));
        assert_eq!(
            (r.code, r.measured, r.limit),
            (code, measured, limit),
            "{case}: {}",
            r.detail
        );
        // The same answer from the child process.
        let Ran { result, .. } = child.check(&file);
        assert_eq!(
            result.expect_err("refused in the child"),
            r,
            "{case} in the child"
        );
        let n = |x: Option<u64>| x.map_or("-".into(), |x| x.to_string());
        println!("| {case} | `{code}` | {} | {} |", n(measured), n(limit));
    }
}

// ---------------------------------------------------------------- A2

#[test]
fn a2_clean_keeps_bytes_and_hash_and_a_photo_loses_its_location() {
    let l = Limits::default();
    for (case, file) in [
        ("PNG", png(16, 16, 6, None)),
        (
            "GLB with a texture",
            Mesh {
                images: vec![png(8, 8, 2, None)],
                ..Mesh::default()
            }
            .build(),
        ),
    ] {
        let c = check(&file, &l).expect("allowed");
        assert_eq!(c.bytes, file, "{case}: its bytes");
        assert_eq!(c.hash, Hash::of(Purpose::Upload, &file), "{case}: its hash");
        assert_eq!(c.stripped, 0);
    }
    let gps = photo();
    let c = check(&gps, &l).expect("allowed");
    assert_eq!(c.format, Format::Jpeg);
    let has = |b: &[u8], s: &[u8]| b.windows(s.len()).any(|w| w == s);
    assert!(has(&gps, b"GPSLatitude"));
    assert!(
        !has(&c.bytes, b"GPS") && !has(&c.bytes, b"Exif"),
        "the location is gone"
    );
    assert_eq!(
        c.bytes.len(),
        gps.len() - (4 + EXIF.len()),
        "only the EXIF segment is cut"
    );
    assert_eq!(c.hash, Hash::of(Purpose::Upload, &c.bytes));
    assert!(
        c.text.iter().any(|t| t.contains("GPSLatitude")),
        "a classifier saw it"
    );
    // Embedded in a model: a PNG's text and a glTF's extras go too, and the result checks clean.
    let model = Mesh {
        images: vec![png(8, 8, 2, Some("Comment\0shot at home"))],
        extra: r#""extras":{"author":"someone"},"#,
        ..Mesh::default()
    }
    .build();
    let c = check(&model, &l).expect("allowed");
    assert!(!has(&c.bytes, b"shot at home") && !has(&c.bytes, b"someone"));
    assert_eq!(c.stripped, 2);
    let again = check(&c.bytes, &l).expect("still allowed");
    assert_eq!(again.bytes, c.bytes, "stripping twice changes nothing");
}

// ---------------------------------------------------------------- A3

/// The largest allowed file: 3 MB less a little, 80,000 triangles, four RGBA textures of 2,048 px (the pixel limit).
fn largest() -> Vec<u8> {
    let tex = png(2048, 2048, 6, None);
    let mut m = Mesh {
        indices: 240_000,
        images: vec![tex; 4],
        ..Mesh::default()
    };
    let base = m.build().len();
    m.pad = 3_000_000 - base - 8;
    m.build()
}

#[test]
#[allow(clippy::disallowed_methods)] // measures the check's own wall time for the posted figure; no engine clock
fn a3_child_bounds_and_peak_on_the_largest_file() {
    let file = largest();
    let l = Limits::default();
    assert!(file.len() as u64 <= l.bytes);
    let child = checker();
    let mut times = Vec::new();
    let mut peak = 0;
    for _ in 0..3 {
        let t = std::time::Instant::now();
        let ran = child.check(&file);
        times.push(t.elapsed());
        let c = ran.result.expect("allowed");
        assert_eq!(
            (c.triangles, c.textures, c.side, c.pixels),
            (80_000, 4, 2048, l.pixels)
        );
        assert_eq!(c.bytes, file);
        peak = ran.peak.expect("a peak");
    }
    times.sort();
    println!(
        "largest allowed file: {} bytes, 80,000 triangles, 4 textures of 2,048 px; child peak {:.1} MB of {} MB bound; median {} ms of {} ms bound",
        file.len(),
        peak as f64 / 1e6,
        child.memory >> 20,
        times[1].as_millis(),
        assets::child::TIME.as_millis()
    );
    assert!(peak < child.memory, "under the memory bound");
    // The default time bound is a speed bar (real time): asserted only in the speed-bar step (ci.sh,
    // V2_SPEED_BARS=1, release).
    if std::env::var_os("V2_SPEED_BARS").is_some() {
        assert!(times[1] < assets::child::TIME, "under the time bound");
    }
    // Over the memory bound: the child ends, the file is refused, the parent goes on.
    let tight = Checker {
        memory: 8 << 20,
        ..checker()
    };
    let r = tight.check(&file).result.expect_err("refused");
    assert_eq!(r.code, "upload.check-limit", "{}", r.detail);
    // Over the time bound: killed.
    let quick = Checker {
        time: Duration::from_millis(1),
        ..checker()
    };
    let r = quick.check(&file).result.expect_err("refused");
    assert_eq!(r.code, "upload.check-limit", "{}", r.detail);
}

// ---------------------------------------------------------------- A4 and A5

const CREATOR: Scope = Scope([0xc0; 16]);

struct Hold(&'static str);

impl Classifier for Hold {
    fn name(&self) -> &str {
        "test"
    }

    fn classify(&self, _: &assets::check::Checked) -> Result<Verdict, String> {
        match self.0 {
            "hold" => Ok(Verdict::Hold("looks wrong".into())),
            "reject" => Ok(Verdict::Reject("refused".into())),
            "fail" => Err("no model loaded".into()),
            "panic" => panic!("the classifier broke"),
            _ => {
                std::thread::sleep(Duration::from_millis(500));
                Ok(Verdict::Allow)
            }
        }
    }
}

fn store() -> Store {
    let creator = Id::new(CREATOR, 1).expect("an id");
    Store::new(creator, Minter::new(Scope([0xa5; 16])), checker())
}

fn creator() -> Actor {
    Actor::Creator(Id::new(CREATOR, 1).expect("an id"))
}

fn model_kind() -> String {
    let text = include_str!("../../replica/fixtures/kinds/model.diag");
    let src = KindSource::parse(text).expect("a kind");
    let named = name_kinds(&[src]).expect("named");
    named.values().next().expect("one").to_string()
}

/// A reference as a thing's field holds it.
fn by_ref(id: Id) -> Value {
    Value::Map(BTreeMap::from([(
        replica::audience::REFERENCE,
        id.to_value(),
    )]))
}

/// A place of the uploaded-model kind at the root, naming `upload`.
fn place(kind: &str, root: Id, upload: Id) -> Op {
    Op::Place {
        name: 0,
        kind: Name::new(kind).expect("a name"),
        parent: Ref::Node(root),
        at: Spot {
            slot: None,
            position: Vec3::new(1_000, 0, 0),
            orientation: Quat::IDENTITY,
            support: Support::None,
        },
        audience: Audience::Everyone,
        fields: BTreeMap::from([(1, by_ref(upload))]),
    }
}

#[test]
fn a4_upload_then_place_through_g1s_gate() {
    let kind = model_kind();
    // The fixture world, pinning the uploaded-model kind beside its own.
    let mut header =
        Header::read(&fixture_bytes(FIXTURE_HEADER).expect("bytes")).expect("a header");
    header.kinds.push(Name::new(&kind).expect("a name"));
    let header = Header::read(&encode(&header.to_value()).expect("bytes")).expect("a header");
    let plain = |k: &str| k.split('@').next().expect("a name").to_owned();
    let root_kind = header
        .kinds
        .iter()
        .find(|k| plain(k.as_str()) == "souls:place")
        .expect("pinned")
        .clone();
    let world = World {
        creator: Id::new(CREATOR, 1).expect("an id"),
        kinds: BTreeMap::from([
            (
                root_kind.as_str().to_owned(),
                Kind {
                    owner: "place".into(),
                    children: BTreeSet::from(["thing".to_owned()]),
                    slots: BTreeMap::new(),
                    hands: None,
                    fields: Default::default(),
                },
            ),
            (
                kind.clone(),
                Kind {
                    owner: "thing".into(),
                    children: BTreeSet::new(),
                    slots: BTreeMap::new(),
                    hands: None,
                    fields: Default::default(),
                },
            ),
        ]),
    };
    let mut live = Replica::start(header.stored()).expect("a replica");
    let mut client = Replica::start(header.stored()).expect("a replica");
    let mut minter = Minter::new(header.lineage);
    let root = minter.mint().expect("the root");
    let (mut log, _) = Log::open(Mem::default(), 1).expect("a log");

    // One call: the file in, the reference out.
    let mut s = store();
    let file = Mesh {
        images: vec![png(8, 8, 2, None)],
        ..Mesh::default()
    }
    .build();
    assert_eq!(
        s.upload(Actor::World, &file)
            .expect_err("not the creator")
            .code,
        "upload.not-the-creator"
    );
    let receipt = s.upload(creator(), &file).expect("uploaded");
    assert_eq!(receipt.state, State::Allowed);
    assert_eq!(receipt.hash, Hash::of(Purpose::Upload, &file));
    assert_eq!(s.served(receipt.reference), Some(&file[..]));

    // Placed through G1's gate: checked on a copy, the upload gate beside it, committed through the one write.
    let edit = Edit {
        claim: None,
        intent: Id::new(Scope([0x11; 16]), 0).expect("an id"),
        actor: creator(),
        planned: live.version(),
        ops: vec![place(&kind, root, receipt.reference)],
    };
    placeable(&edit, &s).expect("an allowed upload is placeable");

    // Hidden by the creator (#3698): not served, not placed, kept; shown again, as before.
    assert_eq!(
        s.hide(Actor::World, receipt.reference)
            .expect_err("not the creator")
            .code,
        "upload.not-the-creator"
    );
    assert_eq!(
        s.show(creator(), receipt.reference)
            .expect_err("not hidden")
            .code,
        "upload.not-hidden"
    );
    assert_eq!(
        s.hide(creator(), receipt.reference).expect("hidden").state,
        State::Hidden
    );
    assert_eq!(s.served(receipt.reference), None);
    assert_eq!(
        placeable(&edit, &s).expect_err("hidden").name,
        "upload.not-placeable"
    );
    assert_eq!(
        s.hide(creator(), receipt.reference)
            .expect_err("already hidden")
            .code,
        "upload.not-allowed"
    );
    s.show(creator(), receipt.reference).expect("shown");
    assert_eq!(s.served(receipt.reference), Some(&file[..]));
    placeable(&edit, &s).expect("shown again, placeable");
    let copy = live.frozen();
    let checked = check_edit(edit, &copy, &world).expect("checked");
    let planned = plan(checked, &copy, None).expect("planned");
    let c = commit(&mut live, &mut minter, &planned, &[], 1_000).expect("committed");
    let thing = c.names[&0];
    log.append(c.part.stored().to_vec()).expect("appended");
    client
        .apply_bytes(c.part.stored())
        .expect("the replica applies it");

    // In the replica, naming the upload by reference and nothing else of it.
    let has_ref = |v: &Value| {
        let mut stack = vec![v.clone()];
        while let Some(v) = stack.pop() {
            if v == by_ref(receipt.reference) {
                return true;
            }
            match v {
                Value::Array(a) => stack.extend(a),
                Value::Map(m) => stack.extend(m.into_values()),
                _ => {}
            }
        }
        false
    };
    let node = client.node(thing).expect("the thing is in the replica");
    assert!(has_ref(&node), "it names the upload: {node:?}");
    assert!(
        !format!("{node:?}").contains("glTF"),
        "by reference, not by bytes"
    );
    // In the log, read back from the disk.
    let mut disk = log.close();
    let found = recover(&Storage::read(&mut disk).expect("the disk")).expect("the log reads back");
    let parts: Vec<Part> = found
        .records
        .iter()
        .map(|r| Part::read(r).expect("a part"))
        .collect();
    let mut archive = Replica::start(header.stored()).expect("a replica");
    for p in &parts {
        archive.apply(p).expect("applies");
    }
    assert!(has_ref(
        &archive.node(thing).expect("the thing is in the log")
    ));
    println!(
        "uploaded {} bytes as {}; placed as {thing:?} of {kind}",
        file.len(),
        receipt.hash
    );
}

#[test]
fn a5_hold_point() {
    let file = png(4, 4, 2, None);
    // No classifier plugged in: allowed.
    let mut s = store();
    assert_eq!(s.classifier.name(), "none");
    let r = s.upload(creator(), &file).expect("uploaded");
    assert_eq!(r.state, State::Allowed);
    assert!(s.served(r.reference).is_some());
    // A test classifier that holds, fails, panics or runs past its time: held, neither served nor placeable.
    let root = Id::new(Scope([0x01; 16]), 0).expect("an id");
    for answer in ["hold", "fail", "panic", "slow"] {
        let mut s = store();
        s.classifier = Arc::new(Hold(answer));
        s.classify_within = Duration::from_millis(100);
        let r = s.upload(creator(), &file).expect("stored, held");
        assert!(matches!(r.state, State::Held(_)), "{answer}: {:?}", r.state);
        assert_eq!(
            s.record(r.reference).map(|x| &x.state),
            Some(&r.state),
            "{answer}: the record is kept"
        );
        assert_eq!(s.served(r.reference), None, "{answer}: not served");
        assert_eq!(
            s.hide(creator(), r.reference).expect_err("held").code,
            "upload.not-allowed",
            "{answer}: a held upload waits for its release"
        );
        let edit = Edit {
            claim: None,
            intent: Id::new(Scope([0x11; 16]), 0).expect("an id"),
            actor: creator(),
            planned: 0,
            ops: vec![place("t:x", root, r.reference)],
        };
        let refused = placeable(&edit, &s).expect_err("not placeable");
        assert_eq!(
            (refused.name, refused.op),
            ("upload.not-placeable", Some(0)),
            "{answer}"
        );
        println!("{answer}: {:?}", r.state);
    }
    // A reject stores nothing.
    let mut s = store();
    s.classifier = Arc::new(Hold("reject"));
    assert_eq!(
        s.upload(creator(), &file).expect_err("rejected").code,
        "upload.rejected"
    );
}
