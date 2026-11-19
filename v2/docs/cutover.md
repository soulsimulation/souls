# The cut-over: Eden serves from the new engine

Engine v2 X7 (#2836). Eden moves to the new engine in one planned step behind the same public name, with a tested
way back. The commands are [`v2/tools/ops/cutover/`](../tools/ops/cutover/); the front door they move is O19's
([`proxy/README.md`](../tools/ops/proxy/README.md)). The release owner runs them, with Gene's yes.

**Gene's decisions (19 Nov, recorded on #2836):** the new system is installed beside today's on the production
machine for the rollback window; Eden switches behind the same front door, with no DNS change, after a preview of
about 2 hours; old Eden stops taking acts and is kept untouched; the rollback window is 24 hours; accounts and Souls
made after the switch are kept untouched in the new system on a rollback and return at the next switch, and nothing
is copied back. The release is tagged 0.131; 0.130 is the rollback version of today's system.

## The two commands

Run as root on the production host, from the live release (`/srv/sim-worlds/production`):

```sh
bash /srv/sim-worlds/production/v2/tools/ops/cutover/cutover.sh check    # the preconditions only; changes nothing
bash /srv/sim-worlds/production/v2/tools/ops/cutover/cutover.sh switch   # the switch
bash /srv/sim-worlds/production/v2/tools/ops/cutover/cutover.sh back     # the rollback, inside the window
```

`/etc/souls/cutover.env` names the world that moves: `SLUG=eden` and `WORLD=<the new system's Eden>`, as
`place-world.sh` placed it.

**`switch`** runs `check` first and refuses, changing nothing, on any failed precondition (each named): the live release
carries the front door; the directory lists `eden`; `worldd@<world>` and `souls-gateway@<world>` run; the world's
placed socket path is under Linux's 108 bytes; the directory's `--gateway-tokens` is the world folder's `tokens` file
(W11b); the backup and store settings are set; it is not already switched. Then it:

1. writes `switch` to `/var/lib/souls/cutover/log.jsonl`, the cut-over's history;
2. copies today's feed (`<today's data>/feed.jsonl`, the owner notice among its items) into the new system's
   `/var/lib/souls/news.jsonl`, each line once, which O23's feed serves in today's shape;
3. runs O19's SWITCH script as the README has it: the front door's map from the directory, the site files, `caddy
   validate`, a reload (a failed validate puts today's file back and reloads nothing);
4. writes `switched` and prints the time it took and the rollback command.

**`back`** runs O19's BACK script (today's site file back, a reload, the map's timer off), writes `back` and prints
the time it took and the count of accounts and Souls made since the switch (`count.mjs`, read-only), for the
declaration of the rollback.

What they change: the proxy's site files, the front door's map and its timer, the cut-over's log and the news file.
Nothing else: no DNS record, no world, no store, no unit of either system. Both systems run throughout; the switch
decides only which of them the public name sends Eden's page to.

## One writer

- **In the directory.** The new Eden is one world with one claim (its epoch) in the store, made when it was first
  served for the preview. Neither command starts, stops or restarts it, so the switch and the rollback add no claim:
  its history shows one writer at every moment.
- **Across the two systems.** At every moment the front door sends Eden's page to exactly one system (a Caddy reload
  swaps the whole configuration at once). Today's API paths under `/w/eden/v1/` still reach today's launcher by
  O19's design, so that old clients get its answer by name, never a redirect that drops their token. **That answer is
  R18's (#2821): until today's launcher refuses Eden's acts from old clients by name, old clients would still act in
  the old Eden after the switch.** It is a stop condition below, not a step of these commands.

## The declaration

Posted on #2836 and on the feed before the switch, with the minute filled in by the release owner:

> **Eden moves to the new engine on Friday 20 November, between 08:00 and 12:00 UTC** (the switch at `<HH:MM>` UTC).
> The address stays soul.game; no DNS changes. The new Eden has served as a preview for about two hours before it.
>
> **Stop conditions.** The release owner switches back if any of these holds after the switch: the front door's check
> from outside fails (`front-check.mjs --v2 eden`); Eden's page or the directory does not answer for 5 minutes; an
> owner's agent cannot pair or act in Eden; a Soul or the world is stuck or frozen; anything the new system writes is
> corrupt; or Gene says so.
>
> **The rollback** is one command on the production host, `bash /srv/sim-worlds/production/v2/tools/ops/cutover/cutover.sh back`,
> for 24 hours after the switch. It takes under a second in the rehearsal. It points the front door back at today's
> system, which kept running untouched.
>
> **What a rollback loses:** everything done in the new Eden since the switch: its acts, its history, what Souls did
> there. The old Eden carries on from where it stopped at the switch.
>
> **Installed clients on a rollback.** A home that upgraded runs `node eden.mjs upgrade --rollback` and is back on the
> old client inside the window. Until it does, the old world answers it by name, telling it to roll back (R18).
>
> **Accounts and Souls made after the switch** are with the sign-in provider and the new system's stores, and a
> rollback removes neither. A Soul made after the switch does not exist in the old world. They are kept untouched in
> the new system and return at the next switch; nothing is copied back. Their count is the rollback's last line:
> `made since the switch at <time>: <n> accounts, <m> Souls`.

## The switch-day checklist

Before the switch:

- [ ] Gene's yes with the time; the preview has served about 2 hours with no missed bar (A5, the coordinator's).
- [ ] R18 is in today's live release: today's launcher answers Eden's old clients by name, and `upgrade --rollback`
      returns a home to the old client. Without it, do not switch (old clients would keep acting in the old Eden).
- [ ] X15's owner notice (`v2/docs/cutover/soul-owner-notice.md`) is posted on today's feed with
      `node tools/world-launcher/op.mjs feed-post --port <launcher port> --kind announcement --title <its title> --body <its body>`.
- [ ] `install-v2.yml apply` has shipped the origin files (O23's site pages among them).
- [ ] The new system's settings in `/etc/souls/secrets.env`: `SOULS_BACKUP_URL` (the `s3:` form of today's
      `BACKUP_OFFSITE_URL`), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SOULS_BACKUP_KEY_FILE`, and
      `DIRECTORY_STORE_URL` (or `WORLDD_STORE`). `check` refuses while any is unset; it never prints a value.
- [ ] The directory's `--gateway-tokens` in `/etc/souls/directory.args` is the Eden folder's `tokens` file
      (`/var/lib/souls/worlds/worlds/<world>/tokens`), so `worldd serve` finds `tokens.souls` (retires and names from
      the owner's page, W11b #3558); otherwise start `worldd serve` with `--directory <that file>`. `check` refuses
      otherwise.
- [ ] The v2 site owner is configured, so `/ops?json=1` answers (not 503 `owner-access-unconfigured`).
- [ ] `/etc/souls/cutover.env` names Eden; `cutover.sh check` passes, and shows the placed socket path's length
      (about 98 bytes of 107).

At the switch:

- [ ] `cutover.sh switch`. Today's feed items, the notice among them, are copied into `news.jsonl` by it.
- [ ] From outside: `node v2/tools/ops/front-check.mjs --v2 eden --today mars-college-2027 --alias eden-2026=eden`.
- [ ] Post the declaration with the minute; walk the real URL (a real owner's agent acts, a real browser watches, one
      uncut clip).

During the 24-hour window:

- [ ] Daily: X15's `node v2/tools/ops/reapproved.mjs --accounts <accounts.sqlite> --pairing <pairing.sqlite>`, posted
      on #2836.
- [ ] On a stop condition: `cutover.sh back`, then post its count line with the rollback's declaration.

## The rehearsal

[`rehearse.mjs`](../tools/ops/cutover/rehearse.mjs) runs both commands twice on a scratch host in one folder under
`.local/`: O18's scratch machine (Eden worlds served by `worldd serve`, their history shipped to a folder store) and
O19's stand-in front door (Caddy in today's layout on loopback), with production's names, paths and ports swapped for
the scratch host's. It records who serves Eden's page every 100 ms, Eden's claims in the store before and after, the
files each command changed and each command's time, and a person who signs up and makes a Soul while switched.

```sh
cd v2 && cargo build --release -p worldd -p gatewayd -p supervisor -p directoryd && cargo build --release -p ops --bin deploy --bin gateway-upgrade
bash tools/ops/install.sh bundle ../.local/bundle target/release <page dist>
cd .. && node v2/tools/ops/cutover/rehearse.mjs --bundle .local/bundle --facts <eden facts.json> --entries content/kinds
```

The facts file is N1's export (`v2/tools/import-eden`).

## Known limits

- The named answer to old clients and open pages, and `upgrade --rollback` into the old world, are R18's (#2821);
  the rehearsal's stand-in for today's launcher has neither.
- The account count reads the account store, which `directoryd` holds while it runs; then `back` says the accounts
  were not counted and why, and the count comes from the store once read (the Souls are counted from the pairing
  store, which is readable).
- A Soul brought over (X11) that its owner approves as a new Soul rather than by id would count as made after the
  switch.
