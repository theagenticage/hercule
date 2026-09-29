# Hercule design systems, round 2 - the brief

PROTOTYPE. Round 1 built ten design systems (`prototype/design-systems/`). Rogier picked two,
**Metro** and **Crew**, and asked for two new iterations of each, built on his feedback. This
folder (`prototype/design-systems-2/`) is the round-2 presentation: the two originals copied
unchanged, and four iterations.

| Folder | System | Step |
|---|---|---|
| `m0-metro` | Metro | the round-1 original, unchanged |
| `m1-wayfinding` | Metro Wayfinding | iteration 1 |
| `m2-concourse` | Metro Concourse | iteration 2 |
| `c0-crew` | Crew | the round-1 original, unchanged |
| `c1-bureau` | Crew Bureau | iteration 1 |
| `c2-labours` | Crew Labours | iteration 2 |

Read, in this order:

1. This file, all of it. Then your own section in §6, and the other iteration of your family, so
   the two of you do not converge.
2. `BRIEF.md` - the round-1 brief. **Everything in it still applies** unless this file says
   otherwise: the product, the vocabulary, the rules, the 22 screens and their sizes, fonts,
   marks, accessibility, form factors. Replace `prototype/design-systems/` with
   `prototype/design-systems-2/` and port 4870 with **4871** wherever it appears.
3. `CONTENT.md` - the fixture world. **It changed in round 2**: read its top note. There are now
   16 live sessions, every one named, and the counts add up. Use the new numbers everywhere,
   including where your starting copy still has the old ones (23 sessions, 6 proposals, "12 idle",
   "Refactor cart totals" as the sibling tab, the weekly reminder, and so on).
4. `DIRECTIONS.md` - your family's round-1 direction (02 Metro or 07 Crew), for the original intent.
5. Your original's book, `m0-metro/index.html` or `c0-crew/index.html`, and its pages. Open them.

## 1. What Rogier said, verbatim

> Okay, the presentation is sensational, really happy with this. 2 designs do indeed stand out
> and they're the ones you identified, Metro + Crew. Aurora contains some really nice concepts
> too, though, so inspiration should definitely be taken from that system during iteration.
>
> I want to create a follow-up document with the same presentation and the same amount of screens
> and rich information about the design systems, but iterating on these two design systems. In
> this new presentation, copy over both the original metro & crew systems as-is (so we can compare
> against the original incarnations). Then add additional iterations based on my feedback below
>
> In general:
> - Some of the other ones have really nice glass and/or gradient effects that make the UI just a
>   little more polished. I would like to be able to experiment with glass in a toggleable (maybe
>   even a slider?) way. It needs to be done subtly though, we don't want a MacOS 26 Tahoe glass
>   disaster. For example, one of the reasons I didn't pick Aurora is because there is too much
>   color wash going on and it's distracting from the content. But I can see that the glass
>   effects make for a very crisp, clean UI
> - For Crew and Metro each, I want to see 2 new iterations based on feedback (so 6 systems
>   altogether in this new presentation)
>
> Good things from Aurora:
> - As mentioned, the glass
> - The thread header row with floating pills and what I think is a quite clean way to show
>   multiple threads in the same workspace via tabs
> - Without the overly blooming colors, Aurora's "Hercule" sidebar is probably the cleanest and
>   best I've seen
>
> Aurora things to avoid:
> - It's understandable glass needs to show something underneath, but the aurora color gradients
>   draw way too much attention to themselves. Also the glowy colored elements everywhere feel
>   slightly washed out and take attention away from the content next to it (for example the
>   threads in the sidebar). Same for the 'burning' glow in intake. It drowns out *everything
>   else*.
>
> Good things from Crew
> - The office is probably the prettiest looking
> - I like the 'cuteness' of the creatures
> - "Waiting on you" in the sidebar is good
> - The Hercule sidebar is also quite clean and easy on the eyes.
> - Intake looks clean and content oriented. Only issue is that with the kiddy buttons, the
>   misalignment of the buttons across rows stands out quite a bit
>
> Issues with Crew
> - I understand it's focusing on having a virtual office that works kind of 'hands off', but the
>   initial experience for users still needs to be t3-code-like, with threads as the main
>   primitive users will initially work with before discovering it's so much more. So we need
>   threads prominently in the sidebar.
> - Buttons are too 'kiddy'. I like that they stand out with colors, but I'm struggling to see the
>   semantic meaning in the colors. Would be interesting to see what some of the glass treatment
>   does
> - Though cute, the creatures don't really evoke a 'Hercule' feel very much which has roots in
>   'Hercule Poirot', or the french name for 'Hercules'
>
> Good things from Metro
> - This is probably the strongest *brand* out of all the presented systems. It has the strongest
>   identity
> - The concept of visualizing how events move through the system, expressed in various pages, is
>   very strong visually
> - Intake looks quite clean
>
> Issues with Metro
> - The threads sidebar is among the weakest. There are too many different types of
>   metroline-themed icons (generally, not just in the threads sidebar) that we can't really
>   expect the user to meaningfully learn their semantics. It also looks quite messy.
> - Not a massive fan of the monospace in UI either
> - The Hercule sidebar is atrocious. I get there's a theme but I really don't like the metro line
>   connecting all sidebar items like that. Also zero differentiation between different sections
> - The metro lines theme makes some interfaces less understandable. For example, it does nothing
>   for me in the providers settings section and actively makes it harder to understand what I'm
>   looking at.
> - While cool, the event metro line streams in the virtual office take up all visual attention.
>
> The metro events stream visualization is a really cool idea and though Metro perhaps emphasises
> it too much, it might be nice to see at least an option in Crew that brings some of this in as
> well.

