# The UI council: brief

This is the brief for the UI council, the reviewer that scores Hercule's desktop UI from screenshots. The plan behind it is [`docs/research/ui-hill-climb.md`](../../research/ui-hill-climb.md) (§4.2). The work is tracked in #852.

The council is one reviewer: GPT-6.1 Sol. The brief has two parts:

- **Sections 1 to 8 are for the reviewer.** Read them before you score anything.
- **Section 9 is for the coordinator**, the session or workflow that runs a round. It holds the calibration set and the commands. The reviewer does not read it: knowing what the broken calibration images are would bias the scores.

## 1. Purpose and the judge

The goal is a desktop app that is easy on the eyes and easy to work in, on Rogier's own monitors: an external 1920 x 1080 screen drawn at 1x, and a Retina screen drawn at 2x.

- **Rogier's verdict on his own monitors outranks every score.** If your score and his eye disagree, his eye is right. His calls are recorded in section 8, and you do not ask to undo them.
- **Scripted metrics are a hard gate that you cannot argue with.** `pnpm ui:metrics` measures contrast, scale, spacing and more. Your job is the part a script cannot measure: how the screen reads and feels. A fix of yours is a hypothesis until `ui:metrics` and a pairwise vote confirm it.
- **You are one reviewer.** No panel averages out your taste. The calibration images (section 5) exist to catch you drifting, and the pairwise vote (section 6) exists to catch position bias.

You never edit files. You may read the repository to find the file and line of a fix.

## 2. What you are given and what a screenshot can show

You score PNG captures of the desktop app, made by `pnpm --filter @hercule/desktop capture:ui` from the specimen pages. The list of screens is `apps/desktop/scripts/ui-screens.ts`.

- **Screens (12):** `sidebar`, `thread`, `thread-long`, `draft`, `conversation`, `intake`, `tracking-pane`, `workflows`, `run`, `discussions`, `wiki`, `settings-appearance`.
- **Themes (5):** `whitehaven` (light, the flagship), `styles` (light, warm), `orient-express` (dark, the flagship), `nile` (dark), `end-house` (dark).
- **File name:** `<screen>-<scale>x-glass<percent>.png`, in a folder per theme. The window is 1440 x 900 CSS pixels, so a 1x file is 1440 x 900 pixels and a 2x file is 2880 x 1800.
- **Scale:** 1x is the main view and is scored first. 2x is a second view. Some defects exist only at 1x (blurry hairlines, uneven stems), and some only show at 2x (spacing seen in detail). Say which scale shows the evidence.
- **Glass:** the default is 40 percent glass. 0 percent is "Reduce transparency". Score the images the prompt lists. Unless it says otherwise, they are the glass 40 captures.

A round may also include images of other apps (T3 Code, Claude, Codex) and images marked as calibration. Score every image on its own, with the same anchors. Do not compare an image with the others in the batch while you score it.

**Images of other apps.** They are windows of 1440 x 900 captured on 2026-10-26, at 1x and 2x.

- Judge their Character against their own identity, not against Hercule's. Section 3.10 has anchors for it.
- Codex: the empty new-chat screen of a Codex whose UI is drawn in a monospace font. Its typography is not a reference, and an empty screen says little about density. Always score `typography` and `spacing-density` as `null` ("unassessable") for it, with that reason. Do this in every round, so that rounds can be compared.
- T3 Code: Ocean theme only. There is no light capture.

**What a still image can and cannot show.** Every anchor below is written so that a still screenshot decides it.

- **Not scored from screenshots:** interaction (hover, press, focus movement, keyboard), motion, animation timing, loading, streaming, scrolling, and any state that is not drawn.
- A state or element that is not in the image is `unassessable` for that image. It is never an invented score.
- If a defect might come from the capture, not from the app (a missing font, a cropped window), say so and score what you can.

## 3. The 11 categories

Each category has an id (used in the output), a one-line meaning, and anchors for 3, 5, 7 and 9. Anchors describe what you can see, how often, and what it costs the reader or the person using the app.

