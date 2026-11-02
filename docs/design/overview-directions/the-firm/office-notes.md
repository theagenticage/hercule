# The Dollhouse - notes for the window builder

PROTOTYPE. `OfficeModes["the-firm"]` in `the-firm-office.js` (+ `.css`), on the app's Office kit. Alone: `office.html`.

**What it shows.** The firm's building cut open at the front, on a little street. A storey per project (walls and parquet border in its tint); a room per team, sized by headcount, the lead at the head desk. Each room has a frosted back door with the kit's brass plaque, a door light (marigold if anyone waits, green if working, dark if quiet), and a whiteboard with the lead's plan (ticks, the arrow where it stands, marigold where it waits) and a dot row per partner. Under each room, a plaque on the slab: light, short name, headcount. Penthouse: your desk, "Now serving 4", the queue of the 4 waiting (3 threads + the Ship release step), oldest nearest the desk; their desks downstairs keep a marigold note and a "lead · upstairs, waits on you" tag. Brass lift on the right. Mezzanine: Ada, Milo, Juno. Ground floor: a bench per live run, a card per step. Basement: the café (no-project threads). Crown: "ROGIER & CO. est. 2026".

**Moments** (`?state=` on office.html; `&moment=<phase>` freezes one for a capture, the window never needs it):
- `spawn`: the secrets room's wall slides (one office to two desks), the new desk drops in, verify rides up in the lift and takes it, then the lead's brief bubble. Phases `start grow ride open walk seated`.
- `exchange`: the newest report in view: cart tests walks to its lead, talks; the lead stands and listens. Phases `start walk talk`.
- `standup`: the 3-D Secure team gathers at its whiteboard, each with a FIRM.standup bubble; the lead comes down with its hand up (still waiting). Phases `start gather speak`.
- `away`: plaques get "new" (team started after 09:01), "+n" (partners joined), "news" (unread result); caption at the top.
- `swarm`: webshop and payments-api wrap onto two storeys each, the ten-person team gets a bullpen, nameplates say "+31 more behind", 9 wait upstairs.

**Best shots** (`?view=`): `room:t3ds`, `room:tCart`, `queue`, `lift`, `storey:<n from the basement>`; default is the whole building. A portrait container gets a lobby directory card over the building (whole-building view only). Captures in `shots/office-*.png`: hero, dark, room, lift, queue, portrait, spawn, spawn-seated, exchange, standup, swarm, away.

**Contract.** `select(id)` takes session ids, assistant names (`Ada`) and run ids (`runShip` goes to its current step). The module calls `onSelect` on a click and `onOpen` on a second click within 450 ms. It flies to a selected bean with the bottom-left 380x150 kept clear. `setState` rebuilds (about 100 ms) and replays the moment. Reduce Motion: moments jump to their end, no glides. Reads `window.FIRM.standup` if present, else the latest headline.

**Controls.** Wheel or vertical drag rides up and down; ctrl-wheel or pinch zooms; right-drag orbits ±34°. ↑/↓ and PgUp/PgDn move one storey; 0 or Home shows the whole building. Click a room to fly in. The lift panel (right edge, P has the waiting badge) jumps between floors. The module does not handle Escape or 1-3.

**Labels by distance.** Far: floor nameplates and plaques (a plaque too narrow for its name shrinks to its light). Mid: queue tags (later ones as marigold pips) and upstairs tags. Near: desk-front name tags ("review · Codex") and full titles on plaques.

**Costs.** The app's stage: draws only while something moves, 30 fps for ambient life, nothing while hidden or after `pause()`. About 740 draw calls and 440k triangles, mostly the kit's furniture (my boxes are merged per material). One canvas texture per team room, redrawn only when its plan changes, the theme changes or fonts load. About 40 labels. At night it adds one ambient light; the two standard lamps are the kit's.

**Limits.** Short names are hand-written (the app would need a short title per thread). Beans walk in straight lines. The lift moves only in `spawn`. Headless capture renders at about 1 fps, so use `&moment=`.
