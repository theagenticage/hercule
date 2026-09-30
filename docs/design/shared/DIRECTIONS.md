# The ten directions

PROTOTYPE. One section per design. Each is a *starting point*, not a spec: you own your design and
may rename it, pick other fonts or theme names, and push the idea further - as long as it stays
recognizably the direction below and stays **far from the other nine**. Each section ends with
"Don't become": the neighbours you must not drift toward.

Every design answers the same question differently: **when the user's attention is the scarcest
resource and agents come in swarms, what is the one organizing idea of the interface?**

---

## 01-docket - Docket

**Thesis: the unit of the interface is a decision.**

Everything that needs Rogier becomes a card on one docket: Proposals, Offers, unsure items, tripped
breakers, Requests from sessions, questions. Home is the docket - a stack with one card in focus,
"1 of 14", and its answers as big keyboard verbs (`Y` Start "Fix bug" · `A` Accept · `D` Dismiss ·
`→` later). Decisions have a speed: you can clear a morning's docket in 90 seconds, and the design
measures and celebrates that ("14 decided in 1m 52s"). Everything else (transcripts, settings) is
reference material one step away.

- **Look**: Swiss / International Typographic Style. Crisp grid, strong numerals, flush-left,
  generous white space, hairlines. Color is **verdict color**: go (a confident green), hold/ask
  (amber), no-go (vermilion), plus one ink accent. Decision *kinds* get a colored corner tab
  (Proposal, Offer, Request, Breaker, Unsure).
- **Signature**: the docket stack - a focused card over a slight fan of the cards behind it, with a
  count and a progress rail of verdicts already given (a row of small colored ticks).
- **Motion**: decisive. A card flies off in the direction of its verdict (right = go, left =
  dismiss, down = later). 180ms, no bounce.
- **Themes (suggested)**: Paper (light, flagship), Bond (light, cool-neutral), Graphite (dark,
  flagship, near-achromatic), Oxblood (dark, deep red-brown ground), Moss (dark, green-black).
- **Fonts**: Geist + Geist Mono (fontsource ids `geist`, `geist-mono`), or Inter Tight.
- **Office**: agents walk up to Rogier's desk holding cards; the height of the paper tray on the
  desk is the size of the docket. Agents with nothing to ask work at their own desks.
- **Desktop**: a global hotkey (`⌥Space`) opens a floating docket HUD over any app; answer with one
  key. **Web**: `decision.html` is one docket card as a page. **Mobile**: swipe decisions (Tinder
  mechanics, but serious), with haptic ticks; lock-screen notifications carry the verbs.
- **Trades away**: browsing and overview. Docket is a to-do machine, not a map.
- **Don't become**: Console (keyboard is a means here, not the identity; no monospace UI) or
  Concierge (no conversation framing).

---

## 02-metro - Metro

**Thesis: every piece of work travels a line.**

Provenance is Hercule's superpower ("made from"), so draw it. Each Connection is a colored **line**
(Sentry line, Gmail line, PostHog line...). Events ride their lines into the **Triage interchange**;
Proposals are **stations** where lines meet (the lead Proposal is an interchange of four lines:
Sentry, Gmail, PostHog, GitHub). Accepted work continues along a line: Proposal → Task → Run →
Session → pull request, each a station with a state. Intake is a live network map; every item's
row starts with its little line diagram. A Session page shows where it came from as a line at the
top ("Sentry + Gmail + PostHog → Proposal → this Thread → PR").

- **Look**: transit signage (think Vignelli, Calvert, Beck). Enamel-sign clarity, rounded line
  ends, station ticks, interchange rings, bold line colors on calm grounds. Color doctrine: **color
  = source line** (each Connection owns a hue); state uses shape (open ring = waiting, filled =
  done, pulse = working, cross = failed) plus a restrained state color.
- **Signature**: the line diagram - colored strokes with station dots - appearing everywhere from
  a 24px row glyph to a full-screen map.
- **Motion**: small dots ("trains") travel along lines as events arrive; a decision "switches the
  points".
- **Themes**: Enamel (light, flagship, white), Tile (light, cream), Night Service (dark, flagship,
  warm charcoal), Underground (dark, brown-black), Signal (dark, near-black with a high-vis
  accent).
