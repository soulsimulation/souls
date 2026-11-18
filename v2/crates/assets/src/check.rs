//! The check (G6, #2747): one uploaded file, read by its first bytes, measured against its limits and stripped of
//! metadata. Today's gate (`apps/server/src/moderation/validate.ts`) is the specification; its numbers are the
//! defaults. A refusal names a code and, for a limit, the measured number and the limit.
//!
//! - **Formats:** self-contained binary glTF, PNG and JPEG, known by their first bytes, never by a name.
//! - **Limits:** bytes, triangles, texture side, texture count, image bytes, and the total pixels of all textures
//!   (64 textures of 2,048 px would decode to a gigabyte).
//! - **Bounded like the Khronos validator:** a buffer view inside its buffer, an accessor inside its view, every index
//!   below its vertex count. A mesh compressed with Draco or meshopt is refused: its size comes from its stream.
//! - **Stripped:** glTF `extras` and unknown chunks; PNG text and other ancillary chunks; JPEG EXIF (a photo's
//!   location), XMP and comments; bytes after an image's end. A clean file keeps its bytes, so its hash.
//! - **Inflation capped:** PNG pixel data is inflated to at most the size its header declares.
//!
//! This runs in a child process with memory and time limits ([`crate::child`]); it holds no state.

use replica::ids::{Hash, Purpose};
use replica::rules::json::{self, Value as Json};

/// The limits one file is checked against. [`Limits::default`] is today's numbers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub bytes: u64,
    pub image_bytes: u64,
    pub triangles: u64,
    pub side: u64,
    pub textures: u64,
    /// The sum of every texture's width times height.
    pub pixels: u64,
    /// JSON values in a glTF's JSON chunk.
    pub json_values: u64,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            bytes: 3_000_000,
            image_bytes: 2_000_000,
            triangles: 80_000,
            side: 2_048,
            textures: 64,
            // Four textures of 2,048 px: 64 MB decoded as RGBA.
            pixels: 4 * 2_048 * 2_048,
            json_values: 200_000,
        }
    }
}

impl Limits {
    /// The limits as a list of numbers, in field order, for the child's command line.
    pub fn to_args(self) -> Vec<String> {
        [
            self.bytes,
            self.image_bytes,
            self.triangles,
            self.side,
            self.textures,
            self.pixels,
            self.json_values,
        ]
        .iter()
        .map(u64::to_string)
        .collect()
    }

    pub fn from_args(args: &[String]) -> Option<Limits> {
        let n: Vec<u64> = args.iter().map(|a| a.parse().ok()).collect::<Option<_>>()?;
        let [
            bytes,
            image_bytes,
            triangles,
            side,
            textures,
            pixels,
            json_values,
        ] = n[..]
        else {
            return None;
        };
        Some(Limits {
            bytes,
            image_bytes,
            triangles,
            side,
            textures,
            pixels,
            json_values,
        })
    }
}

/// A file's format, by its first bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Glb,
    Png,
    Jpeg,
}

impl Format {
    pub fn name(self) -> &'static str {
        match self {
            Format::Glb => "glb",
            Format::Png => "png",
            Format::Jpeg => "jpeg",
        }
    }

    pub fn from_name(s: &str) -> Option<Format> {
        [Format::Glb, Format::Png, Format::Jpeg]
            .into_iter()
            .find(|f| f.name() == s)
    }
}

/// A refused file: the code, and for a limit the measured number and the limit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refused {
    pub code: &'static str,
    pub measured: Option<u64>,
    pub limit: Option<u64>,
    pub detail: String,
}

fn bad<T>(code: &'static str, detail: impl Into<String>) -> Result<T, Refused> {
    Err(Refused {
        code,
        measured: None,
        limit: None,
        detail: detail.into(),
    })
}

/// Refuses `measured` over `limit` under `code`.
fn within(code: &'static str, measured: u64, limit: u64, what: &str) -> Result<(), Refused> {
    if measured > limit {
        return Err(Refused {
            code,
            measured: Some(measured),
            limit: Some(limit),
            detail: format!("{what}: {measured}, over {limit}"),
        });
    }
    Ok(())
}

