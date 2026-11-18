//! Uploads and assets by hash, with limits (Engine v2 G6, #2747). Every viewer's browser downloads and decodes an
//! uploaded file, so one bad file hurts everyone: each is checked in a child process ([`child`], [`check`]),
//! stripped of metadata, passed through the hold point ([`hold`]), and stored under its hash with a record that is
//! allowed, held or removed ([`store`]). A creator uploads with one call and places the upload as a thing through
//! G1's gate. Serving (V12), drawing (V8) and the buttons that release or remove (W9) are not here.

pub mod check;
pub mod child;
pub mod hold;
pub mod store;