- **Fonts**: Overpass + Overpass Mono (`overpass`, `overpass-mono`), or Public Sans.
- **Office**: an isometric office whose floor has colored guidance lines (hospital-corridor style)
  from the mailroom/triage desk to each agent's desk; items travel along them.
- **Desktop**: a live network map as a second window / a floating "departures board" of what is
  running. **Web**: shareable map of one Proposal's lineage. **Mobile**: a vertical line layout
  (like a single metro line on a platform display), the lock screen as a departures board.
- **Trades away**: density of pure text lists; needs discipline so lines don't become noise.
- **Don't become**: Spectrum (color = source here, not project; the chrome is not tinted) or Tide
  (lines are topology, not a time axis).

---

## 03-aurora - Aurora

**Thesis: calm glass, living light.**

The interface is frosted glass panes over a soft ambient **light field**. The field's color and
movement *is* the system's mood: a slow cool-green drift when all is well, warming to amber as
decisions pile up, a red bloom when something burns. Light comes **from the direction** of what
needs you: the Intake entry glows, a waiting session's card is lit from behind, the composer's
Request dock is the brightest object on screen. You feel the state before you read anything. The
most native-desktop design: vibrancy, layered depth, and the glass composer that shrinks and clears
as you scroll is the purest expression of the idea.

- **Look**: visionOS / macOS vibrancy, restrained. Big soft radii, luminous edges (1px inner light
  borders), deep blurred backdrops, generous space. Type is quiet; light carries hierarchy. Color
  doctrine: **color = urgency as light** (calm aurora green → amber → coral), plus project tints in
  the ambient field when you're inside a project.
- **Signature**: the light field and the "glow toward attention".
- **Motion**: slow ambient drift (≤ 0.2 Hz, disabled for reduced motion), soft depth transitions;
  panes rise and settle.
- **Themes**: Dawn (light, flagship, pearl), Mist (light, sage-grey), Dusk (dark, flagship,
  plum-violet night), Boreal (dark, deep green-black), Ember (dark, warm cocoa). Must also work with
  reduced transparency (solid fallbacks).
- **Fonts**: Figtree or Manrope (`figtree`, `manrope`) + a mono (`jetbrains-mono` or
  `geist-mono`).
- **Office**: a glass pavilion at night; rooms glow with their agent's state light; the whole
  scene is lit by the same aurora field.
- **Desktop**: translucent sidebar, a menu-bar glow, native notification banners in glass.
  **Web**: the field works in the browser too, with graceful fallbacks. **Mobile**: lock screen
  and Dynamic Island glowing with the field color.
- **Trades away**: raw density and some contrast headroom; must stay legible.
- **Don't become**: Halo (no ring glyph as identity) or Tide (no time axis).

---

## 04-tide - Tide

**Thesis: time is the interface.**

Every piece of work has a when. Tide lays the system along time with a bright **Now line**: to the
left, what happened (runs, turns, triage passes - the Check-in view); at Now, what needs you; to the
right, what's scheduled (triage at 11:00, Ada's heartbeat every hour, Friday's SSL reminder, the
04:00 backup, rotations). Swimlanes per project (or per agent) show sessions as bars that are still
growing. Intake is "the tide that came in since you last checked" - arrivals stacked at the Now
line, sized by weight. You always know what just happened and what is about to.

- **Look**: nautical charts and tide tables, softened: sand, kelp, coral, sea-glass. Thin rules,
  tabular numerals, gentle curves, lots of air. Color doctrine: **color = time and rhythm** (past
  desaturated, Now vivid coral, future a cool sea-glass outline) plus project lane colors.
- **Signature**: the Now line - a vertical coral line that every time-based view shares, with the
  current time on a small tab. It even appears in the Session page (the live turn sits on it) and
  in the composer ("runs next").
- **Motion**: the Now line advances in real time; scheduled items drift toward it and "land".
- **Themes**: Sand (light, flagship), Shell (light, pale pink-white), Kelp (dark, flagship,
  green-black), Driftwood (dark, warm brown-grey), Low Tide (dark, near-neutral grey-green).
- **Fonts**: Sora + DM Mono (`sora`, `dm-mono`).
- **Office**: the office follows a day/night cycle; windows show the sky at the current time;
  sleeping agents' desks are dark; a big wall clock shows the next scheduled triage.