## 2. Reference shots

Round-1 screens the feedback points at, shot in `/tmp/ds2-ref/` (look at every one that touches
your family, and at all the Aurora ones):

- `aurora-session-light.png`, `aurora-session-dark.png` - the thread header row (floating pills,
  thread tabs) and the Threads sidebar. `aurora-session-scrolled-light.png` - its glass composer.
- `aurora-intake-light.png`, `aurora-intake-dark.png` - the Hercule sidebar Rogier likes, and the
  burning glow he does not.
- `metro-session-light.png` (the weak Threads sidebar and its line icons),
  `metro-intake-light.png`, `metro-office-light.png` (streams that take all attention),
  `metro-providers-light.png` (lines that make settings harder), `metro-appearance-dark.png`.
- `crew-intake-light.png` (the buttons), `crew-office-light.png`, `crew-office-dark.png`,
  `crew-session-light.png`, `crew-assistant-light.png`.

Round-1 pages open from disk too, e.g.
`prototype/design-systems/03-aurora/desktop/session-active.html?theme=dark`. The t3-code
screenshots Rogier attached in round 1 are listed in `BRIEF.md` §1; look again at its sidebar,
its thread header, and its Appearance page, which has a "Glass opacity" slider.

## 3. What every iteration must do

### 3.1 Start from your original, keep the brand

Your folder starts as a copy of your family's original. Evolve it; rewrite anything that needs
it. The result must still be recognizably the same family (Metro's signage identity, Crew's
characters and office), fixed where Rogier said it is weak and carried further where he said it
is strong. Rename it to your system's name everywhere visible (titles, book, logo lockup where the
name appears). Drop the old covers; I shoot new ones.

### 3.2 Threads first: the t3-code shell

A new user meets Hercule as a place to run threads, like t3-code, and discovers the rest later.

- **Sidebar with two tabs, `Threads | Hercule`**, as a segmented control at the top, as in Aurora.
  Session pages open on **Threads**. Intake, the office, Check-in and Fleet open on **Hercule**.
- **Threads tab**, modelled on t3-code: new thread (⌘N) and search (⌘K) at the top; then threads
  grouped by project (webshop, payments-api, ops), each group headed by the project's name, its
  mark and a `+`. A thread row is a title on one line, a quiet meta line (branch · machine, or
  model), and at the right a state mark or an age. Only Threads live here; Runs belong to the
  Hercule tab (except in "Waiting on you", below). Assistants (Ada, Milo, Juno, with presence) sit
  below the projects. The foot holds a one-line count (8 working · 3 waiting · 1 paused · 4 idle)
  and Rogier.
