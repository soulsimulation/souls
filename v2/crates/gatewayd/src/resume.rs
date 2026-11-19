//! Resuming a stream from a cursor (Engine v2 I1, #2683). A client's cursor is the last version it applied, a T3
//! version `[lineage, zone, epoch, sequence]` (`v2/docs/ids.md` rule 8). For each grant the gateway keeps the last
//! [`KEPT`] frames the world sent it, each with its version. A client that signs in with a cursor gets every kept frame
//! after it, or is told by name ([`CANNOT_RESUME`]) that it cannot and must start again: when the cursor is from
//! another lineage or zone, from another epoch than the newest frame (R5, #2699: a superseded writer may have sent
//! what the next one never kept, so the client compares from the top, `replica::sync`), older than a frame already
//! let go, newer than anything sent, or when the gateway holds nothing for the grant (it restarted). Resume by cursor
//! with a plain "start again" is Discord's gateway design.
//!
//! Several frames can share a version: a refusal does not move it, nor do two answers in one tick. So a client also
//! says how many frames it applied at its cursor's version (`seen`, 1 when it does not say), and gets the rest of
//! them before the frames after its cursor. Without the count a refusal at the cursor's version was never replayed,
//! and an agent that dropped before it arrived waited for it forever.

use std::collections::VecDeque;

use replica::encode::Value;

/// Frames kept per grant.
pub const KEPT: usize = 256;

/// Told to a client whose cursor cannot be resumed from: it must fetch its state again and start a new stream.
pub const CANNOT_RESUME: &str = "stream.cannot-resume";
/// Told to a client that resumed: the kept frames after its cursor follow.
pub const RESUMED: &str = "stream.resumed";
/// Told to a client that gave no cursor: its stream starts now.
pub const STARTED: &str = "stream.started";

/// A version as the stream orders it: frames of one lineage and zone, ordered by (epoch, sequence).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cursor {
    /// The lineage and zone, as their bytes in the version.
    pub place: (Value, Value),
    pub epoch: u64,
    pub sequence: u64,
}

impl Cursor {
    /// Reads a version value; `None` if it is not `[lineage, zone, epoch, sequence]`.
    pub fn from_value(v: &Value) -> Option<Cursor> {
        let Value::Array(a) = v else { return None };
        match a.as_slice() {
            [
                lineage @ Value::Bytes(_),
                zone @ Value::Array(_),
                Value::Uint(e),
                Value::Uint(s),
            ] => Some(Cursor {
                place: (lineage.clone(), zone.clone()),
                epoch: *e,
                sequence: *s,
            }),
            _ => None,
        }
    }

    fn after(&self, other: &Cursor) -> bool {
        (self.epoch, self.sequence) > (other.epoch, other.sequence)
    }

    fn at(&self, other: &Cursor) -> bool {
        (self.epoch, self.sequence) == (other.epoch, other.sequence)
    }
}

/// What a client signing in with a cursor gets.
#[derive(Debug, PartialEq, Eq)]
pub enum Resume {
    /// The frames after its cursor, oldest first (possibly none).
    Resumed(Vec<Vec<u8>>),
    /// It must start again.
    CannotResume,
}

/// One grant's kept frames.
#[derive(Default)]
pub struct Kept {
    frames: VecDeque<(Cursor, Vec<u8>)>,
    /// The version of the newest frame let go, if any was, and how many frames at that version were let go.
    dropped: Option<(Cursor, usize)>,
}

impl Kept {
    /// Keeps a frame the world sent, with its version.
    pub fn push(&mut self, at: Cursor, frame: Vec<u8>) {
        if self
            .frames
            .front()
            .is_some_and(|(c, _)| c.place != at.place)
        {
            // Another lineage or zone: nothing kept before it can be resumed into it.
            while let Some((c, _)) = self.frames.pop_front() {
                self.let_go(c);
            }
        }
        if self.frames.len() == KEPT
            && let Some((c, _)) = self.frames.pop_front()
        {
            self.let_go(c);
        }
        self.frames.push_back((at, frame));
    }

    fn let_go(&mut self, c: Cursor) {
        let n = match &self.dropped {
            Some((d, n)) if d.place == c.place && d.at(&c) => n + 1,
            _ => 1,
        };
        self.dropped = Some((c, n));
    }

