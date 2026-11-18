//! The scan (Engine v2 W1, #2704): every byte of every file under the given paths, searched for each identity (an
//! account id, a provider subject, an email) in the forms it could take there: as written, in lower and upper case,
//! in hex and in base64 (standard and URL alphabets, at each of the three byte alignments). A hit names the file, the
//! offset, the identity's index and the form, never the identity itself, so a report can be posted.

use std::path::{Path, PathBuf};

/// Identities shorter than this match by chance; the scan refuses them.
pub const SHORTEST: usize = 6;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub path: PathBuf,
    pub offset: usize,
    /// The identity's index in the list given.
    pub needle: usize,
    pub form: &'static str,
}

#[derive(Debug, Default)]
pub struct Report {
    pub files: u64,
    pub bytes: u64,
    pub forms: u64,
    pub hits: Vec<Hit>,
}

const STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// The base64 characters that depend on `bytes` alone when they start `skip` bytes into a 3-byte group.
fn b64_inner(bytes: &[u8], skip: usize, alphabet: &[u8; 64]) -> Vec<u8> {
    let mut all = vec![0u8; skip];
    all.extend_from_slice(bytes);
    let mut chars = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for b in &all {
        acc = (acc << 8) | u32::from(*b);
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            chars.push(alphabet[((acc >> bits) & 63) as usize]);
        }
        acc &= (1 << bits) - 1;
    }
    // A character holding any bit of the `skip` filler bytes is left out.
    chars.split_off((skip * 8).div_ceil(6))
}

/// Each form an identity is searched in, by name.
pub fn forms(raw: &[u8]) -> Vec<(&'static str, Vec<u8>)> {
    let hex: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let mut out = vec![
        ("as-written", raw.to_vec()),
        ("lower", raw.to_ascii_lowercase()),
        ("upper", raw.to_ascii_uppercase()),
        ("hex", hex.clone().into_bytes()),
        ("hex-upper", hex.to_ascii_uppercase().into_bytes()),
    ];
    for (name, alphabet) in [("base64", STD), ("base64url", URL)] {
        for skip in 0..3 {
            out.push((name, b64_inner(raw, skip, alphabet)));
        }
    }
    let mut seen: Vec<Vec<u8>> = Vec::new();
    out.retain(|(_, f)| {
        let new = !seen.contains(f);
        seen.push(f.clone());
        new
    });
    out
}

fn files(path: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    if path.is_dir() {
        let mut entries: Vec<_> = std::fs::read_dir(path)?.collect::<Result<_, _>>()?;
        entries.sort_by_key(|e| e.path());
        for e in entries {
            files(&e.path(), out)?;
        }
    } else {
        out.push(path.to_path_buf());
    }
    Ok(())
}

/// Scans every file under `paths` for every form of every identity in `needles`.
pub fn scan(paths: &[PathBuf], needles: &[Vec<u8>]) -> Result<Report, String> {
    if let Some(n) = needles.iter().find(|n| n.len() < SHORTEST) {
        return Err(format!(
            "an identity of {} bytes is shorter than {SHORTEST}",
            n.len()
        ));
    }
    let forms: Vec<Vec<(&'static str, Vec<u8>)>> = needles.iter().map(|n| forms(n)).collect();
    let mut all = Vec::new();
    for p in paths {
        files(p, &mut all).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    let mut report = Report {
        forms: forms.iter().map(|f| f.len() as u64).sum(),
        ..Report::default()
    };
    for path in all {
        let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        report.files += 1;
        report.bytes += bytes.len() as u64;
        for (needle, fs) in forms.iter().enumerate() {
            for (form, pattern) in fs {
                if pattern.len() < SHORTEST {
                    continue;
                }
                for offset in find_all(&bytes, pattern) {
                    report.hits.push(Hit {
                        path: path.clone(),
                        offset,
                        needle,
                        form,
                    });
                }
            }
        }
    }
    Ok(report)
}

fn find_all(hay: &[u8], pattern: &[u8]) -> Vec<usize> {
    hay.windows(pattern.len())
        .enumerate()
        .filter(|(_, w)| *w == pattern)
        .map(|(i, _)| i)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_forms_match_at_every_alignment() {
        // "ab" + the identity + "z", at three offsets into a 3-byte group, in both alphabets.
        let id = b"user_2Nq?>x";
        let std_forms: Vec<Vec<u8>> = forms(id)
            .into_iter()
            .filter(|(n, _)| *n == "base64")
            .map(|(_, f)| f)
            .collect();
        for lead in ["", "a", "ab"] {
            let text = [lead.as_bytes(), id, b"z"].concat();
            let enc = b64_inner(&text, 0, STD);
            assert!(
                std_forms.iter().any(|f| !find_all(&enc, f).is_empty()),
                "lead {lead:?}"
            );
        }
    }

    #[test]
    fn short_identities_are_refused() {
        assert!(scan(&[], &[b"abc".to_vec()]).is_err());
    }
}
