# Overview directions - the builder's kit

PROTOTYPE. One reference for every designer building a direction under
`docs/design/overview-directions/<name>/`, so nobody re-reads the kit. Checked against `main` at
7c071e3e on 2026-10-24. Also read the wiki page `hercule wiki-page read 7e8860da` (drawing traps).

## 0. Ground rules

- Your folder holds `desktop.html` (the window), `index.html` (the story page), `<name>.js`,
  `<name>.css` and, if you need more data, `<name>-data.js`. Nothing else of yours lives elsewhere.
- **Link the kit, never edit it.** `crew-bureau-2/`, `shared/` and `sidebar-directions/` feed other
  books and `pnpm compare:bureau` (it loads `sidebar-directions/workbench-refined/desktop.html`).
- Scope every CSS rule under your root class (`.ov-<name> ...`) and prefix your classes. Two
  builders once each defined a bare class and broke each other.
- Plain HTML + ES5 scripts over `file://`, no server, no build, outside lint. No em dash; use "-".
- `book.js`/`book.css` (the story-page harness) exist only on `origin/prototype/sidebar-directions`,
  not on `main`. Byte-identical copies now sit in `overview-directions/shared/`; link those.

## 1. Setting up a page

### desktop.html on the Stage (today's window, sidebar and open thread)

```html
<!doctype html>
<html lang="en" data-theme="whitehaven">
  <head>
    <meta charset="utf-8" />
    <script src="../../shared/page.js"></script>  <!-- first: sets the theme before first paint -->
    <link rel="stylesheet" href="../../crew-bureau-2/tokens.css" />
    <link rel="stylesheet" href="../../crew-bureau-2/system.css" />
    <link rel="stylesheet" href="../../sidebar-directions/shared/stage.css" />
    <link rel="stylesheet" href="<name>.css" />
    <title>Name · Hercule</title>
  </head>
  <body>
    <script src="../../sidebar-directions/shared/world.js"></script>
    <!-- optional: <script src="<name>-data.js"></script> -->
    <script src="../../sidebar-directions/shared/stage.js"></script>
    <script src="<name>.js"></script>                <!-- calls Stage.direction({...}) -->
    <script src="../../crew-bureau-2/brands.js"></script>
    <script src="../../crew-bureau-2/crew.js"></script>  <!-- always last -->
  </body>
</html>
```

The order matters: `stage.js` builds the window in its own DOMContentLoaded listener, registered
before `crew.js`'s, and `crew.js` then swaps every placeholder (section 4). **Without the Stage**:
same `<head>` minus `stage.css`, and a body of `<div class="app"><aside data-side="intake"></aside>
<main class="main">...</main></div>` then `brands.js` and `crew.js`: the book's sidebar, not the app's.

### index.html, the story page

```html
<meta name="viewport" content="width=device-width, initial-scale=1" />  <!-- needed on the phone -->
<script src="../../shared/page.js"></script>
<link rel="stylesheet" href="../../crew-bureau-2/tokens.css" />
<link rel="stylesheet" href="../../crew-bureau-2/system.css" />
<link rel="stylesheet" href="../shared/book.css" />  <!-- after system.css: it undoes overflow:hidden -->
<script src="../shared/book.js"></script>
...body...
<script src="../../crew-bureau-2/brands.js"></script>
<script src="../../crew-bureau-2/crew.js"></script>
```

### Themes and page.js

