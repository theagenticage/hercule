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

## Provenance

Three reaction rounds on the identical #20 check-in slice (enriched with #29 Task nouns).
Round 1 settled the color doctrine (Signal's systematic hues = traffic light; monochrome
slightly too silent). Round 2 settled depth (Slate's hairlines + crisp shadows beat
borderless shadow depth and flat). Round 3's playground settled surfaces (Midnight over
Slate/Neutral/Porcelain/Sage/Mauve), typeface (Onest over Geist/Inter/Schibsted/Hanken/
Instrument/Figtree/Plex), and emphasis weight (500). All rounds preserved in git history
on `prototype/design-language`.