- **Hercule tab**, modelled on Aurora's without its glows: sections separated by space and a small
  quiet label, never by a connecting line. Suggested sections: *Work* - Intake, Check-in, Tasks,
  Runs, Workflows; *System* - Fleet (with the office), Connections, Notifications, Settings. Counts
  sit right-aligned in one column. Crew keeps its Office as a first-class entry here.
- **Waiting on you** (Crew's, which Rogier likes): a short section of what waits on Rogier (the 3
  items, threads and runs alike), with the question in one line. Crew iterations show it in both
  tabs, above the rest. Metro iterations may adopt it; if they do, draw it in Metro's idiom.
- The original's spec change "the office is the home screen" is dropped: the home is Threads.

### 3.3 The thread header row (from Aurora)

The session page's top row floats over the transcript: a project crumb (`webshop /`), then the
threads of **this workspace** as tabs - the active "Fix 3-D Secure checkout for EU cards" and its
sibling "Read the Stripe v14 changelog" (`CONTENT.md`), then `+` for a new thread here. At the
right: open in editor, `…`, and the changes pill (`Changes +48 -12 | Commit`). Each pill carries a
small state mark (the active one: waiting on you). The row has no bar behind it: the pills float,
and the transcript scrolls under them (this is one of the glass surfaces). Draw it in your idiom;
keep its clarity.

### 3.4 Glass: one level, 0 to 1, subtle at every value

Rogier wants to try glass with a slider. So glass is one number, `--glass-level`, from 0 (fully
solid) to 1 (the most glass your system allows), and every glass surface is derived from it.

**The contract (mechanical, shared):**

- `tokens.css` sets your default on `:root`, e.g. `--glass-level: 0.4;` (your section in §6 gives
  a starting value). `shared/page.js` overrides it on `<html>` from `?glass=<0..1>`, or live when a
  book or compare page posts `{ glass: n }` to the frame; it also sets `<html data-glass-off>` at 0
  and fires a `glasschange` event on `document` with the level. (`data-glass` is not used on
  `<html>`: Metro's pages already use `[data-glass]` for the composer host.)
- Derive every glass value from the level with `calc()`, so the slider moves everything at once and
  no JS is needed. For example:
  ```css
  --glass-fill: color-mix(in oklab, var(--surface) calc(100% - 26% * var(--glass-level)), transparent);
  --glass-blur: calc(22px * var(--glass-level));
  --glass-edge: color-mix(in oklab, white calc(45% * var(--glass-level)), transparent);
  ```
  Check in a shot that each expression renders in Chromium; if one does not, use another form.
- `@media (prefers-reduced-transparency: reduce)` forces level 0.
- Your composer's scroll behaviour (shrink and turn slightly see-through while the transcript
  scrolls) scales with the level too: at 0 it still shrinks but stays solid.
- **Appearance settings get a Glass control**: a slider labelled Glass, 0-100%, with a one-line
  description, on `desktop/settings-appearance.html` (and in `mobile/settings.html` if that page
  shows Appearance). It is live: moving it calls `HerculePage.setGlassLevel(value)` and the whole
  page answers, the sidebar and header included.
- **The book has the slider in its sticky toolbar**, beside the theme buttons:
  `<input type="range" min="0" max="100" value="40" data-glass-control>` plus
  `<output data-glass-value></output>` (`shared/book.js` wires both). Its `value` attribute is your
  default times 100, so the book's first view matches the pages.

**The look (what "subtle" means here):**