How to use the anchors:

- **3** means the defect obstructs use. **5** means usable, with repeated defects. **7** means coherent, with localized defects. **9** means clear and consistent in every state this image shows.
- Use 4, 6 and 8 for "between". Use 0 to 2 for worse than the 3 anchor: unusable. Use 10 only when a careful reviewer could not name one thing to improve. It should be rare.
- Each anchor is about the one image in front of you. It never asks you to compare screens, themes or scales, or to imagine use over time. Score what the visible state costs the person who looks at it or uses it.
- Scores follow the anchors. Fixes do not set or cap a score (section 4 has a consistency note).

### 3.1 `typography`: legibility at 12 to 14px, rhythm, letter shapes, line length

- **3:** Body and metadata text at 12 to 14px is hard to read: strokes break up or look thin and blurred, the letters look too small for their size, and `I`, `l` and `1`, or `O` and `0`, cannot be told apart in ids, numbers and hashes. Line spacing is uneven, so lines nearly touch in one place and float apart in another. Prose lines run past 100 characters or are narrower than 35.
- **5:** Readable with effort. The same defects repeat: sizes that differ by half a pixel sit side by side (12 and 12.5, 13 and 14 for the same role), weights that do not separate levels, confusable letters where it matters, a prose measure outside 55 to 85 characters, or 11 to 12px metadata that is small and light together.
- **7:** One UI face and one code face, a small set of sizes with clear roles, even line rhythm, prose at 60 to 75 characters. Localized defects: one label cramped or off the scale, numbers that do not align in one table, a weight too light on one surface.
- **9:** Every text role in the image reads clearly at its size: 12px metadata is as legible as 14px prose. Sizes and weights separate the levels. Confusable letters are distinct where it matters, numbers align in columns, and prose is at 60 to 75 characters. Line spacing is even in every state the image shows.

### 3.2 `hierarchy`: the most important thing wins first

- **3:** You cannot tell what matters. Everything has the same weight, or everything shouts. The main content of a region (the latest message, the open signal, the suggested answer) loses to chrome or decoration. Four or more levels of emphasis compete in one region.
- **5:** The main thing can be found, but only after scanning. Two elements fight for first place in a region, or metadata and tool rows are as loud as messages and titles. Four levels of emphasis appear in places.
- **7:** In most regions the most important item wins first, with at most three levels of emphasis. One region is off: metadata outweighs a title, or the primary action is not the strongest control.
- **9:** In every region the eye lands first on the right item. At most three levels of emphasis show at once. Reading order matches importance. The one suggested answer, the filled `--accent` button, is clearly the primary action wherever it appears in the image.

### 3.3 `spacing-density`: dense without cramped, one rhythm, aligned edges

- **3:** Cramped or empty enough to obstruct. Text touches an edge or a neighbour, rows run into each other, controls cannot be told apart. Or large empty bands push the content out of view. Edges are ragged everywhere.
- **5:** Usable. Similar regions have different densities (list rows of different heights for no reason). Near-equal gaps differ (6, 8 and 10px for the same relation). Left edges are a few pixels off in several places. A few spots are cramped or loose.
- **7:** Dense without being cramped, one rhythm on the 4px grid, aligned edges. Localized defects: one row or panel with the wrong padding, one group whose gap is too small.
- **9:** The same relation has the same gap everywhere in the image. Row heights are consistent. Left and right edges line up across regions. Every region shows its content with no wasted band and no touching elements, in every state the image shows (long, empty, selected).

### 3.4 `colour-contrast`: text and edges are clear, and colour means one thing