/// A file that passed: what the store keeps, its hash, and what was measured.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checked {
    pub format: Format,
    /// The input minus its metadata; the input itself when it had none.
    pub bytes: Vec<u8>,
    /// The `souls/upload/1` hash of [`Checked::bytes`].
    pub hash: Hash,
    pub triangles: u64,
    pub textures: u64,
    /// The longest texture side.
    pub side: u64,
    pub pixels: u64,
    /// Metadata items removed (fields, chunks, segments, trailers).
    pub stripped: u64,
    /// Metadata text seen before stripping, at most [`TEXT_MOST`] bytes, for a classifier.
    pub text: Vec<String>,
}

/// The most metadata text kept for a classifier.
pub const TEXT_MOST: usize = 4096;

fn note(text: &mut Vec<String>, s: &str) {
    let used: usize = text.iter().map(String::len).sum();
    let s = s.trim();
    if used < TEXT_MOST && !s.is_empty() {
        text.push(s.chars().take(TEXT_MOST - used).collect());
    }
}

fn printable(b: &[u8]) -> String {
    b.iter()
        .take(512)
        .map(|&c| {
            if (0x20..0x7f).contains(&c) {
                c as char
            } else {
                ' '
            }
        })
        .collect()
}

/// The format of `b` by its first bytes.
pub fn sniff(b: &[u8]) -> Option<Format> {
    if b.starts_with(b"glTF") {
        Some(Format::Glb)
    } else if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(Format::Png)
    } else if b.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(Format::Jpeg)
    } else {
        None
    }
}

/// Checks one file against `limits` (see the module's notes).
pub fn check(input: &[u8], limits: &Limits) -> Result<Checked, Refused> {
    if input.is_empty() {
        return bad("upload.empty", "no bytes");
    }
    within("upload.size", input.len() as u64, limits.bytes, "bytes")?;
    let Some(format) = sniff(input) else {
        return bad(
            "upload.format",
            "not a binary glTF, a PNG or a JPEG by its first bytes",
        );
    };
    let mut text = Vec::new();
    let (bytes, m) = match format {
        Format::Glb => glb(input, limits, &mut text)?,
        Format::Png | Format::Jpeg => {
            let img = image(input, None, limits, &mut text)?;
            let mut m = Measured::default();
            m.add(&img, limits)?;
            m.stripped = img.drop.len() as u64;
            (cut(input, &img.drop), m)
        }
    };
    Ok(Checked {
        format,
        hash: Hash::of(Purpose::Upload, &bytes),
        bytes,
        triangles: m.triangles,
        textures: m.textures,
        side: m.side,
        pixels: m.pixels,
        stripped: m.stripped,
        text,
    })
}

#[derive(Default)]
struct Measured {
    triangles: u64,
    textures: u64,
    side: u64,
    pixels: u64,
    stripped: u64,
}

impl Measured {
    fn add(&mut self, img: &Image, limits: &Limits) -> Result<(), Refused> {
        self.textures += 1;
        self.side = self.side.max(img.w).max(img.h);
        self.pixels += img.w * img.h;
        within(
            "upload.texture-pixels",
            self.pixels,
            limits.pixels,
            "texture pixels",
        )
    }
}

// ---------------------------------------------------------------- images

const fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        t[n] = c;
        n += 1;
    }
    t
}
const CRC: [u32; 256] = crc_table();

fn crc32(b: &[u8]) -> u32 {
    !b.iter().fold(!0u32, |c, &x| {
        CRC[((c ^ x as u32) & 0xff) as usize] ^ (c >> 8)
    })
}

fn be32(b: &[u8], p: usize) -> u64 {
    u32::from_be_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]) as u64
}

fn be16(b: &[u8], p: usize) -> usize {
    u16::from_be_bytes([b[p], b[p + 1]]) as usize
}

fn le32(b: &[u8], p: usize) -> usize {
    u32::from_le_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]) as usize
}

/// An image checked: its size, and its metadata as `[start, end)` ranges, the bytes after its end marker last.
struct Image {
    w: u64,
    h: u64,
    drop: Vec<(usize, usize)>,
    trailer: Option<usize>,
    format: Format,
}

