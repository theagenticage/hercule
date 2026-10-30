# 47. The desktop app is its own pixel reference

Date: 2026-10-26

## Status

Accepted. Decided by Rogier on 2026-10-26, in the umbrella ticket [UI hill climb (#852)](https://github.com/theagenticage/hercule/issues/852), and written into the spec by [#855](https://github.com/theagenticage/hercule/issues/855). Amends [ADR 0037](./0037-the-desktop-app-is-its-own-electron-client-of-the-public-api.md) on one point: the desktop app's `tokens.css` and font files are no longer kept as they are in the Crew Bureau book. Amends [spec 17 §Design system](../spec/17-desktop-app.md#design-system) and [§Testing](../spec/17-desktop-app.md#testing). Keeps the rest of ADR 0037: Crew Bureau is the app's design language, and the app builds its own components.

## Context

[Spec 17](../spec/17-desktop-app.md) made the Crew Bureau book (`docs/design/crew-bureau-2/`) the pixel reference of the desktop app. Three rules followed from that:

- `tokens.css` and the font files are copies of the book's, byte for byte.
- Where the spec and the book's pages disagree, the pages decide a measurement and the spec decides a behaviour.
- `pnpm compare:bureau` compares the app with the book on macOS and fails on any pixel that differs. Besides the piece sheet (faces, marks and icons), it compares the sidebar, the thread, the draft, Workflows, Settings, the assistant and Intake with the pages that draw them.

That was the right reference while the app was being built to the book. The hill climb ([#852](https://github.com/theagenticage/hercule/issues/852)) now moves the app past it. It changes tokens, type and colours in many small pull requests, and each of them would fail the book comparison and the byte check on `tokens.css`. Keeping the book as the reference would mean editing the book with every change, or giving up the climb.

The comparison also runs only on macOS, so a pull request cannot check a screen change anywhere else.

## Decision

**The app's screens are compared with golden captures of the app itself. The book is frozen.**

- **The rule.** The app's goldens and `tokens.css` decide a measurement. The spec decides a behaviour. This replaces "the pages decide a measurement and this text decides a behaviour".
- **The goldens.**
  - They are the 13 screens of `pnpm --filter @hercule/desktop capture:ui`, at 1x, glass 40%, in all six themes: 78 PNGs under `apps/desktop/ui-goldens/<theme>/<screen>.png`.
  - They are recorded on Linux, by the same Playwright Chromium code as `capture:ui`, inside the single pass of the `ui:metrics` CI job. That job has a budget of 3 minutes. A nightly run on a Linux machine can re-record them.
  - The comparison is exact: every decoded pixel is equal. A missing golden, an extra golden and a size mismatch fail it too.
  - `pnpm --filter @hercule/desktop ui:metrics --write-goldens` re-records them. It never skips the metrics ratchet.
  - Every golden that moved is looked at before it is committed, as the Android Roborazzi goldens are. The diff of a deliberate change to a token shows the screens that moved.
- **The piece sheet stays.** Faces, marks and icons are still compared with the book's `crew.js`, on macOS, in `pnpm compare:bureau`. Both sides draw on the book's frozen palette (the book's `tokens.css`), so retuning a theme in the app does not fail it. It compares how the pieces are drawn, not the app's colours.
- **The book is frozen** as the record of the second edition. Nobody edits it. The check that the book's `tokens.css` and font files equal the app's is dropped. The `*-reference.ts` modules, which edit the book's pages for the screen comparisons, are deleted with those comparisons.
- **Later changes amend spec 17 only when a behaviour changes,** or to remove a number that the change makes wrong. They never add a measurement. The golden holds the measurement.
- **What the goldens do not cover.** Some rendering problems show only on a Mac, such as font smoothing on Rogier's monitors. Linux does not show them. Rogier's eye check on his monitors covers them.

## Considered options

- **Keep the book as the reference and update the book with every change.** Rejected. Every pull request of the climb would edit the book as well, and the book would stop being the record of the second edition. It would also keep a macOS-only check as the gate for every visual change.
- **Record the goldens on macOS.** Rejected. A pull request cannot refresh them without a Mac, and CI's virtual Macs draw differently from a user's Mac, so they would not catch what Rogier sees anyway. On Linux, one rendering path gives the same pixels from one run to the next.
- **Compare with a tolerance.** Rejected. A token change should move the goldens that use it, and the diff should show that. With a tolerance, a small colour or spacing change could pass without showing in review.
- **Drop the piece sheet too.** Rejected. The faces, marks and icons are drawn code that the book's `crew.js` still defines, and a change that redraws a piece by accident should fail. They are not affected by theme retunes, because both sides use the book's palette.

## Consequences

- The `ui:metrics` CI job (3 minutes) now also checks the screens, on Linux, for every pull request that touches the renderer, the tokens or the fonts. `pnpm compare:bureau` keeps its macOS job and compares the piece sheet only.
- The repository grows by 60 PNGs, and a change to a theme or a shared token moves many of them. Reviewing the diff is the point of committing them.
- Spec 17's sentences that describe the screen comparisons with the book are struck, and the spec says where the app's goldens replace them. Its measurements stay as the record of what the app was built to. They can now be wrong where the app has moved on, and a change that makes one wrong removes it.
- Differences between Linux and macOS rendering are not tested. A Mac-only problem is found by eye.
- The book stays in the repository, readable, as the record of how the app was first drawn.
