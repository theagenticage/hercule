# List and Kanban - instructions for the builders

PROTOTYPE. Three designers build this round in one folder, at the same time:

- the **list builder** owns the window (`desktop.html`, `list.js`, `list.css`): the shell, the
  mode switch, the find bar and lenses, the peek panel, and the three List variants;
- the **board builder** owns the Kanban (`board.js`, `board.css`, `board.html`): a module the
  window mounts, plus a page to develop it alone;
- the **book builder** owns the story page (`index.html`, `index.css`) and its drawings of
  SIGNALS.md.

Read first: `BRIEF.md` (all), `SIGNALS.md` (all), `shared/heavy-world.js` and `shared/digest.js`
(the data and the helpers: use them, never re-derive a line or a column yourself, so the List and
the Kanban can never disagree), `../overview-directions/KIT.md` (the drawing kit: tokens, faces,
icons, includes; its §9 has the screenshot tools), and the wiki traps
(`hercule wiki-page read 7e8860da`).

## Why this round exists

Rogier rejected round 1 (`../overview-directions/`) because every page had **too much on it**.
The original Crew Bureau thread list is better because it is **quieter**. Look at it before you
draw anything: the book's sidebar (`../crew-bureau-2/desktop/session-active.html`), the book's
Office list (`../crew-bureau-2/desktop/office.html`, the List tab), and the phone's Threads
(`../crew-bureau-2/mobile/threads.html`). Your work is that list, made to carry 70 sessions and
made easy to search and zoom. **When in doubt, leave it out.**

## The quiet budget (hard rules)

- **One colored thing per row or card, at most.** Marigold for what waits on you (the ask text,
  `--you-ink`). Everything else is `--ink`, `--muted` or `--faint`. The face is the only other
  color, and it is small (20-22px).
- **No chips, pills, badges, bars or rings on rows or cards**, except the status marks crew.js
  already draws and the provider mark today's row has. Progress is words ("4 of 7"), not a bar.
  The peek panel may show a plan's steps and the milestone ladder; nothing else may.
- **Two weights.** `--w-regular` and `--w-medium` (or `--w-bold` for counts only).
- **Hairlines, not boxes.** Rows have no borders or backgrounds at rest; hover is `--hover`;
  selected is `--selected`. Group headers are the book's quiet section heads.
- **Rows never move under the pointer**; new or changed rows wait until it leaves.
- **No decoration.** No illustrations, no Limelight in the product UI, no animation except short
  fades and the peek panel sliding in.
- The design-review controls (variant switch, state switch) live in one small floating bar at the
  bottom centre labelled "Design review", visibly not part of the product.

## Files

| File | Owner |
|---|---|
| `desktop.html`, `list.js`, `list.css` | list builder |
| `board.js`, `board.css`, `board.html` | board builder |
| `index.html`, `index.css` | book builder |
| `shared/*` | read-only for all three (tell the lead if you need a change) |
| `shots/*.png` | anyone, prefixed by owner: `list-*.png`, `board-*.png`, `book-*.png` |

Scope every CSS rule under a root class (`.lb-list`, `.lb-board`, `.lb-book`) and prefix every
class (`lbl-`, `lbb-`, `lbk-`).

## The board module contract

```js
window.LBViews = window.LBViews || {};
window.LBViews.board = {
  // Draws the Kanban into `container` (empty, sized). Returns a handle.
  mount: function (container, api) { return handle; },
};
// api: {
//   sessions: [...],            // already filtered by the window's find bar and lens
//   now: "09:41",
//   variant: "state" | "phase",
//   swimlanes: false | "project",
//   selected: "<id>" | null,
//   onSelect: function (id) {},  // the window opens the peek panel
//   onOpen: function (id) {},    // the window opens the thread
// }
// handle: { update(sessions), select(id), setVariant(v), setSwimlanes(v), dispose() }
```

The window owns the find bar, the lenses, the selection and the peek panel; the board only draws
cards and reports clicks. `board.html` mounts the module alone, with a small switcher, on the
whole heavy world.

## The window (list builder)

- 1440x900, today's window: today's quiet sidebar (crew.js's threads sidebar, unchanged), the main
  pane with the overview. Top bar: the switch **Office · List · Kanban** (system.css's segmented
  `pill`/`ptab`), the find field, the lenses **All · Following · Mine · Needs you**, a quiet
  "View" menu (group by, density), and the counts at the right.
- **Office** shows the book's Office (`../crew-bureau-2/office.js`, `data-office`), unchanged.
- URL params: `?mode=office|list|kanban`, `?list=rows|table|outline`, `?board=state|phase`,
  `?lens=all|following|mine|waiting`, `?q=<query>`, `?select=<id>`, `?zoom=<project>` (outline),
  `?theme=whitehaven|orient-express`. Every state worth showing must be reachable by URL.
- Keys: typing focuses the find field; `↑` `↓` walk; `↩` opens; `space` peeks; `F` follows;
  in Outline `→` zooms in, `←` out; `esc` clears the query, then the peek. ⌘1-⌘9 stay Go's.
- `<meta name="viewport" content="width=1440">`.

## The story page (book builder)

Phone-first (412px), lovely on a desktop. Sections: what Rogier said and the principles (short);
**How far along, and where** - SIGNALS.md told visually: one real event stream (the 3-D Secure
fix's last turn) flowing into the digest and into the row's line, the phase table, the focus rule
with its worked example, the milestone ladder, the cost, what changes where; then the List
variants and the Kanban variants with captures (`shots/list-*.png`, `shots/board-*.png`, which the
other two builders produce; until they exist, leave marked slots); then links to the live window.
Draw the signal diagrams in HTML/SVG in Crew Bureau, not as screenshots. The same quiet budget
applies.

## Verify by looking

`/tmp/ovtools/shot.mjs` and `act.mjs` (see `../overview-directions/tools/README.md`); pages are
served at `http://100.84.20.56:8471/list-and-board/`. Shoot every variant and state in both themes,
read every PNG, and hold it against the book's own list: if yours is busier, take things out.
Captures for the story page: 2x, then convert with `/tmp/ovtools/towebp.mjs 0.86 <png>...` and use
the `.webp`.

No commits. No edits outside your files. Never kill a process you did not start. Report: files,
URLs worth opening, keys, what is drawn versus described.
