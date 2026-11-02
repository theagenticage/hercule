# The Office kit - the real 3D Office, for drawings

PROTOTYPE. `vendor/office-kit.js` is the desktop app's own 3D Office code, bundled for plain
HTML pages: the bean colleagues, the Art Deco props, the architecture, the palette that paints
them from the CSS tokens, and the app's stage with its lights and render loop, on three.js
0.186.1 (the version `apps/desktop/package.json` pins). A small helper layer on top replaces
what the app drives with its simulation and camera rig. Open `vendor/demo.html` to see it.

| File | What |
|---|---|
| `vendor/office-kit.js` | the bundle: one classic script, 943 KiB (258 KiB gzipped). Generated, never edit it |
| `vendor/office-kit-entry.ts` | its source: the imports from `apps/desktop/src/renderer/office` and the helper layer |
| `vendor/build-office-kit.ts` | the build (see "Rebuilding" below) |
| `vendor/demo.html` | one project room as the app lays it out; `?theme=orient-express` for the evening |

## Including it

The script defines two globals, `THREE` (all of three.js) and `OfficeKit`. It is not a module,
so a page works over http and from `file://` alike. In `<name>/desktop.html` or `<name>/office.html`:

```html
<html lang="en" data-theme="whitehaven">
  <head>
    <script src="../../shared/page.js"></script>           <!-- ?theme= sets data-theme -->
    <link rel="stylesheet" href="../../crew-bureau-2/tokens.css" />
  </head>
  <body>
    ...
    <script src="../vendor/office-kit.js"></script>
    <script src="<name>-office.js"></script>
  </body>
</html>
```

The palette reads the tokens on `<html>`; without `tokens.css` the kit puts its own copy of the
app's tokens (no fonts) first in `<head>`.

## A scene in 30 lines

```js
var K = OfficeKit;
var stage = K.stage.create(document.getElementById("office"));   // a sized, empty element
stage.add(K.buildRoom({ width: 8, depth: 5.6, tint: "payments", door: { wall: "south", at: 2 } }));

var beans = [];
["Fix 3-D Secure", "Ledger export", "Refund rules"].forEach(function (name, i) {
  var desk = K.buildDesk();
  desk.object.rotation.y = Math.PI;               // the sitter faces south, toward the camera
  desk.object.position.set(-1.28 + i * 1.28, 0, -1);
  stage.add(desk.object);
  var pose = i === 2 ? "waiting" : "working";
  var bean = K.colleague({ id: "thread-" + i, pose: pose });
  bean.sitAt(desk);                              // types; a waiting one stands beside, hand up
  stage.add(bean);
  beans.push(bean);
  stage.label(bean, K.tag({ name: name, state: pose === "waiting" ? "Run git push?" : "typing",
    hue: bean.look.hue, waiting: pose === "waiting" }));
});

var palm = K.buildPlant("tall");
palm.position.set(3.5, 0, -2.3);
stage.add(palm);
var lamp = K.buildFloorLamp();                   // lights up by itself in a dark theme
lamp.object.position.set(3.6, 0, 2);
stage.add(lamp.object);

stage.onPick(beans, function (bean) {          // click a bean: select it and glide to it
  beans.forEach(function (each) { each.rig.setSelected(each === bean); });
  stage.flyTo(bean, 6, { azimuth: 28, elevation: 30 });
});
```

Units are metres. +y is up, -z is north, +x is east. A builder's object stands on the floor
(y = 0) at the middle of its footprint, its front facing +z, unless the table below says
otherwise. The camera opens from the south-east, as the app's does.

## The stage: `OfficeKit.stage.create(container, options)`

Options, all optional:

- `theme`: sets `<html data-theme>` ("whitehaven", "orient-express", or any theme of tokens.css).
  Leave it out to follow the page, which `page.js` sets from `?theme=`.
- `camera`: `"perspective"` (default, the app's 28 degree lens) or `"iso"` (a 12 degree long
  lens: nearly parallel lines, the camera about 2.4 times farther away).
- `view`: the first view, `{ target: [x, y, z], distance, azimuth, elevation }` in metres and
  degrees. Without it the stage frames everything on its first frame, as the app frames a room.
- `controls`: `false` turns off the camera controls.

It returns a stage:

