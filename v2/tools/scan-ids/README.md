# scan-ids

Engine v2 W1 (#2704): checks that no account identity reached a world's log or views. It searches every byte of
every file under the given paths for each identity in a list (account ids, provider subjects, emails) as written, in
lower and upper case, in hex, and in base64 (standard and URL alphabets, at each of the three byte alignments). A
hit names the file, the offset, the identity's line number and the form, never the identity, so a report can be
posted. It exits 0 with no hits, 1 with any, 2 on a bad argument.

From `v2/`:

```sh
cargo run -p scan-ids -- --ids <file, one identity a line> <log or view file or folder>...
```

The identities come from a file so they never appear in a command line. Leave the account store out of the paths:
it holds account ids and subjects by design.

`cargo test -p scan-ids --test hour` is W1's A2: a person signs in through the directory with a provider token made
for the run, the creator then sets a field once a second for an hour of world time under the principal the directory
minted (T6's base fixture), and the scan runs over the log, all 16 views (the root and the set node, every level,
public and the principal's own) and the directory's log, finding none of the account id, subject or email. As a
control the same scan finds the principal's id in every acted entry. Its files are left under
`v2/target/tmp/scan-ids-hour/` for a rerun of the tool by hand.

Run it again once the pairing (W2) and the new world (G9) are merged, over their logs and views, with the account ids,
subjects and emails of the people they signed in.