`<html data-theme>` takes one of five themes (all in `tokens.css`, named after Poirot's world):

| `data-theme` | Kind | Look |
|---|---|---|
| `whitehaven` (alias `light`, also the `:root` default) | light, flagship | ivory and green-black lacquer |
| `styles` | light, warm | parchment and walnut |
| `orient-express` (alias `dark`) | dark, flagship | warm wood-black and ivory |
| `nile` | dark | green-black and papyrus |
| `end-house` | dark | claret and aubergine |

`shared/page.js` (load first in `<head>`) reads the URL:
- `?theme=<name>` sets `<html data-theme>` (no validation; an unknown name falls back to Whitehaven).
- `?state=<name>` sets `<html data-state>`; your CSS/JS reads it to show a state without clicks.
- `?glass=<0..1>` sets `--glass-level` and `data-glass-off` at 0; also listens for
  `postMessage({glass})`. Inside an iframe it turns `focus()` into a no-op and drops `autofocus`.

## 2. Tokens (`crew-bureau-2/tokens.css`)

Doctrine: **color is who**. A colleague owns one hue; state is a pose or a mark, never a color.

**Surfaces and ink** (per theme): `--bg` page/sidebar · `--surface` main pane · `--raised` cards ·
`--sunken` wells, chips · `--ink` text · `--muted` secondary text · `--faint` tertiary text and
labels · `--line` rule · `--line-soft` hairline · `--scrim` modal backdrop · `--ground` (= `--bg`).

**Reserved colors**, owned by no colleague: `--accent` lacquer green, the one suggested answer
and the only filled button (`--accent-fg` on it, `--accent-ink` as text) · `--you` marigold,
anything addressed to you (`--you-ink`, `--you-tint`; never a button fill) · `--fail` tomato
(`--fail-ink`, `--fail-tint`) · `--ok` green, passed tests and added lines (`--ok-tint`) ·
`--brass` lamps, tubes, rules; never text or state. Derived: `--attn` (= `--you-ink`), `--live`
(= `--ok`), `--focus`, `--hover`, `--press`, `--selected`, `--field`.

**Projects** are low-chroma tints: `--proj-webshop`, `--proj-payments`, `--proj-ops` (note:
`payments`, not `payments-api`). Use them through `.proj--webshop` etc.

**Crew wheel** (oklch hue angles): `--hue-lime` 132, `--hue-mint` 166, `--hue-teal` 198,
`--hue-sky` 240, `--hue-iris` 282, `--hue-grape` 312, `--hue-orchid` 345, `--hue-peach` 52;
reserved `--hue-you` 78, `--hue-fail` 27. Set `--hue` **inline** on an element
(`style="--hue:var(--hue-sky)"`) and it gets `--who` (fill), `--who-shade` (darker rim),
`--who-ink` (text-safe), `--who-tint` (quiet background). The selector is `[style*="--hue"], .who`,
so a `--hue` set from a stylesheet rule does not recompute them; `.who` also gets a flex layout
from system.css. Faces use `--char-*`, `--face-ink`, `--blush` and `--hat` per theme.

**Fonts**: `--font-ui` Bricolage Grotesque (all UI) · `--font-deco` **Limelight**, the decorative
Art Deco face: wordmark, logo lettering, a few big numerals, never UI text (`.wordmark`,
`.deco-num`) · `--font-mono` Recursive with `--mono-axes`, for code, diffs, commands, branches
only (never labels or counts).

**Type** `--t-11` 11 · `--t-12` 12 · `--t-13` 13 UI body · `--t-14` 14 transcript prose · `--t-16`
16 · `--t-18` 18 page titles · `--t-20` 20 largest desktop title · `--t-num` 26 Deco numerals.
**Weights** `--w-regular` 400 · `--w-medium` 520 · `--w-bold` 640.
**Space** (4px grid) `--s-1` 4 · `--s-2` 8 · `--s-3` 12 · `--s-4` 16 · `--s-5` 20 · `--s-6` 24 · `--s-8` 32.
**Radii** `--r-xs` 6 · `--r-btn` 7 · `--r-sm` 9 · `--r-md` 12 · `--r-lg` 16 · `--r-xl` 20 · `--r-pill` 999.
**Shadows** `--shadow-1` small lift (cards, the pressed `.seg` button) · `--shadow-2` medium (an open
graph node) · `--shadow-3` large (the mobile sheet). Floating glass uses `--glass-shadow`.
**Motion** `--dur-1` 120ms · `--dur-2` 200ms · `--dur-3` 320ms · `--ease-out` · `--ease-spring`
(characters only).

**Glass**: one dial, `--glass-level` (default 0.4; 0 under `prefers-reduced-transparency`).
Derived: `--glass-fill`, `--glass-fill-raised`, `--glass-fill-thin` (never below 70% fill),
`--glass-blur` (0 at level 0, else 12-28px), `--glass-sat`, `--glass-filter` (use as
`backdrop-filter`), `--glass-edge` (top highlight), `--glass-rim`, `--glass-shadow`,
`--glass-edge-max` (per theme). Buttons: `--btn-fill`, `--btn-rim`. The sidebar is never glass.

**Office**: `--room-*` (floor, inlay, inlay-2, wall, panel, wood, desk, metal, lamp, plant, lawn,
sun, screen, shade, fabric, cork, paper), used by office.js.

## 3. Components (`crew-bureau-2/system.css`)

Rules: one level of containment at most; separate with space, tone and hairlines.
Note that it sets `html, body { height: 100%; overflow: hidden }` (a window, not a document).

| Class | What it is |
|---|---|
| `.app` / `.main` / `.side` | the 272px-sidebar window grid, main pane, sidebar column |
| `.side-sec` `.side-h` `.side-h--proj` `.side-row` `.side-text` `.side-name` `.side-meta` `.side-ask` `.side-end` | sidebar sections, labels and rows (`.is-on` selected) |
| `.nav-row` / `.who-row` `.who-text` `.who-name` `.who-sub` | icon + label + count row / people row (face, name, line under) |
| `.bar` `.title` `.crumb` `.time` `.spacer` | plain 52px page header row |
| `.top` > `.pill` (`.pill-crumb` `.pill-title` `.pill-btn` `.pill-sep` `.ptab`) | floating header of glass pills over a transcript; `.ptab` is a thread tab (mark, title, `<small>` age) |
| `.glass` | the glass material (`.pill`, `.speech`, `.pop` share it) |
| `.btn` `--accent` `--quiet` `--danger` `--sm` `--lg` / `.icon-btn` `--sm` | neutral tablet, the one suggested answer, decline, destructive / 28px, 22px icon button |
| `.seg` / `.tabs` `.tab` | segmented control (`aria-pressed`/`aria-selected`) / topic tabs with `<small>` counts |
| `.count` `.count--you` / `.dot` `.dot--fail` | count capsule, marigold when it waits on you / 7px dot |
| `.chip` `--you` `--fail` `--ok` `--who` / `.proj` `.proj--webshop` `--payments` `--ops` / `.src` | small label / project name with its tinted diamond / source mark + name |
| `.ledger` `.ans` `.ans-desc` / `.answers` `.choices` / `.bars[data-p="1..4"]` | answers with what each does / fixed answer slots / priority bars |
| `.card` `.hair` `.section-h` | raised card / hairline rule / small section heading |
| `.field` `.toggle` `.choice-box` `.range` `.range-out` `.meter` | inputs; `.meter > i` fills in `--who` or ink |
| `.stack` `.stack-more` | overlapping faces, "+n" |
| `.transcript` `.column` `.msg` `.msg--me` `.bubble` `.worked` `.files` `.codeblock` `.plus` `.minus` `.provenance` `.result` | transcript parts |
| `.composer-wrap` `.composer` `.dock` `.composer-card` `.pick` `.send` `.lip` | composer, with a Request docked on it |
| `.pop` `.pop-h` `.pop-sec` `.line` `.line-note` `.modal` `.dialog` `.options` / `.speech` | popovers and dialogs / small floating glass label |
| `.table-heads` `.table-row` | dense 40px grid rows; the page sets `grid-template-columns` |
| `.axis` `.axis-tick` `.axis-now` `.lanes` `.hour-line` `.now-line` `.run-bar` | the Runs day timeline (section 7) |
| `.wordmark` `.deco-num` | Limelight wordmark / 26px Deco numeral |
| `.muted` `.faint` `.you-ink` `.ok-ink` `.fail-ink` `.who-ink` `.num` `.mono` `.sr`, `kbd` | text helpers; `kbd` is a faint shortcut key |

The eight most useful, in markup:

```html
<button class="btn btn--accent btn--sm">Allow once</button><button class="btn btn--sm">Allow always</button><button class="btn btn--quiet btn--sm">Deny</button>
<h3 class="section-h">Waiting on you <b class="count count--you">3</b></h3>
<span class="proj proj--webshop">webshop</span>
<span class="chip chip--you">Question</span> <span class="chip chip--who" style="--hue:var(--hue-sky)">review</span>
<header class="top"><nav class="pill"><span class="pill-crumb"><span class="proj proj--ops">ops</span></span><a class="ptab is-on" href="#"><i data-mark="waiting"></i>Migrate ops dashboards</a></nav></header>
<div class="seg"><button aria-pressed="true">1 hour</button><button aria-pressed="false">Since 07:00</button></div>
<span class="stack"><i data-face="Ada" data-size="22"></i><i data-face="Milo" data-size="22"></i><span class="stack-more">+3</span></span>
<div class="card" style="padding:16px">...</div>  <div class="glass" style="border-radius:var(--r-lg)">...</div>
```

## 4. crew.js (`window.Crew`)

At DOMContentLoaded it draws every shell (`[data-side]`, `[data-webbar]`, `[data-setnav]`,
`[data-threads]`, `[data-status]`, `[data-tabbar]`), then **once** swaps every placeholder under
`document`. Markup you inject later must be built with the functions, or passed to
`Crew.drawPlaceholders(el)` after `innerHTML`.

| Placeholder | Function | Notes |
|---|---|---|
| `<i data-face="Fix 3-D Secure checkout for EU cards" data-pose="waiting" data-size="24">` | `Crew.face(name, {pose, size, look})` | size default 28; under 30px the strokes go bold |
| `<i data-mark="waiting" data-size="14">` | `Crew.mark(state, size)` | 6 states: `working` `waiting` `done` `failed` `paused` `idle` |
| `<i data-i="search" data-size="16">` | `Crew.icon(name, size)` | throws on an unknown name |
| `<i data-brand="github" data-size="14">` | `Crew.brand(name, size)` | throws on an unknown name |
| `<i data-you="24">` | `Crew.you(size)` | Rogier: a marigold "R"; people are not characters |
| `<i data-logo="28" data-mono>` | `Crew.logo(size, {mono})` | the Hercule mark |

Also exported: `Crew.lookFor(name)`, `Crew.hash(text)`, `Crew.poseWord(pose)` ("waiting" -> "waiting
on you", "away" -> "can't be reached"), `Crew.favicon(waiting)`, `Crew.WAITING`.

**Poses** (`data-pose`, default `idle`): `working` (typewriter, tapping), `waiting` (raised
marigold hand), `idle` (blinks), `asleep` (closed eyes, z, desaturated), `failed` (plaster, red
badge), `paused` (pause badge), `done` (smile, green check), `away` (faded, "can't be reached" badge).

**Color is who.** `lookFor(name)` returns `{hue, shape, acc}`: a hand-cast look for 25 known
names (Ada, Milo, Juno, Hercule, Triage, the workflows, the book's live sessions), else a hash
of the exact name picks hue (8), shape (`egg` `tall` `round` `wide`) and accessory. The face's
SVG carries `style="--hue:var(--hue-<hue>)"`. The Stage seeds every face with the thread's
**title**, so a title keeps its face everywhere. To paint anything in a thread's color:
`style="--hue:var(--hue-' + Crew.lookFor(t.title).hue + ')"`, then `var(--who)`/`--who-ink`.
Two threads of one crew can hash to the same hue; Tracks wrapped `Crew.face` to give partners
distinct hues (section 7).

**Brands** (monochrome, `currentColor`): `github` `gmail` `sentry` `posthog` `intercom` `grafana`
`stripe` `slack` `discord` `anthropic` `claude` `openai` `linear` `pagerduty` `datadog`
`googlecalendar`, plus `pi` (a "π" glyph), `cron` (clock icon) and `web` (chat icon).
Providers: Claude Code -> `claude`, **Codex -> `openai`** (there is no `codex`), pi -> `pi`.

**Icons** (all 83, 16px outline): `search` `plus` `minus` `compose` `close` `check` `chev-r`
`chev-l` `chev-d` `chev-ud` `office` `list` `intake` `checkin` `threads` `runs` `discussions` `wiki`
`overlap` `workflows` `agent` `tasks` `fleet` `connections` `bell` `settings` `sidebar` `editor`
`mic` `send` `stop` `branch` `worktree` `laptop` `server` `clock` `sparkle` `sliders` `shield` `bolt`
`external` `more` `popout` `moon` `sun` `key` `lock` `globe` `filter` `heart` `memory` `skill`
`alarm` `question` `pause` `play` `calendar` `eye` `terminal` `file` `diff` `link` `crew` `mail`
`chat` `user` `palette` `cpu` `id` `bound` `puzzle` `system` `arrow` `undo` `hash` `wave` `grip`,
and the marks `m-working` `m-waiting` `m-done` `m-failed` `m-paused` `m-idle`.

**The book's sidebar**: `<aside data-side="X">` inside `.app`. `X` is a thread key (`fix`,
`read`, `new`), an assistant key (`ada` `milo` `juno` `hercule`) or a place (`office` `intake`
`checkin` `fleet` `workflows` `discussions` `wiki` `settings`; these open the Hercule tab).
`data-side-runs` adds "From runs". It draws its own mini world from `crew.js`, not `world.js`.
**The data-pane trap**: it draws `<div data-pane="threads">` and `<div data-pane="hercule">`,
and CSS hides one per tab. Never mark your own panes `data-pane`, or `[data-pane]` selects the
hidden sidebar div. Use another attribute (Tracking used `data-detail`).

`crew.js` also reads `<html data-state>`: `swarm` (10x counts), `first`/`first-no-repo`, `scrolled`,
`list` (clicks the `[data-seg]` button with `data-view="list"`). `<html data-intake-count>` sets the
Intake count; `<html data-motion="off">` stops face animations (handy for screenshots).

## 5. The Office (`office.js` + `office.css`)

An isometric Art Deco bureau, drawn as one SVG: each runner is a wing of desks (`build-box-1`
8 of 8 at cap, `studio-mac` 5 of 6, `build-box-2` 3 of 8), every live session sits at a desk as
its face with a tag, waiting colleagues queue at your desk, the Triage clerk works by a case
board, and pneumatic tubes carry events from the Connections. Reference page:
`crew-bureau-2/desktop/office.html` (its `?flow=on` sets `data-flow`).

```html
<link rel="stylesheet" href="../../crew-bureau-2/office.css" />
<div style="position:relative; height:560px"><div data-office style="position:absolute; inset:0"></div></div>
<script src="../../crew-bureau-2/brands.js"></script>
<script src="../../crew-bureau-2/crew.js"></script>
<script src="../../crew-bureau-2/office.js"></script>  <!-- after crew.js: it reads window.Crew -->
```

- It takes **no options on the element**: the data is hard-coded (`TODAY`, `SWARM` in office.js).
  `<html data-state="swarm">` draws the 10x floor; `<html data-flow="off">` hides the tubes (they
  show when the attribute is absent). `[data-swarm="n"]` elements get their text swapped in swarm.
  The host needs a size; a ResizeObserver redraws the room to fit whenever it has one.
- `window.Office` exposes the drawing kit (`frame`, `room`, `P`, `box`, `desk`, `sprite`,
  `yourDesk`, `palm`, `cabinets`, ...) for a page that furnishes its own room, as `first-run.html` does.

## 6. `sidebar-directions/shared/` (on main)

### stage.js and stage.css

`Stage.direction({...})` registers your direction; the window is built at DOMContentLoaded and
throws if nothing registered. Fields:
- `rootClass` - class on the window root (`.app.stage.<rootClass>`); scope all your CSS under it.
- `initial` - thread id open at load, or a function of the state. Default `t3ds`
  (`partner` -> `t3dsReview`, `stress` -> `xLead`).
- `drawList(listEl, api)` **required** - draw the sidebar's list. Wire `[data-open-row]` clicks
  to `api.open(id)` yourself.
- `drawHeader(thread, api)` - return header markup, or null for the default pill header.
- `drawMain(mainEl, thread, api)` - draw the whole main pane; return `false` to fall back.
- `onOpen(id, api)`, `boot(api)`.

The stage keeps the sidebar's fixed parts (traffic lights, Threads | Hercule switch with a 9,
New thread / Search / Office, Assistants, the foot's counts and Rogier) and draws the default main
pane: workspace tabs header, transcript (exchange cards for messages between threads), composer
with a docked Request. `api` (also `Stage.api`):
- data: `world`, `state`, `els` (`app` `side` `list` `assistants` `sum` `main`), `getThread`,
  `listThreads(pred)`, `findLead`, `listPartners`, `listCrew`, `listLeads(projectId)`,
  `listExchanges(leadId)`, `listWorkspaceThreads`, `getProject`, `countByPose`, `pickSpokesperson`
- time and words: `toMinutes`, `compareTimes`, `minutesAgo`, `formatAge`, `decideSlot`,
  `describePlace`, `describeAgent`, `findMachine`, `findBranch`, `escapeHtml`
- drawing and acting: `drawFace(t, size, pose)`, `drawBrand`, `drawThreadRow`, `drawSum`,
  `drawHeader`, `drawTranscript`, `drawComposer`, `drawMain`, `open(id)`, `openId()`,
  `onOpen(fn)`, `spawnPartner`, `resetSpawn`, `markDone(ids)`, `restoreThreads`, `showToast`

`api.drawThreadRow(t, {selected, title, detail, cls})` returns the #626 52px row: title and
status word (`Working` in accent ink, `Approval`/`Question` in marigold bold, `Queued`, or an age
like `20m`), then the provider mark and the branch, or `repo · machine`. Working rows recede to
72% unless selected. stage.css classes: `.st-thread` `.st-line` `.st-detail` `.st-glyph`
`.st-clip` `.st-keep` `.st-need` ("2 need you") `.st-more`, `.stage-x*` (exchange cards),
`.stage-toast`.

States the stage itself reads: `everyday` (default), `swarm` (+19 threads), `stress` (+10 threads
of one piece of work), `spawn` (`tSecretsVerify` held back for `api.spawnPartner()`), `partner`.

The app's sidebar now follows **Workbench, refined** (`sidebar-directions/workbench-refined/`,
map #825): one row per piece of work with dots. To keep that sidebar and draw only your main pane,
link `workbench-refined.css` and `.js`, and before the `.js` patch the registration (checked in
jsdom, which has no layout, not in a browser):
`var reg = Stage.direction; Stage.direction = function (d) { d.drawMain = myMain; reg(d); };`

### world.js: the fixture morning (`window.WORLD`)

Tuesday 29 September 2026, 09:41 (`now: "09:41"`, `today: "Tuesday 29 September 2026"`). It
extends `shared/CONTENT.md` (the book's world: machines `studio-mac`, `build-box-1`,
`build-box-2`) with leads and partners.

| Key | Shape |
|---|---|
| `projects` | `{id, name, tint}`: `webshop`/`webshop`, `payments-api`/`payments`, `ops`/`ops` |
| `providers` | `claude` Claude Code, `codex` Codex (brand `openai`), `pi` pi |
| `workspaces` | id -> `{kind: worktree\|main\|scratch\|none, repo, branch, from, machine}` |
| `threads` (16) | `{id, title, project\|null, provider, model, workspace, pose, status: working\|approval\|question\|queued\|null, ask, askShort, started, last, lead, joined: spawned\|added, role, result, fromTask}` |
| `output` | lead id -> `{plus, minus, files, pr: {number, state}\|null, checks}` |
| `exchanges` | `{at, from, to, kind: brief\|report, text}`, oldest first |
| `done` (7 of `doneCount` 23) | `{id, title, project, provider, model, doneAt, lead, role}` |
| `waitingRuns` | one run step: "Ship release v2.15 · publish", "Publish to npm?" |
| `assistants` | Ada working, Milo idle, Juno asleep |
| `spawn` | `{lead: "tSecrets", thread, exchange}` - the partner that joins at 09:41 |
| `swarm` | `{more: {webshop: 31, ...}, threads: [19]}` |
| `stress` | `{open: "xLead", threads: [10], exchanges}` - long real titles, `roleBy` |
| `transcripts` | `t3ds`, `t3dsReview`, `tStripe`: items `{me}` `{from}` `{sent}` `{worked, tools}` `{agent, html}` `{files}` `{result, cmd}` `{waiting}` |

Times are `"HH:MM"` today, or `"yesterday HH:MM"`, `"Mon HH:MM"`, `"Sun HH:MM"`. Live morning:
3 waiting (`t3ds` approval "Run git push?", `tPayoutCheck` question, `tDash` question), 6 working,
7 idle.

**Reuse, don't copy**: link `../../sidebar-directions/shared/world.js` so all five directions
draw the same morning and Rogier compares designs, not content. Put anything extra in your own
`<name>-data.js` loaded after it. Per-turn activity for every world thread already exists in the
Tracks data (section 7); fetch it with `git show` into your folder if you need history.

### book.js and book.css (copies in `overview-directions/shared/`)

```html
<figure class="bk-frame" data-src="desktop.html?state=everyday" data-caption="Tuesday 09:41"
        data-note="One line under the caption" data-crop="0,96,272,640" data-zoom="1.5"
        [data-w="1440" data-h="900"] [data-replay] [data-theme="orient-express"]></figure>
<button data-theme-option="whitehaven">Whitehaven</button>
```

Each frame is a live, lazy, scaled iframe of the page at 1440x900. `data-crop="x,y,w,h"` (page
pixels) shows one region at `data-zoom` when the column is wide enough, else as large as fits.
`data-replay` adds a Replay button; `data-theme` pins one frame (moved to `data-frame-theme`).
Theme buttons switch the book and all unpinned frames; the choice is kept in localStorage
(`sbd-theme`, shared with the sidebar book on the same origin). Blocks: `.bk-top` (sticky toolbar:
`.bk-brand`, `.bk-links`, `.bk-themes`), `.bk` (page column), `.bk-wide` (breaks out to 1440px),
`.bk-hero` (`.bk-eyebrow`, `h1 .bk-num`, `.bk-lever`, `.bk-lede`), `.bk-sec` (h2 + `.bk-lede`),
`.bk-grid` / `--3` / `--4`, `.bk-card` / `--quiet`, `.bk-stats` > `.bk-stat` (`<b>` Deco numeral +
`<span>`), `.bk-pair`, `.bk-duo`, `.bk-frames`, `.bk-steps` (numbered callouts), `.bk-huh`
(inverted block), `.bk-table` in `.bk-scroll`, `.bk-chip` / `--you` / `--accent`, `.bk-body`,
`.bk-list`, `.bk-next`. Reference: `git show origin/prototype/sidebar-directions:docs/design/sidebar-directions/tracks/index.html`.

## 7. How Tracks drew its day sheet

`git show origin/prototype/sidebar-directions:docs/design/sidebar-directions/tracks/tracks.js`
(lines 852-1050), data in `tracks-data.js`, styles `.tk-s-*` in `tracks.css`.
- Data: `TRACKS_DATA.spans[threadId] = [["09:02","09:04"], ..., ["09:38", null]]` (null = still
  running), `looked[leadId] = "HH:MM"`, `sheetFrom: "07:00"`, `awayFrom: "09:01"`.
- A `<section class="tk-sheet">` appended to `.app`, absolutely over the main pane (`left: 272px`);
  top row: title, a `.seg` span switch (1 hour / 2 hours / Since 07:00), a legend, Close (esc).
- Time axis: a linear scale `x(m) = (m - from) * chartW / (to - from)`; ticks every 15 or 30 min as
  absolutely placed spans (`left: x px`), hours emphasised, "now 09:41" at the end. Behind the rows,
  one vertical rule per tick (dashed; solid on the hour; darker at now).
- Body: grouped by project, one block per piece of work: a 268px label column (face, role,
  provider) and one inline SVG per lane, one 26px row per thread.
- Per thread, in its hue: a hairline from start to now, an 8px-tall rounded bead per span, a
  `--you-tint` bar outlined in `--you` from `last` to now while waiting, and a curved elbow where
  a partner branches off its lead.
- Exchanges are vertical arrows between two threads' rows at their minute; a notch marks "you
  looked at HH:MM". Hover shows a `data-tip`; a click on a label opens the thread. `?state=daysheet`.
- Simpler reusable alternative already in system.css, the Runs day timeline:
  `<div class="axis"><span class="axis-tick is-major" style="--at:37.5%">09:00</span><span class="axis-now" style="--at:40.3%">09:41</span></div>`
  `<div class="lanes" style="--tracks:3"><span class="hour-line" style="--at:37.5%"></span><span class="now-line" style="--at:40.3%"></span><span class="run-bar run-bar--you" style="--at:30%;--span:5%;--track:1"><span class="run-bar-line"></span><span class="mark mark--waiting">...</span></span></div>`
  (`--at`/`--span` are % of the width; see `drawRunDay` in `crew-bureau-2/workflows.js`).

## 8. Reading on the phone (Android Chrome, over the tailnet)

What book.css already does at `max-width: 900px`: the column becomes `100% - 36px`, every grid
(`.bk-grid*`, `.bk-pair`, `.bk-duo`, `.bk-next`) drops to one column, stats go to two columns,
hero and section padding shrink, the toolbar wraps into two rows with horizontally scrolling
links, and anchors land below it. Frames refit to the column on resize (ResizeObserver).

Traps:
- A full 1440px frame shows at about 0.25 scale on a phone: unreadable. Pair every key point
  with a `data-crop` of 360px or less at `data-zoom`, so the phone shows it near 1:1.
- No hover and no keyboard on a phone, and page.js disables focus inside frames: anything shown
  on hover or by a shortcut needs a `?state=` that draws it, framed on its own.
- `scrollIntoView` inside a framed page scrolls the story page too; set the list's `scrollTop`.
- Frames are `loading="lazy"`, each a full animated page: keep their number sensible. "Open ↗"
  opens the page itself, which has no viewport meta. Wide tables go in `.bk-scroll`.
- Serving: already running. A static server serves `docs/design` on the tailnet address
  (`http://100.84.20.56:8471/`, or `http://beelink:8471/` from the phone via MagicDNS).
  `tailscale serve` needs root on beelink, so the server binds the tailnet address directly. Do
  not start another server, and never kill one you did not start.

## 9. Screenshots (on beelink, Linux)

A working headless Chromium is set up in `/tmp/ovtools` (Playwright 1.63 core, the cached
Chromium 1243, and the missing system libraries unpacked into a scratch dir). Two scripts:

```
# One screenshot. Prints page errors and console errors: read them, that is your JS check.
node /tmp/ovtools/shot.mjs "<abs path or URL>?theme=orient-express&state=everyday" out.png \
  [--w 1440] [--h 900] [--scale 2] [--full] [--wait 600] [--mobile]

# Drive the page, then shoot. Steps run in order.
node /tmp/ovtools/act.mjs "<abs path or URL>" out.png [--w --h --scale --mobile --full] -- \
  "click:<css>" "hover:<css>" "key:Meta+Shift+T" "wait:400" "eval:<js expression>" "shot:/tmp/mid.png"
```

- Use the http URL (`http://100.84.20.56:8471/overview-directions/<name>/desktop.html?...`) or a
  file path; both work. A `#fragment` in a file URL gives a blank capture.
- WebGL (the 3D Office) renders through SwiftShader in headless Chromium: slow but correct. Give
  3D pages `--wait 2500` or more.
- Phone check: `--w 412 --h 915 --scale 2 --mobile` (a Galaxy S23 Ultra in portrait).
- Write output PNGs to `/tmp/ovtools/<name>/`, not into the repo, unless the PNG is a deliberate
  asset of a story page.
- Look at every PNG you take with the Read tool. A design is not checked until you have looked.

## 10. Traps, in one list

- From above: `data-pane` is crew.js's; `data-theme` on a `<figure>` restyles it; `scrollIntoView`
  in a frame scrolls the book; placeholders are swapped once; `--hue` must be inline.
- `Crew.icon`/`Crew.brand` throw on an unknown name (`codex` is `openai`), which stops the script.
- `?state=swarm` changes crew.js, office.js and the stage at once; name your own states.
- Accent is the only filled button; marigold never fills one; brass is never text; mono is for
  code only; Limelight is never UI text.
- If you link Intake's `intake-directions/asks/asks.css`: it caps list children at 960px; the
  app runs rows full width, so override it, except `.asks-toast` (412px).
