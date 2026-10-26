# UI council, round 0 (trial), 2026-10-26

- **Reviewer:** GPT-6.1 Sol, effort high, on the Codex instance `83fb775f`, spawned by the coordinator with `--output-schema` set to `absolute.schema.json` at commit 42f399ac.
- **Sessions:** A (`144b3221`) scored 52 images in 6 turns: today's app at 1x in Whitehaven and Orient Express (12 screens each, captured by `capture:ui` at 9c817c33), the 18 frozen calibration images under neutral names, and the 10 reference screenshots. B (`6a175777`) scored the calibration and reference images again, in a fresh session, for the repeat spread.
- **Inputs:** `inputs-A.txt`, `inputs-B.txt` (order, set, screen, theme, scale), `inputs.sha256`, `calibration-names.txt` (neutral name to frozen file). The raw outputs are `A-turn*.json` and `B-turn*.json`; every turn passed the checks of BRIEF.md section 9.2 on the first try. `run_round.py.txt` is the script that ran the round.
- **Scope of this trial:** two themes at 1x. Later rounds add Styles, Nile and End House, and the 2x view.

## Hercule, mean per category

| theme | typography | hierarchy | spacing-density | colour-contrast | eye-comfort | iconography | state-visibility | consistency-polish | clarity-copy | character | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| whitehaven | 5.7 | 7.5 | 7.4 | 5.7 | 6.7 | 7.3 | 7.4 | 7.8 | 6.8 | 7.3 | 6.6 |
| orient-express | 5.2 | 7.5 | 7.4 | 5.0 | 6.8 | 7.2 | 7.3 | 7.7 | 6.8 | 7.5 | 6.6 |

## Reference apps (session A, 1x)

| image | typography | hierarchy | spacing-density | colour-contrast | eye-comfort | iconography | state-visibility | consistency-polish | clarity-copy | character | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-dark-1x.png | 8 | 7 | 7 | 7 | 8 | 8 | 7 | 8 | 7 | 7 | 8 |
| claude-light-1x.png | 8 | 7 | 7 | 5 | 6 | 8 | 7 | 8 | 7 | 7 | 7 |
| codex-dark-1x.png | - | 7 | - | 5 | 7 | 7 | 6 | 8 | 5 | 8 | 7 |
| codex-light-1x.png | - | 7 | - | 4 | 6 | 7 | 6 | 8 | 5 | 8 | 6 |
| t3-ocean-1x.png | 6 | 7 | 8 | 5 | 8 | 7 | 7 | 8 | 7 | 8 | 7 |

## Drift baseline

Repeat spread per category (largest difference between session A and B on the same image): typography 2, hierarchy 3, spacing-density 3, colour-contrast 2, eye-comfort 2, iconography 1, state-visibility 2, consistency-polish 1, clarity-copy 1, character 1, overall 2.

**This round does not count toward the drift baseline.** BRIEF.md section 5 asks for all 1x images first and the 2x images in later turns. This trial interleaved the 2x reference screenshots with 1x images (session A's first turn holds both scales, and both sessions put 2x references before remaining 1x images). The spread above is kept as a first estimate only. The drift baseline of section 9.3 comes from the first two rounds that follow the prescribed order. The Hercule scores above are the trend baseline that later rounds are compared with.

## Fixes (session A)

35 fixes: 4 MUST, 26 SHOULD, 5 COULD. The MUSTs are the run graph's small node text and its dimmed (opacity) unreached nodes, in both themes. The SHOULDs are mostly faint supporting text, prose running to about 100 characters per line, small metadata, raw event keys in Workflows, and colour-only completion marks in the tracking pane. They agree with `ui:metrics`' own findings (faint contrast, opacity dimming, prose measure).