/// Checks one image, standalone or embedded (`declared` is an embedded image's `mimeType`).
fn image(
    b: &[u8],
    declared: Option<&str>,
    limits: &Limits,
    text: &mut Vec<String>,
) -> Result<Image, Refused> {
    within(
        "upload.image-size",
        b.len() as u64,
        limits.image_bytes,
        "image bytes",
    )?;
    let format = sniff(b);
    let named = declared.map(|m| match m {
        "image/png" => Some(Format::Png),
        "image/jpeg" => Some(Format::Jpeg),
        _ => None,
    });
    if let Some(named) = named
        && named != format
    {
        return bad(
            "upload.image-format",
            format!("an image declared {declared:?} is {format:?}"),
        );
    }
    let img = match format {
        Some(Format::Png) => png(b, text)?,
        Some(Format::Jpeg) => jpeg(b, text)?,
        _ => return bad("upload.image-format", "images are PNG or JPEG"),
    };
    within(
        "upload.texture-side",
        img.w.max(img.h),
        limits.side,
        "texture side",
    )?;
    if img.format == Format::Png {
        inflate_png(b, &img)?;
    }
    Ok(img)
}

/// PNG chunks that change how pixels look; every other ancillary chunk is metadata.
const PNG_KEEP: [&[u8; 4]; 12] = [
    b"IHDR", b"PLTE", b"IDAT", b"IEND", b"tRNS", b"gAMA", b"cHRM", b"sRGB", b"iCCP", b"sBIT",
    b"bKGD", b"pHYs",
];

fn png(b: &[u8], text: &mut Vec<String>) -> Result<Image, Refused> {
    let inv = |d: &str| bad::<Image>("upload.image-invalid", format!("PNG: {d}"));
    if b.len() < 45 {
        return inv("too short");
    }
    let (mut p, mut w, mut h, mut ended, mut palette, mut idat) = (8, 0, 0, false, false, false);
    let mut color = 0;
    let mut drop = Vec::new();
    while p < b.len() {
        if p + 12 > b.len() {
            return inv("a truncated chunk");
        }
        let n = be32(b, p) as usize;
        let ty: [u8; 4] = b[p + 4..p + 8].try_into().expect("four bytes");
        let end = p + 12 + n;
        if n > 0x7fff_ffff || end > b.len() {
            return inv("a truncated chunk");
        }
        if !ty.iter().all(u8::is_ascii_alphabetic) {
            return inv("a chunk type that is not letters");
        }
        if crc32(&b[p + 4..p + 8 + n]) as u64 != be32(b, p + 8 + n) {
            return inv("a bad checksum");
        }
        if p == 8 {
            if &ty != b"IHDR" || n != 13 {
                return inv("no header first");
            }
            (w, h) = (be32(b, p + 8), be32(b, p + 12));
            let (depth, interlace) = (b[p + 16], b[p + 20]);
            color = b[p + 17];
            let ok = match color {
                0 => [1, 2, 4, 8, 16].contains(&depth),
                2 | 4 | 6 => [8, 16].contains(&depth),
                3 => [1, 2, 4, 8].contains(&depth),
                _ => false,
            };
            if w == 0 || h == 0 {
                return inv("no pixels");
            }
            if !ok || b[p + 18] != 0 || b[p + 19] != 0 || interlace > 1 {
                return bad("upload.image-format", "an unsupported PNG pixel layout");
            }
        } else if &ty == b"IHDR" {
            return inv("a second header");
        }
        palette |= &ty == b"PLTE";
        idat |= &ty == b"IDAT";
        if !PNG_KEEP.contains(&&ty) {
            if ty[0].is_ascii_uppercase() {
                return bad("upload.image-format", "an unknown critical PNG chunk");
            }
            if [b"tEXt", b"zTXt", b"iTXt"].contains(&&ty) {
                note(text, &printable(&b[p + 8..p + 8 + n]));
            }
            drop.push((p, end));
        }
        p = end;
        if &ty == b"IEND" {
            ended = true;
            break;
        }
    }
    if !ended || !idat || (color == 3 && !palette) {
        return inv("incomplete");
    }
    let trailer = (p < b.len()).then_some(p);
    if let Some(t) = trailer {
        drop.push((t, b.len()));
    }
    Ok(Image {
        w,
        h,
        drop,
        trailer,
        format: Format::Png,
    })
}

