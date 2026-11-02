# Tools for checking the drawings on the Linux runner (beelink)

PROTOTYPE. Playwright scripts used to build this book on beelink, which has no system libraries
for Chromium and no sudo. They expect a scratch setup in `/tmp/ovtools`:

```
mkdir -p /tmp/ovtools/debs && cd /tmp/ovtools/debs
apt-get download libatk1.0-0t64 libatk-bridge2.0-0t64 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libasound2t64 libatspi2.0-0t64 libwayland-server0 libxrender1 libxi6 \
  libxkbcommon0 libcups2t64 libcairo2 libpango-1.0-0 libavahi-common3 libavahi-client3 \
  libxcb-render0 libxcb-shm0 libpixman-1-0 libthai0 libharfbuzz0b libdatrie1 libgraphite2-3 \
  libfontconfig1 libfreetype6 libpangocairo-1.0-0 libpangoft2-1.0-0 libfribidi0
for f in *.deb; do dpkg-deb -x "$f" ../root; done
cd /tmp/ovtools && npm init -y && npm i playwright-core@1.63.0   # matches ~/.cache/ms-playwright/chromium-1243
cp <this folder>/*.mjs /tmp/ovtools/
```

- `shot.mjs <url> <out.png> [--w --h --scale --full --mobile --wait]` takes one screenshot and
  prints page and console errors.
- `act.mjs <url> <out.png> -- click:<css> key:<Key> wait:<ms> eval:<js> shot:<file>` drives a page.
- `towebp.mjs <quality> <png>...` re-encodes PNGs as WebP with Chromium's encoder (files must be
  under `docs/design`, served at `http://100.84.20.56:8471/`).
- `imgcheck.mjs <url>...` loads story pages in both themes at phone and desktop sizes, forces every
  image to load, and lists failed requests and broken images.

WebGL works in this headless Chromium (software rendering, 1 to 4 frames a second): give 3D pages
`--wait 3000` or more, or a `motion=off` parameter.
