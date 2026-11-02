# Gazette Office - notes for the window builder

PROTOTYPE. `gazette-office.js` + `gazette-office.css` register `OfficeModes.gazette`; `office.html` mounts it alone (`?state=`, `?theme=`, `?select=`). It is the app's Bureau from the Office kit, made legible and given a memory.

**What it shows.** One room per project (webshop, payments-api, ops, named as the projects are) along the Gallery, each piece of work's desks pushed together; across the Gallery the Lounge (idle beans sip tea), the Secretariat (Ada, Milo, Juno), Your Office (waiting beans queue at your desk, oldest first, hands up) and the Lobby with the front door. The 16 threads plus the 5 run-step sessions (visors); the swarm adds its 19.

- **Bubbles.** Far away, one bubble per piece of work, a line per member at work (`WORLD.activity`); close up, one per bean, with its name. In the swarm, only the room the camera looks at (or the selected bean's) keeps its bubbles; the rest fold to "…".
- **Paper planes.** Each `WORLD.exchanges` message flies desk to desk with a dotted trail in the sender's hue; the receiver's bubble then shows its first words for ~2 minutes of the morning. A message to a bean in the queue stacks over its ask, never replaces it.
- **Desks remember.** Reams of paper grow with the diff (`WORLD.files` edits), sticky notes in the finder's hue land on the desk they were reported to, a brass cup for PR #1281 (pewter for draft #1287), a red folder for the failing property. Close up, each desk says it in words: `+48 −12 · 1 finding`.
- **The time dial** (bottom, from x 412: clear of your selection card). Drag to scrub 07:00-09:41 (beans jump), Play to replay (beans walk the corridors), 30/60/120×. Ticks: arrivals, turn ends (hue), Requests (marigold), messages (beads). The wire above it captions the last three events. The past is drawn in a light sepia; the longcase clock in the Lobby keeps the dial's time.
- **While you were away.** The newsboy (flat cap, the Gazette under his arm) walks from the front door to your desk and puts the 09:41 edition down; the camera pulls back and 09:01-09:41 replays at 30× with captions, then rests on now.

**States.** `everyday`, `swarm` (rebuilds), `away` (newsboy, then replay), `edition` (now, paper on the desk, no replay), `open` (glides to the 3-D Secure fix), `replay` (parked at 09:21:25: the Stripe research's plane in the air, three captions). Anything else draws as `everyday`.

**Camera.** Opens on the whole Bureau; `select(id)` glides so the bean sits right of centre and above your card; click a floor or a room label to fly to the room; double-click a bean calls `onOpen`; Escape or the crumb ("The Bureau") flies home. The crumb keeps clear of your top bar by itself.

**Best shots** (in `shots/`): `office-hero.webp` (everyday), `office-dark.webp`, `office-dial.webp` (09:21 mid-replay), `office-desks.webp` (webshop close up). For your own captures, `handle.debug` has `setTime`, `view`, `frameRoom`, `selectNow` (instant, since headless draws ~1.5 frames a second).

**Costs.** Draws on demand: nothing while idle unless ambient breathing (the kit's 30 fps cap; off under Reduce Motion), a camera move, or a replay. Bubbles are static text, rewritten only when the minute shown changes their words; labels are moved apart by one pass per drawn frame (no layout reads unless a label's text changed). The replay reads the turn history once at mount and computes poses from spans; no data reads per frame. `pause()` stops everything; the sepia is a GPU filter on the canvas.

**Described, not drawn:** activity lines for past minutes come from a hand-written history in `gazette-office.js` (Hercule would keep the activity line per tool call); the newsboy is a character, not a session. Walks are straight lines between corridor waypoints, so a bean may brush a desk corner.