- **3:** Text or edges cannot be read at normal viewing distance. Muted or faint text sits close to the background, borders are invisible so panels merge, or the contrast is so hard that it glares. One colour carries several meanings, so you cannot tell what it signals.
- **5:** Primary text is clear. Secondary text, metadata or placeholders are weak in several places, for example faint text carrying real content or text dimmed with transparency. Edges show on some panels only. Colour has more than one meaning in a few places.
- **7:** Every text role is readable. Edges show on panels and controls. Colour means the same thing each time. Localized defects: one metadata line too faint, one divider too weak, one colour used outside its meaning.
- **9:** Every text role is clear against the actual background behind it, including tinted rows and glass. Edges and control borders are visible, and nothing relies on dimming. Each colour means one thing everywhere shown, as the colour doctrine in section 8 says. Contrast beyond what reading needs earns nothing here.

### 3.5 `eye-comfort`: glare, muddiness, glow, flat layers

This is scored apart from contrast. "More contrast" does not raise this score, and a harder contrast can lower it.

- **3:** Hard to look at for long. Large bright areas glare, or pure white text on near black makes the text seem to glow or vibrate (halation). Surfaces are muddy, and layers merge into one slab. Saturated areas are harsh.
- **5:** Tiring in places. A dark theme reads as muddy or flat brown-black, layers differ barely, or a bright element pulls the eye (a white bubble, a strong selected row). A light theme has one glaring white sheet. Or the whole image is dim and grey.
- **7:** Calm overall. Layers separate gently and nothing glares. Localized defects: one bright patch, one muddy layer, one saturated badge louder than the rest.
- **9:** Calm to look at, with nothing that would tire the eye. Layers step up clearly but softly. The brightest element is the content. No glow or vibration around text. Saturated colour is small and means something. Glass adds depth, not murk.

### 3.6 `iconography`: one stroke weight, one optical size, aligned to text

The small state marks count as icons. The colleague faces do not: score them under `character`.

- **3:** Icons are unreadable or misleading. Outline and filled styles mix, several stroke weights share one row, sizes jump, icons are blurred at 1x, or an icon's meaning is unclear without its label.
- **5:** Readable but inconsistent. Two stroke weights or two optical sizes in one context. Icons sit 1 to 2px off the text centre or baseline in several rows. Some are filled and some are outlined without a reason.
- **7:** One family, and one stroke and one size per context in most places. Localized defects: one icon off-centre, one slightly heavier, one blurred.
- **9:** One stroke weight and one optical size per context. Icons are centred on the text's cap height and crisp on the pixel grid at 1x. State marks stay distinct at their smallest size.

### 3.7 `state-visibility`: states told apart without relying on colour alone

States are working, waiting, failed, done, selected, focused and disabled. Score only the states the image draws.

- **3:** States cannot be told apart. Working, waiting and failed look alike, or differ by colour alone and would vanish in greyscale. The selected row is indistinguishable. A shown focus is not visible.
- **5:** The main states differ, but some only by colour or only weakly. The selected row is subtle, waiting and idle are ambiguous, a failure is marked only by a tint, or a focus ring is faint in places.
- **7:** States differ by a mark, a pose or a word as well as colour. Localized defects: one state is weak, such as a selected and a hovered row that look nearly the same.
- **9:** Every state shown is distinct in greyscale. A mark or word sits beside each. Selected and focused are never confused, and nothing is dimmed to show a state.

### 3.8 `consistency-polish`: same thing, same look; no stray misalignments

- **3:** The same thing looks different within the image: buttons with different radius, height or weight. Many 1px misalignments. Text is clipped or overlaps. Something renders broken.
- **5:** Mostly the same, with repeated deviations. Row heights, radii or button styles vary. Several 1px misalignments, uneven borders or clipped text.
- **7:** Coherent, with a few localized defects: one stray radius, one misaligned label, one doubled border.
- **9:** The same thing looks identical everywhere in the image. No stray misalignment at this image's scale. Edges, radii and borders are crisp, with no half-pixel blur.

### 3.9 `clarity-copy`: labels predict what happens; plain words

Use the vocabulary of `GLOSSARY.md`. You judge the words that are drawn, not the flows behind them.

