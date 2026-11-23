//! Replacing a file so that a crash or a power cut leaves the old one or the new one, never a short one (B1-7): the
//! bytes are written whole under a temporary name and synced, renamed over the file, and the folder is synced so the
//! rename itself is on the disk (as `sim::checkpoint` writes its checkpoints).

use std::io::Write;
use std::path::Path;

/// Writes `bytes` to `tmp`, syncs it, renames it to `path` and syncs `path`'s folder.
pub fn replace(path: &Path, tmp: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut f = std::fs::File::create(tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(tmp, path)?;
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::File::open(dir)?.sync_all()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_replaced_file_holds_the_whole_new_bytes_and_no_temporary_is_left() {
        let dir = std::env::temp_dir().join(format!("directoryd-durable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (path, tmp) = (dir.join("tokens"), dir.join("tokens.tmp"));
        std::fs::write(&path, "the old line\n").unwrap();
        let new = "soul-a 01\nsoul-b 02\n".repeat(1000);
        replace(&path, &tmp, new.as_bytes()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), new);
        assert!(!tmp.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