/// Inflates a checked PNG's pixel data to at most the size its header declares (twice that when interlaced).
fn inflate_png(b: &[u8], img: &Image) -> Result<(), Refused> {
    let (depth, color, interlace) = (b[24] as u64, b[25], b[28]);
    let channels: u64 = match color {
        0 | 3 => 1,
        2 => 3,
        4 => 2,
        _ => 4,
    };
    let stride = (img.w * channels * depth).div_ceil(8) + 1;
    let expected = img.h * stride;
    let cap = if interlace == 1 {
        expected * 2
    } else {
        expected
    };
    let mut data = Vec::new();
    let mut p = 8;
    while p + 12 <= b.len() {
        let n = be32(b, p) as usize;
        if &b[p + 4..p + 8] == b"IDAT" {
            data.extend_from_slice(&b[p + 8..p + 8 + n]);
        }
        if &b[p + 4..p + 8] == b"IEND" {
            break;
        }
        p += 12 + n;
    }
    let pixels = miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(&data, cap as usize)
        .or_else(|_| bad("upload.image-invalid", "PNG: bad or excessive pixel data"))?;
    if interlace == 0 && pixels.len() as u64 != expected {
        return bad(
            "upload.image-invalid",
            "PNG: pixel data does not match its size",
        );
    }
    Ok(())
}

fn jpeg(b: &[u8], text: &mut Vec<String>) -> Result<Image, Refused> {
    let inv = |d: &str| bad::<Image>("upload.image-invalid", format!("JPEG: {d}"));
    let (mut p, mut w, mut h, mut sos) = (2, 0, 0, None);
    let mut drop = Vec::new();
    while p < b.len() {
        if b[p] != 0xff {
            return inv("a bad marker");
        }
        while p < b.len() && b[p] == 0xff {
            p += 1;
        }
        let Some(&marker) = b.get(p) else {
            return inv("a truncated marker");
        };
        p += 1;
        if [0x00, 0xd8, 0xd9].contains(&marker) || (0xd0..=0xd7).contains(&marker) {
            return inv("segments out of order");
        }
        if p + 2 > b.len() {
            return inv("a truncated segment");
        }
        let (n, start) = (be16(b, p), p - 2);
        let end = p + n;
        if n < 2 || end > b.len() {
            return inv("a truncated segment");
        }
        if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
            if n < 8 {
                return inv("a bad frame");
            }
            if ![0xc0, 0xc1, 0xc2].contains(&marker) {
                return bad(
                    "upload.image-format",
                    "only baseline, extended and progressive JPEG",
                );
            }
            (h, w) = (be16(b, p + 3) as u64, be16(b, p + 5) as u64);
            if w == 0 || h == 0 {
                return inv("no pixels");
            }
        }
        let app = (0xe0..=0xef).contains(&marker);
        let icc = marker == 0xe2 && b[p + 2..end].starts_with(b"ICC_PROFILE\0");
        if (app && marker != 0xe0 && marker != 0xee && !icc) || marker == 0xfe {
            note(text, &printable(&b[p + 2..end]));
            drop.push((start, end));
        }
        p = end;
        if marker == 0xda {
            sos = Some(p);
            break;
        }
    }
    let Some(sos) = sos else {
        return inv("no scan");
    };
    if w == 0 {
        return inv("no frame");
    }
    let Some(eoi) = (sos..b.len().saturating_sub(1))
        .rev()
        .find(|&i| b[i] == 0xff && b[i + 1] == 0xd9)
        .map(|i| i + 2)
    else {
        return inv("no end marker");
    };
    let trailer = (eoi < b.len()).then_some(eoi);
    if let Some(t) = trailer {
        drop.push((t, b.len()));
    }
    Ok(Image {
        w,
        h,
        drop,
        trailer,
        format: Format::Jpeg,
    })
}

/// `b` without the `drop` ranges (a standalone image).
fn cut(b: &[u8], drop: &[(usize, usize)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len());
    let mut p = 0;
    let mut sorted = drop.to_vec();
    sorted.sort_unstable();
    for (s, e) in sorted {
        out.extend_from_slice(&b[p..s]);
        p = e;
    }
    out.extend_from_slice(&b[p..]);
    out
}

/// Blanks an embedded image's metadata in place, keeping its length so nothing after it moves: a PNG chunk becomes a
/// private chunk of zeros with a good checksum, a JPEG segment an empty comment, a trailer zeros.
fn blank(b: &mut [u8], img: &Image) {
    for &(s, e) in &img.drop {
        if Some(s) == img.trailer {
            b[s..e].fill(0);
        } else if img.format == Format::Jpeg {
            b[s + 1] = 0xfe;
            b[s + 4..e].fill(0x20);
        } else {
            b[s + 4..s + 8].copy_from_slice(b"zeRo");
            b[s + 8..e - 4].fill(0);
            let c = crc32(&b[s + 4..e - 4]);
            b[e - 4..e].copy_from_slice(&c.to_be_bytes());
        }
    }
}

// ---------------------------------------------------------------- binary glTF