| Member | What it does |
|---|---|
| `scene`, `camera`, `renderer` | three.js objects. The camera is a `PerspectiveCamera` |
| `controls` | three's `OrbitControls`, mapped as the app's camera: drag pans along the floor, right-drag or shift-drag orbits, wheel and pinch zoom toward the pointer; one finger pans, two pinch and turn. Elevation 18 to 72 degrees |
| `building` | the still building: everything added that is not a colleague |
| `stage` | the app's own `Stage` instance (`sun`, `sky`, `applyTheme()`, `requestRender()`) |
| `add(object, ...more)` | adds objects. A colleague joins the scene and animates; anything else joins the still building. Returns the first object |
| `remove(object)` | takes it out again |
| `onFrame(fn)` | calls `fn({ dt, time })` (seconds) before each drawn frame. Return `true` while you animate something. Returns a function that removes `fn` |
| `requestRender()` | draws one frame. Call it after changing the scene outside `onFrame` |
| `view(view)` | places the camera at once |
| `frame(object?, { azimuth, elevation })` | fits `object` (default: the building) in the canvas, from 38 and 52 degrees by default. Returns the view, so you can fly back to it |
| `flyTo(target, distance?, { azimuth, elevation, seconds })` | glides to an object, a colleague (its chest) or `[x, y, z]`, keeping the angles you leave out. Returns a Promise |
| `label(target, html, { offset, className })` | draws an HTML string or element over an object, a colleague (over its head, as the app's name tags) or a point, every frame. `offset` lifts it in metres, or moves it by `[x, y, z]`. Returns `{ element, setContent(html), remove() }` |
| `onPick(objects, fn)` | calls `fn(object, hit, event)` on a click or tap on one of `objects` or anything inside it; the nearest hit wins, a drag is not a click. The pointer turns into a hand over them. Returns a function that stops it |
| `pause()`, `resume()` | stop and restart all animation and drawing, for a mode the window hides |
| `dispose()` | frees the WebGL context, the labels and the colleagues |

A label gets the class `office-kit-label`, sits centred above its point (`translate: -50%
-100%`), and loses its `is-shown` class while the point is off the canvas or behind the camera.
Pointer events go through to the canvas unless you give a label `pointer-events: auto`.

`OfficeKit.tag({ name, state, hue, waiting })` returns the app's name tag (`.office-tag`, from
`engine/overlay.css`, which the kit loads): the hue dot, the name in bold and the state in
`--faint`, marigold when `waiting`. Add `is-selected` or `is-hovered` to it as the app does.

`OfficeKit.buildRoom({ width, depth, tint, windows, door })` builds a project room's shell
as the Bureau does: the parquet floor with its Deco border inlaid in the project's tint
(`"webshop"`, `"payments"`, `"ops"`, or `null`), windows on the north wall (default on), a
doorway (`{ wall: "south", at: 0, width: 1.0 }` by default, `null` for none), and four walls
the stage lowers to the dado rail when they stand between the camera and the room (the app's
rule). Width and depth run wall middle to wall middle; the origin is the middle of the floor.

### Fitting the Office module contract (BUILDERS.md)

- `mount(container, api)`: `OfficeKit.setAmbientMotion(!api.reducedMotion)`, then
  `OfficeKit.stage.create(container)` and build. The theme needs nothing: the stage follows
  `<html data-theme>`, which the window sets.
- `select(id)`: `rig.setSelected` on the bean, `stage.flyTo(bean, 6)`; null flies back to the
  view `frame()` returned. `onPick` gives you the bean to pass to `api.onSelect`.
- `pause()`, `resume()`, `dispose()`: the stage's own. `resize()` does nothing: the stage watches its element.
- Leave the bottom-left 380 x 150 for the window's selection card: aim `flyTo` a little left
  of and below the bean, or frame with room to spare.

## Colleagues: `OfficeKit.colleague({ id, kind, pose, action, look })`

Returns a three.js `Group` that is the app's bean rig with its contact shadow, plus:

