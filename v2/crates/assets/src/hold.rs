//! The hold point (G6, #2747): after the check, every upload passes one interface that answers allow, hold or
//! reject, as today's hook does (`apps/server/src/moderation/classifier.ts`: allow, quarantine, reject). The only
//! classifier shipped is [`NoClassifier`], `none`, which allows everything. A classifier that fails or runs past its
//! time holds: it never allows. Releasing and removing a held upload are W9's.

use crate::check::Checked;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

/// What a classifier says of an upload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Stored, served and placeable.
    Allow,
    /// Stored, neither served nor placeable until released; the reason is kept.
    Hold(String),
    /// Refused: nothing is stored.
    Reject(String),
}

/// One classifier. It sees the checked file: format, hash, measures, the stripped bytes and the metadata text found
/// before stripping.
pub trait Classifier: Send + Sync {
    fn name(&self) -> &str;
    /// Its verdict, or why it could not give one (which holds).
    fn classify(&self, file: &Checked) -> Result<Verdict, String>;
}

/// `none`: allows everything. The only classifier shipped.
pub struct NoClassifier;

impl Classifier for NoClassifier {
    fn name(&self) -> &str {
        "none"
    }

    fn classify(&self, _: &Checked) -> Result<Verdict, String> {
        Ok(Verdict::Allow)
    }
}

/// How long a classifier may take before the upload is held.
pub const CLASSIFY_WITHIN: Duration = Duration::from_secs(5);

/// The verdict of `classifier` on `file` within `limit`. A classifier that panics, answers an error or runs past
/// `limit` holds the upload. A late answer is dropped with its thread.
pub fn judge(classifier: Arc<dyn Classifier>, file: Arc<Checked>, limit: Duration) -> Verdict {
    let (tx, rx) = mpsc::channel();
    let name = classifier.name().to_owned();
    let spawned = std::thread::Builder::new()
        .name("assets-classify".into())
        .spawn(move || {
            let answer = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                classifier.classify(&file)
            }));
            let _ = tx.send(answer);
        });
    if spawned.is_err() {
        return Verdict::Hold(format!("{name}: could not start"));
    }
    match rx.recv_timeout(limit) {
        Ok(Ok(Ok(v))) => v,
        Ok(Ok(Err(e))) => Verdict::Hold(format!("{name} failed: {e}")),
        Ok(Err(_)) => Verdict::Hold(format!("{name} failed: it panicked")),
        Err(_) => Verdict::Hold(format!("{name} ran past {} ms", limit.as_millis())),
    }
}