- Glass only on layers that float over other content: the header pills, the composer and its
  dock, popovers and menus, the command palette, sheets and notifications, floating office
  panels, the mobile tab bar and sheets, and optionally the desktop sidebar. Never on rows or
  cards in the content flow. (Crew's answer buttons are the one exception; see §6.)
- What shows through is content, never decoration: the transcript under the header and composer,
  the office under its panels, the app under the palette. **No aurora gradients, no colored
  blobs, no glows put there to feed the glass.** If a ground needs life, a near-neutral tonal
  gradient is the most it gets.
- Glass is a mostly opaque fill (surfaces that carry text stay at 70% or more even at level 1),
  blur roughly 12-28px, saturation at most 1.3, a hairline light edge on top, and a soft shadow.
  No refraction, no specular streaks, no chromatic or rainbow edges, no "liquid" distortion. The
  test: at level 1 it is still something Rogier would ship; at level 0 it looks finished, not
  broken.
- Text on glass keeps 4.5:1 at every level in every theme, against the worst content that can
  scroll under it (a code block, a diff, the office).

### 3.5 Color serves content

- Nothing glows. The burning Proposal is marked by its mark, its word and at most a thin accent
  or a tinted fill, never by a bloom that "drowns out everything else".
- Color carries meaning your book states (your family's doctrine, adjusted where Rogier found it
  unreadable). Areas of color stay small next to text; the sidebar's thread titles are never
  washed out by color beside them.

### 3.6 Buttons and answers are semantic and aligned

- One written doctrine, a small table in the book: which answer gets which look, and why. A
  starting point: the suggested answer (what triage recommends, or the one that moves the work
  forward) is the one filled button; other answers that do something are neutral; answers that
  decline or close (Dismiss, Deny, Not now) are quiet; red is only for what destroys something.
  The "waiting on you" color points at a decision; it is not a button fill.
- **Answers line up across rows.** In any list of decisions (Intake above all), the same kind of
  answer sits in the same place in every row, buttons share one height and fixed widths or a fixed
  grid, so the eye can draw a straight line through every primary answer. Round 1's Crew Intake
  failed exactly here.

### 3.7 Type and icons

- **No monospace in the UI.** Mono is for code, commands, diffs and file paths inside code-like
  contexts (a code block, a diff card, the composer's lip for a branch). Labels, meta lines,
  counts and states are in the UI face.
- **One conventional icon family** for navigation and actions (outline, one stroke weight, on a
  16px grid; drawn by you, recognizable at a glance: a chat bubble for threads, a gear for
  settings). **State marks are a small closed set** - at most six (for example working, waiting
  on you, done, failed, paused, idle/asleep) - used identically everywhere, each explained once in
  the book. No family of themed variants a user would have to learn.

### 3.8 The office

Still required (`desktop/office.html`, with the `List | Office` toggle), and it must hold all 16
live sessions from `CONTENT.md`: who works, who waits on Rogier, who is paused, who is idle, and
Juno asleep. The people and the decisions are the subject; everything else supports them. Rogier
called Crew's office the prettiest; Metro's streams took all the attention. See §6 for each
iteration's take on event flow in the office.

When the office has an event-flow layer, `office.html` reads `?flow=on|off` (a few lines of page
JS) and has a visible toggle for it, so the book can show both states.

### 3.9 Everything else from round 1

All 22 screens, all sizes, at least 5 themes with `light` and `dark` aliases, non-blue darks, the
glass composer with `?state=scrolled`, mobile and desktop platform strengths, the 10x story, real
content, plain dashes, the vocabulary. Settings pages must be plain enough that a newcomer
understands them at once (Rogier on Metro's providers page: the theme "actively makes it harder
to understand what I'm looking at").

## 4. The book

Same richness as round 1: the same sections, all 22 screens (plus the scrolled session), the
office, 10x, adoption and spec changes. Styled in your system, with your tokens. Changes:

1. **Hero** - name, thesis, mark, a brief of at most 90 words, and one line naming your family and
   the step ("Metro, iteration 1").
2. **What changed, and why** (new, second) - a table: every point of Rogier's feedback that touches
   your family (the general points, the Aurora points, and your family's good and bad points) →
   what this iteration does about it → where to see it. Then 3 to 5 before/after pairs: the
   original's page beside yours, as two frames, e.g.
   `<figure data-frame="desktop" data-src="../m0-metro/desktop/session-active.html" ...>` beside
   `<figure data-frame="desktop" data-src="desktop/session-active.html" ...>`.
3. **Why this one** - why this iteration over the original and over its sibling (at most 150
   words, honest about what it trades away).
4. **Why it beats today** - kept from round 1, updated.
5. **The system** - as in round 1, plus a **Glass** part: the rule of what may be glass, the
   derived tokens, and the same surface shown at 0, your default, and 1 (frames with `?glass=`
   in `data-src`, e.g. `data-src="desktop/session-active.html?glass=0" data-state="scrolled"`),
   and the button doctrine table from §3.6.
6. **Screens** - all 22 plus the scrolled session.
7. **The office**, **At 10x**, **Adopting it**, **What this design asks the spec to change** - as
   in round 1.

The sticky toolbar holds the theme buttons and the glass slider (§3.4).

## 5. Rules of work

- Your folder is `prototype/design-systems-2/<your id>/`. Touch nothing outside it: not `shared/`,
  not the originals `m0-metro` and `c0-crew`, not round 1 in `prototype/design-systems/`, not the
  other iterations. Report anything you think `shared/` needs.
- A server already runs at `http://localhost:4871/`. Do not start or stop servers.
- Check with `node prototype/design-systems-2/shared/check.mjs <your id>` (from the repository
  root of this worktree). It reports missing screens, banned words and dashes, external requests,
  scrolling pages, console errors, the theme count, and whether you honour `--glass-level`; and
  it shoots every page in light and dark, the scrolled session and Intake at glass 0 and 1, and
  the book, into `/tmp/review/<your id>/`. **Look at every shot**, at glass 0 and 1 as well as the
  default, and fix what is off: alignment, spacing, clipping, contrast, overflow, orphaned words,
  stale fixture numbers. Pixel perfection. Iterate until you would be proud to show Rogier.
- `node prototype/design-systems-2/shared/shoot.mjs <page?query> <out.png> [--w --h --scale --full]`
  shoots one page.
- Do not commit.
- Finish with a short report: final name and thesis (one line each), default glass level, theme
  names, the page and theme for the cover, how each feedback point was answered (one line each),
  what you are least happy with, and anything you could not do.

## 6. The four iterations

### m1-wayfinding - Metro Wayfinding

*Thesis to start from: the map where it explains, plain signs everywhere else.*

The conservative evolution: the same brand, with the metro metaphor confined to the places where
it explains how work moves. Default glass **0.35**; solid-first, with glass on the floating layers.

- **Keep**: the brand - the logo, the enamel-sign clarity, the line colors and the color doctrine
  (a hue belongs to a Connection), the themes, Intake's clean layout.
- **The map appears only where something moves** - and nowhere else:
  1. Intake: one compact flow diagram at the top (sources → Triage → what the morning became, with
     numerals), and each Proposal's "made from" as its lines merging - the one row glyph.
  2. The session: at most one slim route strip (Proposal → this Thread → pull request), quiet.
  3. The office floor (quietly, see below), Check-in if you show it, and the Connections page,
     where a Connection's line color is a small swatch beside it, not a line joining things.
- **Everywhere else, plain signage**: conventional icons (§3.7), the Overpass UI face with no mono
  in the UI, the t3-code Threads sidebar, Aurora's sectioned Hercule sidebar (§3.2), a plain
  providers page (a clear list or table: provider, account, models, machines with version and
  signed-in state, default access mode, usage - readable in five seconds).
- **Office**: the event streams become a quiet layer - thin, low-contrast lines that take color
  only for the desk or source the reader hovers or selects - so the desks, the people and the three
  waiting on Rogier carry the scene. A flow toggle (`?flow=on|off`) is allowed; the default is the
  quiet layer.

### m2-concourse - Metro Concourse

*Thesis to start from: a glass concourse over the network.*

The bolder merge: Metro's brand in Aurora's floating glass shell. Default glass **0.6**, glassier
than its sibling, still subtle.

- **The shell**: the sidebar is a floating rounded panel inset from the window edge; the header
  pills float over the transcript; the composer floats. The window ground is quiet and neutral.
  Anything under the glass is content. A very faint, monochrome network-map texture on the ground
  is allowed only if a screenshot proves it never draws the eye; when in doubt, leave it plain.
- **The signature: one live flow element.** Concentrate Metro's flow visualization into one
  reusable component - a slim "departures board" strip of the network (events → Triage → Proposals,
  live, with numerals) - and use that same component wherever flow matters: the top of Intake,
  Check-in, the menu bar extra and quick panel, the lock screen Live Activity, the office. One
  element to learn, recognizable in any screenshot.
- **Fix the rest as Rogier asked**: the t3-code Threads sidebar, Aurora's sectioned Hercule sidebar,
  conventional icons and at most six state marks, no mono in the UI (Overpass for signage and UI,
  or pair it with a neutral grotesk for body text if that reads better; your call, justified in the
  book), a plain providers page.
- **Dark themes** as crisp as Aurora's dark, with none of its color wash.
- **Office**: glass panels float over the scene; the event streams are quiet, in the same idiom as
  the flow strip; the scene belongs to the people.

### c1-bureau - Crew Bureau

*Thesis to start from: order and method - a detective bureau of small colleagues.*

Crew given the Hercule Poirot root. Default glass **0.4**.

- **The characters** stay as cute as round 1 (Rogier likes them) and gain a Poirot character: an
  egg-shaped head (canon for Poirot), a small waxed mustache on the Triage clerk and a few others,
  the odd homburg, bow tie or pocket watch, and a love of symmetry. Ada, Milo and Juno each get one
  distinct accessory beside their hue. Presence stays a pose (focused eyes working, a raised hand
  waiting on you, closed eyes asleep, a bandage failed), redrawn in the new idiom. Cute, never a
  caricature, never childish.
- **The office**: an Art Deco bureau, still the prettiest thing in the presentation - a geometric
  inlaid floor, brass and green-glass desk lamps, filing cabinets for Tasks, a case board with pins
  and thread where Triage groups what it found ("made from" drawn as the thread), rooms or wings
  per runner, Rogier's desk with the three waiting on him.
- **The event-flow option**: pneumatic tubes from each Connection into the Triage clerk's desk,
  with small capsules travelling in them. A toggle in the office toolbar, **off by default**;
  `office.html?flow=on` shows it on, and the book shows both. When on it stays quiet: thin brass
  tubes, small capsules, the Triage desk the only busy place.
- **Buttons**: neutral glass material - a surface tint, a hairline top highlight, a soft edge -
  scaled by `--glass-level` (flat and solid at 0). The suggested answer is the one filled button,
  in the accent. The marigold "you" color marks what waits on Rogier (badges, the raised hand), not
  button fills. Aligned per §3.6.
- **Brand**: a Deco wordmark (an OFL Deco-flavoured display face for the wordmark, logo and at
  most large numerals; the UI face stays a friendly grotesk). A mark that reads as Hercule at 16px
  - for example the egg-shaped head with its mustache. Themes may take names from Poirot's world
  (Whitehaven, Styles, Orient Express...) while keeping `light` and `dark`.

### c2-labours - Crew Labours

*Thesis to start from: small heroes, twelve labours a day.*

Crew given the Hercules root. Default glass **0.5**.

- **The characters** stay as cute as round 1 and become small, sturdy heroes: the Triage figure
  wears a little lion hood (the Nemean lion); others get a laurel sprig, a headband, a tiny club;
  sturdy, friendly proportions. Ada, Milo and Juno each get one distinct attribute beside their hue.
  Presence stays a pose, redrawn in the new idiom. Cute and heroic, never a theme park.
- **The office**: a sunlit classical courtyard - marble floor, a colonnade, olive trees in
  terracotta pots, amphorae for Tasks, a fountain, desks under porticos per project, a wing per
  runner, Rogier's desk with the three waiting on him. Restraint: one or two classical cues per
  area, not a temple on every desk.
- **The event-flow option**: an aqueduct. Small channels bring event droplets from each
  Connection into the Triage fountain, where they are sorted - Hercules rerouted two rivers to clean
  the Augean stables, and Triage cleans the stream. A toggle in the office toolbar, **off by
  default**; `office.html?flow=on` shows it on, and the book shows both. Quiet when on.
- **Buttons**: glass material as in Crew Bureau, in your own idiom, scaled by `--glass-level`; the
  suggested answer is the one filled button; aligned per §3.6. Take a different route from Bureau
  where you can (shape, weight, how the fill is built), so Rogier sees two answers.
- **Brand**: the Hercules knot (the reef knot of classical jewellery, the knot of Hercules) is a
  natural mark; a meander may appear as a tiny ornament in the brand and the book only, never as UI
  chrome. Warm marble and terracotta grounds, olive and deep-wine darks - none of them blue. Theme
  names may come from the myths (Marble, Terracotta, Nemea, Olympia...), keeping `light` and `dark`.
- **Vocabulary**: "Labours" is the design's name only. A Task is always a Task, a Run a Run; never
  "labour" or "quest" in the product's text.
