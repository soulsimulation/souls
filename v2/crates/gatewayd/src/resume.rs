//! Resuming a stream from a cursor (Engine v2 I1, #2683). A client's cursor is the last version it applied, a T3
//! version `[lineage, zone, epoch, sequence]` (`v2/docs/ids.md` rule 8). For each grant the gateway keeps the last
//! [`KEPT`] frames the world sent it, each with its version. A client that signs in with a cursor gets every kept frame
//! after it, or is told by name ([`CANNOT_RESUME`]) that it cannot and must start again: when the cursor is from
//! another lineage or zone, older than a frame already let go, newer than anything sent, or when the gateway holds
//! nothing for the grant (it restarted). Resume by cursor with a plain "start again" is Discord's gateway design.

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
    /// The version of the newest frame let go, if any was.
    dropped: Option<Cursor>,
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
            self.dropped = self.frames.back().map(|(c, _)| c.clone());
            self.frames.clear();
        }
        if self.frames.len() == KEPT
            && let Some((c, _)) = self.frames.pop_front()
        {
            self.dropped = Some(c);
        }
        self.frames.push_back((at, frame));
    }

    /// The frames after `cursor`, or [`Resume::CannotResume`].
    pub fn resume(&self, cursor: &Cursor) -> Resume {
        let Some((newest, _)) = self.frames.back() else {
            return Resume::CannotResume;
        };
        if newest.place != cursor.place
            || cursor.after(newest)
            || self.dropped.as_ref().is_some_and(|d| d.after(cursor))
        {
            return Resume::CannotResume;
        }
        Resume::Resumed(
            self.frames
                .iter()
                .filter(|(c, _)| c.after(cursor))
                .map(|(_, f)| f.clone())
                .collect(),
        )
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
    fn a4_resumes_after_the_cursor_across_epochs() {
        let mut k = Kept::default();
        for (e, s) in [(1, 1), (1, 2), (2, 3), (2, 4)] {
            k.push(at(e, s), vec![u8::try_from(s).unwrap()]);
        }
        assert_eq!(k.resume(&at(1, 2)), Resume::Resumed(vec![vec![3], vec![4]]));
        assert_eq!(k.resume(&at(2, 4)), Resume::Resumed(vec![]));
    }

    #[test]
    fn a4_cannot_resume_from_a_frame_let_go_from_the_future_or_from_nothing() {
        let mut k = Kept::default();
        assert_eq!(k.resume(&at(1, 0)), Resume::CannotResume, "nothing kept");
        for s in 0..(KEPT as u64 + 10) {
            k.push(at(1, s), vec![]);
        }
        assert_eq!(k.resume(&at(1, 5)), Resume::CannotResume, "let go");
        assert!(matches!(k.resume(&at(1, 9)), Resume::Resumed(f) if f.len() == KEPT));
        assert_eq!(k.resume(&at(1, 10_000)), Resume::CannotResume, "future");
        let mut other = at(1, 5);
        other.place.0 = Value::Bytes(vec![2; 16]);
        assert_eq!(k.resume(&other), Resume::CannotResume, "another lineage");
    }
}