const JSON_CHUNK: usize = 0x4e4f_534a;
const BIN_CHUNK: usize = 0x004e_4942;
/// Mesh compression whose decoded size comes from its stream; refused, not decoded.
const COMPRESSED: [&str; 3] = [
    "KHR_draco_mesh_compression",
    "EXT_meshopt_compression",
    "KHR_meshopt_compression",
];

fn uint(v: Option<&Json>) -> Option<u64> {
    match v {
        Some(Json::Int(n)) => u64::try_from(*n).ok(),
        _ => None,
    }
}

fn list<'a>(j: &'a Json, key: &str) -> Result<&'a [Json], Refused> {
    match j.get(key) {
        None => Ok(&[]),
        Some(Json::Arr(a)) => Ok(a),
        Some(_) => bad("upload.invalid", format!("glTF {key} is not an array")),
    }
}

fn glb(
    input: &[u8],
    limits: &Limits,
    text: &mut Vec<String>,
) -> Result<(Vec<u8>, Measured), Refused> {
    let inv = |d: String| bad::<(Vec<u8>, Measured)>("upload.invalid", format!("GLB: {d}"));
    let b = input;
    if b.len() < 20 {
        return inv("too short".into());
    }
    if le32(b, 4) != 2 {
        return inv("only glTF 2.0".into());
    }
    if le32(b, 8) != b.len() {
        return inv("its length is not the file's".into());
    }
    let (mut p, mut json, mut bin, mut chunks) = (12, None::<(Json, &[u8])>, None::<&[u8]>, 0u64);
    while p < b.len() {
        if p + 8 > b.len() {
            return inv("a truncated chunk header".into());
        }
        let (n, ty) = (le32(b, p), le32(b, p + 4));
        if n % 4 != 0 || p + 8 + n > b.len() {
            return inv("a misaligned or truncated chunk".into());
        }
        let data = &b[p + 8..p + 8 + n];
        if p == 12 && ty != JSON_CHUNK {
            return inv("the first chunk is not JSON".into());
        }
        if ty == JSON_CHUNK {
            if json.is_some() {
                return inv("two JSON chunks".into());
            }
            let s = std::str::from_utf8(data)
                .or_else(|_| inv("JSON that is not UTF-8".into()).map(|_| ""))?;
            let v = json::parse(s).or_else(|e| inv(format!("JSON: {e}")).map(|_| Json::Null))?;
            if v.obj().is_none() {
                return inv("JSON that is not an object".into());
            }
            json = Some((v, data));
        } else if ty == BIN_CHUNK {
            if bin.is_some() {
                return inv("two BIN chunks".into());
            }
            bin = Some(data);
        } else {
            chunks += 1;
        }
        p += 8 + n;
    }
    let Some((mut j, json_text)) = json else {
        return inv("no JSON chunk".into());
    };
    // Every value counted, `extras` removed and its text kept, compression refused, before anything is read.
    let fields = walk(&mut j, limits, text)?;
    if !j
        .get("asset")
        .and_then(|a| a.get("version"))
        .and_then(Json::str)
        .is_some_and(|v| v.starts_with('2'))
    {
        return inv("asset.version is not 2.x".into());
    }
    let buffers = list(&j, "buffers")?;
    for (i, x) in buffers.iter().enumerate() {
        if x.get("uri").is_some() {
            return bad(
                "upload.external-resource",
                format!("buffers.{i} names a file outside: a GLB embeds its data"),
            );
        }
    }
    let images = list(&j, "images")?;
    for (i, x) in images.iter().enumerate() {
        if x.get("uri").is_some() {
            return bad(
                "upload.external-resource",
                format!("images.{i} names a file outside: a GLB embeds its textures"),
            );
        }
    }
    within(
        "upload.texture-count",
        images.len() as u64,
        limits.textures,
        "textures",
    )?;
    if buffers.len() > 1 {
        return inv("more than one buffer".into());
    }
    let bin = bin.unwrap_or(&[]);
    let buffer_len = match buffers.first() {
        Some(x) => uint(x.get("byteLength")).filter(|&n| n <= bin.len() as u64),
        None => Some(0),
    };
    let Some(buffer_len) = buffer_len else {
        return inv("buffers.0 is longer than the BIN chunk".into());
    };
    // Buffer views inside the buffer (the validator's BUFFER_VIEW_TOO_LONG).
    let mut views = Vec::new();
    for (i, v) in list(&j, "bufferViews")?.iter().enumerate() {
        let off = uint(v.get("byteOffset")).unwrap_or(0);
        let (Some(len), Some(0)) = (uint(v.get("byteLength")), uint(v.get("buffer"))) else {
            return inv(format!("bufferViews.{i} is not a view of buffer 0"));
        };
        if off.checked_add(len).is_none_or(|e| e > buffer_len) || len == 0 {
            return inv(format!("bufferViews.{i} lies outside its buffer"));
        }
        views.push((off, len, uint(v.get("byteStride"))));
    }
    // Accessors inside their views (ACCESSOR_TOO_LONG).
    let mut accessors = Vec::new();
    for (i, a) in list(&j, "accessors")?.iter().enumerate() {
        let size = match uint(a.get("componentType")) {
            Some(5120 | 5121) => 1,
            Some(5122 | 5123) => 2,
            Some(5125 | 5126) => 4,
            _ => return inv(format!("accessors.{i} has no known component type")),
        };
        let parts = match a.get("type").and_then(Json::str) {
            Some("SCALAR") => 1,
            Some("VEC2") => 2,
            Some("VEC3") => 3,
            Some("VEC4" | "MAT2") => 4,
            Some("MAT3") => 9,
            Some("MAT4") => 16,
            _ => return inv(format!("accessors.{i} has no known type")),
        };
        let Some(count) = uint(a.get("count")).filter(|&c| c > 0) else {
            return inv(format!("accessors.{i} has no count"));
        };
        if a.get("sparse").is_some() {
            return inv(format!("accessors.{i} is sparse, which is not taken"));
        }
        let view = match uint(a.get("bufferView")) {
            None => None,
            Some(v) => {
                let Some(&(off, len, stride)) = views.get(v as usize) else {
                    return inv(format!("accessors.{i} names a missing view"));
                };
                let elem = size * parts;
                let stride = stride.unwrap_or(elem);
                let start = uint(a.get("byteOffset")).unwrap_or(0);
                let need = (count - 1)
                    .checked_mul(stride)
                    .and_then(|x| x.checked_add(start)?.checked_add(elem));
                if need.is_none_or(|n| n > len) {
                    return inv(format!("accessors.{i} runs past its view"));
                }
                Some((off + start, stride, size))
            }
        };
        accessors.push((count, view));
    }
    // Triangles, and every index below its vertex count (ACCESSOR_INDEX_OOB).
    let mut m = Measured {
        stripped: fields + chunks,
        ..Measured::default()
    };
    for (mi, mesh) in list(&j, "meshes")?.iter().enumerate() {
        for (k, prim) in list(mesh, "primitives")?.iter().enumerate() {
            let at = format!("meshes.{mi}.primitives.{k}");
            let mode = match prim.get("mode") {
                None => 4,
                Some(v) => uint(Some(v)).filter(|&m| m <= 6).ok_or_else(|| Refused {
                    code: "upload.invalid",
                    measured: None,
                    limit: None,
                    detail: format!("GLB: {at}.mode is not a glTF mode"),
                })?,
            };
            let pos = prim.get("attributes").and_then(|a| uint(a.get("POSITION")));
            let Some(&(vertices, _)) = pos.and_then(|p| accessors.get(p as usize)) else {
                return inv(format!("{at} has no position accessor"));
            };
            let counted = match uint(prim.get("indices")) {
                None => vertices,
                Some(ix) => {
                    let Some(&(n, view)) = accessors.get(ix as usize) else {
                        return inv(format!("{at} names a missing index accessor"));
                    };
                    if let Some((start, stride, size)) = view {
                        for e in 0..n {
                            let o = (start + e * stride) as usize;
                            let ix = match size {
                                1 => bin[o] as u64,
                                2 => u16::from_le_bytes([bin[o], bin[o + 1]]) as u64,
                                _ => le32(bin, o) as u64,
                            };
                            if ix >= vertices {
                                return inv(format!("{at} has index {ix} of {vertices} vertices"));
                            }
                        }
                    }
                    n
                }
            };
            m.triangles += match mode {
                4 => counted / 3,
                5 | 6 => counted.saturating_sub(2),
                _ => 0,
            };
            within(
                "upload.triangle-budget",
                m.triangles,
                limits.triangles,
                "triangles",
            )?;
        }
    }
    // Embedded textures: in the BIN chunk, PNG or JPEG, within the limits, their metadata blanked in place.
    let mut out = bin.to_vec();
    let mut trims: Vec<(usize, u64)> = Vec::new();
    for (i, im) in images.iter().enumerate() {
        let Some(&(off, len, _)) = uint(im.get("bufferView")).and_then(|v| views.get(v as usize))
        else {
            return inv(format!("images.{i} names no view of the BIN chunk"));
        };
        let (s, e) = (off as usize, (off + len) as usize);
        let img = image(
            &out[s..e],
            im.get("mimeType").and_then(Json::str),
            limits,
            text,
        )?;
        m.add(&img, limits)?;
        blank(&mut out[s..e], &img);
        m.stripped += img.drop.len() as u64;
        if let Some(t) = img.trailer {
            trims.push((uint(im.get("bufferView")).unwrap_or(0) as usize, t as u64));
        }
    }
    if m.stripped == 0 {
        return Ok((input.to_vec(), m));
    }
    // An image's trailer stays outside its view.
    let rewrite = fields > 0 || !trims.is_empty();
    if !trims.is_empty()
        && let Some(Json::Arr(vs)) = obj_get_mut(&mut j, "bufferViews")
    {
        for (v, len) in trims {
            if let Some(Json::Obj(o)) = vs.get_mut(v) {
                for (k, x) in o.iter_mut() {
                    if k == "byteLength" {
                        *x = Json::Int(len as i128);
                    }
                }
            }
        }
    }
    let raw = if rewrite {
        j.to_json().into_bytes()
    } else {
        json_text.to_vec()
    };
    let jlen = raw.len().next_multiple_of(4);
    let blen = out.len().next_multiple_of(4);
    let total = 12 + 8 + jlen + if out.is_empty() { 0 } else { 8 + blen };
    let mut o = Vec::with_capacity(total);
    o.extend_from_slice(b"glTF");
    o.extend_from_slice(&2u32.to_le_bytes());
    o.extend_from_slice(&(total as u32).to_le_bytes());
    o.extend_from_slice(&(jlen as u32).to_le_bytes());
    o.extend_from_slice(&(JSON_CHUNK as u32).to_le_bytes());
    o.extend_from_slice(&raw);
    o.resize(20 + jlen, b' ');
    if !out.is_empty() {
        o.extend_from_slice(&(blen as u32).to_le_bytes());
        o.extend_from_slice(&(BIN_CHUNK as u32).to_le_bytes());
        o.extend_from_slice(&out);
        o.resize(total, 0);
    }
    Ok((o, m))
}