- `colleagueId`, `look`, `pose`, `action`, `headHeight`, and `rig` (the app's `ColleagueRig`);
- `setPose(pose)`: changes the face and what the body does (table below);
- `play(action)`: plays an action whatever the pose; `play(null)` goes back to the pose's;
- `sitAt(seat, index?)`: sits on a desk (`buildDesk()` and the other desks), an armchair, seat
  `index` of a bench or a table, or a seat marker. Place the seat first;
- `standAt(x, z, facing?)`: stands there at once. `facing` is a yaw in radians, 0 faces +z;
- `walkTo(x, z, facing?, speed?)`: walks there in a straight line (1.35 m/s, the app's pace),
  then turns to `facing`. Returns a Promise; a new walk or seat ends the old one;
- `update(frame)`: the stage calls it. Call it yourself only without a stage.

`kind` picks the headwear, as the app does: `"thread"` (default) is bare-headed, `"run"` wears
a clerk's visor, `"agent"` a flat cap, `"assistant"` a cloche, beret or headset. The `id` seeds
the rest, exactly as the app hashes a session id: one of 8 hues (iris, teal, orchid, lime, sky,
peach, mint, grape), 4 shapes (egg, tall, round, wide) and 8 wardrobes (nothing, homburg,
bowtie, tache, monocle, watch, glasses, tache and bowtie). `look` overrides any of it:
`{ hue: "teal" }`, or `look: OfficeKit.HERCULE_LOOK` for Hercule himself.

What a pose does, as the app's sim decides it:

| Pose | At a desk | In an armchair or on a bench | Standing |
|---|---|---|---|
| `working` (default) | types; the banker's lamp is lit | reads a newspaper | stands |
| `waiting` | steps beside the desk, raises the marigold palm; a marigold note lies on the desk | steps beside the seat, raises a hand | raises a hand |
| `idle`, `done` | sips tisane, cup and saucer in hand and a cup on the desk | sips | stands |
| `asleep`, `away` | dozes, head tilted | dozes | stands |

Each pose has its own face; `away` wears an enamel badge and `asleep` closes the eyes. A seated
colleague that starts or stops waiting walks to or from the spot beside its seat.

Actions for `play`: `stand`, `walk` (walks in place unless it moves), `sit`, `type`, `read`,
`sip`, `raise-hand`, `talk`, `listen`, `hop` (one hop, 0.62 s, then stands), `doze`, `stretch`
(2.4 s, then stands). Sitting actions need a seat under the colleague. The rig itself also
has `rig.lookAt(point | null)` (turns the head), `rig.setHovered(bool)` (perks up and glances
at the camera) and `rig.setSelected(bool)` (the green selection ring on the floor).

`OfficeKit.setAmbientMotion(false)` stops breathing, typing and glances for every colleague;
the stage turns it off by itself when the system asks to reduce motion.

## Props and architecture

Every builder of `kit/props` and `kit/architecture`, measured (width x height x depth, metres).
"Wall" pieces have their back at z = 0, to hang on a wall's inner face: put them at the wall's
line plus `OfficeKit.WALL_THICKNESS / 2 + 0.002`, turned to face into the room.

| Builder | What | Size |
|---|---|---|
| `buildDesk()` | a clerk's desk, chair, green banker's lamp, typewriter. The sitter faces -z: turn it by `Math.PI`. Returns `{ object, seatMarker, setLamp, setNote, setCup }` | 1.2 x 0.95 x 1.43 |
| `buildWritingDesk()` | an assistant's slimmer writing desk, pad, inkwell, lamp. Same handle | 1.0 x 0.95 x 1.28 |
| `buildYourDesk()` | the user's partner desk with brass bell and in-tray; its chair is on -z, so the user faces +z. Same handle | 2.06 x 0.95 x 1.68 |
| `buildArmchair()` | a green club armchair, the sitter faces +z. `{ object, seatMarker }` | 0.89 x 0.78 x 0.71 |
| `buildBench(seats)` | a waiting bench, seats 0.6 apart. `{ object, seatMarkers }` | seats x 0.6 + 0.12 x 0.88 x 0.57 |
| `buildLongTable(seats, chairsUp)` | the café's marble table, bentwood chairs on its north side. `{ object, seatMarkers }` | seats x 0.62 + 0.2 x 0.92 x 1.05 |
| `buildRoundTable(chairsUp)` | the café's table for one. `{ object, seatMarkers }` | 0.62 x 0.79 x 1.09 |
| `buildPicnicTable()` | a picnic table with two benches, for a lawn | 1.8 x 0.77 x 1.49 |
| `buildCounter(length)` | the café's zinc counter: till, taps, croissants, espresso machine | length + 0.08 x 1.76 x 0.68 |
| `buildBackBar(length)` | the mirror and bottle shelves behind the counter | length x 2.34 x 0.42 |
| `buildChalkboard()` | an A-frame pavement board | 0.5 x 0.84 x 0.21 |
| `buildBookcase()` | an empty Deco bookcase | 0.84 x 1.51 x 0.35 |
| `buildCabinet()` | a four-drawer filing cabinet with brass pulls | 0.52 x 1.3 x 0.62 |
| `buildCoatStand()` | a coat stand with a camel coat and a homburg | 0.37 x 1.65 x 0.38 |
| `buildTeaTrolley()` | a tea trolley with pot, cups and plates | 0.72 x 0.9 x 0.44 |
| `buildPlant("small" \| "tall")` | an aspidistra, or a kentia palm, in a lacquered planter | 0.68 x 0.71 x 0.85 / 1.27 x 1.38 x 1.23 |
| `buildRug(w, d, { medallion })` | a Deco rug with a fringe; walkable, casts no shadow | w + 0.08 x 0.01 x d |
| `buildFloorLamp()` | a standard lamp; the stage lights it in a dark theme. `{ object, setOn }` | 0.44 x 1.58 x 0.44 |
| `buildLongcaseClock()` | a longcase clock. `{ object, hands, setTime(date) }`: see limits | 0.52 x 2.16 x 0.34 |
| `buildCaseBoard(width)` | Triage's cork case board, wall, frame from y 0.74 to 2.08 | width + 0.04 x 1.34 x 0.1 |
| `buildNowServing()` | the "Now serving" sign, wall, bottom at y 0. `{ object, setNumber(n) }` | 0.92 x 0.41 x 0.05 |
| `buildWallClock()` | the sunburst clock, wall, centre at y 0 | 0.65 x 0.65 x 0.06 |
| `buildPoster(0 \| 1)` | a framed Deco poster, wall | 0.56 x 0.78 x 0.03 |
| `buildAwning(width)` | a striped café awning, wall, origin at its top | width x 0.77 x 0.86 |
| `buildBladeSign(name)` | a blade sign on an iron bracket, wall; its faces look along x | 0.13 x 0.53 x 1.02 |
| `buildPlaque(text, { hue })` | a brass room plaque, cream capitals on enamel, wall, centre at y 0 (the app hangs it at 1.42) | letters x 0.04 + 0.12 x 0.17 |
| `buildFloor(w, d, { inlay, tiles })` | parquet with a brass-edged Deco border; `inlay` is a token such as `"proj-ops"`; `tiles` lays café tiles | w x 0.1 slab x d |
| `buildWall(length, { height, doors, windows, cutaway })` | a panelled wall along x, outward side +z. `doors: [{ at, width }]`; `cutaway: { roomId, exterior }` lets the stage lower it | length x 2.6 x 0.12 |
| `buildLamppost()`, `buildPath(w, l)`, `buildLawn(w, d)`, `buildSideStreet(w, l, crossingAt, crossing)` | the street outside the Bureau | lamppost 2.46 tall |

The scale: `SEAT_HEIGHT` 0.42, `DESK_HEIGHT` 0.7, `WALL_HEIGHT` 2.6, `WALL_THICKNESS` 0.12,
`CUTAWAY_HEIGHT` 0.55 (the dado rail), `WALK_SPEED` 1.35. A colleague's head tops out about 1.0
standing and 1.2 seated. The app puts one piece of work's desks 0.08 apart, 0.5 between pieces
of work, and 0.9 of aisle behind a row of chairs (`maps/bureau-rooms.ts`).

Lower level, for your own pieces: `buildColleagueRig({ id, look })` (the bare rig; add
`addContactShadow(rig.object)` and call `rig.update(frame)` yourself), the looks (`buildLook`,
`buildSessionLook`, `buildAssistantLook`, `hashSeed`, `HUES`, `SHAPES`, `WARDROBE`, `HEADWEAR`),
and the palette: `paint(token, finish, shift)` returns the shared material of a token in a
finish (`matte`, `satin`, `gloss`, `lacquer`, `brass`, `metal`, `fabric`, `paper`, `glass`,
`vinyl`, `glow`) that repaints with the theme; `paintHue(hue, part, finish)`; `readColor(token)`
returns a three `Color`; `readHue`, `readToken`, `writeOklch`, `refreshPalette`,
`subscribePalette(fn)`, `isDarkTheme()`. Tokens are the `--room-*` family (`room-floor`,
`room-wood`, `room-desk`, `room-fabric`, `room-lamp`, ...), `brass`, `accent`, `you`, `fail`, `ok`,
`proj-webshop|payments|ops`, `bg`, `surface`, `ink` and a few more (`engine/palette.ts`).
Also exposed: `OrbitControls`, `Stage` (the app's class), `clearCaches`, `threeRevision`.

## Light and theme

The stage is the app's `engine/stage.ts`, unchanged: a `WebGLRenderer` without its own
antialiasing that draws through a 4x multisampled half-float target and an output pass;
sRGB output; neutral tone mapping at exposure 1; pixel ratio at most 2; a `RoomEnvironment`
reflection map; a hemisphere sky light (its sky in `--room-sun`'s hue, its ground in
`--room-floor`'s); one sun with a 4096 PCF shadow map fitted to everything added; the
background is `--surface`; no fog. A light theme is drawn as morning (sun from the north-east,
24 degrees up), a dark theme as evening (sun low from the west, warmer, standard lamps and
window panes lit), read from the theme's `color-scheme`: Whitehaven is morning, Orient Express
evening. Changing `<html data-theme>` repaints every material, sign and lamp live: no rebuild,
no reload.

## Performance rules

- The stage draws on demand: only while something moves (a colleague's ambient life, a walk,
  a camera glide, a lowering wall) or after `requestRender()`. Ambient life draws at most 30
  frames a second; a moving camera 60. With colleagues on stage and ambient motion on, that is
  a steady 30 fps, as in the app; with it off, the stage stops once everyone has settled.
- Nothing draws while the tab is hidden (`document.hidden`) or the stage's element is off
  screen. Call `pause()` when your mode is hidden and `resume()` when it shows again.
- The still building's shadows are drawn once and again only when something in it changes.
  So build props once and move or hide them; never rebuild them per frame. Anything you
  animate yourself belongs in `scene`, not in `add`, and must not cast the sun's shadow
  (`castShadow = false`), or its shadow stays behind.
- **No `backdrop-filter` over the canvas.** A blur over a live canvas makes Chromium composite
  the whole window on every frame. Use a solid or translucent fill (`--raised`,
  `--glass-fill-raised`) for anything that floats over the Office. The kit turns the blur off
  for the app's room labels for this reason.
- One stage per page. Each is a WebGL context with a 4096 by 4096 shadow map, about 64 MB of
  GPU memory.
- Keep labels few and short; each is a DOM element moved every frame (no layout reads).

## Known limits

- **No simulation.** The app's sim (`engine/sim.ts`) needs the whole Office (a map, a nav
  graph, the world), so it is not bundled. Colleagues do what you tell them: no queue at Your
  Office, no lounge wandering, no tea runs, no visits, no arrivals from the street. `walkTo`
  goes in a straight line, through furniture.
- **Not the app's camera rig.** OrbitControls with the app's mouse map and limits, not its
  spring glides, double-click glide or keyboard turns. `iso` is a long lens, not a true
  orthographic camera.
- **Labels are plain.** The app's overlay hides a tag behind a wall, keeps tags inside the
  window, moves overlapping tags apart and shows room labels from afar. `label` does none of
  that: lay the scene out so tags do not collide.
- **Picking hits meshes.** The app picks a colleague generously, from the line between its feet
  and head; here a far-away bean is a small target.
- **Hung pieces stay up when a wall drops.** `buildRoom` lowers the walls that face the camera;
  a clock hung on one would float. Hang things on the far walls (north and west by default).
- **The longcase clock's hands** live outside its object: after placing the clock, call
  `clock.hands.applyMatrix4(clock.object.matrixWorld)`, `stage.scene.add(clock.hands)` and
  `clock.setTime(new Date())`.
- **Headless screenshots are slow motion.** SwiftShader draws about 4 frames a second and each
  frame advances at most 1/20 s, so a 1 s walk takes 5 s to shoot. Give 3D pages `--wait 3000`
  or more; `/tmp/ovtools/shot.mjs` and `act.mjs` render WebGL as they are.

## Rebuilding

When the app's Office code changes, rebuild rather than edit the bundle:

```
mkdir -p /tmp/ovtools/kitbuild && cd /tmp/ovtools/kitbuild && bun add three@0.186.1   # once
bun docs/design/overview-directions/vendor/build-office-kit.ts                       # from the repo root
```

It fails if that three.js is not the version `apps/desktop` pins. Bun (`.bun-version`) bundles
it minified as an IIFE; one plugin does what Vite does for the app: `three` resolves to that copy,
`?raw` imports become the file's text, and `@hercule/*` resolves to an empty module (the Office
kit imports only types from it).