    /// The frames a client has not applied: those at `cursor` after the first `seen` of them, then those after it;
    /// or [`Resume::CannotResume`], also when one of them was let go.
    pub fn resume(&self, cursor: &Cursor, seen: usize) -> Resume {
        let Some((newest, _)) = self.frames.back() else {
            return Resume::CannotResume;
        };
        let let_go_at_cursor = match &self.dropped {
            Some((d, _)) if d.after(cursor) => return Resume::CannotResume,
            Some((d, n)) if d.at(cursor) => *n,
            _ => 0,
        };
        if newest.place != cursor.place
            || newest.epoch != cursor.epoch
            || cursor.after(newest)
            || seen < let_go_at_cursor
        {
            return Resume::CannotResume;
        }
        let mut skip = seen - let_go_at_cursor;
        let mut frames = Vec::new();
        for (c, f) in &self.frames {
            if c.at(cursor) && skip > 0 {
                skip -= 1;
            } else if c.at(cursor) || c.after(cursor) {
                frames.push(f.clone());
            }
        }
        Resume::Resumed(frames)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(epoch: u64, sequence: u64) -> Cursor {
        Cursor {
            place: (
                Value::Bytes(vec![1; 16]),
                Value::Array(vec![Value::Bytes(vec![1; 16]), Value::Uint(0)]),
            ),
            epoch,
            sequence,
        }
    }

    #[test]
    fn a4_resumes_after_the_cursor_within_the_newest_epoch() {
        let mut k = Kept::default();
        for (e, s) in [(1, 1), (1, 2), (2, 3), (2, 4)] {
            k.push(at(e, s), vec![u8::try_from(s).unwrap()]);
        }
        assert_eq!(k.resume(&at(2, 3), 1), Resume::Resumed(vec![vec![4]]));
        assert_eq!(k.resume(&at(2, 4), 1), Resume::Resumed(vec![]));
    }

    #[test]
    fn r5_a3_a_cursor_from_another_epoch_never_resumes() {
        let mut k = Kept::default();
        for (e, s) in [(1, 1), (1, 2), (2, 3), (2, 4)] {
            k.push(at(e, s), vec![u8::try_from(s).unwrap()]);
        }
        assert_eq!(
            k.resume(&at(1, 2), 1),
            Resume::CannotResume,
            "an older epoch"
        );
        assert_eq!(
            k.resume(&at(3, 0), 1),
            Resume::CannotResume,
            "a later epoch"
        );
    }

    #[test]
    fn a4_cannot_resume_from_a_frame_let_go_from_the_future_or_from_nothing() {
        let mut k = Kept::default();
        assert_eq!(k.resume(&at(1, 0), 1), Resume::CannotResume, "nothing kept");
        for s in 0..(KEPT as u64 + 10) {
            k.push(at(1, s), vec![]);
        }
        assert_eq!(k.resume(&at(1, 5), 1), Resume::CannotResume, "let go");
        assert!(matches!(k.resume(&at(1, 9), 1), Resume::Resumed(f) if f.len() == KEPT));
        assert_eq!(k.resume(&at(1, 10_000), 1), Resume::CannotResume, "future");
        let mut other = at(1, 5);
        other.place.0 = Value::Bytes(vec![2; 16]);
        assert_eq!(k.resume(&other, 1), Resume::CannotResume, "another lineage");
    }

    #[test]
    fn frames_sharing_a_version_resume_after_the_ones_seen() {
        let mut k = Kept::default();
        // An answer moves the version to 1; two refusals do not; the next answer moves it to 2.
        for (s, f) in [(1, 1), (1, 2), (1, 3), (2, 4)] {
            k.push(at(1, s), vec![f]);
        }
        assert_eq!(
            k.resume(&at(1, 1), 1),
            Resume::Resumed(vec![vec![2], vec![3], vec![4]])
        );
        assert_eq!(
            k.resume(&at(1, 1), 2),
            Resume::Resumed(vec![vec![3], vec![4]])
        );
        assert_eq!(
            k.resume(&at(1, 1), 0),
            Resume::Resumed(vec![vec![1], vec![2], vec![3], vec![4]])
        );
        assert_eq!(k.resume(&at(1, 1), 9), Resume::Resumed(vec![vec![4]]));
        assert_eq!(k.resume(&at(1, 2), 1), Resume::Resumed(vec![]));
    }

    #[test]
    fn a_frame_not_seen_and_let_go_at_the_cursor_cannot_be_resumed() {
        let mut k = Kept::default();
        // Three frames at version 1, then enough at version 2 to let two of the three go.
        for _ in 0..3 {
            k.push(at(1, 1), vec![1]);
        }
        for _ in 0..(KEPT - 1) {
            k.push(at(1, 2), vec![2]);
        }
        assert_eq!(
            k.resume(&at(1, 1), 1),
            Resume::CannotResume,
            "the second was let go"
        );
        assert!(matches!(k.resume(&at(1, 1), 2), Resume::Resumed(f) if f.len() == KEPT));
        assert!(matches!(k.resume(&at(1, 1), 3), Resume::Resumed(f) if f.len() == KEPT - 1));
    }
}