- **3:** Labels mislead or are missing. A button's label does not predict its result. Internal ids or jargon show where a person needs words. Truncation cuts the meaning out of a label. An empty state gives no direction.
- **5:** Understandable with effort. Several vague labels, two words for one concept, jargon where a plain word exists, or truncation that hides key information in a few places.
- **7:** Labels predict outcomes, and words are plain. Localized defects: one ambiguous label, one inconsistent term, one bad truncation.
- **9:** Every label, heading, button and empty state predicts what happens. One word per concept. Truncation keeps the informative part. Sentences are short.

### 3.10 `character`: it still looks like itself

Character is not the amount of ornament. A quiet screen can score 9, and more ornament never scores higher. It guards against drift to a generic grey app. There are two sets of anchors. Use the first for images with `set` `hercule` or `calibration`, and the second for images of other apps.

**Hercule.** Character is whether the image is still recognisably Hercule: the colleague faces, the crew hues, the warmth, and the Deco touches.

- **3:** It looks like a generic grey app. Faces, crew hues, warmth and Deco touches are missing or so muted that nothing says Hercule. Or ornament is so heavy that it obstructs reading.
- **5:** Some Hercule. Faces are present but small or washed out, crew hues have faded toward grey, warmth is partly lost, or Deco touches are in one or two spots.
- **7:** Recognisably Hercule. Faces are readable, crew hues can be told apart, the palette is warm, and the Deco face and ornament appear where they belong. Localized defects: one region is bare, one hue is washed out.
- **9:** Unmistakably Hercule. Faces are expressive, each colleague's hue is identifiable and appears only on that colleague, the tone is warm, and the Deco touches are placed with restraint, without costing legibility.

**Another app (`set` `other-app`).** Character is how coherent and recognisable the app's own identity is. Do not look for Hercule's faces, hues or Deco touches, and do not reward or punish the app for being quiet or ornate.

- **3:** No identity. The image could be any app, or its parts pull in different directions.
- **5:** Some identity, in one or two places (a colour, a mark, a typeface), while the rest is generic or inconsistent with it.
- **7:** A recognisable identity that most of the image follows. Localized defects: one region that does not fit.
- **9:** A distinct, coherent identity in every part of the image, without costing legibility.

### 3.11 `overall`

Overall is its own judgment, not an average. Ask: would you choose to work in this screen? Section 4 has a consistency note for when it differs from the other categories.

- **3:** You would not choose to work in it. At least one category obstructs use or reading.
- **5:** Workable. You notice repeated rough edges in several categories.
- **7:** Pleasant and coherent. The defects are localized and a fix list would clear them.
- **9:** Polished and comfortable to work in. You looked for defects in every category and found none worth a fix.

## 4. Scoring rules

- **Evidence.** Every score cites visible evidence: the image's file name, which tells the screen, theme and scale, and a region in that image's own pixels (x, y, width, height) or an element described by name. "The sidebar looks fine" is not evidence.
- **Unassessable.** `null` with a reason is a valid answer for any category and image. Use it when the image does not show what the category needs. Never invent a score to fill a gap.
- **Fixes and scores agree.** This is a consistency note, not a mechanical cap:
  - A category with a MUST fix should rarely score above 6 on the images the fix cites.
  - A score of 9 or more means you looked for defects and found none worth a fix in that category.
  - When `overall` differs by more than 2 points from the average of the other non-null categories of the same image, say why in one sentence in that image's `overall_note`. Otherwise `overall_note` is `null`.
  - A `null` (unassessable) category is ignored by every aggregate: this average, the coordinator's means and the drift check.
- **Do not inflate.** A score of 9 means you looked for defects and found none worth a fix. Scores that drift upward over rounds with no change in the images are a failure the calibration set detects.
- **Stay inside the owner decisions** (section 8).
- **One image at a time.** Do not anchor on the previous image or on a score you gave earlier in the thread.
- **Plain words.** Short sentences. Name the element and the place. No praise padding.

## 5. Absolute scoring, per round

A round scores the whole app and tracks the trend. It never decides a PR on its own.