fn obj_get_mut<'a>(j: &'a mut Json, key: &str) -> Option<&'a mut Json> {
    match j {
        Json::Obj(o) => o.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

/// Walks every JSON value without recursion: counts them against the limit, removes each `extras` (its text noted)
/// and refuses compressed meshes. Returns how many `extras` it removed.
fn walk(root: &mut Json, limits: &Limits, text: &mut Vec<String>) -> Result<u64, Refused> {
    let (mut seen, mut removed) = (0u64, 0u64);
    let mut stack: Vec<&mut Json> = vec![root];
    while let Some(v) = stack.pop() {
        seen += 1;
        within(
            "upload.too-complex",
            seen,
            limits.json_values,
            "glTF JSON values",
        )?;
        match v {
            Json::Arr(a) => stack.extend(a.iter_mut()),
            Json::Obj(o) => {
                if let Some(c) = o.iter().find(|(k, _)| COMPRESSED.contains(&k.as_str())) {
                    return bad(
                        "upload.compressed-mesh",
                        format!("{} is refused: its size comes from its stream", c.0),
                    );
                }
                for (k, x) in o.iter() {
                    if (k == "extensionsUsed" || k == "extensionsRequired")
                        && let Some(c) = x
                            .arr()
                            .into_iter()
                            .flatten()
                            .filter_map(Json::str)
                            .find(|s| COMPRESSED.contains(s))
                    {
                        return bad(
                            "upload.compressed-mesh",
                            format!("{c} is refused: its size comes from its stream"),
                        );
                    }
                }
                let before = o.len();
                o.retain(|(k, x)| {
                    if k == "extras" {
                        note(text, &x.to_json().chars().take(512).collect::<String>());
                        false
                    } else {
                        true
                    }
                });
                removed += (before - o.len()) as u64;
                stack.extend(o.iter_mut().map(|(_, x)| x));
            }
            _ => {}
        }
    }
    Ok(removed)
}
