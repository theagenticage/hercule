# 51. The desktop app ships on Linux, and a desktop change is checked on one platform

Date: 2026-11-04

## Status

Accepted. Decided by Rogier on 2026-11-04, in [Desktop: enable the app on Linux, and make Linux a full place to develop it (#1017)](https://github.com/theagenticage/hercule/issues/1017). Amends [ADR 0037](./0037-the-desktop-app-is-its-own-electron-client-of-the-public-api.md), which built the app for macOS only and measured its budgets on a Mac. Amends [spec 17](../spec/17-desktop-app.md) (§Scope, §Auth and the token, §Security baseline, §Native behaviour, §Performance, §Testing, §Post-v1). Keeps [ADR 0047](./0047-the-desktop-app-is-its-own-pixel-reference.md): the goldens are recorded on Linux, and what shows only on a Mac is found by eye.

## Context

Spec 17 made the desktop app a macOS app and put Windows and Linux after v1. Three rules followed from that, and they asked for a Mac:

- the end-to-end suite (`pnpm test:desktop`) ran on a developer's Mac, "before a pull request that changes the desktop app";
- the perf script, which measures processes, memory, idle wakeups and streaming work, ran on a Mac;
- `pnpm compare:bureau` ran on macOS.

Most of the work on Hercule is done by agents on headless Linux machines, and none of them can meet those rules. The rules were not kept in practice. Rogier excepted pull request after pull request from the Mac checks: #851, #893, #894, #895 and #911 all carry a "not measured, because the perf script needs macOS" note in spec 17 §Measured. A rule that is waived each time is not a rule, and it also meant that memory and idle work went unmeasured for weeks.

Linux itself needs no new technology. Electron, the compiled `hercule` binary, the runner and the CLI already run there, and the app's bundle checks and `ui:metrics` already run on Linux CI.

## Decision

**The desktop app ships on Linux now. A desktop pull request needs its checks on one platform, Linux or Mac, never both.**

- **Linux moves forward from Post-v1.** The first format is a `.deb` published on the `edge` release, for Ubuntu 24.04 on x64. Windows stays later.
  - A `.deb` comes first because electron-builder's install script puts an AppArmor profile in place on Ubuntu 24 and sets the SUID bit on Chromium's sandbox helper only where user namespaces do not work. The app refuses `--no-sandbox`, so it needs one of those two to start.
- **One platform per pull request.** Rogier's rule, in his words: "In the future, no instructions should require testing on both platforms as a blocker for successfully shipping a PR. Of course CI still runs tests on mac too."
  - `pnpm test:desktop` runs on either platform. A headless Linux machine is enough: `pnpm test:desktop:container` runs the suite on a virtual screen in a container.
  - CI covers the other platform. A Mac runner builds the app, runs `pnpm compare:bureau` and a subset of the end-to-end suite. Linux runners run the whole suite, install the `.deb` on a real Ubuntu 24.04 host, and compare the goldens.
- **Budgets work across platforms by what they measure** (spec 17 §Performance):
  - Budgets measured on a Mac stay as they are and are judged only on a Mac. A Linux reading is never compared with them.
  - Budgets that are counts are judged on both platforms: processes, bundle bytes, work per streamed token, and no idle timers.
  - Memory and time on Linux are judged before against after, on the same machine and setup, back to back. Spec 17 records a Linux reference table for that.
  - A change is measured on the platform its author has. A Linux author is not blocked by a Mac budget, and a Mac author is not blocked by Linux's.

## Considered options

- **Keep macOS as the one place that gates a desktop change, and add Linux without a gate.** Rejected. It is the state that produced the waived exceptions. Every desktop change from a headless machine would still need Rogier's exception.
- **Require both platforms.** Rejected by Rogier's rule above. No agent on a headless machine could ship a desktop change, and no agent on a Mac could ship one without a Linux machine.
- **Judge Linux readings against the Mac budgets.** Rejected. The numbers do not mean the same thing. A Mac budget is a physical footprint, and Linux has the proportional set size (PSS) from `/proc`, which is not the same quantity. Under Xvfb and software rendering the GPU process draws on the CPU, frame gaps mean little, and launch and paint times follow the host's load.
- **Give Linux budgets of its own now.** Rejected. There is no baseline yet, and one reading on one container is a poor basis for a limit. Spec 17 records the reference table instead, and a change is judged against the table's before and after on the same setup.
- **Another format first (an AppImage or a tarball).** Rejected for now. Neither can run an install script, so neither can put in place the AppArmor profile that Ubuntu 24.04 needs.
- **Wait until the client feels Linux-native.** Rejected. Rogier moved Linux forward so that it works first. The feel (shortcut labels, wording, the window's top strip, an update path) is [#1018](https://github.com/theagenticage/hercule/issues/1018).

## Consequences

- **Pixel and timing checks that only hold on a Mac are no longer run by a developer by default.** CI's macOS runner covers a functional subset of the end-to-end suite. Hosted Macs differ from a user's Mac in screen size, accessibility settings and speed, so the tests that depend on those are skipped there. A Mac-only regression in what those tests check, such as the traffic lights' place or a saved window on a Mac display, can reach `main` unseen until someone with a Mac notices.
- **What shows only on a Mac is found by eye,** as ADR 0047 already says: font smoothing, for example. Rogier's eye on his monitors covers it.
- **Mac budgets are measured only when someone with a Mac measures.** A memory or wakeup regression on a Mac can land and be found later. The count budgets are checked on both platforms, so the changes that add a process, a timer or a write per token are caught wherever they are written.
- **`pnpm compare:bureau` stays in CI on macOS,** and nobody needs a Mac to run it.
- **Linux is a weaker place for the login token and the process than macOS.** Spec 17 §Security baseline states it:
  - there is no hardened runtime, so another program of the same user can load a library with `LD_PRELOAD`;
  - Electron checks the asar file's integrity only on macOS and Windows, so that fuse does nothing on Linux;
  - the token is as safe as the user's keyring. On a desktop that Chromium does not recognise (i3, sway, openbox), Electron picks a backend that encrypts with a key written in its source, so the app stores no token there and the user signs in on each launch. [#1018](https://github.com/theagenticage/hercule/issues/1018) tracks that case.
- **The repository carries a container image and a Linux reference table to keep current.** The table is re-recorded on any Electron or image change.