- **What is scored:** every screen in every theme, 0 to 10 in each of the 11 categories. Unless the prompt says otherwise, that is 12 screens x 5 themes at the default glass.
- **Order:** all 1x images first. The 2x images follow as a second view, in separate turns. The 1x scores are the main result.
- **Batches:** at most 10 images per message. A round is several turns in one session. Each turn returns the output of section 7 for its own images. A final turn with no new images may ask for one consolidated fix list for the round.
- **Calibration images** are in the same batches and scored the same way (section 9).
- **No history.** You are not shown the scores of earlier rounds. A fresh session scores each round.

## 6. Pairwise vote, per PR

A PR is judged by comparing the screen before and after, not by an absolute score.

- **What you see:** for each touched screen and theme, two 1x captures, labelled "A" and "B". One is the before capture and the other is the after capture. You are not told which. You are not given the PR's rationale, its diff, or any earlier vote. Do not read the repository, the git history or the PR to find out.
- **What you answer:** for each of the 11 categories: `A`, `B`, `tie` or `unassessable`.
  - `A` or `B`: that image is better on this category alone. Judge each category apart. "More contrast" does not win Eye comfort.
  - `tie`: no visible difference, or no difference that matters.
  - `unassessable`: the pair does not show what the category needs.
  - Cite the region in pixels for every vote that is not a tie.
- **It is asked twice,** in two separate turns. The second turn swaps the order: the image that was "A" is now "B". The coordinator gives the images neutral file names and labels each turn's pair afresh, so nothing in a name or the order hints which is the after capture.
- **Aggregation, per category, per screen and theme:**
  - The after capture wins only when both orders pick the after capture.
  - The before capture wins only when both orders pick the before capture. That is a confirmed regression.
  - Anything else is a tie: one order picks a side and the other disagrees, either order is a tie, or either order is `unassessable`.
- **A limit that is stated plainly.** Swapping the order reduces position bias. It does not remove the correlation of two turns in one thread: the second turn can remember the first. Asking the second order in a fresh session is a stronger test and is allowed. Either way, a pairwise result is evidence, not proof.
- **Pairwise has no fix list.** The PR's own author acts on a result. What to do with a confirmed regression or a tie is decided by the PR rules in the plan (§7), not here.

## 7. Output format

The output is JSON that matches a schema. Every turn must return it.

- Absolute round: [`absolute.schema.json`](absolute.schema.json). Example: [`examples/absolute.example.json`](examples/absolute.example.json).
- Pairwise vote: [`pairwise.schema.json`](pairwise.schema.json). Example: [`examples/pairwise.example.json`](examples/pairwise.example.json).

Two files, not one, because the schema language the sessions accept has no `oneOf`. Both use `additionalProperties: false` and require every field. A field that may be absent is `null`.

Category ids, in the order to use:

`typography`, `hierarchy`, `spacing-density`, `colour-contrast`, `eye-comfort`, `iconography`, `state-visibility`, `consistency-polish`, `clarity-copy`, `character`, `overall`.

**Absolute output, in this order:**

1. **Scores.** One entry per image, with one score entry per category (11) and the `overall_note`. Each score entry has the score (0 to 10, or `null`), the reason when it is `null`, and the evidence.
2. **A prioritized fix list**: MUST, then SHOULD, then COULD.
   - **MUST:** obstructs use or reading, or breaks a scripted target.
   - **SHOULD:** a repeated defect.
   - **COULD:** localized polish.
   - **A fix may cite only images with `set` `hercule`.** Images of other apps and calibration images never produce a fix. What you see in them goes only in the evidence of a score.
   - Each fix has:
     - the category;
     - the images: the exact file names from the prompt of the `hercule` images that show the problem;
     - the screens and themes of those images;
     - the visible problem with its evidence (image file name and region in pixels);
     - a proposed change with exact values (for example `--line` from `oklch(0.32 0.012 60)` to `oklch(0.40 0.012 60)`), and the file and line;
     - the scripted metric it should move: `text-contrast`, `wcag-text-contrast`, `non-text-contrast`, `line-visibility`, `surface-separation`, `opacity-dimming`, `type-scale`, `weights`, `radii`, `spacing-grid`, `target-size`, `focus`, `text-spacing`, `text-size-zoom`, `prose-measure`, `glyph-confusion`, or `none`.
   - The values are a hypothesis. `ui:metrics` measures them before they count. If you cannot find the file, say `null`. Do not guess a path.
   - A fix may not break an owner decision (section 8). If you think one is wrong, say so in `summary`. Do not turn it into a fix.
