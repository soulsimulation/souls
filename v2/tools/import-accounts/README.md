# import-accounts

Engine v2 X11 (#2820): a stage's accounts, each Soul's identity and each world's creator brought into the new stores
from a backup, so the clean start drops history, not ownership. The worlds' content is X6's
(`v2/tools/import-world`); the owners' memory is R18's.

From `v2/`:

```
cargo run -p import-accounts --release -- <backup set> [--world <file.db>]… --out <dir> [--json]
```

- **Reads only the backup.** `<backup set>` is one nightly set as `tools/world-launcher/deploy/backup.mjs` writes it:
  `accounts.sqlite` (the stage's registry), `forks-accounts.sqlite` (the original worlds' own registry), `worlds.json`
  and `worlds/<slug>.db`. `--world` adds a world file kept elsewhere (an original world's). Every file opens read-only
  and immutable. From a world it reads the `souls` rows by named columns, never a token column; the latest snapshot,
  for each Soul's body; and the world's meta, for its creator when `worlds.json` has no row for it.
- **Accounts** go into W1's store (`<dir>/accounts.sqlite`, `directoryd::accounts::store`) with the same ids, in
  today's mapping shape. The two registries merge by (issuer, subject): a person both know keeps the stage's id and
  their old worlds' id is kept as an alias of it (`account_aliases_v1`). Each account gets W1's principal id.
- **Each Soul** that is not retired, and whose owner is an account, gets a global id minted as the directory mints
  them; one record in W8's directory at its world (`<dir>/directory/`, the directory's objects as files, written with
  `Directory::set_place`); and one birth in K10's `Birth` shape (soul, entry, asked 0) in `<dir>/births/<world>.json`,
  the first thing the world's new history does. The entry is the world's root (its zone, as `import-eden` names it)
  until N9 declares arrival places. Its name, description and look (family, today's preset, and the SHA-256 of today's
  body) stay with its account (`souls_v1`).
- **Looks, until B15 (#2750):** every Soul comes in `eden:humanoid`, the one body family v2 has a kind for. A body
  today's preset puts in another family is counted per preset in the row (`no kind`), and its preset and hash are kept
  for B15 to map.
- **Each world** keeps its creator's account (`world_creators_v1`); the creator's principal is the account's.
- **Ownership (V13c):** each Soul brought is recorded as its account's in W1's `account_grants_v1` (its `soul-…`
  grant, and its own body as the one the page follows), and each creator account as owning its `creator-…` grant, so
  a signed-in owner's session exchanges for a view of them (V13b).
- **Private:** the old-to-new Soul ids (`imported_souls_v1`, for R18), the aliases and the Souls' details stay in the
  account store and are never posted. The births and the directory hold no account id; the row prints counts only.
- **The row.** Accounts (stage, old worlds', aliases, conflicts, all equal), then per world: live, retired (not
  brought), brought, unowned (owner is no account: not brought), no kind by preset, creator kept, and read back equal
  to the backup. Then the state hash: SHA-256 over every row of the store, the directory's objects and the births. A
  second run into the same `<dir>` changes nothing and prints the same hash. It exits 1 when the import is not clean.

Test (makes its own stage with today's server code, backs it up with today's backup tool, under
`.local/import-accounts/test`; needs `pnpm install` and cargo), from the repository root:
`node --test v2/tools/import-accounts/test/import-accounts.test.ts`.
