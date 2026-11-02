# Overview directions - instructions for the builders

PROTOTYPE. Every direction is built by two designers working in parallel in one folder:

- the **window builder** owns the live window (`desktop.html`), the sidebar, the Threads mode,
  the direction's own view, the mode switch, the states, and the story page (`index.html`);
- the **office builder** owns the 3D Office mode: one module the window mounts, plus a standalone
  page to develop and shoot it.

Read, in this order: `BRIEF.md` (all of it; your direction's section 7.x is your spec),
`KIT.md` (the drawing kit), `OFFICE-KIT.md` (the real Office's 3D kit, for the office builder;
the window builder skims it), `../sidebar-directions/shared/world.js` and `shared/world-plus.js`
(the shared morning), and the wiki traps (`hercule wiki-page read 7e8860da`). Look at the book's
Office (`../crew-bureau-2/desktop/office.html`) and Rogier's real sidebar today
(`shared/rogier-sidebar-2026-10-24.png`): you are paying homage to both.

## The bar

Rogier asked for designs that are "true marvels of amazing UX": visually beautiful, a pleasure to
use, instantly familiar to someone who uses Claude Code, Codex or T3 Code, and still making them
stop and think "huh, why didn't anyone think of that?". He is picky about pixels. He will review on
his phone. So:

- **Hi-fi, not wireframe.** Real content from the shared world, every state drawn, both themes
  (`whitehaven`, `orient-express`) as good as each other, the 4px grid, the token type scale.
- **Crew Bureau.** Color is who; state is a pose and a mark; places get tints; marigold only for
  what is addressed to you; the beans; the Art Deco of the 1930s; Limelight only for display.
- **Sell the story.** The story page is a pitch, not a spec dump: lead with the moment that makes
  someone say "huh", show it big, then explain.
- **Honest.** Every number agrees with the world. Codex usage is "not reported". A prediction looks
  like a prediction (a range, a "~").
- **Plain words.** Short sentences, active voice, no jargon in UI text. Never the em dash; use "-".
  No product name inside identifiers.

## Files (all inside `overview-directions/<folder>/`)

| File | Owner | What |
|---|---|---|
| `desktop.html` | window | the live window, 1440x900 design size |
| `<folder>.css`, `<folder>.js` | window | the shell, sidebar, Threads mode, own view, switch, states |
| `<folder>-data.js` | window | direction-only data that `shared/world-plus.js` does not hold |
| `<folder>-office.js`, `<folder>-office.css` | office | the Office mode module |
| `office.html` | office | the Office module alone, full window, with a small state switcher |
| `office-notes.md` | office | 15-30 lines for the window builder: what the Office shows, its signature moments, the best camera states to shoot, its costs |
| `index.html` (+ `index.css`) | window | the story page |
| `shots/*.png` | both | captures used by the story page and the book; `shots/hero.png` is the book's hero image (window builder picks it) |

Never write outside your folder. `shared/`, `vendor/`, `../sidebar-directions/`,
`../crew-bureau-2/` are read-only: if you need a change there, say so in your report. Scope every
CSS rule under your root class (`.ov-<folder>` for the window, `.ov-<folder>-office` for the Office)
and prefix every class; two builders share one page.

## The Office module contract

The office builder exposes one global, the window builder calls it:

```js
window.OfficeModes = window.OfficeModes || {};
window.OfficeModes["<folder>"] = {
  // Draws the Office into `container` (an empty, sized element). Returns a handle.
  mount: function (container, api) { return handle; },
};
// api: {
//   world: window.WORLD,               // the shared world (with world-plus)
//   theme: "whitehaven" | "orient-express",
//   state: "everyday" | "swarm" | "away" | "open" | <a direction state>,
//   selected: "<thread id>" | null,    // fly to it on mount
//   reducedMotion: boolean,
//   onSelect: function (id) {},        // a bean (plane, climber...) was clicked or tapped
//   onOpen: function (id) {},          // the user asked to open that thread
// }
// handle: {
//   select: function (id) {},          // highlight it and glide the camera to it; null clears
//   setState: function (state) {},     // redraw for another state without a reload
//   resize: function () {},
//   pause: function () {}, resume: function () {},  // the window calls these when the mode is hidden
//   dispose: function () {},
// }
```

- The window loads `../vendor/office-kit.js`, `<folder>-office.css` and `<folder>-office.js` in
  `desktop.html`, mounts the module the first time the Office mode is shown, and calls
  `pause()` when another mode is shown. Until the office builder's files exist, the window shows
  a handsome placeholder in the Office mode (check with `window.OfficeModes && OfficeModes[...]`).
- The Office module draws its own in-scene HUD inside `container` (labels, legends, its own
  controls such as a time dial). The **selection card** (the selected thread's face, title, status,
  ask with its buttons, "Open thread") is the window's, shared by all three modes: the Office calls
  `onSelect`, the window shows the card. Leave room for it: bottom-left, about 380x150.
- `office.html` mounts the same module full-window with a small floating switcher for state and
  theme, so the office builder can develop and shoot it alone.

## The window

- **Layout.** Today's window at 1440x900: the 272px sidebar on the left, the main pane on the
  right, traffic lights, Crew Bureau chrome. You may use the Stage (`KIT.md` §1, §6) or draw the
  shell yourself; either way it must look like the app.
- **The overview.** Opened from the sidebar's Office button (and ⌘⇧O). Its top bar holds the
  three-way switch **Office · Threads · <own view>** (icons plus words, the selected one pressed),
  the direction's own controls, and the counts. Keyboard: pick shortcuts that do not clash with
  the app's (⌘1-⌘9 are taken by Go; say what you chose). A mode switch is quick: an object you
  selected stays selected, and the change of mode is a short cross-fade or a shared-element
  move, never a jump that loses the user.
- **The sidebar** is the Threads mode folded to 272px, organized by your direction's idea.
  Waiting on you stays on top. Say what the sidebar does while the overview is open.
- **URL params** (read on load): `?mode=office|threads|<own view id>`, `?state=everyday|open|swarm|away|<yours>`,
  `?theme=whitehaven|orient-express`, `?select=<thread id>`. Every signature moment must be
  reachable by URL, so it can be shot and linked from the story page.
- **States** (BRIEF §9): `everyday`, `open` (the 3-D Secure lead open in the main pane, sidebar
  beside it), `swarm` (use `WORLD.swarm` and the world-plus swarm data), `away` (Rogier back at
  09:41 after 40 minutes). Add your own for your signature moments.
- **Interactions that must work:** the mode switch (click and keys), selecting a thread in any
  mode (it stays selected across modes), opening a thread, hover states, the waiting thread's
  answer buttons (answering moves it out of Waiting on you with a short toast and Undo), and your
  direction's signature interaction.
- **On a phone** the window is a 1440px design: set `<meta name="viewport" content="width=1440">`
  so the phone shows the whole window, scaled. The story page is where the phone reading happens.

## The story page (`index.html`, the window builder writes it last)

Phone-first (412px wide), lovely on a desktop too. `<meta name="viewport" content="width=device-width, initial-scale=1">`.
Use `../shared/book.css`/`book.js` or your own CSS, in the house style. Sections:

1. **The pitch**: the direction's name, its tagline, one paragraph, and the hero image.
2. **The huh**: the signature moment, big, with one sentence.
3. **The three modes**: for each, an image (a crop that reads on a phone, at 2x), what it shows,
   and how you use it. Mention the sidebar.
4. **A walk-through**: four to six steps of a real moment of the morning in this direction (for
   example "09:41, you come back from lunch...").
5. **What Hercule would need** (data and spec changes, honest), **what it costs** (idle, per event,
   per token: nothing), and **risks and answers**.
6. Links: "Open the live window" (with a note: best on a laptop, or a phone held sideways) and
   deep links to the signature states; back to the book (`../index.html`).

Images: static PNG crops at 2x from your own captures (`shots/`), not live iframes (the phone
cannot run five WebGL frames at once). One live iframe at most, lazy.

## Verify by looking

A headless Chromium works on this machine: `KIT.md` §9 (`/tmp/ovtools/shot.mjs` and
`/tmp/ovtools/act.mjs`). Pages are served at `http://100.84.20.56:8471/overview-directions/<folder>/`.
Shoot every mode, state and theme you build, read every PNG with the Read tool, and fix what looks
off: alignment, spacing, truncation, overlapping labels, contrast in the dark theme, empty corners,
anything that would not survive Rogier's eye. Check the console errors the scripts print. Shoot
the story page at phone size (`--w 412 --h 915 --scale 2 --mobile --full`). WebGL renders in
software here, so 3D captures need `--wait 3000` or more. Keep scratch PNGs in
`/tmp/ovtools/<folder>/`.

## Etiquette

- No commits. No edits outside your folder. Never kill a process you did not start.
- When you finish, report: the files, the states and URLs worth opening, the shortcuts you chose,
  what is drawn versus only described, and anything you would do with more time.