3. **A short summary.** Two or three plain sentences, without scores.

**Record of a round.** Every output records:

- the reviewer: model, version, effort;
- the input images, by file name and sha256, as the prompt lists them. Copy the sha256 values from the prompt. Never compute or invent them.

The coordinator keeps the same record from the spawn command and checks it against yours.

## 8. Owner decisions

These are Rogier's calls. Do not ask to undo them, and do not propose a fix that breaks one. If you think one hurts the app, say so once in `summary`.

### 8.1 Hercule's character is protected

- The colleague **faces**, the **crew hues**, the **warmth** and the **Deco touches** stay.
- Character is a scored category. A fix that makes the app greyer, colder or plainer must show what it costs under `character`.
- Why: the T3 Code council removed colour until a later PR had to put it back.

### 8.2 The colour doctrine

The source is the header comment of [`apps/desktop/src/renderer/styles/tokens.css`](../../../apps/desktop/src/renderer/styles/tokens.css). Read it. In short:

- **COLOR = WHO, and one color = one meaning.**
- **Every colleague** (an agent session, a workflow, an assistant) owns one signature hue from the eight-hue crew wheel: lime, mint, teal, sky, iris, grape, orchid, peach. Its face and its name ink use that hue and nothing else.
- **State is never a colleague's colour.** It is a pose on the character (focused eyes, a raised hand, closed eyes, a bandage) and one of six small state marks, so it reads in greyscale too.
- **Four colours are reserved** and belong to no colleague:
  - `--accent`, lacquer green: the one suggested answer, the filled button. Nothing else is filled.
  - `--you`, marigold: anything addressed to you ("waiting on you" counts). Never a button fill.
  - `--fail`, tomato: something got hurt (the bandage, a failed turn), or an answer that destroys.
  - `--ok`, green: added lines and passed tests.
- **Places get tints, not hues.** Projects are low-chroma inlays (`--proj-*`), so rooms never compete with the people in them.
- **Brass (`--brass`) is ornament only:** the office's lamps and tubes, the book's rules. Never text, never a state.
- The same file keeps two typeface rules: the Deco face (Limelight) is only for the wordmark, the logo lettering and a few large numerals, and the code face (Recursive) is only for code, diffs and commands. The file's comment also lists branch names as code. That is out of date: [spec 17](../../spec/17-desktop-app.md) (Design system, item 2) sets branch values, time separators and workspace labels in the UI face, and spec 17 decides. Where spec 17 itself sets something in the code face, such as a path or a command, that is correct.
- So a label, a count, a state or a branch value set in the code face is a defect. A branch value set in the UI face is correct. Never propose a fix that moves a branch value into the code face.

**A change that breaks one of these rules needs Rogier's call, not the council's.** Do not propose it.

### 8.3 The dark themes

- **T3 Code's pure-black dark is not a goal.** Ocean's calm comes from visible layer steps and visible borders, not from black.
- **The dark themes stay warm** and are not copied from other apps. Orient Express, Nile and End House keep their hues.
- You may report muddiness, flat layers and weak edges under `eye-comfort` and `colour-contrast`. A fix for them keeps the theme's warm hue family.

### 8.4 Decisions still waiting for Rogier

Until a pick is recorded in 8.5, do not propose these. Do report what you see under the right category.

- **The UI font and the code font.** Rogier picks on his monitors after a font bake-off (plan §6, round 1). Do not propose a different font family. Legibility findings under `typography` are welcome.
- **The direction of the dark retune.** Rogier picks after a dark examples sheet (plan §6, round 2). Do not propose new base values for the dark `--bg` and surfaces.

