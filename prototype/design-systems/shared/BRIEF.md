# Hercule design systems - the brief every design agent builds from

PROTOTYPE. Ten design systems for Hercule, one folder each, built in parallel by ten agents.
Read this whole file, then `CONTENT.md` (the fixture data every design shows), then **your own
section** of `DIRECTIONS.md`. Skim the other nine directions too, so you know what you must *not*
become.

## 1. The assignment, in Rogier's words (condensed)

Rogier (the product owner; address him by name in anything you write to him) asked for:

- A full, coherent design vision for Hercule that can stand for **the coming year** and support all
  the features we expect to add, with a recognizable **identity**: someone who has only heard it
  described should recognize a screenshot as "clearly Hercule".
- **Ten** high-fidelity design *systems*, each spanning **multiple pages** and **three form factors**:
  desktop app, web, mobile. On each form factor, play to that platform's strengths.
- Each design needs:
  1. a **name and a brief**;
  2. a clear outline of the **main elements of its design system**;
  3. a story that **convinces**: why *this* system over the other nine;
  4. a story that clearly explains why it is **"1000x better" than Hercule's current design**;
  5. desktop, web and mobile versions.
- The framing: *"In an age of intelligence too cheap to measure, and swarms of agents doing the
  user's bidding, the one thing at a premium is the user's attention and ability to quickly make
  high-quality, high-impact decisions. We're not there today, but the design needs to scale to that
  situation."*
- Inspiration (not to copy): t3-code. What Rogier likes about it compared with Hercule today:
  - **More colorful.** Hercule is very monochrome.
  - **Theming out of the box.** Hercule's dark theme is "especially egregious, way too blue". He
    wants sophisticated, crisp, easy-on-the-eyes dark themes.
  - **Subtle glass.** Scrolling a session transcript animates the composer to become smaller and
    slightly see-through.
- It must be **very easy to pick one design, iterate a little, and start improving the real Hercule
  interfaces with it**. Full component-library detail is not needed; a clean token file and a
  handful of well-built components are.
- **Never**: large italic headers (avoid italic display type altogether); super text-heavy
  interfaces (content such as transcripts and emails excepted); heavy box-in-box.
- **Must**: support a future cute **3D "virtual agent office"** view as an alternative to the list
  overview of agents, in a way that feels like it *belongs* to the system.
- Required screens: **Session** page with composer (empty state and active session), **Intake**,
  **Settings** across several domains, **Assistant**.

The t3-code screenshots Rogier attached (look at them):
`/Users/rogier/.t3/userdata/attachments/77fbd0e9-03c5-480f-80f3-1b4aee8aa08d-d3872482-836e-42f7-9317-49011d576a5f.png` (session + composer),
`...-3c41c6d3-5ed5-4c1c-88c4-fdaa0cc471f6.png` (command palette over blurred app),
`...-642160c8-6d7b-4071-b6bb-75ab5cbb970f.png` (usage page),
`...-55a2067e-43c6-4c8b-944b-734cfe4dde8c.png` (appearance settings with themes),
`...-e01a02a6-e1da-4dd5-b941-0bce25b57eff.png` (provider settings)
(all in `/Users/rogier/.t3/userdata/attachments/`, prefix `77fbd0e9-03c5-480f-80f3-1b4aee8aa08d-`).

Today's Hercule, for comparison: `shared/baseline/*.png` (captured from the prototypes the current
app was built from; they still say "Hydra", the old name) and the live tokens in
`packages/ui/src/styles.css`.

## 2. What Hercule is (read this until you could explain it to someone)

Hercule is a **self-hosted agent orchestration platform** for one person (multi-user later). One
always-on **controller** holds all state in one SQLite database; **runners** on the user's machines
host agent **Sessions** (Claude Code, Codex, pi) as plain processes in **Workspaces** (git
checkouts); **clients** - the web app, the `hercule` CLI, and the agents themselves - all use one
public API. Plugins bring **Connections**: event sources (GitHub, Gmail, Sentry, PostHog,
Intercom, Grafana, Stripe, cron...), chat **Channels** (Slack, Discord; the web channel is built
in) and **Providers**.

The flow of work, which is the heart of the product:

1. **Events** pour in from every Connection - thousands a day.
2. A scheduled **Triage** agent reads every event in its window, sets aside what is known or noise,
   enriches, groups across sources, and turns what matters into **Proposals** (a Task labelled
   `proposed` plus a go/no-go Notification), **Offers** (an immediate action with no Task, e.g.
   "Merge 4 dependency bumps"), **FYIs**, or **unsure** items it cannot decide. Triage never does
   work itself: *proposing is not doing*.
3. The user decides on **Intake**: Accept (it becomes a Task in the backlog), **Start *X*** (starts a
   fitting Workflow on it), or Dismiss. Every answer is a **Bound Action**: one frozen operation,
   with a describe line saying exactly what the click does.
4. **Workflows** run as **Runs** (a frozen Execution Plan of Steps; agent steps are Sessions). The
   user can also start a **Thread**: a Session they drive themselves from the composer (t3-code
   style).
5. Sessions ask for things: **Requests** (a tool approval or a question) dock on the composer and
   also reach the user as **Notifications** wherever they are (web, Slack, Discord, soon mobile).
6. **Assistants** (e.g. "Ada") are agents with **Memory**, a **Heartbeat** (hourly 07-23, silent when
   nothing matters), **Reminders**, and **Channel Bindings**; the user has a **Conversation** with
   each. They sleep when idle (**Idle Unload**: the UI says "asleep") and wake on a message.
7. **Check-in** looks backward (what is running, what happened); **Intake** looks forward (what
   should happen). Both are decision surfaces.

The five identity features: one binary, self-hosted; work triaged before you see it; decisions
answered anywhere (bound actions); assistants with memory; any provider on any of your machines.