- **Desktop**: a timeline strip as a menu-bar dropdown ("next: triage 11:00"). **Web**: timeline
  with lanes. **Mobile**: time runs **vertically** (now at the top, scroll down into the past, pull
  up for what's next); the lock screen shows a mini timeline.
- **Trades away**: pure priority ordering - urgent-but-old items must still float to Now.
- **Don't become**: Metro (lanes are time, not topology) or Aurora.

---

## 05-postmark - Postmark

**Thesis: everything that arrives gets stamped.**

Hercule is a sorting office for work: thousands of events arrive, triage stamps each one (→ task,
offer, FYI, unsure, known, held, no action). Postmark makes that literal and tactile: paper-and-ink
materials, real **rubber-stamp** marks (slightly rotated, ink texture drawn with SVG), each
Connection a **postage stamp** with its own illustration and color, perforation lines and
tear-offs as dividers instead of boxes. Proposals are envelopes with the stamps of every source
that made them; accepting one "franks" it. It is warm, human and unmistakable - and the stamp
vocabulary is exactly the triage vocabulary, so the metaphor teaches the product.

- **Look**: mid-century stationery, crisp and modern, never kitsch or brown-grungy. Off-white paper,
  ink colors (post red, stamp green, ink violet, ochre), mono typewriter details for ids. Color
  doctrine: **color = stamp** (each triage outcome and each Connection has an ink color).
- **Signature**: the stamp - ink-textured, slightly rotated, used for states, outcomes and the
  Hercule logo itself (a postmark-style roundel).
- **Motion**: the stamp "thunk" (scale 1.15 → 1 with a tiny rotation, 120ms) when a decision is
  made; items slide like paper.
- **Themes**: Manila (light, flagship), Newsprint (light, grey-white), Carbon (dark, flagship,
  carbon-paper black with a hint of violet), Oxide (dark, red-brown), Bottle (dark, deep bottle
  green).
- **Fonts**: Archivo + Archivo Narrow (`archivo`, `archivo-narrow`) + IBM Plex Mono
  (`ibm-plex-mono`).
- **Office**: a mailroom / sorting office: pigeonholes per agent, a conveyor from the Connections'
  post slots through the triage desk; agents at desks behind.
- **Desktop**: stamps as dock badges and menu-bar icon states. **Web**: `decision.html` as a letter
  on the desk. **Mobile**: notifications as postcards; swipe to stamp.
- **Trades away**: some neutrality; the metaphor must never slow down a decision.
- **Don't become**: Docket (Postmark is about provenance and sorting, not a single-card focus
  flow) or Concierge.

---

## 06-halo - Halo

**Thesis: glance, don't read.**

One glyph tells the whole state of the swarm: the **Halo**, a segmented ring. Each segment is a
live session colored by state (working, idle, waiting on you, failed); a bright **notch** marks
decisions waiting and points at the most urgent one; the center shows the one number that matters
("3"). The halo lives everywhere you already look: the menu bar, the Dynamic Island, the lock
screen, the watch, the favicon, the dock icon. The full app is the halo **expanded**: Intake,
sessions and assistants are rings and arcs you open into, then conventional detail. Designed for
people who should spend 5 seconds a day in the app and still be in control.

- **Look**: Braun / watch-complication precision, instrument-like, crisp. Circles and arcs as the
  shape language; tabular numerals; minimal chrome. Color doctrine: **color = state** in a vivid,
  carefully tuned set (working = electric lime or aqua-green, waiting = sodium orange, failed =
  red, idle = neutral), accessible because every state also has a segment pattern.
- **Signature**: the Halo glyph, from 16px (favicon) to a 500px hero on the home screen.
- **Motion**: segments sweep in, the notch breathes gently when something waits, working segments
  shimmer.
- **Themes**: Daylight (light, flagship), Porcelain (light, warm white), Eclipse (dark, flagship,
  true neutral black-grey), Umber (dark, warm), Orchid (dark, violet-black).
- **Fonts**: Outfit or Plus Jakarta Sans (`outfit`, `plus-jakarta-sans`) + Geist Mono.
- **Office**: a round office - desks in a ring under a big ring light whose segments are the
  agents; the halo, in 3D.