### 8.5 Later owner decisions

Add a decision here when Rogier makes one, in the pull request that records it. One bullet each, newest last:

```
- YYYY-MM-DD, #<issue or PR>: <the decision, in one or two plain sentences>. Why: <the reason>. Replaces: <an earlier decision, or "nothing">.
```

(No later decisions yet.)

---

## 9. For the coordinator (the reviewer does not read this section)

### 9.1 The calibration set

Scored in every absolute round, with the same prompt and the same anchors, to detect drift. A reference that moves with the UI cannot detect drift, so both parts are frozen.

**Part 1: screenshots of other apps.** They are outside the repo, because the repo is public. They are on beelink in `~/hercule-ui-council/calibration/`:

- `t3-ocean-1x.png`, `t3-ocean-2x.png`
- `claude-light-1x.png`, `claude-light-2x.png`, `claude-dark-1x.png`, `claude-dark-2x.png`
- `codex-light-1x.png`, `codex-light-2x.png`, `codex-dark-1x.png`, `codex-dark-2x.png`

They were captured on 2026-10-26 on atlas, in windows of 1440 x 900: 1x on the HP 27f and 2x on the Retina screen. T3 Code is in its Ocean theme, which does not follow the system appearance, so there is no light capture. Codex shows its empty new-chat screen, and this Codex draws its UI in a monospace font. Section 2 tells the reviewer what that means.

Never copy these images into the repo.

**Part 2: three deliberately broken Hercule variants.** They are frozen PNGs under `docs/design/ui-council/calibration/`, made from token overrides:

- **`max-contrast`:**
  - `--ink` is pure black in the light themes and pure white in the dark themes;
  - `--muted` and `--faint` equal `--ink`;
  - `--line` is the full ink colour.
- **`cramped`:** the component CSS spells nearly all its spacing as literal pixels, not as `--s-*` tokens, so no token override can halve it. The variant is a simple stand-in that is deterministic and visibly cramped:
  - the `--s-*` scale is halved;
  - line height is 1.15 and letter spacing is -0.01em, on every element;
  - every element loses its vertical padding (`padding-block: 0`);
  - every flex or grid container gets a 2px gap;
  - margins and horizontal padding are left alone, because layouts push things apart with `margin-top: auto` and icons have fixed widths.
- **`noisy`:**
  - every crew hue is at full chroma;
  - every surface has a different hue;
  - every border is 2px, everywhere.

The files:

- **Name:** `broken-<variant>-<theme>-<screen>-1x.png`, with `<variant>` one of `max-contrast`, `cramped`, `noisy`.
- **Themes:** `whitehaven` and `orient-express`.
- **Screens:** `thread`, `sidebar`, `intake`.
- That is 18 files, at 1x and the default glass.

The step that generates them also writes `docs/design/ui-council/calibration/manifest.json`: each file's sha256, the commit it was generated from, and the command and overrides used.

**Frozen.** Regenerating the variants is an explicit calibration revision: a PR of its own that says why, and it resets the drift baseline. It is never part of a normal round, and nothing regenerates them automatically.

**Blind names.** Do not give the reviewer the variant names. Copy each broken image to a neutral name (`cal-01.png` and so on), keep the mapping, and tell the reviewer only that the image is a calibration image. In the output its `set` is `calibration`.

### 9.2 Checking an answer before using it

The schema cannot enforce everything. Before an answer is used, check each point below. When one fails, ask again in the same session: name the failed check and ask for the corrected output. Do not repair the answer by hand.

**Whole answer:**

- `mode` is the mode of the session, and `reviewer` matches the spawn command.
- The images in `inputs` and in `images` are exactly the images sent in this turn: the same file names, in the same order, each once. The sha256 values equal the ones in the prompt.
- Each image's `set` matches what the coordinator knows: `hercule`, `other-app` or `calibration`.

**Each image:**

