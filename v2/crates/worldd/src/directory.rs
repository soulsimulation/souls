//! The directory's word on Souls, in a running world (Engine v2 W11b, #3511). An owner retires a Soul, or saves its
//! name and description, on its page (W11, `directoryd`'s `pairing::souls`); the directory writes every such word to
//! its Souls file beside the gateway's tokens file, whole, then renamed into place. The world reads it at its start
//! and again whenever it changes ([`watch`]), and at its next tick brings each of its Souls in line with it
//! (`answers`): a retired Soul's body is retired by K10's one path, as its own `life:leave`; a Soul whose saved words
//! differ from its body's gets them as its own `life:describe` (V1b). A Soul with no body here is left alone: the
//! directory never births a body, and a retired Soul's later intents are refused `soul-retired`. A world that was
//! down when the owner retired gets the retire at its next start, since the file holds it.
//!
//! The file, one line each, `#` lines passed over:
//!
//! - `retired <grant>`: the Soul was retired.
//! - `words <grant> <name hex> <description hex>`: its saved words as UTF-8 in hex, `-` for one not saved.
//!
//! A grant is the Soul's, `soul-<scope hex>-<counter>`, as the tokens file names it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::time::Duration;

use replica::encode::{Value, from_hex};
use replica::ids::{Id, Scope};

use crate::answers::{Event, Reply};

/// A Soul's saved words: its name and its one-line description, each as saved, or none.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Words {
    pub name: Option<Vec<u8>>,
    pub description: Option<Vec<u8>>,
}

/// What the directory's file says of the Souls.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Directory {
    pub retired: BTreeSet<Id>,
    pub words: BTreeMap<Id, Words>,
}

impl Directory {
    /// Reads the file's text; a line that does not read is passed over.
    pub fn read(text: &str) -> Directory {
        let mut d = Directory::default();
        for line in text.lines() {
            let mut parts = line.split_whitespace();
            match (parts.next(), parts.next().and_then(soul)) {
                (Some("retired"), Some(s)) => {
                    d.retired.insert(s);
                }
                (Some("words"), Some(s)) => {
                    let mut w = || match parts.next()? {
                        "-" => None,
                        h => from_hex(h).ok(),
                    };
                    let (name, description) = (w(), w());
                    d.words.insert(s, Words { name, description });
                }
                _ => {}
            }
        }
        d
    }

    /// Every Soul the file names.
    pub fn souls(&self) -> impl Iterator<Item = Id> + '_ {
        self.retired.iter().chain(self.words.keys()).copied()
    }
}

/// A Soul's id from its grant, `soul-<scope hex>-<counter>`.
pub fn soul(grant: &str) -> Option<Id> {
    let rest = grant.strip_prefix("soul-")?;
    let (scope, counter) = rest.split_once('-')?;
    let scope: [u8; 16] = from_hex(scope).ok()?.try_into().ok()?;
    Id::new(Scope(scope), counter.parse().ok()?)
}

/// The directory's Souls file beside the gateway's tokens file `tokens`: its name with `.souls` added.
pub fn beside(tokens: &Path) -> PathBuf {
    let mut name = tokens.file_name().unwrap_or_default().to_os_string();
    name.push(".souls");
    tokens.with_file_name(name)
}

/// How often the file is looked at again.
const EVERY: Duration = Duration::from_secs(1);

/// Hands the file at `path` to the world on `events` now, before this returns, when it is there (so it comes before
/// any intent served after), and again from a thread of its own each time it changes, with `answers` where the
/// world's answers to it go. The thread ends once the world has stopped.
pub fn watch(path: PathBuf, events: Sender<Event>, answers: Reply) {
    let send = move |last: &mut Option<String>| {
        let Ok(text) = std::fs::read_to_string(&path) else {
            return true;
        };
        if last.as_deref() == Some(text.as_str()) {
            return true;
        }
        let d = Directory::read(&text);
        *last = Some(text);
        events
            .send(Event::Directory(Box::new((d, answers.clone()))))
            .is_ok()
    };
    let mut last = None;
    if !send(&mut last) {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("directory".into())
        .spawn(move || {
            while send(&mut last) {
                std::thread::sleep(EVERY);
            }
        });
}

/// An answer frame (`{1: version, 2: answer}`) in a few words: `receipt <entries>` or `refused <reason>`.
pub fn show(frame: &[u8]) -> String {
    let a = match replica::encode::decode(frame).map(|d| d.value) {
        Ok(Value::Map(m)) => m.get(&2).cloned(),
        _ => None,
    };
    let Some(Value::Map(a)) = a else {
        return "unread".into();
    };
    match (a.get(&3), a.get(&4), a.get(&5)) {
        (Some(Value::Uint(1)), _, Some(Value::Array(e))) => {
            let e: Vec<String> = e
                .iter()
                .map(|v| match v {
                    Value::Uint(n) => n.to_string(),
                    other => format!("{other:?}"),
                })
                .collect();
            format!("receipt [{}]", e.join(", "))
        }
        (Some(Value::Uint(2)), Some(Value::Text(r)), _) => format!("refused {}", r.as_str()),
        _ => "unread".into(),
    }
}
