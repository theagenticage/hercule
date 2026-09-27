# Hercule - design systems, round 2 (prototype)

Throwaway design exploration on branch `prototype/design-systems`. Never shipped; excluded from
eslint and prettier. Round 1 (ten systems) lives beside it in `../design-systems/`, unchanged.

Round 2 takes the two systems Rogier picked in round 1, Metro and Crew, and iterates on each twice,
from his feedback (quoted in full in `shared/BRIEF-2.md`). The originals are copied in unchanged, so
each iteration can be compared against the system it came from.

| Folder | System | Step |
|---|---|---|
| `m0-metro` | Metro | round-1 original, unchanged |
| `m1-wayfinding` | Metro Wayfinding | iteration 1 |
| `m2-concourse` | Metro Concourse | iteration 2 |
| `c0-crew` | Crew | round-1 original, unchanged |
| `c1-bureau` | Crew Bureau | iteration 1 |
| `c2-labours` | Crew Labours | iteration 2 |

## Open it

- Double-click `index.html` (works from disk), or run `pnpm design-systems-2` and open
  <http://localhost:4871/>.
- `index.html` - the gallery: one row per family, the original first.
- `compare.html?screen=desktop/intake.html&theme=dark` - one screen in all six systems, a row per
  family, with a Glass slider.
- `<folder>/index.html` - a system's book: what changed from the original and why, the system,
  all 22 screens, the agent office, and how to adopt it. Each iteration's book has a Glass slider
  in its toolbar.
- Any screen page takes:
  - `?theme=<name>` - every system has `light` and `dark`;
  - `?state=scrolled` on `session-active.html` - the shrunken glass composer;
  - `?glass=<0..1>` on the iterations - the glass level, from fully solid to the most glass the
    system allows;
  - `?flow=on|off` on an iteration's `desktop/office.html`, where it has an event-flow layer.

## Glass

Each iteration derives every see-through surface from one custom property, `--glass-level`
(0 to 1). Its `tokens.css` sets the default; `shared/page.js` overrides it from `?glass=` or from a
`{ glass: n }` message posted by a book or the compare page, which is how their sliders move every
frame live, even from disk. The originals ignore it.

## Layout

- `shared/BRIEF-2.md` - the round-2 assignment: Rogier's feedback, the shared shell, glass, button
  and icon rules, and each iteration's direction.
- `shared/BRIEF.md` - the round-1 assignment, which still applies where round 2 does not override it.
- `shared/CONTENT.md` - the fixture world every system shows, corrected in round 2 so its numbers
  add up (the originals still show the old ones).
- `shared/DIRECTIONS.md` - the ten round-1 starting directions.
- `shared/baseline/` - today's design, from the prototypes the current web app was built from.
  Round 2's copy shows the product name Hercule where the old prototypes still used retired names.
- `shared/page.js`, `book.js`, `frames.css` - theme, state and glass handling, and the device frames.
- `shared/shoot.mjs` - `node shared/shoot.mjs <page> <out.png> [--w --h --scale --full]`.
- `shared/check.mjs` - `node shared/check.mjs <folder>`: mechanical checks plus a shot of every
  page in light and dark, the scrolled session and Intake at glass 0 and 1, and the book in 1600px
  slices. Both tools use Chromium's new headless mode, the one that draws `backdrop-filter` blur.
- `<folder>/cover-light.png`, `cover-dark.png` - the gallery thumbnails, 1440x900 shots of each
  system's best page. A missing cover falls back to a live frame.
