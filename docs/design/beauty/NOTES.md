# A study in beauty

Rogier approved two clean designs, Work and Inbox, and asked what beautiful elements could look like without giving up the cleanliness. This folder is that study, on the side. The clean builds are untouched. Everything here is invented.

Open `index.html`. The panel sits over the app's sidebar, so the board keeps its full width. Each move is a switch, off by default. Hold Option, or the button under the main switch, to see the clean build in place. `\` hides the panel. The three moves marked Keep are the ones I would keep.

The question for every move: does it make it more beautiful, and does it stay as clean? Beauty here adds no information. The page says exactly what it said before.

## The moves

| Move | What it is | Why it costs nothing |
|---|---|---|
| **Paper** (keep) | Continuous corners, a rim lit from above, a soft layered shadow that takes the desk's warmth | Only the edge of the sheet changes |
| **Set by hand** (keep) | Inter's display cut on large titles, even line breaks, lighter weights on dark themes, identifiers that no longer float their hyphens, lighter status shapes | The same words at the same sizes |
| **Colleagues who notice** (keep) | Heads stand truly behind the sheet, each has its own lean, and they glance at the pointer | They say nothing new, and go still when you do |
| **A clear desk** | Hercule rises over a horizon in the colour of the hour and tips his hat | Nothing else is on the page |
| **A real landing** | A check draws and one line of light runs round the sheet. The colleague hops. Finishing an initiative fills its line for good | It comes only when you finish something |
| **One ring** | One focus ring glides between cards | It shows where you went |
| **A sheet that opens** | The sheet's words arrive in a quick cascade and its shadow settles last. The Inbox behind goes soft | Same speed as before |
| **Fine lines** | Hairlines at one device pixel, a thinner initiative line with beads right on it, rules that fade at the far end | Less to look at |
| **A soft edge** | Cards melt away under a stuck lane name and at the foot of the window | Only shows while you scroll |

## Which three, and why

**Paper, Set by hand and Colleagues who notice.** They are the three you live with every minute, and none asks anything of you. All three are felt more than seen, so if Rogier wants one he will notice, A clear desk is the first to look at: it is the most beautiful frame in the study, and most people will rarely see it, which is why it is not a pick.

The weakest of the nine is **A sheet that opens**. It passed the critic, but on Work it is now only a cascade and a shadow, and it is the one you would miss least.

## What was tried and removed

The critic's question removed these. They are here because Rogier suggested some of them, and each one was built for real and looked at.

- **Daylight.** The whole window in the light of the hour. Lovely in a single frame, but at 19:00 two cards in the same state differed in colour, and Whitehaven stopped being Whitehaven. Time of day lives on in A clear desk, the one place where it costs nothing.
- **A small lamp.** A pool of light following the pointer. On Whitehaven it burned a white oval into the grey hover row, exactly under the pointer, and on dark it barely showed. A white sheet has no brighter to go.
- **Paper's tooth.** A grain on the sheet. On white it read as dirt at any strength you could see.
- **Glass beads, a glow on the line, an initiative's colour behind its cards.** Muddy on the olive beads, neon on dark, and a tinted block with hard edges. An initiative's colour was already right.
- **Colour from a source's logo on its surface.** Considered and not built: it would add a signal to decode.
- **A glass lane band.** Words on cards ghosted beside the lane's name.
- **A blur behind Work's details.** The board beside the sheet must stay readable, and at any small blur it looked like a bad render.

## What this would change in the design system

If Rogier keeps a move, these are the rules it touches. Nothing changes until he says so.

- **Paper:** `--h-rest`, `--h-hover`, `--h-carry` and `--card-r` change value, and `corner-shape: squircle` joins the card.
- **A real landing:** MOTION.md says Done shrinks into its stage's count at once. Here the card holds for 460ms first, though focus moves on at once, so D, D, D keeps pace.
- **A soft edge:** DESIGN.md says stage headers sit on solid desk. They still do. The change is only under the rule and under a stuck band.
- **Set by hand:** titles use `text-wrap: balance` instead of `pretty`. Dark themes change `--w-regular`, `--w-medium` and `--w-bold`.

`corner-shape` and the `scroll-state` container query need Chromium 139 and 133. The app's Electron 44 has both. Reduced transparency and reduced motion are honoured in every move.

## How it is built

- `work/` and `inbox/` are copies of the clean builds from `prototype/overview-hifi` and `prototype/inbox-hifi`, with the commits in `.clean-overview` and `.clean-inbox`. Each `desktop.html` gains three lines: `moves/boot.js`, `moves/moves.css` and `moves/moves.js`. `shared/page.js` loses the rule that stops a frame taking focus, because the keys are part of the comparison.
- A move is one attribute on `<html>`, `data-b-<id>`. Every rule sits behind its attribute, and every listener starts in the move's `on()` and ends in its `off()`.
- `tools/identity.mjs` proves the point of the folder: with every move off, 48 states in six themes match the clean builds pixel for pixel. Run `tools/refresh.sh` when the clean builds move, then run identity again. It needs `docs/design` served on 8483 and the refreshed `/tmp/beauty-clean` on 8484, and `HOST` if the first is not on 127.0.0.1.
- `tools/shot.mjs` and `tools/sheet.mjs` take review shots. They need `/tmp/ovtools`; see the wiki page on drawings.
