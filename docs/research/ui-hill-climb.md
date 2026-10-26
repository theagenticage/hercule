# Desktop UI hill climb: plan

Researched 2026-10-26. This plan is for agents who will make many small pull requests that improve the desktop app's UI step by step, until it scores well on every metric below and Rogier finds it easy on the eyes on his own monitors.

The idea comes from T3 Code's "council" (Theo, 2026-10-25): LLM reviewers score screenshots per round on a rubric, give prioritized fixes with exact values, and an agent applies them. We use that as a guide, add scripted metrics the reviewers cannot argue with, and guard against the ways such a loop goes wrong.

Section 8 records the decisions Rogier made on 2026-10-26. The work is tracked in [#852](https://github.com/theagenticage/hercule/issues/852), with one sub-issue per ticket of rounds 0 to 2.

## 1. Scope

- **The desktop app** (`apps/desktop`, the Crew Bureau design system). It is where the UI work happens: 290 desktop commits in the last 14 days, against 2 in the web app's CSS and `packages/ui`.
- All five themes. Whitehaven (light) and Orient Express (dark) come first, because they are the defaults and the ones `compare:bureau` checks.
- Out of scope: the web app (`docs/design-language.md`, Onest and "Midnight"), Android, and the Office's 3D scene. The web app can take the results later, once the tokens settle.

## 2. Where we stand today (measured)

### Fonts

- The UI font is Bricolage Grotesque, at 13px for UI body text and 14px for transcript prose. Weights are 400, 520 and 640.
- Bricolage is a display face. At 13px:
  - Its x-height is 0.517 em, against Inter's 0.546, so text looks about 6% smaller at the same size.
  - `I` and `l` draw identically, and `O` and `0` nearly so. The font has no feature that fixes this.
  - It relies on the browser's automatic optical sizing. Its default instance is the opsz 96 display cut.
  - Its Latin file is 132 KB, the heaviest of the sans fonts compared.
- Code uses Recursive with `CASL 0.5`, a semi-casual mono. The file is 305 KB.

### Contrast per theme

Text tokens on `--bg`. WCAG is the ratio, APCA is the Lc value (negative in dark themes).

| Theme | bg | ink | muted | faint | line vs bg |
|---|---|---|---|---|---|
| Whitehaven | `#f4f3f0` | 15.6 / Lc 97 | 6.7 / Lc 79 | 4.55 / Lc 68 | 1.27 |
| Styles | `#f5eee3` | 14.0 / Lc 93 | 6.8 / Lc 78 | 4.8 / Lc 68 | 1.31 |
| Orient Express | `#1a1310` | 15.4 / Lc -94 | 8.8 / Lc -61 | 5.9 / Lc -43 | 1.44 |
| Nile | `#0e1714` | 15.5 / Lc -95 | 9.1 / Lc -63 | 5.9 / Lc -43 | 1.45 |
| End House | `#1d1217` | 15.7 / Lc -96 | 9.0 / Lc -62 | 6.0 / Lc -44 | 1.47 |

What this means:

- **The light themes are fine on contrast.** Whitehaven's faint text sits right at the WCAG 4.5:1 floor and must not get lighter.
- **The dark themes are dark, brown and flat:**
  - The background is OKLCH L 0.195, with a visible warm tint (`#1a1310` is brown-black).
  - Surfaces step up by only 0.03 L (bg 0.195, surface 0.226, raised 0.262).
  - Lines are 1.44:1 against the background, which APCA counts as invisible, so panels melt into one slab.
  - Faint text is Lc 43, below what 12px text needs.
- **The background lightness alone does not explain why T3 feels lighter.** T3's dark background is `#0a0a0a`, which is darker than ours. The likely causes are the brown tint, the invisible lines, the flat layers, and the smaller-looking font. Round 2 tests this.

### How the CSS uses type and colour

Counts are for renderer CSS, excluding specimens and `tokens.css`.

- **Font sizes:** 21 distinct values. Among them are off-scale ones: `11.5px` ×6, `12.5px` ×4, `12px` ×8 written raw.
- **Font weights:** 520 ×99, 640 ×80, 400 ×22, and raw 700, 600 and 400 once each.
- **Text colour:**
  - `--faint` is used 163 times, almost as often as `--ink` (103). The quietest colour carries a lot of real content.
  - `--muted` is used 182 times.
- **Border radius:** 30 distinct values, including raw 5px ×7 and 8px ×5.
- **Text dimmed with opacity, not a colour:** receded sidebar rows 0.72, done rows 0.6, away faces 0.55, and intake 0.55 to 0.8. Opacity lowers contrast in a way no token check sees.
- **Text size is specified but never built.** Spec 17 §Appearance defines a 4-step Text size, and the IPC contract carries `textSize`. No renderer code reads it, and `theme-init.js` does not set it.
- **There is no accessibility tooling:** no axe, no contrast test, no APCA check.

## 3. What T3 Code did (reference, not a template)

Theo's chain of PRs in `pingdotgg/t3code`. Every PR body carries a "Council review" table.

| PR | What it changed |
|---|---|
| [#24776](https://github.com/pingdotgg/t3code/pull/24776) | Inter as a fallback after SF Pro; radius 10 to 8px; icon stroke 2 to 1.75; higher muted and border contrast in dark |
| [#24837](https://github.com/pingdotgg/t3code/pull/24837) | sidebar, composer, details panel; reference apps scored 8.3 to 8.5 |
| [#24810](https://github.com/pingdotgg/t3code/pull/24810) | a blue accent pass; mostly dropped |
| [#24865](https://github.com/pingdotgg/t3code/pull/24865) | the main overhaul behind a Beta toggle; 18 rounds, 4 reviewers (Opus, GPT, Muse, Gemini) |
| [#25251](https://github.com/pingdotgg/t3code/pull/25251) | brought colour back where it means something, after the council made it too grey; added 4 categories: accessibility, responsive behaviour, motion, copy |
| [#25323](https://github.com/pingdotgg/t3code/pull/25323), [#25324](https://github.com/pingdotgg/t3code/pull/25324) | sent-message contrast; new design on by default |

Lessons for us:

- **Scores inflate.** By round 13 every reviewer gave 10/10 in every category. The PR also flags Gemini's scores of the reference apps moving from 8.5 to 9.6 on the same images. Absolute scores alone cannot steer the loop.
- **The council drifts toward grey.** It removed colour until a later PR had to put it back. We have a stronger identity (faces, crew hues, Deco), so we protect it explicitly (section 4, Character).
- **Owner calls stay.** Theo kept some choices against the council: the blue switch, the 75% read titles, the three-line sidebar rows. We do the same: Rogier's verdict on his monitors outranks every score.
- **T3's dark theme is pure black (`#000`).** That is the opposite of what Rogier wants. We do not copy its colours.
- **On macOS, T3's UI font is SF Pro, not Inter.** Inter is only the fallback for Windows and Linux.
- **The brief and rubric were never published.** We write our own (section 4).

## 4. The scorecard

Two layers. The scripted layer is a hard gate: a PR may not make any of its numbers worse. The judged layer decides what to do next and whether a change is better.

### 4.1 Scripted metrics (`pnpm ui:metrics`)

Computed on the specimen pages in every theme, by a script (section 5). Each metric has a target, and some also have an upper bound, so the loop cannot win by pushing one number to its extreme.

| Metric | How it is measured | Target |
|---|---|---|
| Text contrast per role | APCA Lc of each text node's effective colour (opacity included) against the pixels behind it, sampled from a capture with the text hidden | ink Lc ≥ 85, and in dark ≤ 95; muted ≥ 60; faint ≥ 45 and only on 12px metadata; placeholder and disabled ≥ 30 |
| WCAG text contrast | same pairs | ≥ 4.5:1 below 18px, ≥ 3:1 above |
| Non-text contrast | control borders, focus ring, state marks against their background | ≥ 3:1 (WCAG 1.4.11) |
| Lines are visible | `--line` against the surface it sits on | APCA Lc ≥ 15 |
| Surface separation | OKLCH L between bg, surface and raised | each step ≥ 0.025 |
| Dimming by opacity | text nodes whose contrast is lowered by an `opacity` below 1 | 0 (state is shown by colour or a mark, not by fading) |
| Type scale | distinct font sizes in use, and sizes that are not whole pixels or not tokens | ≤ 7 sizes; 0 off-scale |
| Weights | distinct weights in use | ≤ 3 |
| Radii | distinct radii in use, and radii not taken from a token | ≤ 6; 0 off-token |
| Spacing grid | padding, margin and gap values on the 4px grid | ≥ 95% |
| Target size | clickable boxes | ≥ 24 × 24 px (WCAG 2.5.8); report those under 28 |
| Focus | every interactive element shows a visible focus ring with ≥ 3:1 change | 100% |
| Text spacing | nodes that clip or overlap with line-height 1.5, letter-spacing 0.12em, word-spacing 0.16em injected (WCAG 1.4.12) | 0 |
| Text size and zoom | nodes that clip at the largest Text size step, and at 150% zoom | 0 |
| Prose measure | characters per line of transcript prose at 1440px wide | 60 to 75 |
| Glyph confusion | bitmap difference of `Il1` and `O0` at the UI size | all pairs distinct |

Notes:

- APCA's strict tables would fail the muted text of almost every dark UI (GitHub, Apple and T3 sit at Lc 45 to 51). That is why the tiers above are ours, not APCA's strict ones.
- The baseline is committed (`apps/desktop/ui-metrics.baseline.json`). CI fails a PR that makes any number worse than the baseline. A PR that improves a number updates the baseline in the same commit, so the metrics only go one way. This ratchet is what makes the loop climb.
- A regression is accepted only by editing the baseline in the PR, with the reason in the PR body.
- The thresholds above are starting values. A target changes only through a PR that says why.

### 4.2 Judged categories (the council)

Each category has anchors written out as text for scores 3, 5, 7 and 9. The calibration set is the visual reference. Sol reads the anchors before scoring.

1. **Typography**: legibility at 12 to 14px, rhythm, letter shapes, line length.
2. **Hierarchy**: the most important thing in each region wins first; at most 3 levels of emphasis visible at once.
3. **Spacing and density**: dense without being cramped; consistent rhythm; aligned edges.
4. **Colour and contrast**: text and edges are clear; colour means one thing each time.
5. **Eye comfort**: glare, muddiness, glow around bright text, flat layers. Scored apart from contrast, so "more contrast" cannot win on its own.
6. **Iconography**: one stroke weight, one optical size, aligned to text.
7. **State visibility**: working, waiting, failed, selected and focused are told apart without relying on colour alone.
8. **Consistency and polish**: same thing, same look; no stray 1px misalignments.
9. **Clarity and copy**: labels predict what happens; plain words.
10. **Character**: it still looks like Hercule (faces, crew hues, warmth, Deco touches). This guards against the drift to generic grey that T3 hit.
11. **Overall.**

How the council runs:

- **One reviewer: GPT-6.1 Sol** (decided by Rogier, 2026-10-26).
  - Its settings: high effort, full access, on the Codex provider instance (`83fb775f`, "Codex").
  - **In a normal session**, the climbing agent spawns it in its own workspace, so it sees the same captures and code:
    ```
    hercule session spawn --instance 83fb775f --model gpt-6.1-sol --options '{"effort":"high"}' --access-mode full-access --role "ui council"
    ```
    The prompt points it at `docs/design/ui-council/BRIEF.md`.
  - **In the workflow**, agents cannot start sessions, so the council is a step of its own on the same model. Its output is held to the brief's format by `outputSchema`.
- **Per PR: pairwise.** The reviewer sees the before and after captures of the touched screens, and answers "which is better on category X" for each category. It answers twice, in two separate turns, with the order swapped. A win counts only when both orders agree. This removes position bias, which matters more with a single reviewer.
- **Per round: absolute.** All screens are scored 0 to 10 per category. This tracks the trend; it never decides a PR on its own.
- **With one reviewer, there is no panel to average out its taste.** Two things stand in for the panel: the calibration set below, and Rogier's check. When Sol and Rogier disagree, Rogier's call is recorded under "Owner decisions" in the brief, so Sol stops asking for the same change.
- **A frozen calibration set is scored every round:**
  - the T3 Code, Claude desktop and Codex desktop screenshots in `~/hercule-ui-council/calibration/` (section 5, item 3);
  - three deliberately broken Hercule variants (maximum contrast, cramped, noisy).
  
  If their scores move, Sol drifted, not the UI. That round's absolute scores are then marked unreliable.
- **Rogier's check.** At the end of each round, Rogier looks at the app on his work and home monitors. That verdict is the real metric, and it overrules the council.

## 5. Round 0: the harness

Build these first, in this order. Each item is its own small PR.

1. **The plan on `main`.** This document lands with a docs PR, and later PRs keep it current.
2. **`capture:ui`.** Captures a fixed list of screens from the specimen pages, with no controller needed. Every later item depends on it.
   - **It runs on Linux.** It drives plain Playwright Chromium against the renderer's Vite server, as the wiki page "Screenshotting a desktop specimen at any window width" describes.
   - **Screens:** sidebar, thread, thread with a long transcript, draft, conversation, intake, tracking pane, workflows, run, discussions, wiki, and Settings › Appearance. The screens the specimens do not cover yet (Settings › Skills, step sessions, subagents) are added when a later round needs them.
   - **Variants:** every screen in all five themes, at 1440 × 900.
     - **1x is the main capture.** Rogier's external 1920 × 1080 monitor draws at 1x, where font rendering is hardest. Sol scores 1x first, and every before/after image in a PR is 1x.
     - **2x** is captured as a second view.
     - **Glass** at the default (40%) and at 0% (Reduce transparency).
   - **Output:** PNGs, a contact sheet per theme, and a manifest.
3. **These three, in parallel:**
   - **`ui:metrics` and its CI job.** It computes section 4.1, and prints JSON and a Markdown table.
     - **The ratchet.** It commits the baseline (`apps/desktop/ui-metrics.baseline.json`) and fails CI on any number that got worse. The only way to accept a regression is to edit the baseline in the PR and give the reason in the PR body. No label or flag skips the gate.
     - **CI must stay fast.** The job:
       - runs on Linux, in parallel with the other jobs, and only when the renderer, the tokens or the fonts change;
       - loads each specimen screen once per variant, in a single browser with pages running in parallel;
       - records the goldens (1x, default glass, all five themes) and computes every metric, including the glass 0%, largest Text size and text-spacing variants, in that same pass;
       - leaves the 2x captures and the contact sheets to the nightly run, because only Sol needs them;
       - has a hard budget of 3 minutes, measured in the ticket. Anything that pushes it past moves to the nightly run.

       CI as a whole takes about 10 minutes today, and its longest jobs (desktop, android) take about 5. A job under 3 minutes adds no time.
   - **The app as its own pixel reference (D2).** An ADR, the spec 17 amendment, and the change to `compare:bureau`:
     - **Goldens are recorded on Linux in CI,** by the same tool as `capture:ui`, so a nightly run on beelink can record them. Rendering problems that show only on a Mac (font smoothing on Rogier's monitors) are caught by Rogier's eye check, not by the goldens.
     - **The piece sheet** (faces, marks, icons) keeps its comparison with the book, on macOS, as today.
     - **The book is frozen** as the record of the second edition. The rule that the book's `tokens.css` and font files are byte-identical with the app's is dropped.
     - **The new rule:** "The app's goldens and `tokens.css` decide a measurement; the spec decides a behaviour." It replaces "the pages decide a measurement; this text decides a behaviour". Hill-climb PRs then amend spec 17 only when a behaviour changes, or to remove a number the change makes wrong. They never add new measurements.
   - **Sol's brief and the calibration set.**
     - `docs/design/ui-council/BRIEF.md` holds the rubric, the anchors, the output format, and "Owner decisions". The output format is scores, then a prioritized fix list (MUST / SHOULD / COULD), each fix with exact values and a file and line.
     - **Anchors are written as text only.** The calibration set serves as the visual reference.
     - **The calibration set has two parts:**
       - **Screenshots of the reference apps.** They live outside the repo, because the repo is public: `~/hercule-ui-council/calibration/` on beelink. The brief names that path. They were captured on 2026-10-26, as windows of 1440 × 900 on atlas, at 1x (the HP 27f) and 2x (the built-in Retina screen):
         - `t3-ocean-{1x,2x}.png`: T3 Code in Ocean, which does not follow the system appearance, so there is no T3 light reference;
         - `claude-{light,dark}-{1x,2x}.png`;
         - `codex-{light,dark}-{1x,2x}.png`: Codex's empty new-chat screen. Rogier's Codex draws its UI in a monospace font, which is not Codex's usual look, so the brief tells Sol not to read Codex's typography as a reference.
       - **Deliberately broken Hercule variants** (maximum contrast, cramped, noisy). `capture:ui` generates these, so they live in the repo.
4. **The nightly "UI hill climb" workflow,** modelled on the Performance hunt (`4890db19`):
   - **Steps:**
     - **Score** (GPT-6.1 Sol, high): reads the brief and the latest captures, and returns the scores and the prioritized fix list.
     - **Climb** (Opus, high effort): takes the top MUST that is still open, makes the one change, captures again, and runs the metrics.
     - **Judge** (GPT-6.1 Sol, high, a fresh session): the pairwise before/after vote, in both orders.
     - **Review** (a fresh Opus at extra-high effort): checks that the change is one thing, that no metric got worse, and that the pairwise vote is a real win. It also checks that the desktop cost is stated, and that spec 17 is amended where a behaviour changed.
     - **Ship** (Sonnet): commits, and writes a PR body with the 1x before/after images, the metric diff and the vote table.
   - **When it runs:** once a night at 02:00 Europe/Amsterdam, and on demand with `hercule run start`.
   - **One PR at a time.** A run starts only when no hill-climb PR is open. Almost every change touches `tokens.css`, and the loop moves only as fast as Rogier merges.
   - **Nothing found.** A run that finds nothing worth a PR ends with a notification instead, as the Performance hunt does.
   - **The Mac-only checks** (the piece sheet in `compare:bureau`, `test:desktop`, the desktop perf scripts) are listed in the PR body as still to run. They are run on atlas before merging, as the wiki page "The sidebar's groups (#828)" describes.

### Who builds rounds 0 to 2

One coordinator session builds all of rounds 0 to 2 (decided by Rogier, 2026-10-26):

- **The coordinator:** Claude Opus 5.5, high effort, full access. It works from the umbrella issue and its tickets.
- **Sparring and review: a GPT-6.1 Sol thread.** The coordinator spawns it once, in the coordinator's own workspace, at high effort with full access. It uses the thread to spar over approaches and to review each change adversarially before it ships. The same thread acts as the UI council when a ticket needs one.
- **The implementation: Sonnet 5.5 subagents at high effort.** The coordinator hands each subagent one small piece of work that is simple to check. It checks each piece itself before going on.
- **Shipping:** the coordinator ships each PR with the `ship` skill.

## 6. Rounds 1 to 5: what to change, in order

Ordered by how much each round is expected to help "easy on the eyes". Each bullet is one PR unless it says otherwise. Every PR follows the rules in section 7.

### Round 1: type

1. **The font comparison sheet** (on a `prototype/*` branch, never merged).
   - **What it is.** A switcher that exists only in development lets the specimen pages swap the UI font and the code font.
   - **How Rogier sees it.** A session on atlas checks out the branch, starts the desktop dev server, and opens the sheet in Chrome, which renders with the same Chromium engine as the app. Rogier drags the window between his monitors (the HP 27f at 1x and the Retina screens) and picks. A screenshot would mislead: a 2x image shown on a 1x monitor is scaled.
   - **The UI candidates:**
     - **Inter 4.** Features `cv05` (tailed l), `cv08` (serifed I), `zero`, and `tnum` on numbers. 13px/400 with line-height 1.4 for UI; prose 14px with line-height 1.55; emphasis at 550 to 600. Its Latin subset is about 84 KB, against Bricolage's 132 KB.
     - **IBM Plex Sans.** Hinted, warmer, with a distinct `I`. It needs 13.5 to 14px because of its smaller x-height.
     - **Geist.**
     - **Bricolage Grotesque,** as today, for comparison.
   - **Each UI candidate is shown twice:** with Bricolage kept for page titles of 18px and up, and without it. Limelight stays for the wordmark either way.
   - **The code candidates:** JetBrains Mono, Geist Mono, and Recursive with its casual axis at 0.
   - **SF Pro is left out.** It cannot be bundled, and the Linux captures could not show it, so the loop would score a font Rogier never sees.
   - **The ticket closes** once Rogier's pick is written into the font-swap ticket.
2. **Swap the UI font** to the pick. This ticket is blocked by the sheet and labelled `needs-info` until Rogier picks. It covers:
   - `tokens.css`, the `@font-face` rules, the preload in `index.html`, and the licence entry in `styles/fonts/LICENSES.md`;
   - the spec 17 amendments (§Design system "Self-hosted fonts", Performance rule 6);
   - the bundle bytes, stated per AGENTS.md.
3. **Swap the code font** to the pick.
4. **Clean up the type scale:**
   - Remove the half-pixel and raw sizes, mapping each to the nearest token.
   - Weights become 400 / 500 / 600 (Inter's own instances) in place of 520 / 640.
5. **Build the Text size setting** spec 17 already defines: `theme-init.js` sets it, and Settings › Appearance draws the 4-step control the book has. People who want larger text can then have it, whatever the default is.

### Round 2: colour, light and dark

1. **The dark examples sheet** (on a `prototype/*` branch, never merged). Rogier wants to see the options before any dark theme changes. He views it live on atlas, as he does the font sheet (round 1, item 1). The sheet shows the sidebar, a thread and intake side by side, in:
   - (a) Orient Express as it is today;
   - (b) Orient Express retuned with the starting values in item 2;
   - (c) the same as (b), but with stronger layers: Ocean's steps applied to our warm hue;
   - (d) the sixth-theme candidate of item 4.

   Rogier picks a direction on his monitors, and the values are tuned from there. The sheet renders the specimens with a `tokens.css` override, so nothing on `main` changes.
2. **Retune Orient Express** to the picked direction (D4). This ticket is blocked by the sheet and labelled `needs-info` until Rogier picks. Starting values for (b):
   - bg L 0.195 to about 0.25, with chroma cut from 0.012 to about 0.006 so it reads warm grey, not brown;
   - surface steps of about 0.03 L above that, or Ocean's larger steps for (c);
   - `--line` up to about L 0.37 to 0.44, so edges are visible (Lc ≥ 15);
   - ink 0.94 to about 0.91 (Lc about -86), muted about 0.76, faint about 0.66.

   For reference: GitHub Dark Dimmed's background is `#212830` (L 0.274), VS Code's `#1e1e1e` (L 0.235), Apple's elevated `#1c1c1e` (L 0.227).
3. **Nile and End House** get the same recipe, keeping their hues. Possibly in one PR, since it repeats a decided pattern.
4. **A sixth theme, "Blue Train", modelled on T3 Code's "Ocean"** (the theme Rogier likes; his screenshot, 2026-10-26). It is a night theme only, and its ticket is written after the dark examples sheet, with the values Rogier picks there.
   - **Ocean's dark values** (`pingdotgg/t3code` `packages/shared/src/themePalettes.ts`), all OKLCH:

     | Token | Value | Note |
     |---|---|---|
     | canvas | `0.243 0.024 251` | slate blue |
     | sidebar | `0.290 0.032 247` | lighter than the canvas |
     | raised surface | `0.348 0.020 254` | |
     | overlay | `0.399 0.018 256` | |
     | border | `0.439 0.039 245` | clearly visible |
     | text | `0.990 0.008 326` | |
     | muted text | `0.65 to 0.69, chroma about 0.012` | |
     | selected row | `0.414 0.052 244` | |
     | user message | `0.445 0.057 243` | |
     | accent | `0.759 0.106 242` | |
   - **What makes it calm.** The background is barely lighter than ours. The difference is that its layers step up 0.05 to 0.10 L and its borders sit at L 0.44, against our 0.03 steps and 0.32 lines. This supports the guess in section 2 that flat layers and invisible edges, not darkness, make our dark themes hard on the eyes.
   - **Name.** "Blue Train", after *The Mystery of the Blue Train*: a Poirot name, like the other five themes, keeps the Character.
   - **Doctrine.**
     - The blue ground is a tint, at chroma 0.02 to 0.03.
     - `--accent` stays lacquer green. Ocean's blue accent is not copied, because in Hercule `--accent` means the one suggested answer.
     - The `sky` crew hue (240) sits close to the ground's hue. Check that sky colleagues still stand out against it.
   - **The spec change.** The theme is added to spec 17 §Appearance as a night theme, with its sRGB `--bg` in `window-background.ts` and `base.css`, as the other five have.
5. **Audit the text roles:**
   - `--faint` is for timestamps and secondary metadata only. Content that sits in `--faint` today moves to `--muted`.
   - This touches many files, so it is split by screen: sidebar, thread, intake, workflows, settings.
6. **Replace text dimming by opacity** with colour tokens:
   - receded rows: the title in `--muted`, metadata unchanged;
   - done rows;
   - intake's quiet items.
   
   This is the same change T3's council made its top MUST.
7. **Light themes:** keep faint at or above 4.5:1, and make lines visible enough to separate panels. Expect small changes only.

### Round 3: hierarchy and density, screen by screen

One PR per screen, driven by the council's MUSTs. Expected themes:

- **Sidebar:** the title is the strongest element of a row; metadata is one size and one colour; status words stay in their semantic colours.
- **Thread:** transcript prose at its measure, headings in the transcript, tool rows quieter than messages, composer weight.
- **Intake, workflows, settings:** section headings, row heights, alignment of the left edges.

### Round 4: icons and shape

- One icon stroke weight and one optical size per context, aligned to the text's cap height.
- Radii collapse from 30 values to the token scale (`--r-xs` to `--r-xl`, plus pill and circle).
- Shadows: check `--shadow-*` in the dark themes, where shadows do not show and edges must do the work.

### Round 5: accessibility and polish

- **Focus rings** everywhere, at ≥ 3:1.
- **Target sizes** of at least 24px.
- **No clipping** under text spacing, the largest Text size and 150% zoom.
- **State without colour:** every state also has a mark or a word.

### After round 5: the open loop

The workflow keeps taking the top open MUST from the council, one PR per run. It stops when the conditions in section 9 hold.

## 7. Rules for every PR

- **One change, one reason.** The PR names the metric or the council finding it moves.
- **No scripted metric gets worse** (the ratchet). A regression is accepted only by editing the baseline, with the reason in the PR body.
- **Sol's pairwise vote calls the change better, in both orders.**
- **Before and after captures at 1x** of every touched screen go in the PR body, in all the themes the change affects.
- **The spec decides behaviour, the goldens decide measurements** (section 5, item 3). A PR amends spec 17 when it changes a behaviour, in the spec's own amendment style ("*(Amended 2026-xx-xx, #nnn.)*"). It also removes a number in spec 17 that the change makes wrong, and never adds a new one.
- **State the desktop cost**, as AGENTS.md requires: processes, memory, work while idle, work per streamed token, and bundle bytes. A font change states the font bytes and whether the preload changed.
- **Keep the doctrine and the character.** COLOR = WHO, and one colour = one meaning; `--accent` is the only fill; `--you` means addressed to you. The faces, the crew hues, the warmth and the Deco touches stay. A change that breaks a rule in the `tokens.css` header comment needs Rogier's call, not the council's.
- **Rogier's calls are recorded** in the brief, under "Owner decisions", so Sol stops asking for them.
- **Checks:** typecheck, lint, test, dep-lint, `capture:ui` and `ui:metrics`. The Mac-only checks (the piece sheet in `compare:bureau`, the perf scripts, `test:desktop`) are listed in the PR as still to run, and run on atlas before merging.

## 8. Decisions

Decided by Rogier on 2026-10-26:

- **D1. Scope: the desktop app only.** The web app may take the results later.
- **D2. The app becomes its own pixel reference.** This changes spec 17 §Design system and §Testing, because both keep `tokens.css`, the font files and the screens identical with the Crew Bureau book.
  - The piece sheet (faces, marks, icons) stays compared with the book.
  - The screen comparisons in `compare:bureau` become golden captures of the app itself, recorded and reviewed like the Android Roborazzi goldens.
  - The book is frozen as the record of the second edition.
  - Round 0 writes the ADR and the spec amendment for this, before any visual change lands.
- **D3. Fonts: a bake-off first, then Rogier picks** on his monitors (round 1, item 1). Every candidate is licensed for commercial use and may be bundled in the app; see "Font licences" below.
- **D4. Dark themes: retune the existing three, but only after seeing examples** (round 2, item 1). A sixth theme modelled on T3 Code's Ocean is welcome (round 2, item 4).
- **D5. Character is protected.** The Crew Bureau identity (the faces, the crew hues, the warmth, the Deco touches) must not be lost. It is a scored category, and the doctrine rule in section 7 applies to every PR.
- **D6. One reviewer: GPT-6.1 Sol**, at high effort with full access, spawned in the climbing agent's own workspace (section 4.2).
- **D7. Rounds 0 to 2 run as normal sessions; then the nightly Hercule workflow takes over.**

Decided by Rogier on 2026-10-26, in the grilling round before the tickets were written:

- **The tickets.**
  - One umbrella issue, with every ticket as a sub-issue and GitHub's "blocked by" links between them.
  - Rounds 0 to 2 are ticketed up front. Rounds 3 to 5 are not: Sol's fix lists drive them.
  - A ticket that waits on Rogier's pick (the font swap, the dark retune) is blocked by its comparison-sheet ticket and labelled `needs-info`. Once he picks, the pick is written into the ticket and the label becomes `ready-for-agent`.
- **The plan lives on `main`** (this file), and later PRs keep it current.
- **The goldens are recorded on Linux in CI;** the piece sheet stays on macOS (section 5, item 3).
- **Measurements leave spec 17's authority:** the goldens and `tokens.css` decide them (section 5, item 3).
- **The ratchet is a hard gate from the start,** and CI must stay fast: the UI job has a 3-minute budget (section 5, item 3).
- **One hill-climb PR open at a time.** The workflow runs nightly at 02:00 Europe/Amsterdam, and on demand.
- **The Mac-only checks run on atlas before merging.**
- **1x is the main capture;** glass is measured at 40% and at 0%.
- **The metric thresholds** in section 4.1 are the starting values. A target changes only through a PR that says why.
- **The Text size setting** spec 17 already defines is built in round 1.
- **The comparison sheets** (fonts, dark themes) are built on `prototype/*` branches that are never merged. A session on atlas starts the dev server and opens the sheet in Chrome, and Rogier judges it live on his monitors.
- **The anchors are text only;** the calibration set is the visual reference. Rule of thumb: simpler wins.
- **The calibration screenshots** were captured on atlas on 2026-10-26 and stored outside the repo (section 5, item 3).
- **The sixth theme** is a night theme named "Blue Train", ticketed after the dark examples sheet.
- **Rounds 0 to 2 are built by one coordinator:** Opus 5.5, with a Sol thread for sparring and review, and Sonnet 5.5 subagents for the implementation (section 5).

### Font licences

Checked on 2026-10-26 against `google/fonts` (each family's `OFL.txt`) and the Inter repository's `LICENSE.txt`.

| Font | Licence | Bundle it in a commercial app? |
|---|---|---|
| Inter | SIL OFL 1.1 | yes |
| JetBrains Mono | SIL OFL 1.1 | yes |
| IBM Plex Sans, IBM Plex Mono | SIL OFL 1.1 | yes |
| Geist, Geist Mono | SIL OFL 1.1 | yes |
| Bricolage Grotesque, Recursive, Limelight (today's fonts) | SIL OFL 1.1 | yes |
| SF Pro, SF Mono | Apple's licence | no. It can only be reached as the system font on a Mac (`system-ui`, `ui-monospace`), never shipped |
| Berkeley Mono | commercial | not a candidate |

What the OFL asks of us:

- **Ship the licence text beside the font files.** The desktop app already does this in `styles/fonts/LICENSES.md`; a font swap adds its entry there.
- **Never sell the font on its own.**
- **A modified font keeps none of its Reserved Font Names.** Subsetting a family that has one counts as modifying it, so use the official subsets that Fontsource and Google publish, as today's files are.

## 9. When we are done

- Every scripted metric meets its target in all five themes.
- Against the calibration set, Sol rates Hercule at or above T3 Code, Claude and Codex in every category. This is pairwise, not absolute.
- Rogier says the app is easy on the eyes on his work and home monitors, in light and dark.

## Sources

- T3 Code PRs: linked in section 3; fonts and tokens from `pingdotgg/t3code` `apps/web/src/index.css`.
- APCA: https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell
- WCAG 2.2: https://www.w3.org/WAI/WCAG22/Understanding/ (1.4.3, 1.4.11, 1.4.12, 2.4.7, 2.4.11, 2.5.8)
- Apple HIG, Dark Mode and Accessibility: https://developer.apple.com/design/human-interface-guidelines/dark-mode
- Material colour tones: https://github.com/material-foundation/material-color-utilities
- GitHub Primer Dark Dimmed: https://unpkg.com/@primer/primitives/dist/css/functional/themes/dark-dimmed.css
- NN/g on dark mode: https://www.nngroup.com/articles/dark-mode/
- Line length: https://practicaltypography.com/line-length.html
- Inter: https://rsms.me/inter/
- Bricolage Grotesque: https://github.com/ateliertriay/bricolage
- LLM judges: Zheng et al. 2023 (arXiv:2306.05685) on position bias and pairwise judging; Verga et al. 2024 (arXiv:2404.18796) on panels of judges; Duan et al. 2024, UICrit (arXiv:2407.08850) on LLM UI critique.
- Font metrics (x-height, glyph confusion) and the contrast table were measured on 2026-10-26 with fontTools and a small OKLCH/APCA script on the Google Fonts files and `tokens.css`.
