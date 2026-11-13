# The desktop app

Measure a change's performance cost with `pnpm --filter @hercule/desktop perf:counts --write-baseline` on `main`, then `perf:counts` on your branch (`perf:counts:container` on Linux without Chromium's libraries), and explain in the PR any count that went up.
CI runs the same check on every desktop PR and posts its report as a PR comment; it never fails on a count.

## Renderer layout

The renderer (`src/renderer`) follows the root `AGENTS.md` §Web app layout, with its own components in place of `@hercule/ui` and `screens/`: it never imports `@hercule/ui` (spec 17). Every read `ensureShellData` loads uses `SHELL_READ_OPTIONS`, and a test fails when one does not.

## Checks

The desktop pair is the desktop app's counterpart of the root's packaging pair, on macOS or on Linux. `pnpm test:desktop` launches the packaged app, so it needs `pnpm build:desktop` before it, and `pnpm build:binary` too, because the app signs in to the compiled controller. With Docker, on a headless Linux machine or on a Mac, `pnpm test:desktop:container` builds both in a container, as unpacked folders only, and runs the suite on a virtual screen (`apps/desktop/container`). Its arguments go to `vitest`, such as test files or `--shard=2/6`.

**A desktop PR needs these checks on one platform, Linux or Mac, never both** (Rogier, 2026-11-04, ADR 0051). Use the one you have. A headless Linux machine is enough. CI covers the other:

- macOS runs `pnpm build:desktop`, `pnpm compare:bureau` and the end-to-end files that do not depend on a screen, timing or focus. `compare:bureau` runs only there, and nobody needs a Mac to run it.
- Linux runs the whole end-to-end suite in the container, split over parallel runners by recorded run time (`desktop-e2e-linux`), installs the `.deb` on a real Ubuntu 24.04 host and starts it with the sandbox on, and runs `ui:metrics`.
- On `main`, `edge-build` also runs `e2e/desktop/package.test.ts` on the signed app it builds for the `edge` prerelease.

```
pnpm build:desktop           # vite build of main, preload and renderer, the bundle budget check, then the release and test packages
pnpm build:desktop:unpacked  # the same, but on Linux the release package is the unpacked folder only: no .deb or Arch package, which no test reads
pnpm test:desktop            # Playwright drives the test package: window, security, fuses, IPC
pnpm test:desktop:container  # the same in Docker on a virtual screen, on Linux or a Mac
```

The desktop app's looks are checked in two places. The app is its own pixel reference (ADR 0047):

- **The goldens** are 126 PNGs in `apps/desktop/ui-goldens/`: the 21 screens of `capture:ui` at 1x, in the six themes. `ui:metrics` records them on Linux and compares every pixel exactly, in the same pass as its metrics and their ratchet. When a golden fails on a screen you meant to change, re-record with `--write-goldens`, then look at every golden that moved in the diff before committing it, as for the Android goldens (root `AGENTS.md`). Rendering that only a Mac shows, such as font smoothing, is not in them. Rogier checks it by eye on his Mac; it is not a step of your PR.
- **The piece sheet** (faces, marks, icons) is compared with the frozen Crew Bureau book by `pnpm compare:bureau`, in CI on macOS. The book is not edited.

```
pnpm --filter @hercule/desktop ui:metrics                   # the metrics, the ratchet, and the goldens
pnpm --filter @hercule/desktop ui:metrics --write-goldens   # re-record the goldens (never bypasses the ratchet)
pnpm --filter @hercule/desktop ui:metrics --write-baseline  # re-write the metrics baseline; a worse number needs its reason in the PR body
pnpm --filter @hercule/desktop ui:metrics --write-goldens --write-baseline  # both in one run, when both moved
pnpm --filter @hercule/desktop ui:metrics --screens inbox --no-goldens      # one screen, no pixels: for while coding
```

`--screens inbox --no-goldens` runs on the host in seconds, with no container. Use it per slice, to see the numbers of the screen you are changing. It checks only that screen's keys against the baseline and skips the goldens, so it is never the check: the full run above stays the check before a PR. It cannot write the baseline or the goldens. On the host, pixel-based numbers (contrast, clipping) can differ from the linux/amd64 baseline, so a difference there is a hint, and the container run decides.

On a Mac, or a Linux machine without Chromium's libraries, run `pnpm --filter @hercule/desktop ui:metrics:container`, which takes the same flags. It runs on linux/amd64, the platform the goldens are recorded on, which a Mac emulates (several minutes). On a Mac it works in a copy of the checkout and copies the goldens, the baseline and the report back. Any other command runs in the container with `node apps/desktop/container/run.ts -- <command>`.
