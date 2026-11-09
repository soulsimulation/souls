# Souls starburst icons

The favicon and installable-app PNGs are resized from the supplied starburst image, preserved as the CDN-backed
`apps/web/src/media/starburst-source.png` in `tools/assets/manifest.json`. Resize that source to the filename's
dimensions when regenerating them. The header uses `starburst.png`, a transparent extraction of the same mark (its
brightness as alpha, on white), drawn inside a black circle. The previous halo images stay in the manifest for the social
card (`halo-social.png`).

The launcher serves Worlds at `/` directly. Its loading and error states never render legacy cards. `/old` redirects directly to Worlds; no legacy cards are shipped.
