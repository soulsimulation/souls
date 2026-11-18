//! The log's bytes: a header naming the epoch, then records, each `[length, previous checksum, checksum, T6 bytes]`,
//! the checksum CRC-32C over the header's own checksum (the salt), the length, the previous checksum and the bytes.
//! Recovery reads forward and tells a torn tail from damage before it (`v2/crates/sim/src/log/mod.rs`, rules 2 to 4).

use replica::effects::Refusal;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// The header's length in bytes: `souls-lg`, version, zero, epoch, zero, checksum of the 28 before it.
pub const HEADER_LEN: usize = 32;
/// A record's head: length, previous checksum, checksum (each `u32`, little-endian).
pub const HEAD_LEN: usize = 12;
/// The longest record the log takes (`record-too-long` above it).
pub const MAX_RECORD: usize = 64 << 20;
const MAGIC: &[u8; 8] = b"souls-lg";
const VERSION: u32 = 1;

const fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                (c >> 1) ^ 0x82F6_3B78
            } else {
                c >> 1
            };
            k += 1;
        }
        t[i] = c;
        i += 1;
    }
    t
}

static CRC_TABLE: [u32; 256] = crc_table();

/// CRC-32C (Castagnoli), continued from `crc` (0 to start).
pub fn crc32c(crc: u32, bytes: &[u8]) -> u32 {
    let mut c = !crc;
    for &b in bytes {
        c = CRC_TABLE[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    !c
}

/// A log's header: its epoch (T11 rule 4), and its checksum, which salts every record's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    pub epoch: u64,
    pub salt: u32,
}

impl Header {
    pub fn new(epoch: u64) -> Header {
        let b = Header::fields(epoch);
        Header {
            epoch,
            salt: crc32c(0, &b),
        }
    }

    fn fields(epoch: u64) -> [u8; 28] {
        let mut b = [0u8; 28];
        b[..8].copy_from_slice(MAGIC);
        b[8..12].copy_from_slice(&VERSION.to_le_bytes());
        b[16..24].copy_from_slice(&epoch.to_le_bytes());
        b
    }

    pub fn to_bytes(self) -> [u8; HEADER_LEN] {
        let mut b = [0u8; HEADER_LEN];
        b[..28].copy_from_slice(&Header::fields(self.epoch));
        b[28..].copy_from_slice(&self.salt.to_le_bytes());
        b
    }
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn record_crc(salt: u32, len: u32, prev: u32, payload: &[u8]) -> u32 {
    let mut c = crc32c(0, &salt.to_le_bytes());
    c = crc32c(c, &len.to_le_bytes());
    c = crc32c(c, &prev.to_le_bytes());
    crc32c(c, payload)
}

/// Appends one record to `out`, chained from `prev`; returns its checksum, the next record's `prev`.
pub fn encode_record(out: &mut Vec<u8>, salt: u32, prev: u32, payload: &[u8]) -> R<u32> {
    if payload.is_empty() {
        return refuse("record-empty", "a record holds at least one byte");
    }
    if payload.len() > MAX_RECORD {
        return refuse(
            "record-too-long",
            format!("{} bytes over {MAX_RECORD}", payload.len()),
        );
    }
    let len = payload.len() as u32;
    let crc = record_crc(salt, len, prev, payload);
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&prev.to_le_bytes());
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(payload);
    Ok(crc)
}

/// A record that checks by itself at `at` (its length fits and its checksum matches under `salt`):
/// `(payload length, prev, crc)`. Its place in the chain is checked by the caller.
fn check(b: &[u8], at: usize, salt: u32) -> Option<(usize, u32, u32)> {
    if at + HEAD_LEN > b.len() {
        return None;
    }
    let len = u32_at(b, at) as usize;
    if len == 0 || len > MAX_RECORD || at + HEAD_LEN + len > b.len() {
        return None;
    }
    let prev = u32_at(b, at + 4);
    let crc = u32_at(b, at + 8);
    let payload = &b[at + HEAD_LEN..at + HEAD_LEN + len];
    (record_crc(salt, len as u32, prev, payload) == crc).then_some((len, prev, crc))
}

/// A torn tail: the bytes from `at` to the end hold no whole record and nothing valid follows them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Torn {
    /// Where the cut record starts; the log is cut back to here.
    pub at: usize,
    /// How many bytes are dropped.
    pub dropped: usize,
}

/// What recovery found: the header (none for an empty log, or a header cut before it was whole), the records in
/// order, where the valid log ends, the last record's checksum, and a torn tail if there was one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recovered {
    pub header: Option<Header>,
    pub records: Vec<Vec<u8>>,
    pub end: usize,
    pub last_crc: u32,
    pub torn: Option<Torn>,
}

/// Reads a log forward. A record that does not check, with nothing valid after it, is a torn tail (reported, to be
/// cut). A record that does not check with a valid record anywhere after it, a valid record whose chain is broken,
/// or a damaged header, is corruption: refused by name (`log-corrupt`, `log-header-bad`) and never trimmed.
pub fn recover(b: &[u8]) -> R<Recovered> {
    let epoch =
        (b.len() >= HEADER_LEN).then(|| u64::from_le_bytes(b[16..24].try_into().expect("8 bytes")));
    let whole = epoch.is_some_and(|e| b[..HEADER_LEN] == Header::new(e).to_bytes());
    if !whole && b.len() <= HEADER_LEN {
        // A header is written and synced before any record, so a header that does not check with nothing after it
        // is one cut while being written: a torn tail of an empty log.
        return Ok(Recovered {
            header: None,
            records: Vec::new(),
            end: 0,
            last_crc: 0,
            torn: (!b.is_empty()).then_some(Torn {
                at: 0,
                dropped: b.len(),
            }),
        });
    }
    if !whole {
        return refuse(
            "log-header-bad",
            "the header does not check (magic, version or checksum) and bytes follow it; the log is left as it is",
        );
    }
    let header = Header::new(epoch.expect("whole"));
    let salt = header.salt;
    let (mut at, mut prev) = (HEADER_LEN, salt);
    let mut records = Vec::new();
    while at < b.len() {
        match check(b, at, salt) {
            Some((len, p, crc)) if p == prev => {
                records.push(b[at + HEAD_LEN..at + HEAD_LEN + len].to_vec());
                prev = crc;
                at += HEAD_LEN + len;
            }
            Some(_) => {
                return refuse(
                    "log-corrupt",
                    format!(
                        "record {} at byte {at} checks but does not follow record {} (a record is missing or moved)",
                        records.len(),
                        records.len().wrapping_sub(1)
                    ),
                );
            }
            None => {
                if let Some(q) = (at + 1..b.len()).find(|&q| check(b, q, salt).is_some()) {
                    return refuse(
                        "log-corrupt",
                        format!(
                            "record {} at byte {at} is damaged and a valid record follows at byte {q}",
                            records.len()
                        ),
                    );
                }
                return Ok(Recovered {
                    header: Some(header),
                    records,
                    end: at,
                    last_crc: prev,
                    torn: Some(Torn {
                        at,
                        dropped: b.len() - at,
                    }),
                });
            }
        }
    }
    Ok(Recovered {
        header: Some(header),
        records,
        end: at,
        last_crc: prev,
        torn: None,
    })
}