- Every one of the 11 categories appears exactly once, in the order of the brief.
- Each score is an integer from 0 to 10, or `null`.
- A `null` score has an `unassessable_reason`. A number has `null` there.
- For Codex images, `typography` and `spacing-density` are `null`, in every round.
- `overall_note` is not `null` when `overall` differs by more than 2 from the average of the other non-null categories of the image.

**Each fix:**

- Every entry in `images` is a file name from `inputs`, and its image has `set` `hercule`. A fix that cites a calibration or other-app image is rejected.
- `screens` and `themes` are the ones of the cited images.
- Ids are unique, and the fixes are in the order MUST, SHOULD, COULD.

### 9.3 Drift

The calibration set shows whether the reviewer's scale moves from round to round. The repeat spread says how much it moves by itself.

- **Baseline.** In each of the first two rounds, score the calibration set twice, in two fresh sessions on the same images. That gives four scores of every calibration image in every category.
  - The baseline score of an image and category is the mean of its four scores.
  - The repeat spread of a category is the largest difference between two scores of one image in the same round, over all calibration images and both rounds.
- **Later rounds.** Score the calibration set once and keep the scores with the round's record. A calibration score has moved when it differs from its baseline score by more than `max(1, repeat spread of its category)`. A `null` that was a number, or a number that was `null`, also counts as moved.
- **If any calibration score has moved, the reviewer drifted, not the UI.** Mark that round's absolute scores unreliable and record this in the round's record. A `null` score is ignored in every mean and spread.
- **Expected shape of the broken variants,** for the coordinator only: `max-contrast` should score low on `eye-comfort`, `cramped` on `spacing-density`, `noisy` on `colour-contrast`, `character` and `consistency-polish`. A round where they do not is suspect.
  - **One exception.** The cramped sidebar is a weak variant, because the sidebar's fixed row heights keep its layout. It is a frozen reference, not a guaranteed negative control. A round is not suspect only because that image still scores as usable.

### 9.4 How to run a round

From a session, spawn the reviewer in the session's own workspace, so it sees the same captures and code:

```
hercule session spawn --instance 83fb775f --model gpt-6.1-sol --options '{"effort":"high"}' --access-mode full-access --role "ui council" --output-schema "$(cat docs/design/ui-council/absolute.schema.json)" < prompt.txt
```

- **Use `pairwise.schema.json` for a pairwise vote**, in a session of its own. The schema is set at spawn and holds for every turn of that session.
- **Output schema subset.** Sessions accept a closed set of JSON Schema keywords (`packages/protocol/src/output-schema.ts`, `lintOutputSchema`): `$schema` (draft-07 only), `type`, `enum`, `const`, `title`, `description`, `properties`, `required`, `additionalProperties`, `items`. There is no `oneOf`, `anyOf`, `$ref`, `minimum`, `minItems` or `pattern`, and `enum` cannot hold `null`. So the range 0 to 10 of a score is not enforced by the schema: the consumer checks it, and rejects the output otherwise. Every object needs `additionalProperties: false` and all its properties in `required`.
- **Images:** attach with `--image`, at most 10 per message, each at most 10 MiB. The first message goes with `spawn`, the next ones with `hercule session input <id> --image ...`.
- **The prompt names the brief and the images.** It tells the reviewer to read sections 1 to 8 of `docs/design/ui-council/BRIEF.md` and nothing more of it, lists each image in the order attached with its file name and sha256 (compute them with `sha256sum`), and names the mode. It does not carry a PR rationale or earlier scores.
- **The reviewer never edits files.** Its prompt says so, and the coordinator checks `git status` after a round.
- **A fresh session per absolute round.** A pairwise vote uses a session of its own, and may use a second fresh session for the swapped order.
- **The record of a round** keeps: the reviewer's model, version and effort; the spawn command; every input image's file name and sha256; the raw outputs; the calibration scores; and the drift verdict.
- The same command runs in the nightly workflow's score and judge steps, where the output schema is set with `outputSchema`.
