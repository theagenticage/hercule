# 37. The desktop app is its own Electron client of the public API

Date: 2026-09-29

## Status

Accepted. Decided by [Desktop app: threads in Crew Bureau (#275)](https://github.com/theagenticage/hercule/issues/275). Amends [ADR 0017](./0017-the-web-app-is-a-static-pure-client-of-the-public-api.md): the desktop app no longer reuses `@hercule/ui`. Keeps the rest of ADR 0017: the desktop app is an ordinary client of the public API, and it is not a wrapped webview of the web app.

**Amended 2026-09-29 ([#275](https://github.com/theagenticage/hercule/issues/275)):** performance no longer comes first during the desktop app's first milestone. Slices 1 to 4 were each held to the budgets before they merged. From slice 5 on, the budgets are guides: the milestone's functionality lands first, and performance passes after it bring the app within the budgets. The rules of spec 17 §Performance still apply to every slice, because they cost little when followed from the start and much when added later. The budgets themselves stand, and spec 17 §Performance says how they are checked while they are guides. Everything else here stands.

**Amended 2026-10-02 ([#313](https://github.com/theagenticage/hercule/issues/313)):** two facts below have moved on, and the decision stands.

- **The pixel reference is now the book's second edition,** in [`docs/design/crew-bureau-2/`](../design/crew-bureau-2/). It started as a copy of the first edition and adds #313's first run. The first edition stays in `docs/design/crew-bureau/`, byte for byte, where the Context below names it.
- **"Later it can manage a local controller" has partly arrived.** The first run's main starts a local controller by running the `hercule` binary that `install.sh` put on the Mac, and asks that binary where the controller is. Main still links only `@hercule/contract` and `@hercule/client-core`, and reads no file in the Hercule Home. Installing and updating the binary stay post-v1 (spec 17 §The first run, spec 15 §Post-v1).

## Context

ADR 0017 planned the desktop app as a second consumer of two packages: `client-core` for data and `ui` for components. Its planning assumption was Electron. The final call belonged to the desktop effort, which starts now.

Two things have changed since then:

- The desktop app now has a design language of its own: **Crew Bureau**, from the design-systems prototype (`prototype/design-systems-2/c1-bureau/` on `prototype/design-systems`, a130074e), copied byte for byte into [`docs/design/crew-bureau/`](../design/crew-bureau/). Bureau is not the web's Midnight language with other colours. It has different type, radii and colour roles, and faces that show state through poses. It limits glass to a fixed set of surfaces and has its own button rules.
- The goal is an app that feels native on macOS, not a web page in a frame. Most of that feel lives in the components. A native control shows the arrow cursor, and nothing in its chrome can be selected. It shows a focus ring only for the keyboard, and it gets a native context menu. `@hercule/ui` is built to feel right in a browser tab.

Reusing `ui` would mean bending each of its components to two design languages and two sets of platform habits. Everything that interprets domain data already lives in `client-core` (spec 14 §Packages). What the two apps can share without cost is therefore the contract and `client-core`, not the components.

The desktop app must reach a controller that is on the same machine or elsewhere on the LAN or tailnet. That controller serves plain HTTP (spec 13 §1).

## Decision

**The desktop app is an Electron app of its own, in `apps/desktop`. It shares `@hercule/contract` and `@hercule/client-core` with the web app, and nothing else. Its renderer calls the controller directly, from the origin `app://hercule`, and the controller allows exactly that origin in CORS.**

- **Electron.** Every install carries the same Chromium, so the rendering, the fonts and the glass are the same on every Mac. A performance measurement taken on one Mac also holds on another of the same speed. Electron's main process runs TypeScript on Node, so it can be written on Effect like the rest of Hercule's non-browser code (ADR 0031). It reaches the Keychain, notifications and the dock. Later it can manage a local controller and act as the installer (spec 15 §Post-v1).
- **Three layers:**
  - **main** is written on Effect. It owns the window, the menu, the stored token, notifications, the dock badge and external links.
  - **preload** is a thin typed bridge. Every IPC message is declared in one contract, in Effect Schema, and main decodes each message against it.
  - **renderer** is React. It writes no Effect code and gets all data through `client-core`. It follows the web app's layering rules (AGENTS.md §Web app layout).
- **Its own components, in Crew Bureau.** The renderer builds its components from the Bureau pages, one component at a time. `tokens.css` and the fonts are copied as they are. `@hercule/ui` stays the web app's library, and dep-lint forbids the desktop app from importing it.
- **Direct calls, one allowed origin.** The renderer is served from the custom scheme `app://hercule`. The scheme is registered as standard and secure, so the page is a secure context. `fetch` and the WebSocket go straight to the controller. The controller answers CORS for the origin `app://hercule` and for no other.
- **Performance and resource use come first.** An empty Electron window already costs about 300 MB and four processes. Every feature is measured against budgets built on that baseline (spec 17 §Performance).

## Considered options

- **Wrap the web app** by loading the controller's web app in a window. Rejected. ADR 0017 already rules it out: the app would keep the web's look and feel, and it would change whenever the controller is upgraded.
- **Reuse `@hercule/ui` and swap the design tokens.** Rejected. Bureau changes more than colours: it adds faces and poses, and its type, radii, glass rules and button rules differ from Midnight's. The native habits listed above belong in the components as well. Every shared component would carry two looks, and neither app could change a component without checking the other.
- **Tauri, or another shell over the system WebView.** It uses less memory and disk: WKWebView is part of macOS, so the app does not carry its own Chromium. That is the strongest argument against Electron. Rejected, for three reasons:
  - The engine is whatever the user's macOS ships, and it is a different engine on each platform. A design judged pixel by pixel would render differently from one install to the next.
  - The main process would be Rust, not the TypeScript and Effect used everywhere else in Hercule.
  - Electrobun keeps TypeScript, but it is too young to build on.
- **Send every request through main.** The renderer would ask main over IPC, and main would call the controller. The controller would need no CORS change. Rejected. Every request and every streamed token would take an extra hop and be serialized twice, and main would become the bottleneck for streaming. `client-core` would also need a second transport just for the desktop app.

## Consequences

- ADR 0017's promise that the desktop app reuses `ui` is withdrawn by a dated note on that ADR. Two component sets now exist. They cannot disagree about what domain data means, because interpretation stays in `client-core`.
- The controller gains a CORS allow-list with one origin (spec 13 §1). The allow-list gives nothing without a bearer token. CORS only decides whether a page may read a response, and every operation except `setup.read` and `auth.login` still requires the token. No web page can take the origin `app://hercule`: only an app that registers the scheme itself can use it.
- `apps/desktop` becomes the second package with a build of its own, after `apps/web`.
- The desktop app has its own spec, `docs/spec/17-desktop-app.md`, with its own performance budgets.
- The bundled Chromium is a fixed cost: about 300 MB of memory, four processes and a large app bundle. Tauri would avoid part of that cost. The budgets make sure Hercule adds as little as possible on top.
