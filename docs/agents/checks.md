# Platform checks

The packaging, desktop, golden and Android checks that go beyond the four core checks in `AGENTS.md`.

CI runs the packaging pair in a job of its own. `pnpm test:binary` runs the
release binary rather than building one, so it needs the build before it and fails
saying so when there is none. Building rewrites `apps/web/dist` and the generated
file list, which is why it is not part of `pnpm test`.

```
pnpm build:binary  # vite build, the bundle budget check, then bun build --compile, writing ./hercule
pnpm test:binary   # ./hercule serves the embedded web app beside the API
```

The desktop pair works the same way, on macOS or on Linux. `pnpm test:desktop` launches the packaged app, so it needs `pnpm build:desktop` before it, and `pnpm build:binary` too, because the app signs in to the compiled controller. With Docker, on a headless Linux machine or on a Mac, `pnpm test:desktop:container` builds both in a container, as unpacked folders only, and runs the suite on a virtual screen (`apps/desktop/container`). Its arguments go to `vitest`, such as test files; CI passes each of its shards the files that `bun run scripts/desktop-e2e-shards.ts <index>/<count>` prints.

**A desktop PR needs these checks on one platform, Linux or Mac, never both** (Rogier, 2026-11-04, ADR 0051). Use the one you have. A headless Linux machine is enough. CI covers the other:

- macOS runs `pnpm build:desktop`, `pnpm compare:bureau` and the end-to-end files that do not depend on a screen, timing or focus. `compare:bureau` runs only there, and nobody needs a Mac to run it.
- Linux runs the whole end-to-end suite in the container, split over parallel runners by recorded run time (`desktop-e2e-linux`; the weights in `scripts/desktop-e2e-shard-weights.json` are refreshed from a green run with `bun run scripts/update-desktop-e2e-shard-weights.ts <run id>`), installs the `.deb` on a real Ubuntu 24.04 host and starts it with the sandbox on, and runs `ui:metrics`.
- On `main`, `edge-build` also runs `e2e/desktop/package.test.ts` on the signed app it builds for the `edge` prerelease.

```
pnpm build:desktop           # vite build of main, preload and renderer, the bundle budget check, then the release and test packages
pnpm build:desktop:unpacked  # the same, but on Linux the release package is the unpacked folder only: no .deb or Arch package, which no test reads
pnpm test:desktop            # Playwright drives the test package: window, security, fuses, IPC
pnpm test:desktop:container  # the same in Docker on a virtual screen, on Linux or a Mac
```

The desktop app's looks are checked in two places. The app is its own pixel reference (ADR 0047):

- **The goldens** are 120 PNGs in `apps/desktop/ui-goldens/`: the 20 screens of `capture:ui` at 1x, in the six themes. `ui:metrics` records them on Linux and compares every pixel exactly, in the same pass as its metrics and their ratchet. When a golden fails on a screen you meant to change, re-record with `--write-goldens`, then look at every golden that moved in the diff before committing it, as for the Android goldens below. Rendering that only a Mac shows, such as font smoothing, is not in them. Rogier checks it by eye on his Mac; it is not a step of your PR.
- **The piece sheet** (faces, marks, icons) is compared with the frozen Crew Bureau book by `pnpm compare:bureau`, in CI on macOS. The book is not edited.

```
pnpm --filter @hercule/desktop ui:metrics                   # the metrics, the ratchet, and the goldens
pnpm --filter @hercule/desktop ui:metrics --write-goldens   # re-record the goldens (never bypasses the ratchet)
pnpm --filter @hercule/desktop ui:metrics --write-baseline  # re-write the metrics baseline; a worse number needs its reason in the PR body
```

On a Mac, or a Linux machine without Chromium's libraries, run `pnpm --filter @hercule/desktop ui:metrics:container`, which takes the same flags. It runs on linux/amd64, the platform the goldens are recorded on, which a Mac emulates (several minutes). On a Mac it works in a copy of the checkout and copies the goldens, the baseline and the report back. Any other command runs in the container with `node apps/desktop/container/run.ts -- <command>`.

The Android app has a check of its own, which no `pnpm` command runs. CI runs it in a job of its own, `android`, on a macOS runner: the screenshot goldens are recorded on a Mac, and Linux rasterises vector shapes slightly differently. It needs JDK 21 (newer JDKs are too new for the Android Gradle plugin) and the Android SDK with platforms 36 and 37 and build-tools 37, located by `JAVA_HOME` and `ANDROID_HOME`; `apps/android/README.md` has the paths. Run it before a PR that changes `apps/android`:

```
cd apps/android && ./gradlew assembleDebug testDebugUnitTest verifyRoborazziDebug lintDebug
```

When `verifyRoborazziDebug` fails on a screen you meant to change, run `./gradlew recordRoborazziDebug`, then look at every golden that moved in the diff before committing it. Never run `./gradlew --stop`: it stops the Gradle daemons of every worktree on this machine.
