# Hydra design language

Pinned by [ticket #33](https://github.com/rogierpennink/hydra/issues/33) (2026-08-26).
**All later UI prototypes and the v1 web app must be built in this language.**
The living reference is the playground prototype
([`prototype/design-language.html` on branch `prototype/design-language`](https://github.com/rogierpennink/hydra/blob/prototype/design-language/prototype/design-language.html)),
whose defaults are the pinned settings: `face=Onest th=Midnight cs=6 ll=94.5 dl=20 w=500`.

## Register

- **Calm middle density.** Comfortable line heights; a screen shows plenty but never feels
  like a cockpit. The UI's job is to ease the cognitive load of managing fleets of agents,
  never to add to it. Give the eyes rest.
- **Linear-adjacent refinement, less dense.** Hairline borders, crisp shallow shadows,
  small type set carefully.
- **Both themes are first-class.** Every surface ships light and dark from one token system.
- **Decision affordances are quiet** (pinned by #20's reaction): text-only ghost buttons,
  the primary action in ink-colored text, hover reveals a soft background. Never filled
  action buttons in monitoring surfaces.

## Color doctrine

Color appears **only at word and dot scale** - a tinted state word, a 6px dot, a colored
age label. Never as fills, chips, pills, stripes, edge bars, or background washes
(the round-1 "traffic light" and "sickly amber wash" failures). Semantic hues are fixed
and mean exactly one thing each:

| Meaning | Light | Dark |
| --- | --- | --- |
| Waiting on you (attention) | `#8a6116` | `#d0a147` |
| Failed | `#a34e46` | `#cf7b71` |
| Live / running | `#48717f` | `#7fa8b8` |
| Done (the ✓ glyph) | `#48745a` | `#7fae8e` |
| Project dot · hydra | `#7d7ab0` | `#9490c9` |
| Project dot · ops | `#a67f92` | `#bd93a8` |

Attention-soft (rare tinted background, e.g. warning badges): `rgba(138,97,22,0.09)` light,
`rgba(208,161,71,0.12)` dark.

## Surfaces: Midnight

Blue-violet neutrals (oklch hue 265), color strength 1.2x base chroma; quiet in light,
leaning rich navy in dark. Grounds: light 94.5%, dark 20%.

```css
:root { /* light */
  --bg:      oklch(94.5% 0.0156 265);
  --surface: oklch(96.7% 0.0125 265);
  --raised:  oklch(100% 0.0078 265);
  --ink:     oklch(23% 0.0100 265);
  --muted:   oklch(48% 0.0156 265);
  --faint:   oklch(66% 0.0156 265);
  --line:      oklch(23% 0.0100 265 / 0.10);
  --line-soft: oklch(23% 0.0100 265 / 0.055);
  --card-shadow: 0 1px 2px rgba(23,26,33,0.05);
  --lift-shadow: 0 1px 2px rgba(23,26,33,0.06), 0 4px 14px rgba(23,26,33,0.06);
}
[data-theme="dark"] {
  --bg:      oklch(20%   0.0288 265);
  --surface: oklch(22.2% 0.0288 265);
  --raised:  oklch(25.5% 0.0259 265);
  --ink:     oklch(90% 0.0080 265);
  --muted:   oklch(68% 0.0288 265);
  --faint:   oklch(50% 0.0288 265);
  --line:      oklch(90% 0.0288 265 / 0.10);
  --line-soft: oklch(90% 0.0288 265 / 0.06);
  --card-shadow: 0 1px 2px rgba(0,0,0,0.35);
  --lift-shadow: inset 0 1px 0 rgba(255,255,255,0.05),
                 0 1px 2px rgba(0,0,0,0.4), 0 6px 18px rgba(0,0,0,0.3);
}
```

Layer roles: `--bg` is the page ground, `--surface` holds passive containers (sidebar,
ledger groups), `--raised` is the lit layer for what needs attention. **Depth = hairline
border (`--line`) + crisp shallow shadow.** In dark, prominence comes from the raised
surface plus a faint white inner top highlight - never a color wash.

## Typography

- **UI face: Onest** (Google Fonts), weights 400/500/600. Chosen for calm rhythm and
  slightly narrow letterforms that ease dense monitoring rows.
- **Emphasis weight is 500** (`--w-emph`) - titles, names, buttons, inline `<b>`.
  Heavier bolds caused squinting. One step up (600, `--w-urgent`) is reserved for
  urgent-priority names.
- **Mono face: IBM Plex Mono** for ids, refs, ages, timestamps, counts.
  `font-variant-numeric: tabular-nums` wherever digits align.
- Body 14px/1.5; row names 13.5px; metadata 12-12.5px; uppercase lane labels 10.5px with
  0.1em letter-spacing in `--faint`.

## Semantic encodings

The five monitoring axes (from #20's reaction) and their pinned encodings:

- **Currency (live vs stale):** a 6px pulsing dot in the live hue + a live-tinted state
  word ("running 12m"). Static things have no motion. Respect `prefers-reduced-motion`.
- **Waiting-time:** the age label (mono) darkens as waiting grows -
  `--faint` (fresh) → `--muted` (recent) → `--ink` (stale) → attention hue at weight 500
  (old). No backgrounds, no badges.
- **Importance (task priority):** shape and ink, never color. A three-bar glyph fills
  1-3 bars in grays (`--faint`/`--muted`/`--ink`); names step in weight
  (urgent `--w-urgent`, low 500 at reduced size); low-priority and finished rows drop to
  ~0.66 opacity. Urgent needs-you titles step up to 15px.
- **Outcome:** glyphs - muted ✓ for success, fail-colored ✕ for failure; failed state
  words in the fail hue.
- **Lineage:** plain-text breadcrumbs ("hydra · Fix flaky webhook tests"); small square
  project identity dots on group headers only, never per row.

## Structure conventions

- What needs attention sits on `--raised` cards (the lit stage); passive records sit in
  `--surface` groups; finished work recedes by opacity; digests/history step back
  (~0.82 opacity, smaller type).
- Radii: 10px cards/groups, 6px controls.
- A "last check-in" divider marks what the user has already seen.

## Monitoring semantics (pinned by ticket #20, 2026-08-28)

The check-in prototype rounds 3-4 added system-wide semantics on top of the encodings
above:

- **Intent-level first.** Monitoring rows are strands of intent (a task, a standing
  workflow, a one-off run); execution detail (runs, sessions, steps, turns) appears only
  behind progressive disclosure. Entities always carry their domain noun (task, run,
  session, workflow) - never invented vocabulary.
- **Aggregate by default.** Routine work collapses to one row per workflow ("6 runs
  today · all ✓"); the page keeps its shape from one runner to a fleet.
- **Provenance-first attention.** Started-by-you outranks standing workflows, which
  outrank routine schedules; task priority breaks ties; waiting-time warming stops
  anything hiding forever.
- **Decisions are questions.** Every needs-you item is phrased as a question whose
  answers are its (quiet) buttons, marked by a small attention-hue diamond. The decision
  card is uniform-height with labeled fields (FROM / WHY / AGENT) so cycling never moves
  the controls; one decision at a time ("Focus") is the pinned treatment.
- **One calm headline sentence** ("2 decisions wait · 3 strands in motion · 6 outcomes
  today") and a **pulse rail** (fleet / assistants / intake as quiet text lines) replace
  stat-card rows, which are banned. Assistants are ambient presence, never work strands.
- **Marks legend** lives behind a toggle in the app chrome, never permanently on a page.
- **Iconography is TBD**: the mark set (equalizer, diamond, queued, paused) and entity
  glyphs (task, run, session) sketched in the prototype are placeholders pending their
  own focused ticket; do not treat the specific glyph shapes as pinned.

## Intake semantics (pinned by ticket #30, 2026-08-28)

The Intake prototype (four rounds) settled how prepared work is presented. Intake and
check-in are **separate views** for now; merging is a post-dogfooding question.

- **Intake is a morning brief.** The page is framed around "since you last checked": one
  calm headline sentence leads with what burns ("1 burning · 6 proposals from 212 events ·
  2 need a call · 3 FYI · 198 handled quietly").
- **Topic tabs** group the page (All / Code / Business / Personal / Ops). A topic is a
  label: each Connection files into one default topic chosen at setup; triage agents label
  a proposal with the connection's topic unless the content says otherwise. Tabs show every
  topic in use, user-ordered; a "Manage topics" affordance sits at the tabs' right edge.
- **Needs a call** is verdict-based, never priority-based: it holds what triage could not
  decide (an unsure verdict, a tripped spawn bound). Its label says so.
- **Priority tiers make urgency legible**: proposals sit under Now / Today / When you can.
  The Now tier carries a pulsing attention-hue dot on its label, on the burning card, and on
  the topic tab that contains it - the one place a colored dot marks urgency.
- **Lead card + condensed rows.** The burning proposal is one lead card (title, made-from
  marks, gist, the proactive link, actions, "Open the full picture"); every other proposal
  is a condensed row: title · priority bars · system marks · "→ suggested action" · age.
- **Made from** is mandatory on every proposal: one entry per source system with the
  system's monochrome mark. Marks show the *system* (GitHub, Gmail, Sentry, Tailscale,
  Hetzner, Dependabot, cron, Hydra itself); the connection that carried it is a mono
  suffix. Brand marks are 12px monochrome `currentColor` paths - never brand colours.
- **Detail lives in a drawer**, never a page or a permanent split: proposal detail (Next +
  actions · Why + links · Made from as signal cards with the source excerpt and "Open in
  <system>" · the triage verdict block · History), connection events, and the Topics sheet
  all open in the same right-hand drawer over the rail. Esc closes.
- **The events view is the context.** A connection opens to every event since the last
  check, each stamped with what triage made of it (→ proposal, unsure, FYI, ignored, filed,
  held), filterable by that verdict. Held events from a tripped breaker are listed there.
- **What came in** rows (one per connection: mark, name, summary, event count, "Events →")
  and a one-line receipt ("212 events → 6 proposals · 2 routed · 1 attached · 3 FYI ·
  198 ignored") close the page. Anything that opens says so with "Open →" / "Events →".
- **Rejected on the record**: narrative brief prose at the top of the page (round 2), a
  time-first ledger as the page (round 1), master/detail split (round 3: too little room for
  the overview), a full detail page (round 3: the light card reads better).

## Provenance

Three reaction rounds on the identical #20 check-in slice (enriched with #29 Task nouns).
Round 1 settled the color doctrine (Signal's systematic hues = traffic light; monochrome
slightly too silent). Round 2 settled depth (Slate's hairlines + crisp shadows beat
borderless shadow depth and flat). Round 3's playground settled surfaces (Midnight over
Slate/Neutral/Porcelain/Sage/Mauve), typeface (Onest over Geist/Inter/Schibsted/Hanken/
Instrument/Figtree/Plex), and emphasis weight (500). All rounds preserved in git history
on `prototype/design-language`.
Intake: four reaction rounds on `prototype/intake-view` (ticket #30) - round 1 settled
two-views-not-one-spine and the Desk skeleton; round 2 settled topic tabs, the morning-brief
framing and system marks; round 3 settled the drawer, priority tiers and the events view;
round 4 is the converged single design.