- **Desktop**: menu-bar halo with a popover; notch-area "island" for live sessions. **Web**: the
  favicon and tab title are live halos. **Mobile**: lock screen and Dynamic Island are the primary
  surfaces; the app opens on the halo.
- **Trades away**: the ring must be learned; detail is always one step deeper.
- **Don't become**: Aurora (no atmospheric glass as identity) or Crew.

---

## 07-crew - Crew

**Thesis: your agents are colleagues.**

People are wired to track people, not rows. Crew gives every agent, assistant and workflow a
**character**: a friendly geometric avatar with a signature color, generated from its name
(assistants are hand-picked: Ada, Milo, Juno). Presence is shown *on* the character - focused eyes
while working, a raised hand when it waits on Rogier, closed eyes when asleep, a small bandage when
it failed. The **3D office is the home screen**; the roster is its list alternative. Intake is the
crew's morning stand-up: who found what, who needs a call. Sessions read like working with a
colleague. It makes 140 agents manageable the way a manager handles a big team: by faces and roles.

- **Look**: warm, rounded, playful-but-professional (think a Pixar-grade toy set meets Linear's
  precision). Chunky soft shapes, friendly type, bright character colors on calm grounds. Color
  doctrine: **color = who** (each agent's signature hue); state is a pose/badge, not a color.
- **Signature**: the character avatars and their poses.
- **Motion**: small character animations (blink, wave, typing hands) - subtle, disableable.
- **Themes**: Studio (light, flagship), Sunroom (light, warm), Cocoa (dark, flagship, warm
  brown-black), Pine (dark, green), Plum (dark, violet-red).
- **Fonts**: Bricolage Grotesque (`bricolage-grotesque`) + a friendly mono (`jetbrains-mono` or
  `dm-mono`).
- **Office**: the home. A cute isometric office with desks per project, the assistants' lounge,
  a triage desk where the Triage agent sorts mail, and Rogier's desk with a queue of colleagues
  waiting to ask something.
- **Desktop**: characters in native notifications and the menu bar ("Ada is waiting"). **Web**:
  shareable stand-up page. **Mobile**: the crew as a stack of faces; tap a waiting face to answer.
- **Trades away**: seriousness headroom; must never feel childish, and the list view must be first
  class.
- **Don't become**: Concierge (Crew is many faces, no single mediator) or Docket.
- **Spec change to declare**: home screen is the office/roster instead of the Threads face or
  Intake.

---

## 08-console - Console

**Thesis: keyboard at the speed of thought.**

For the power user running a swarm, the fastest interface is a keyboard-first one with instant
feedback. Console's primary navigation is the **command bar** (⌘K is the front door, not a
shortcut); screens are **tiled panes** you can split, stack and close (Intake left, a live session
right, a run's log below); a **status line** along the bottom shows the swarm at a glance
(`23 live · 8 working · 3 waiting · build-box-1 at cap · triage 11:00`). Every action shows its key.
Decisions are verbs: `a` accept, `s` start, `d` dismiss, `.` repeat. Themes are a whole ecosystem,
like terminals: each theme brings an ANSI-style 16-color palette used for syntax, diffs, sources
and states.

- **Look**: modern TUI (lazygit, helix, Warp) - grid-aligned, dense but rhythmic, sharp 4px radii,
  mono for data and chrome, sans for prose. Color doctrine: **color = syntax**: a consistent
  16-color palette per theme maps to states, sources and diffs.
- **Signature**: the status line + keycaps, and the tiled panes.
- **Motion**: instant (≤ 90ms), no easing theatrics; a cursor-like focus ring moves between panes.
- **Themes**: Phosphor (dark, flagship, green-black), Graphite (dark, neutral), Ember (dark, warm
  brown), Paper Tape (light, flagship, warm white), Porcelain (light, cool-neutral).
- **Fonts**: JetBrains Mono (`jetbrains-mono`) + Geist (`geist`) for prose.
- **Office**: a voxel / pixel-art isometric office (think a cozy retro game): pixel agents at
  pixel desks with CRT glows in theme colors.
- **Desktop**: pop-out panes as windows, global command bar. **Web**: URL = pane layout, shareable.
  **Mobile**: a command bar at the bottom with a verb row above the keyboard; panes become a
  swipeable stack.
- **Trades away**: approachability for newcomers; must keep labels and discoverability.
- **Don't become**: Docket (Console is about navigation and multitasking, not one decision flow).

---

## 09-spectrum - Spectrum

**Thesis: color is context.**

Rogier works across projects and the swarm spans them all. Spectrum gives each **Project a hue**,
and the whole chrome takes on the hue of where you are (Arc-style spaces): enter webshop and the
window warms to its tangerine; switch to payments-api and it turns violet; ops is green. Across the
app, the fleet is a **spectrum band** - a thin horizontal bar of every live session, colored by
project, brightness by state - so one look tells you where the swarm is spending itself. Mixed
things (a Proposal spanning two projects, Intake across all) show gradients. You never wonder
"where am I" or "what is this about".

- **Look**: vivid but refined; saturated hues on clean neutrals; gradients used sparingly and
  meaningfully (only for mixed contexts). Color doctrine: **color = project** (and "all projects" =
  the full spectrum). State uses shape/mark plus luminance.
- **Signature**: the spectrum band and the tinted chrome.
- **Motion**: the chrome cross-fades hue when switching project (240ms); the band's segments flow
  as sessions start and end.
- **Themes**: Prism (light, flagship, white), Pastel (light, faint tints), Obsidian (dark,
  flagship, neutral black), Mulberry (dark, red-violet), Moss (dark, green-black). Project hues
  retune per theme.
- **Fonts**: Instrument Sans (`instrument-sans`) + Martian Mono (`martian-mono`).
- **Office**: a building with one floor per project, each floor painted in its project hue; the
  spectrum band is the building's facade lighting.
- **Desktop**: one window per project space, tinted. **Web**: tinted tabs and favicons per
  project. **Mobile**: swipe between project spaces; the whole app tints.
- **Trades away**: color can't also mean state; state must be clear through shape.
- **Don't become**: Metro (color = project, not source; no line diagrams) or Aurora.

---

## 10-concierge - Concierge

**Thesis: talk to one, command many.**

Swarms don't scale in lists; they scale behind a trusted voice. In Concierge the user's primary
**Assistant (Ada)** is the front door: the home screen is Ada's briefing - a short, calm spoken-style
summary of what matters, with **inline decision cards** (bound actions) embedded in her messages,
so a morning is a conversation: "Three things need you. First, EU card payments…" [Start "Fix bug"]
[Accept] [Dismiss]. Ada can be asked anything, from anywhere (a global composer). The rest of the
product (Intake, sessions, settings) is still one step away for inspection, but most days you never
need it. A **presence orb** represents Ada (breathing when listening, swirling when working,
dimmed when asleep).

- **Look**: hospitality and editorial warmth: an upright serif for Ada's voice, a crisp sans for UI,
  warm grounds, a single rich accent, cards that feel like well-set notes. No italics for display
  type. Color doctrine: **color = voice** (Ada's accent vs system ink vs each other assistant's
  color), with state as small marks.
- **Signature**: the presence orb and the "briefing with embedded decisions".
- **Motion**: text arrives in calm phrases; the orb breathes; decision cards settle in place.
- **Themes**: Linen (light, flagship), Porcelain (light, cool-white), Espresso (dark, flagship,
  warm brown-black), Velvet (dark, plum), Charcoal (dark, neutral).
- **Fonts**: Newsreader, upright only (`newsreader`) + Inter (`inter`).
- **Office**: Ada as the receptionist at the front desk; the office behind her, with every other
  agent at work; she walks you to whoever needs you.
- **Desktop**: a global "ask Ada" hotkey panel; menu-bar orb. **Web**: the briefing as a page you
  can open from anywhere. **Mobile**: voice-first; the lock screen shows Ada's one-line brief with
  bound actions.
- **Trades away**: direct manipulation at scale; must never hide the underlying objects or silently
  decide for the user (every decision in a briefing is a real bound action with its describe line).
- **Don't become**: Crew (one mediator, not many faces) or Docket.
- **Spec change to declare**: home is the primary assistant's Conversation; Intake is still
  there, rendered as a briefing on the home screen.