Vocabulary is fixed (`CONTEXT.md`). Use the words exactly and respect its "Avoid" lists:
Intake (never "inbox", "dashboard", "command center"), Task (never "ticket"/"issue" for Hercule's
own concept - a GitHub issue is still a GitHub issue), Proposal, Offer, Request, Session, Thread,
Run, Workflow, Step, Assistant (never "persona"), Conversation (never "chat" as the noun for the
exchange; "web chat" is the channel's name), Notice, Memory, Heartbeat, Reminder, Topic,
Connection, Runner/machine, Fleet, Workspace ("main workspace" in the UI), Access Mode, Permission
Profile, Grant, Spawn Bound, Provenance, "made from". Presence words for assistants: working, idle,
asleep, can't be reached.

Read for depth (skim, then look things up as you need them):
- `CONTEXT.md` - the glossary.
- `docs/design-language.md` - today's visual system *and its semantics*. The semantics are gold:
  decisions phrased as questions; answers as a ledger whose describe line says what the click does;
  provenance-first attention; aggregation by default ("6 runs today · all ✓"); "made from" marks;
  receipts ("2,418 events → 6 proposals · ..."); dimmed with the reason, never hidden; the system
  never silently substitutes behaviour. **Keep the semantics. Replace the presentation.**
- `docs/spec/14-web-app.md` - screen inventory, app shell, thread surface, **the composer** (its
  card and lip: `+` · access mode · model options · model pill · voice · Stop · send; the lip:
  workspace · branch · machine; the permission dock above the card), Intake anatomy, empty states.
- `docs/spec/10-triage-intake-and-notifications.md` §1-4 and §7 - triage, stamps, proposals,
  bound actions.
- `docs/spec/12-assistants.md` §1, §8, §9 - assistant record, heartbeat, reminders, web chat.

## 3. What is wrong with today's design (the "1000x" baseline)

Be concrete and fair; today's design has good bones. What it gets wrong:

1. **Monochrome.** Color lives only at "word and dot scale": 6px dots, colored words. Nothing can be
   told apart at a glance - not projects, not sources, not states - so the eye has to *read*.
2. **The navy dark theme.** Neutrals at oklch hue 265 with chroma 0.029 read as navy; it is tiring,
   muddy, and dates the product. One light, one dark, no choice, no accent.
3. **Text-heavy.** Headline sentences, uppercase 10.5px lane labels, ledgers of label + describe line
   + description, rows of text. Understanding state means reading sentences: the scarcest resource
   (attention) is spent on parsing.
4. **Flat and static.** One transition in the whole system. No depth for layers (drawer, composer,
   popovers), no glass, no motion that explains what changed. Live state is a pulsing 6px dot.
5. **No identity.** "Calm, Linear-adjacent" and a text wordmark. Nothing you'd recognize.
6. **Doesn't scale visually.** Everything is a list that grows linearly. At 10 agents it's fine; at
   100 agents and 30,000 events a day it becomes a wall.
7. **One form factor.** A web app only. No desktop-native affordances (menu bar, global hotkey,
   native notifications), no mobile - the place decisions increasingly get made.
8. **Decisions don't feel decisive.** Quiet ghost buttons are calm but low-affordance; answering
   twenty decisions a morning should feel fast and satisfying, not like reading a form.

And what it gets right, which you must keep: the domain semantics listed above, the thread surface
shape (centered column, "Worked for 31s ›" dividers, changed-files cards, permission dock on the
composer), and the calm principle that nothing shouts unless it matters.

## 4. Rules for every design

- **Colorful, with a doctrine.** Real color, used boldly, but every color means something your
  design defines (state? source? project? agent? time?). Write the doctrine down in the book.
- **Themes out of the box.** At least **5 themes: ≥ 2 light and ≥ 3 dark**, each with a name. Theme
  keys `light` and `dark` must exist and point at your flagship light and dark (alias them, e.g.
  `[data-theme="light"], [data-theme="paper"] { ... }`). Themes switch with `<html data-theme>`.
- **Dark themes are not blue.** Neutral grounds must not read as navy. Rule of thumb: dark neutrals
  either near-achromatic (oklch chroma ≤ 0.008) or tinted toward a warm, green or violet-red hue -
  never hue ~220-275 with visible chroma. Crisp: clear separation between ground, surface and text;
  text contrast ≥ 4.5:1; no muddy mid-greys for body text. Easy on the eyes: no pure #000 grounds
  with pure #fff text except in an explicit OLED theme.
- **Glass, subtly.** Translucency + backdrop blur where layers overlap (composer, popovers, palette,
  sidebars on desktop, sheets on mobile). **The composer must shrink and turn slightly see-through
  while the transcript scrolls**, and restore when you stop at the bottom or focus it. Implement it
  with a few lines of JS on `session-active.html` pages, and make `?state=scrolled` force the
  shrunken state for screenshots. Respect `prefers-reduced-motion` and
  `prefers-reduced-transparency`.
- **No italic display type. No huge headers.** Page titles are modest (≤ 20px on desktop). Size
  hierarchy comes from numerals, color and position, not from shouting headings.
- **Not text-heavy.** Prefer marks, color, position, shape, numerals and motion to sentences. Every
  sentence must earn its place. A new user must still be able to understand everything (labels
  exist; they're just not the primary encoding).
- **No box-in-box.** At most one level of containment on any surface. Separate with spacing, tone
  shifts and hairlines, not nested bordered cards.
- **The 3D agent office** gets its own page (`desktop/office.html`): an alternate view of the agents
  and sessions overview (toggle `List | Office` visible in the page). Draw it as an isometric/3D
  scene in SVG and/or CSS 3D transforms - no external libraries, no images from the web. It must
  use your tokens, marks, presence and state encodings, so it obviously belongs. Cute, not
  childish. Show it holding real fixture data (who is working, who waits on Rogier, who sleeps).
- **Identity.** Design a Hercule mark (logomark + wordmark) and an app icon in your system's idiom,
  and name your system's **signature element** - the one thing that makes a screenshot "clearly
  Hercule".
- **Scale to the swarm.** Show, in at least Intake and the office, how the design holds at 10x
  today's load (e.g. 140 live sessions, 31,000 events a day): aggregation, summaries, spatial
  encodings - never a longer list.
- **Accessibility.** State is never color alone (pair with a mark, shape or word). Text contrast
  ≥ 4.5:1 (≥ 3:1 for large/secondary UI). Focus states visible.
- **Real content only.** Use `CONTENT.md`. No lorem ipsum, no "Item 1". Product name is "Hercule",
  always; never "agentick" or "Hydra".
- **Plain dash, never em dash** (–/— are banned in visible text; use "-" or "·").
- **Spec conflicts are allowed but declared.** If your design changes product behaviour (say, a
  different home screen, or merging Intake with Check-in), list it in the book under "What this
  design asks the spec to change", naming the spec section. Never change semantics silently.

## 5. Form factors - play to each platform's strengths

- **Desktop app** (macOS-first; Electron-class, not a wrapped webview in spirit): native window
  chrome (unified titlebar with traffic lights, translucent sidebar), keyboard-first with visible
  shortcuts, a command palette, multi-window (pop a thread out), dock badge, **menu bar extra** and
  a **global-hotkey quick panel** for answering decisions without switching apps, native
  notifications with action buttons. `glance.html` shows these desktop-only surfaces over a desktop
  backdrop (draw the backdrop yourself: a soft gradient "wallpaper" plus a hint of another app).
- **Web**: zero install, any machine; URLs are shareable deep links (`decision.html` is where a link
  from Slack or email lands: one Proposal as a page); the browser tab title and favicon as ambient
  signals; responsive at 1280px wide (show it adapts, not just shrinks).
- **Mobile** (iPhone-sized, native-app in spirit): thumb-reach navigation at the bottom, one-handed
  decisions (swipe or big answer rows), bottom sheets instead of popovers/drawers, push
  notifications with bound-action buttons and a Live Activity / Dynamic Island for a working
  session on the **lock screen** (`lock.html`), voice-first composer, haptics annotated where they'd
  fire. Mobile is where many decisions will be made - make that fast.

## 6. The deliverable

Your folder: `prototype/design-systems/NN-slug/` (given in your direction). Touch nothing outside it.
Plain HTML/CSS with small inline or local JS. No build step, no frameworks, no CDN at runtime.
Everything must work by double-clicking the HTML file (file://) and over
`http://localhost:4870/NN-slug/...`.

```
NN-slug/
  index.html              the design book (see §7)
  tokens.css              every theme; semantic token names (see §8)
  system.css              the shared components your pages use
  marks.svg (optional)    an SVG sprite of your marks/icons, or inline them
  fonts/                  self-hosted woff2 (OFL) + the licence text; see §9
  desktop/  session-empty.html  session-active.html  intake.html  assistant.html
            settings-appearance.html  settings-assistants.html  settings-connections.html
            office.html  glance.html
  web/      session-empty.html  session-active.html  intake.html  decision.html
            assistant.html  settings-providers.html
  mobile/   session-empty.html  session-active.html  intake.html  decision.html
            assistant.html  settings.html  lock.html
```

These 22 file names are fixed: a compare page shows the same screen across all ten designs.

Page rules:
- Every page starts `<head>` with `<script src="../../shared/page.js"></script>` (handles
  `?theme=` and `?state=`), then your `../tokens.css` and `../system.css`.
- Set a default theme on `<html data-theme="...">`.
- **Sizes**: desktop pages are exactly **1440 x 900** and draw their own window chrome (the whole
  page *is* the app window; put the window on your ground, full bleed, no outer margin). Web pages
  are **1280 x 800** of browser viewport (the harness draws the browser). Mobile pages are
  **390 x 844** and draw their own status bar (9:41, signal, battery) and home indicator. Design
  every page to fill its viewport exactly; scrolling regions scroll inside (`overflow: auto`), the
  page itself never scrolls.
- Settings pages: `settings-appearance` must show your theme picker with every theme previewed.
  `settings-assistants` shows Ada's record with Memory (core + topics with gists), heartbeat
  schedule, reminders, rotation, channel bindings, reply mode. `settings-connections` shows the
  Connections (event sources + channels) with health, volume and default Topic.
  `web/settings-providers` shows provider instances, machines, models, access modes.
  `mobile/settings` shows the settings index plus how one domain looks (your choice).
- Interactions worth showing may be live (hover, theme switch, composer glass, a menu opening),
  but every page must also read correctly as a static screenshot.

## 7. The design book (`index.html`)

Styled in your own system, using your tokens. Keep it visual; words are for the argument, not
padding. Sections, in order:

1. **Hero**: name, one-line thesis, your mark, and a brief (≤ 90 words).
2. **Why this one**: why this system over the other nine (≤ 150 words, pointed, honest about what
   it trades away).
3. **Why it's 1000x better than today**: concrete, before/after pairs against the baseline (you may
   embed `../shared/baseline/*.png`). Tie each to attention and decision speed.
4. **The system**: color doctrine and every theme (live switcher using
   `<button data-theme-option="...">`, see `shared/book.js`), type, shape/depth/glass, motion, marks
   and icons, layout and density, the signature element, the logo and app icon. Short captions.
5. **Screens**: all 22 pages, grouped Desktop app / Web / Mobile, each in a frame:
   `<figure data-frame="desktop" data-src="desktop/intake.html" data-caption="Intake"
   data-note="..."></figure>` (see `shared/book.js`; `data-url` for web frames, `data-state` to pass
   a state such as `scrolled`). Add the session-active page a second time with
   `data-state="scrolled"` to show the glass composer.
6. **The office**: how the 3D office belongs.
7. **At 10x**: how it holds with a swarm.
8. **Adopting it**: a table mapping today's tokens (`--bg --surface --raised --ink --muted --faint
   --line --line-soft --attn --fail --live --ok`, project dots) to yours, and the first five changes
   you'd make in `packages/ui` and `apps/web` to move Hercule onto this system.
9. **What this design asks the spec to change** (if anything).

Include `<link rel="stylesheet" href="../shared/frames.css">` and
`<script src="../shared/book.js" defer></script>` in the book.

## 8. Tokens

`tokens.css` defines every theme as custom properties on `:root[data-theme="..."]` (and
`:root` for the default). Keep today's names where the meaning holds, so adoption is a swap:
`--bg --surface --raised --ink --muted --faint --line --line-soft --attn --fail --live --ok`.
Add what your system needs (`--accent`, `--glass`, `--glass-blur`, per-project hues, per-source
hues, radii, shadows, motion durations...). Comment the doctrine briefly. Type scale, radii, spacing
and motion tokens live here too.

## 9. Fonts, marks, brands

- Fonts: OFL fonts only (the real app self-hosts fonts under a strict CSP). Download woff2 files into
  your `fonts/` folder from fontsource's CDN, e.g.
  `https://cdn.jsdelivr.net/fontsource/fonts/<id>:vf@latest/latin-wght-normal.woff2` (variable) or
  `https://cdn.jsdelivr.net/fontsource/fonts/<id>@latest/latin-<weight>-normal.woff2` (static).
  Metadata (weights, variable or not, licence): `https://api.fontsource.org/v1/fonts/<id>`. Save a
  short `fonts/LICENSES.md` naming each family and its licence.
- Brand marks of source systems are in `shared/brands/*.svg` (Simple Icons, CC0): github, gmail,
  sentry, slack, discord, intercom, posthog, datadog, grafana, stripe, linear, anthropic, claude,
  openai, zendesk, pagerduty, googlecalendar, vercel, cloudflare, hubspot. Use them monochrome
  (`currentColor`), never brand colors, unless your color doctrine assigns them a color of your
  own. Inline the path data or reference the files. pi's mark is a mono `π`.
- Your own marks: the state marks (working, decision `?`, queued, paused, done ✓, failed ✕,
  cancelled, skipped) and entity glyphs (task, run, session, workflow) exist today on a 12px grid
  (`packages/ui/src/marks/marks.tsx`). Redraw them in your idiom or keep them; one family,
  consistently used.

## 10. How to work

1. Read. Look at the screenshots. Understand the product before drawing.
2. Build the system first: tokens (all themes), fonts, marks, logo, a small set of components in
   `system.css` (window chrome, sidebar/nav, buttons, answer rows, composer with lip and dock,
   proposal row/card, presence, tabs, inputs, toggles, sheets).
3. Build desktop pages, then web, then mobile, then the office, then the book.
4. **QA like a pixel-perfectionist.** Screenshot every page and look at it:
   `node prototype/design-systems/shared/shoot.mjs <page.html?theme=dark> /tmp/<slug>-<name>.png --w 1440 --h 900`
   (web: `--w 1280 --h 800`; mobile: `--w 390 --h 844 --scale 2`; `--full` for the book).
   The script prints page errors; fix them. Check your flagship light **and** dark themes, plus
   `?state=scrolled` on session-active. Fix alignment, spacing, overflow, clipping, contrast,
   orphaned words, anything that looks off. Iterate until it's something you'd be proud to show.
   Keep screenshots in /tmp, not in the repo.
5. Do not commit. Do not touch `shared/` or other designs' folders (report anything you think
   `shared/` needs). Do not start servers; one runs at `http://localhost:4870/` already (fall back
   to file:// if it doesn't).
6. Finish with a short report: the final name and one-line tagline, theme names, which page and
   theme make the best cover image, what you're least happy with, and anything you could not do.
