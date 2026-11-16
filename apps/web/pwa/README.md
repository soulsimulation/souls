# Souls starburst icons

The favicon and installable-app PNGs are the supplied starburst image resized to each filename's dimensions;
`icon-512.png` is the largest copy and the one to resize from. `icon-mark.png` is a transparent extraction of the same
mark (its brightness as alpha, on white) used by the header and the phone menu, drawn inside a black circle. These are
small own-work binaries kept in git (the `icon-*.png` allowlist in `.gitignore` and `tools/assets/manifest.test.mjs`).
`icon-social.png` is the social card: `icon-512.png` centred, unscaled, on a 1200×630 pure black canvas
(`sips --padToHeightWidth 630 1200 --padColor 000000` on a copy). The build emits it as `assets/sim-social-<hash>.png`
(`vite.config.ts`), and `index.html` names that file by absolute URL on soul.game in `og:image`, `twitter:image` and the
JSON-LD; the build fails if the two disagree, so a new card means updating that URL.

The launcher serves Worlds at `/` directly. Its loading and error states never render legacy cards. `/old` redirects directly to Worlds; no legacy cards are shipped.
