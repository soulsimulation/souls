# Souls starburst icons

The favicon and installable-app PNGs are the supplied starburst image resized to each filename's dimensions;
`icon-512.png` is the largest copy and the one to resize from. `icon-mark.png` is a transparent extraction of the same
mark (its brightness as alpha, on white) used by the header and the phone menu, drawn inside a black circle. These are
small own-work binaries kept in git (the `icon-*.png` allowlist in `.gitignore` and `tools/assets/manifest.test.mjs`).
The social card is still the halo (`halo-social.png`, on the CDN).

The launcher serves Worlds at `/` directly. Its loading and error states never render legacy cards. `/old` redirects directly to Worlds; no legacy cards are shipped.
