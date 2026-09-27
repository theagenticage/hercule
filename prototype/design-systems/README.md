# Hercule - ten design systems (prototype)

Throwaway design exploration on branch `prototype/design-systems`. Never shipped; excluded from
eslint and prettier.

## Open it

- Double-click `index.html` (works from disk), or run `pnpm design-systems` and open
  <http://localhost:4870/>.
- `index.html` - the gallery: one card per design, plus today's baseline.
- `compare.html?screen=desktop/intake.html&theme=dark` - one screen in all ten designs.
- `NN-slug/index.html` - a design's book: the brief, the argument, the system, all 22 screens, the
  agent office, and how to adopt it.
- Any screen page takes `?theme=<name>` (every design has `light` and `dark`) and, for
  `session-active.html`, `?state=scrolled` (the shrunken glass composer).

## Layout

- `shared/BRIEF.md` - the assignment every design was built from.
- `shared/CONTENT.md` - the fixture world every design shows (same data everywhere).
- `shared/DIRECTIONS.md` - the ten starting directions.
- `shared/baseline/` - today's design, from the prototypes the current web app was built from.
- `shared/page.js`, `book.js`, `frames.css` - theme/state handling and the device frames.
- `shared/shoot.mjs` - `node shared/shoot.mjs <page> <out.png> [--w --h --scale --full]`.
- `shared/check.mjs` - `node shared/check.mjs <NN-slug>`: mechanical checks plus a shot of every
  page in light and dark.
