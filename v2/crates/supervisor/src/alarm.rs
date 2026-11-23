//! The alarm record (Engine v2 O2, #2731): each sleeping world's next due change, in the directory, so a sleep
//! survives a supervisor restart and a reboot.
//!
//! One object per machine, `alarms/<machine>`, a line per world: `<world> <due µs from the Unix epoch>`, or
//! `<world> none` for a world asleep with nothing due (it wakes only for an intent). The machine's alarm daemon
//! ([`crate::wake`]) is its one writer: a world asks the daemon to set its alarm and sleeps only once the write is
//! acknowledged. Each write is conditional on the version last read (the store's `If-Match`), so a second writer
//! is refused by name, never silently lost.

use std::collections::BTreeMap;

use directoryd::directory::store::{Store, When};

/// Each world's alarm: its next due time (µs from the Unix epoch), or `None` for nothing due.
pub type Alarms = BTreeMap<String, Option<i64>>;

/// The record's key for `machine`.
pub fn key(machine: &str) -> String {
    format!("alarms/{machine}")
}

/// Reads a record's bytes.
pub fn read(bytes: &[u8]) -> Result<Alarms, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "alarms: not text".to_owned())?;
    let mut out = Alarms::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let (world, due) = line
            .split_once(' ')
            .ok_or_else(|| format!("alarms: {line:?}"))?;
        let due = match due {
            "none" => None,
            d => Some(d.parse().map_err(|_| format!("alarms: {line:?}"))?),
        };
        out.insert(world.to_owned(), due);
    }
    Ok(out)
}

/// A record's bytes.
pub fn write(alarms: &Alarms) -> Vec<u8> {
    let mut out = String::new();
    for (world, due) in alarms {
        match due {
            Some(d) => out.push_str(&format!("{world} {d}\n")),
            None => out.push_str(&format!("{world} none\n")),
        }
    }
    out.into_bytes()
}

/// A machine's alarm record as last read or written, with the version a write is conditional on.
pub struct Record<S: Store> {
    store: S,
    key: String,
    etag: Option<String>,
    pub alarms: Alarms,
}

impl<S: Store> Record<S> {
    /// Reads `machine`'s record; none yet is an empty one.
    pub fn load(store: S, machine: &str) -> Result<Record<S>, String> {
        let key = key(machine);
        let (etag, alarms) = match store
            .get(&key)
            .map_err(|r| format!("{}: {}", r.name, r.detail))?
        {
            Some(o) => (Some(o.etag), read(&o.bytes)?),
            None => (None, Alarms::new()),
        };
        Ok(Record {
            store,
            key,
            etag,
            alarms,
        })
    }

    /// Sets `world`'s alarm and writes the record. Not written is not set: the world stays awake.
    pub fn set(&mut self, world: &str, due: Option<i64>) -> Result<(), String> {
        let mut next = self.alarms.clone();
        next.insert(world.to_owned(), due);
        let bytes = write(&next);
        let when = match &self.etag {
            Some(e) => When::Is(e),
            None => When::Absent,
        };
        let etag = self
            .store
            .put(&self.key, &bytes, when)
            .map_err(|r| format!("{}: {}", r.name, r.detail))?;
        self.etag = Some(etag);
        self.alarms = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use directoryd::directory::store::Memory;

    #[test]
    fn a_record_reads_back_and_survives_a_new_reader() {
        let store = Memory::default();
        let mut r = Record::load(&store, "m").expect("loaded");
        r.set("a", Some(5_000_000)).expect("set");
        r.set("b", None).expect("set");
        r.set("a", Some(7_000_000)).expect("set again");
        // A restarted daemon reads what was written.
        let again = Record::load(&store, "m").expect("loaded");
        assert_eq!(
            again.alarms,
            Alarms::from([("a".into(), Some(7_000_000)), ("b".into(), None)])
        );
    }

    #[test]
    fn a_second_writer_is_refused_not_lost() {
        let store = Memory::default();
        let mut one = Record::load(&store, "m").expect("loaded");
        let mut two = Record::load(&store, "m").expect("loaded");
        one.set("a", Some(1)).expect("first");
        assert!(
            two.set("b", Some(2))
                .unwrap_err()
                .starts_with("precondition-failed")
        );
        let store_alarms = Record::load(&store, "m").expect("loaded").alarms;
        assert_eq!(store_alarms, Alarms::from([("a".into(), Some(1))]));
    }

    #[test]
    fn an_unreachable_store_sets_nothing() {
        let store = Memory::default();
        let mut r = Record::load(&store, "m").expect("loaded");
        store.set_reachable(false);
        assert!(r.set("a", Some(1)).is_err());
        assert!(r.alarms.is_empty());
    }
}
