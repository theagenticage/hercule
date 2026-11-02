# Atlas Office: the City - notes for the window builder

PROTOTYPE. `atlas-office.js` + `atlas-office.css`, root class `.ov-atlas-office`. Load after `../vendor/office-kit.js`, `world.js` and `world-plus.js`; load `crew.js` too, so each bean wears the look of its face (`Crew.lookFor(title)`).

**What it shows.** Each repository is a city on a tinted plinth round a square; folders are districts, files are buildings.
- Height = lines of code. Lit windows = lines changed today: more lines, more and brighter panes.
- Roof trim in a thread's hue = that thread changed the file (two hues: two threads). Chequered roof = a test file.
- Scaffolding = changes not landed yet, as high as the share of the file changed. A crane stands over the big refactor (tResult, 23 files).
- Crossings: a dashed tomato ring, on the pavement and round the roof, where a dry-run merge would conflict; a brass ring for an Edit Overlap. Why not marigold: marigold is only for you. A conflict is a failure that has not happened yet, so `--fail`, dashed because it is a prediction; an overlap is advisory, so brass, and the label says what it is.
- Working beans type at a desk on the roof of the file they are in now; idle ones sit on a bench at their door. Waiting beans queue on the Town hall steps, palms up (your desk, "Now serving", Ada, Milo and Juno inside); a waiting editor's desk stays on its roof with the marigold note. Threads that only read sit in the Library under the glass dome.

**Semantic zoom** (`data-zoom` on the container): far = cities, busy districts (heat, who), Town hall, Library, crane, the conflict, and a pin per bean in its hue (marigold for the queue); mid = name tags (title + file) and every crossing; near = everything, and file names under the pointer. Colliding labels fold to pins or wait, sorted once when the camera rests.

**API.** `OfficeModes.atlas.mount(container, api)` as BUILDERS.md says. States: `everyday`, `open` (glides to t3ds), `swarm`, `away`, and mine: `crossing`, `land`. Extra: `handle.show(name, instant)` for `home`, `webshop`, `payments-api`, `ops`, `crossing`, `refactor`, `landed`.
- Click a bean: `onSelect`, and a glide that keeps the bottom-left 380x150 clear. Double-click: `onOpen`.
- Click a building: its file card (who changed it today, +/-, the crossing). Click a district or a city: fly there. Escape closes the card.
- My HUD: top-right (fly to a city; the crossings chip steps through them), bottom-right (the key, folded), top-left (a note in `away` and `land` only). Bottom-left is yours.

**Shots** (`office.html?bar=off&motion=off` hides my switcher): hero `&state=everyday`, night `&theme=orient-express`, `&state=crossing`, crane `&view=refactor`, `&state=land`, `&state=away`, `&state=swarm`, `&select=t3ds`. Captures in `shots/office-*.png`.

**Costs** (measured in `office.html`): 18 instanced meshes hold 108 buildings and 9,520 window panes, built once per state, never per event or token. It draws only while visible and not paused: 30 fps while beans breathe, nothing at rest under Reduce Motion. Tilt-shift is two full-screen passes, on only in the far view. 17 real lights (the kit's 13 lampposts, 4 floor lamps); the street lamps are glowing globes with painted pools. 50 labels (78 in the swarm), moved by transform only.

**Needs.** Files edited and read per session (the edit watch, best effort; the key says so), the repository tree with line counts, dry-run merges. `away` uses each session's turns as a stand-in for per-edit times.

**Trap.** `page.js` sets `<html data-state>`: never pick buttons with `[data-state]`, a click anywhere would match.
