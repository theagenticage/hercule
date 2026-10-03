# PROTOTYPE - the 3D office

Throwaway code on the branch `prototype/office-3d`. It answers one question:

> What should the Bureau's office look like and feel like as a truly 3D, living place inside the
> desktop app, and how should a fleet that grows from 3 to 140 sessions be laid out in it?

## Run it

```
pnpm office
```

It opens `http://127.0.0.1:5317/specimens/office-prototype/index.html`: the real desktop shell and
sidebar, with the office in the main pane. The bar at the bottom switches the variants (the left
and right arrow keys do too). Every control is kept in the URL, so any view can be shared and
reloaded.

Each part also has a lab page of its own beside `index.html` under `labs/`: `character.html`,
`props.html`, `architecture.html`, `sim.html`, `camera.html` and `tower.html`.

## The variants

All three share the same characters, furniture, architecture kit, sim, camera and panels. They
differ in how the fleet becomes a building.

**A - the Bureau floor** (`variants/bureau*.ts`). The whole office on one storey, organised by
area of the code base:

- Each code area has a room of its own. Rooms are grouped into wings by project; the floor is inlaid
  in the project's colour and a plaque hangs at the door.
- The meta rooms (Your Office, the Case Room, the Post Room, the Library, the Parlour, Records...)
  line the Gallery, the main corridor.
- The front door opens from the street into the Lobby on the south-east corner.
- A pneumatic tube line carries each event's capsule to Triage in the Case Room.
- As the fleet grows, wings get longer and new wings are added.

**B - the Tower** (`variants/tower*.ts`). The fleet as architecture: a slender Art Deco tower seen
in section, like a doll's house with its front cut away.

- The lobby is on the ground floor. Each runner has a storey of its own above it, in fleet order.
- The assistants live in the penthouse under a stepped crown. A brass lift links every storey.
- When you look at one storey (pick a room, or a colleague), the storeys above it lift up and fade
  away, so the camera looks straight into it.
- Growth is vertical: a new runner is a new storey.

**C - the Campus** (`variants/campus*.ts`). A campus of pavilions, one per machine, round a paved
plaza.

- The headquarters closes the plaza's north end: Your Office with its queue, the Case Room where
  Triage sits, the lounge and the records.
- The pavilions stand in two rows down the plaza's long sides, doors on the plaza, the local machine
  first. Each holds its runner's sessions by code area, and grows with the runner's slots.
- The conservatory closes the south end, where the assistants live.
- Pneumatic tubes run behind each row of pavilions to the Case Room.
- Growth is outward: a new runner is a new pavilion.

## What every variant shares

- **Characters** (`kit/character/`). Two styles, switched in the controls:
  - `bean`: the Bureau crew's egg on short legs.
  - `suited`: the same face on a grown-up figure in a suit.

  Both are skinned rigs of 17 bones that walk, sit, type, read, sip tea, sleep and raise a hand.
  Feet stay on the floor.
- **The sim** (`engine/sim.ts`, `engine/nav.ts`). Every colleague runs one short script at a time
  ("stand up, walk to the queue, raise a hand"). Colleagues walk a nav graph through doors and
  corridors, never through walls. An office where nobody walks draws no frames between happenings.
- **Furniture and architecture** (`kit/props/`, `kit/architecture*.ts`). Painted from the Crew
  Bureau 2 palette, so every theme repaints the whole office. Brass is used for trim only, and
  nothing glows.
- **Light** (`engine/stage.ts`). Morning, noon, evening and night. `auto` follows the theme: day in a
  light theme, evening in a dark one. Room lamps switch on in the evening.

## Interaction model

- **Hover** a colleague: it perks up and its name tag shows.
- **Click** a colleague: the camera glides to it and follows it. The dossier card opens with:
  - its face, name and state;
  - what it is asking, with answer buttons;
  - an activity ticker;
  - its thread, room, runner and model.
- **Answer from the card**. The colleague lowers its hand and walks back to its desk.
- **Open thread** (or Enter): the real thread screen slides in as a drawer from the right, without
  leaving the office. Its request dock answers too.
- **A thread in the sidebar** selects that colleague and opens its drawer.
- **The top bar**:
  - Office (overview) and Rooms (a directory grouped by project);
  - the Event flow switch;
  - the counts: each count is a button that selects the next colleague in that state;
  - Simulate (ask, visit, arrive, fail, finish, event);
  - the controls button.

### Keys

| Key | What it does |
|---|---|
| Esc | Steps back one level: controls panel, then drawer, then card and selection, then room |
| Tab / Shift+Tab | Next / previous colleague waiting on you, longest waiting first |
| Enter | Opens the selected colleague's thread |
| `.` | Shows and hides the controls panel |
| Q / E | Turns the building 45 degrees |
| `=` / `-` | Zooms in and out |
| F | Finds the followed colleague again |
| ← / → | Switches the variant (prototype only) |

### Pointer (a Mac trackpad first, a mouse second)

- Two-finger scroll pans. Pinch zooms toward the pointer; a mouse wheel zooms.
- Left-drag grabs the floor. Right-drag or Option-drag orbits.
- Double-click on the floor glides there.
- Walls between the camera and the room in view drop to the dado rail, so you can always see in.

### The controls panel (`.`)

| Control | Values |
|---|---|
| Layout | the three variants, as the bottom bar switches them |
| Theme | the five Bureau themes: Whitehaven, Styles, Orient Express, Nile, End House |
| Time of day | Theme (day in a light theme, evening in a dark one), Morning, Noon, Evening, Night |
| Fleet | Today (16 sessions on 3 runners), Growing (48 on 5), Ten times (142 on 9). Reloads the page |
| Characters | Bean, Suited |
| Name tags | All, Smart, None. Smart shows tags where they help; from far away only the five longest waiting keep a full tag, and the rest become pips |
| Liveliness | Still, Calm, Bustling |
| Quality | Low, Medium, High (High adds ambient occlusion) |
| Event flow | shows and hides the pneumatic tubes |
| Performance readout | frames, CPU time, draw calls and triangles |

## Cost

_Measured at integration._

## Open questions for Rogier

- **Event flow opens on.** The design opens with the tubes hidden (`?flow=on` to show them). The
  prototype shows them by default, so the capsules are seen without looking for a switch.
- **Two counts.** The sidebar's footer counts threads; the top bar counts colleagues, assistants
  included. They can differ by the number of assistants.
- **Room counts in the Rooms menu** count colleagues whose desk is in the room, not who is there
  now. The 3D room tags count who is there now.

## Verdict

_Rogier's call._
