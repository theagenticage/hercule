# Desktop app

The desktop app is a macOS app built on Electron and drawn in the Crew Bureau design system. Like the web app, it is an ordinary client of the public API, with no privileged path ([ADR 0037](../adr/0037-the-desktop-app-is-its-own-electron-client-of-the-public-api.md), [ADR 0017](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)). It shares the contract and `client-core` with the web app, and nothing else.

This document covers:

- the process model and the packages
- how the renderer reaches the controller, and how the token is stored
- the Electron security baseline and the IPC contract
- the native behaviour the app must have
- the design system
- the first milestone's screens
- the performance budgets and rules
- the slices and the tests

What a thread does - its sidebar, its transcript, its composer, its Requests - is owned by [./14-web-app.md](./14-web-app.md). This document owns how the desktop app draws that behaviour, and what the desktop adds.

**Status:** locked 2026-09-29 for [Desktop app: threads in Crew Bureau (#275)](https://github.com/theagenticage/hercule/issues/275), with [ADR 0037](../adr/0037-the-desktop-app-is-its-own-electron-client-of-the-public-api.md). Slices 1 to 8 are built, except the `link.open` channel (see [The IPC contract](#the-ipc-contract)).

## Scope of the first milestone

The first milestone is threads, in a native shell:

- the sidebar's Threads face, with Waiting on you at the top
- a thread: its live transcript, its Requests and its queued inputs
- the composer on an active thread
- starting a new thread: the project picker, the Draft Thread and the composer's pickers
- connecting to a controller, and signing in and out
- the native behaviour below: the window, the menu and shortcuts, the dock badge and notifications

Everything else comes later (see [Post-v1](#post-v1)). That includes the Hercule face and its screens, assistants, All sessions, Settings, the desktop app as installer, and Windows and Linux.

## Architecture

### Process model

The desktop app has three layers. Each has one job.

| Layer | Runs | Owns | Written with |
|---|---|---|---|
| main | Node, in Electron's browser process | the window, the app menu, the `app` scheme and its files, the stored token and settings, notifications, the dock badge, external links, the local-runner probe | Effect 4 ([ADR 0031](../adr/0031-the-backend-is-written-on-effect.md)) |
| preload | the renderer's isolated world | the bridge: one function per IPC channel, and nothing else | TypeScript without Effect |
| renderer | a sandboxed Chromium renderer | every screen and component, and every call to the controller | React 19 with the React Compiler, TanStack Router, Query and Virtual; `client-core` for all data; no Effect code ([ADR 0017](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)) |

- **One window.** The first milestone has exactly one window.
- **One instance.** A second launch shows and focuses the running window and exits (`app.requestSingleInstanceLock`). The app takes focus from whichever app is in front, often the terminal the launch came from (`app.focus({ steal: true })`).
- **The renderer follows the web app's layering rules** (AGENTS.md §Web app layout):
  - one screen is one route file, and its loader prefetches what the screen reads;
  - components are presentational or orchestrating;
  - anything that interprets domain data goes to `client-core`, with its own test.
- **The router uses memory history.** A desktop window has no address bar, so no URL is shown or kept.
- **Main stays thin.** It makes no calls to the controller, with one exception: the connection check in [Reaching the controller](#reaching-the-controller).

### Package

`apps/desktop` (`@hercule/desktop`) is one package with three entry points, `src/main`, `src/preload` and `src/renderer`, plus `src/ipc`, the IPC contract that all three import.

- **Build.** It is the second package with a build of its own, after `apps/web`. Vite builds the three bundles, one config per layer, and `electron-builder` packages the `.app`. The repository is on Vite 8, and `electron-vite` 5 supports only Vite 5 to 7, so a small dev script (`apps/desktop/scripts/dev.ts`) does what `electron-vite dev` would: it starts the renderer's dev server, rebuilds main and the preload when they change, and restarts Electron.
- **Its components are its own.** They live in the renderer. They move into a package of their own only when a second app needs them.
- **Imports allowed:** `@hercule/contract` and `@hercule/client-core`.
- **Imports forbidden:** `@hercule/ui`, `@hercule/web`, the controller, the runner, `@hercule/protocol`, `@hercule/plugin-host`, `@hercule/cli` and `@hercule/hercule`.
  - `@hercule/contract` itself imports `@hercule/protocol` and `@hercule/plugin-host`. The desktop app may therefore reach those two through the contract, but never import them itself. The other six are forbidden even through a library.
- **Imports forbidden within the layers:**
  - The renderer never imports `electron` or a Node built-in.
  - The preload imports only `electron` and the IPC contract's types.
  - Main never imports React.
- **`pnpm dep-lint` enforces the import rules.**

Pinned versions: Electron 44.4.5 (Chromium 152, Node 24), Vite 8.2.2, electron-builder 26.15.3.

## Reaching the controller

**The renderer calls the controller directly.** It creates its clients the way the web app does, with the controller's URL as the base:

```ts
const client = createClient({ baseUrl: controllerUrl, tokenStore });
const live = createLive({ client, baseUrl: controllerUrl });
```

Nothing is forwarded through main. The reason is in [ADR 0037](../adr/0037-the-desktop-app-is-its-own-electron-client-of-the-public-api.md).

**The renderer's origin is `app://hercule`.** Main registers the scheme `app` before the app is ready, with these privileges:

| Privilege | Why |
|---|---|
| `standard` | gives the page a real origin, `app://hercule` |
| `secure` | makes the page a secure context; without it, `crypto.randomUUID` and `crypto.subtle` are missing |
| `supportFetchAPI` | lets the page's own files be fetched |
| `corsEnabled` | lets the page make CORS requests |
| `codeCache` | turns on V8's code cache for the page's scripts, which speeds up warm launches |

Main serves the renderer's built files through `protocol.handle`, from inside the app bundle. No remote content is ever loaded into the window.

Measured 2026-09-29 against Electron 44.4.5:

- A page at `app://hercule` sends `Origin: app://hercule` on a CORS preflight, on `fetch` and on the WebSocket upgrade.
- `fetch` to plain `http://` on loopback and on this machine's own LAN address succeeds when the server answers with `access-control-allow-origin: app://hercule`. It fails without that header, and there is no mixed-content block.
- A `ws://` WebSocket to either address works.

**The controller allows that one origin** ([./13-security.md](./13-security.md) §1 owns the rule).

**Verify at build time:** reaching a controller on another machine, on the LAN or a tailnet. The measurement reached this machine's own LAN address. Chromium's Local Network Access checks must not block a secure custom-scheme origin that reaches a private address.

**Verify at build time:** that the `codeCache` privilege caches the renderer's scripts in Electron 44, and how much it shortens a warm launch.

### The controller URL and the connect screen

- **One controller.** The first milestone connects to one controller at a time.
- **Where the URL is kept.** Main keeps the URL in the app's settings file in its user data directory.
- **The connect screen.** It asks for the URL, prefilled with `http://127.0.0.1:4937` (the default `bind.port`, [./15-packaging-and-operations.md](./15-packaging-and-operations.md)).
- **The URL is an origin.** Main accepts an `http:` or `https:` URL with no user name, no password, no path other than `/`, no query and no fragment, and saves its origin. Anything else is refused with a message, never trimmed.
- **Main checks the URL.** Main sends `setup.read` to it. This is main's one call to the controller: the renderer cannot make it, because its CSP (below) names only the controller it is connected to.
  - **The request goes through Chromium's network stack, the one the page uses,** not through Node's `fetch` and not through the contract's client. That way the check sees the macOS proxy settings and the certificates the Keychain trusts, as the page does. Main uses Electron's `net.request`, because `net.fetch` cannot return a redirect or send the preflight with the page's origin. The request sends no cookies or stored credentials. Main must read the response's `access-control-allow-origin` header, and the derived client does not expose response headers. Main still takes the operation's path from the contract's operation table, and decodes the body with the contract's `SetupState` schema. The check is its own module, imported the first time the user connects, so it is not on the launch path.
  - **The check gives up after 5 seconds,** and reads at most 64 kB of the answer. A larger answer is not a `SetupState`.
  - **The check sends the preflights too.** After the `GET`, main sends the `OPTIONS` requests the renderer's own calls will need, one for each method in the contract's operation table, all at once. Each asks with its method and `access-control-request-headers: authorization, content-type`. A reverse proxy can pass the `GET` with its CORS header and still reject a preflight, and sign-in or every edit would then fail with a misleading line. Main asks once per method, rather than asking once and reading the answer for every method, because a server may answer a preflight for the asked method only, and Chromium asks the same way. The check asks at one path, so a proxy whose CORS answer differs from path to path is not detected.
  - **The outcomes,** checked in this order. The connect screen shows each as one line, with the origin that was checked rather than the text as typed, and nothing is saved unless the check passes:
    - The request fails, or times out: the controller is unreachable.
    - The answer redirects to the same path on another origin, such as `https:` for `http:`: the app names that origin and asks the user to connect to it instead. It does not follow the redirect, because the saved URL must be the one the renderer calls. Any other redirect counts as the next outcome.
    - The status is not 200, or the body is not a `SetupState`: the URL is not a Hercule controller. So does a status outside 200 to 599, such as `999`. Response headers that the page's network stack cannot represent, such as a header with a character above U+00FF, are ignored: the check reads only `location` and the CORS headers, and those are plain ASCII whenever they are valid.
    - The response's `access-control-allow-origin` does not allow the origin (by name or `*`): the controller is older than the desktop app and must be updated.
    - A preflight's answer is not 2xx, does not allow the origin (by name or `*`), does not name `authorization`, does not allow `content-type` (by name or `*`), or does not allow its method (by exact name or `*`): the app names every refused method, and asks the user to update the controller or check any proxy in front of it. A proxy is the likelier cause here, because the controller's own answer passed the step above. These are Chromium's rules for the page's calls. A preflight's answer need not list `GET`, `HEAD` or `POST`, which CORS always allows. `*` counts because the page's calls send no credentials; it never covers `authorization`.
    - The controller's setup is not complete: the app says so and opens `<url>/setup` in the default browser. The desktop app is not the installer yet.
    - Otherwise the check passes: main saves the URL and reloads the window, so the new CSP names the new controller.
- **A controller that is down at launch** shows the connect screen, with the saved URL and the "could not reach" line. Connecting checks again.
- **A controller that does not answer at launch** is treated as down after 5 seconds. A connection can be accepted and never answered, and neither Chromium nor the client gives up on its own. While the app waits, and only once the wait is noticeable, it shows the lockup, "Connecting to `<url>`…", and a Change button that leads to the connect screen.
- **Every request the renderer sends gives up after 5 seconds,** for the same reason, and reports the controller as unreachable. The 5 seconds cover the whole answer, body included, so a controller that sends the headers and then stalls is unreachable too. Two operations wait longer on a healthy controller: `session.input` and `input.steer` wait up to 10 seconds for the runner to confirm the message. ~~Slice 6, which adds the composer, gives those two a limit above that wait.~~ *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275): slice 5 gives those two a limit of 15 seconds, above that wait, because its queued rows already steer.)* A limit shorter than the controller's own wait would report a failure for a message that still arrives, and a user who sends it again would send it twice.
- **Onboarding is left to the browser.** Setup and onboarding both happen in the web app, before anyone connects the desktop app, so the desktop app has no onboarding step.
- **Changing controllers.** Changing the controller deletes the stored token (see [Auth and the token](#auth-and-the-token)).
- **A screen that fails** *(added 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275))* shows spec 14's "This screen did not load" screen ([./14-web-app.md](./14-web-app.md), the row "A screen that threw while rendering"), with the failure's own message. It covers a read that fails as well as a render that throws. It differs from the web app's in two ways:
  - It offers **Try again**, which loads every route on screen again, instead of Go to Sessions: the desktop app has no Sessions screen. While the routes load, the button reads "Trying again…" and ignores presses.
  - When the shell itself failed, the screen fills the window, and its foot reads "Controller at `<url>`" with the Change button that leads to the connect screen. It does not say "Connected to", because the failure may be that the controller stopped answering.

### Content-Security-Policy

Main sends this header with every file the `app` scheme serves. `<controller>` is the saved controller's origin, and `<controller-ws>` is the same origin with `ws:` or `wss:`.

```
default-src 'self'; script-src 'self'; connect-src <controller> <controller-ws>; img-src 'self' data:; font-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'
```

- **`connect-src` names exactly one controller.** The web app's policy has to allow ten loopback ports for its local-runner probe. The desktop policy does not, because main runs that probe (below).
- **Before a controller is saved,** `connect-src` is `'none'`.
- **`style-src` has no `'unsafe-inline'`.** No component in the first milestone needs a `<style>` element at run time. React sets element styles through the CSSOM, which `style-src` does not govern.
- **Any relaxation is recorded here, with its reason,** as spec 14 does for the web app.

### The "local" runner

`detectLocalRunner(runners, probe)` in `client-core` takes the probe that asks one port which runner is listening there. The web app's probe uses `fetch`. The desktop app's probe asks main through the bridge, with only the port.

- **Main makes the request.** It sends only `GET http://127.0.0.1:<port>/identity`, and returns only the `runnerId` of the answer.
- **Main accepts only the ten identity ports,** 4939 to 4948, the ones the web app's CSP names. Any other port would let the page make main probe every service on the Mac.
- **Why main does it:** the runner's identity endpoint allows only the controller's origin in CORS, and the renderer's CSP names only the controller.
- **No runner change is needed.**

### Development

In development, the `app` scheme handler forwards each request to the Vite dev server, so the renderer runs at `app://hercule` in development too. It reaches the controller exactly as the packaged app does. The CORS path is therefore used every day, not only in the end-to-end test.

- **The request's headers pass through,** except `Origin`. Vite decides how to answer from `Accept` and `Sec-Fetch-Dest`. An `Origin` of `app://hercule` makes Chromium's network stack fail the forwarded request.
- **The HMR socket dials the dev server directly.** Vite's `server.ws` option sets its host to `127.0.0.1` and its port to the dev server's. Without it, the HMR client would dial `ws://hercule`. Vite's HMR socket accepts a client whose origin is `app://hercule` (measured 2026-09-29).

The development CSP adds what the dev server needs, and only in development:

- the dev server's HMR socket and origin in `connect-src`: `ws://127.0.0.1:<port>` and `http://127.0.0.1:<port>`
- `'unsafe-inline'` in `script-src`, for the React Refresh preamble
- `'unsafe-inline'` in `style-src`, for the styles Vite injects in development

## Auth and the token

The flow is the web app's ([./14-web-app.md](./14-web-app.md) §Auth in the client):

- Password login returns the bearer token.
- Every HTTP request carries the bearer token.
- The WebSocket authenticates with a short-lived ticket fetched over HTTP.

Only the storage differs:

- **At rest,** main encrypts the token with Electron's `safeStorage` and writes it into the app's user data directory. On macOS, `safeStorage` keeps its key in the Keychain. The token is never in `localStorage` and never on disk in plain text.
- **It is stored together with the controller URL it belongs to,** so one controller's token is never sent to another. Both sit in the app's settings file and change in one write. Connecting to a different controller deletes the token; connecting to the same one again keeps it. The URL is encrypted together with the token, and main deletes a token whose URL does not match the saved one, or that has no saved URL beside it, or whose encrypted value names no URL. Otherwise another program could edit the settings file and have the token sent to a server of its own.
- **When the Keychain fails:**
  - If the saved token cannot be decrypted, for example because the Keychain key changed or access was denied, main deletes it, and the user signs in again.
  - If a new token cannot be encrypted, main saves nothing and tells the user they will have to sign in again next time. The user stays signed in for this run. There is no plain-text fallback.
- **At boot,** the renderer reads the token once through the bridge, before it creates the client. Its `TokenStore` then reads from memory, and each write is sent to main.
- **Logout and the first 401 remove it,** as on the web.
- **Sign Out never waits on the controller.** The app forgets the token, empties its caches and shows the sign-in screen at once. It then asks the controller to revoke the token it just forgot, and ignores the answer. A controller that hangs must not keep a user signed in who asked to be signed out, and a quit in that moment must not leave the token on disk.
- **While the app runs, the token is in the renderer's memory,** as it is in a browser tab. The CSP above is what protects it.

**Verify at build time:** whether an unsigned development build prompts for Keychain access when `safeStorage` is first used. A signed build must not prompt.

## Security baseline

- **`webPreferences`:** `contextIsolation`, `sandbox` and `webSecurity` are on, and `nodeIntegration` is off. These are Electron's defaults, and a test checks them.
- **The window never navigates away from `app://hercule`.** `will-navigate` and `will-redirect` are prevented.
- **External links and new windows:**
  - `window.open` is denied.
  - An `http:` or `https:` link opens in the default browser through `shell.openExternal`.
  - Any other scheme is refused.
- **Permission requests from the renderer are denied,** every one of them: camera, microphone, geolocation, notifications. Main shows notifications itself.
  - **Local network access is denied too, and the renderer still reaches the controller.** Electron 44 has the permission types `local-network-access`, `local-network` and `loopback-network`, but it turns Chromium's Local Network Access checks off, so they do not gate `fetch` (measured 2026-09-29). An end-to-end test reaches a loopback controller with every permission denied. The day Electron turns the checks on, that test fails, and the permission handler must then grant those three types to `app://hercule` alone.
- **IPC:**
  - Main answers only messages from a frame whose origin is `app://hercule`.
  - Main decodes every message against the IPC contract, and refuses and logs one that does not decode.
- **Electron fuses, set when the app is packaged:**
  - `RunAsNode` off
  - `EnableNodeOptionsEnvironmentVariable` off
  - `EnableNodeCliInspectArguments` off
  - `EnableEmbeddedAsarIntegrityValidation` on
  - `OnlyLoadAppFromAsar` on
  - `GrantFileProtocolExtraPrivileges` off: the app loads nothing over `file://`
- **The test package differs from the release package in one fuse.** Playwright's Electron driver attaches through `--inspect`, which `EnableNodeCliInspectArguments` turns off. The end-to-end tests and the perf script therefore run a second package with only that fuse on. A packaging test reads every fuse off the release `.app` and checks it.
- **The packaged app refuses every command-line argument but three, matched as whole arguments.** Started with any other argument, it prints why and exits before it reads the token. Many of Chromium's switches would let another program on the machine read the signed-in session, and nobody can list them all, so the rule is an allow-list. For example:
  - `--remote-debugging-port` and `--remote-debugging-pipe` let another program drive the page, which holds the token. No fuse turns them off.
  - `--log-net-log` writes every request to a file, the `authorization` header included.
  - `--proxy-server`, `--host-resolver-rules` and `--ignore-certificate-errors` send the app's requests, and the token with them, to another server.
  - `--use-mock-keychain` replaces the Keychain key with a fixed one, so any program could decrypt a token saved under it.
- **Arguments that are not switches are refused too.** Chromium trims spaces, tabs and newlines from each argument before it looks for a switch, and reads `-x` as it reads `--x`. So ` --remote-debugging-port=0`, with a leading space, is that switch.
- **The three allowed arguments are the ones the end-to-end tests pass.** macOS passes the app no argument when it opens it.
  - `--user-data-dir=<folder>` gives each test its own folder. It exposes nothing: a program that can write a folder it names can write the app's own.
  - `-ApplePersistenceIgnoreState` followed by `YES` keeps macOS from offering to reopen windows after a test stops the app. The app does not use window restoration.
- **The refusal applies only while the Node inspector is closed.** An open inspector already gives full control of main, so refusing arguments would add nothing. The release package's fuse keeps the inspector closed, so there the refusal always applies. The test package runs with the inspector open, which lets Playwright pass `--remote-debugging-port` and the tests pass `--use-mock-keychain`.

## The IPC contract

`apps/desktop/src/ipc` declares every channel in Effect Schema: its name, its request and its response.

- Main decodes each request against it.
- The preload exposes one typed function per channel, on one object in the renderer's world: `window.bridge`.
  - A renderer → main channel `a.b` is called as `window.bridge.a.b(request)` and returns a promise of the response.
  - A main → renderer channel is declared in a second table. The bridge exposes it as a subscription: `thread.open` becomes `window.bridge.thread.onOpen(listener)`, which returns a function that unsubscribes. Main encodes each payload against the table before it sends it. The preload passes the listener only that payload, never Electron's IPC event object. The preload does not decode it, because the preload links nothing but Electron.
- Nothing else crosses between the layers.

**Errors across the bridge:**

- **An outcome the user can cause is part of the response,** as a tagged union. `controllerUrl.save`, for example, answers with one of its outcomes, and the connect screen shows each one. Errors cannot carry a type across the bridge: Electron copies only an error's message to the page.
- **A refused message is a bug.** Main refuses a message that does not decode, a sender other than the app's main frame, and a request that makes no sense in main's current state. It logs the refusal, and the promise in the renderer rejects with its message. The renderer never shows a refusal to the user as if the user had caused it.
- **A defect,** an error nobody expected, rejects the promise too, and Electron logs it.

The first milestone's channels. *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* `goMenu.set` is added, because the Go menu lists the threads the sidebar shows and only the renderer knows them. `waitingThreads.set` replaces `badge.set`, `notification.show` and `notification.close`: the renderer sends every thread waiting on the user, and main decides the badge and which notifications to show or remove. Main then keeps which notifications it has shown, so a reload of the page cannot show them again, and main knows whether the user is signed in before the page sends anything, so a page still leaving the shell after a sign-out cannot bring them back.

| Channel | Direction | Purpose |
|---|---|---|
| `token.read` / `token.write` | renderer → main | the stored token (see [Auth and the token](#auth-and-the-token)) |
| `controllerUrl.read` / `controllerUrl.save` | renderer → main | the saved controller URL; checking a new one and saving it. Not the public API's `controller.read`, which describes the controller itself |
| `runnerIdentity.read` | renderer → main | the local-runner probe |
| `goMenu.set` | renderer → main | the threads the sidebar shows, top to bottom, for the Go menu |
| ~~`badge.set`~~ | ~~renderer → main~~ | ~~the dock badge count~~ |
| ~~`notification.show` / `notification.close`~~ | ~~renderer → main~~ | ~~a thread's notification, keyed by session id~~ |
| `waitingThreads.set` | renderer → main | every thread waiting on the user, for the dock badge and the threads' notifications |
| `link.open` | renderer → main | opening an `http:` or `https:` link in the default browser. Not built yet: it arrives with the draft's Log in button, which is its first caller. A link the user clicks already opens in the default browser without it (see [Security baseline](#security-baseline)) |
| `firstScreen.report` | renderer → main | the frame that draws the first screen, fonts included, has reached the window, so main can show the window (see [Native behaviour](#native-behaviour)) |
| `thread.open` | main → renderer | a notification click or a Go menu item asks for a thread |
| `menu.command` | main → renderer | a menu item the renderer carries out, such as New Thread or Send |

A new channel is added to the contract, and to this table, in the same change.

## Native behaviour

Each item below is an acceptance criterion. The end-to-end test checks it where it can.

- **Title bar:**
  - `titleBarStyle: "hiddenInset"`, with the traffic lights sitting in the sidebar's top strip.
  - `trafficLightPosition: { x: 19, y: 16 }` puts the native lights where the Bureau pages draw them: centres at 26, 46 and 66 pt from the left, 24 pt from the top. The renderer draws no lights of its own.
  - The top 52 pt of the window drags it, across its full width. The shell draws this as one strip over the top of the window that paints nothing and is not a compositing layer; the sidebar's top strip and the thread's chrome row both sit inside it. Each control placed in the band is marked `no-drag`, so it takes clicks.
- **No flash:**
  - The window is created hidden, with `backgroundColor` set to `--bg` of the current appearance: `#f4f3f0` for Whitehaven and `#1a1310` for Orient Express. These are the sRGB values Chromium draws for the `oklch` tokens, and a unit test derives them from `tokens.css`.
  - It is shown when the frame that draws its first screen, fonts included, has reached the window, or 3 seconds after its page first painted, whichever is first. It is also shown at once when its page fails to load or its renderer exits. Showing on `ready-to-show` would show an empty page for a few frames: `ready-to-show` fires when the bare HTML first paints, 50 to 80 ms before the first screen has painted.
  - The 3-second limit means a renderer that fails before it reports still gets its window. It sits well above the "connecting" screen's 1-second delay, because that delay starts only once the renderer's code has loaded and its router has started, and fonts and a few frames follow it. So a healthy renderer shows its window by reporting, even on a slow Mac's cold launch. A crash or a failed load does not wait for the limit.
  - The renderer reports its first screen through the IPC contract once the frame that draws it has been presented: it times a sentinel element that draws nothing with Element Timing, whose entry arrives only once its frame has been presented, or has failed to present. A frame that fails to present is rare; the window then shows a frame early, and the screen appears with the next frame. Two animation frames are not enough, because the second can run before the first frame has reached the window. The "connecting" screen reports too, so a slow controller does not keep the window hidden.
  - When the appearance changes, main updates the background colour.
- **Theme follows the system, live:** Whitehaven when macOS is light, Orient Express when it is dark, through `prefers-color-scheme`. Bureau's other three themes, and a glass setting, arrive with Settings.
- **Accessibility settings:**
  - Reduce transparency sets `--glass-level` to 0, which removes the blur completely.
  - Reduce motion stops every animation.
- **Window size:**
  - The first launch opens a 1440 × 900 pt window, the size of the Bureau pages, centred on the display. On a smaller display it fills the work area.
  - The window cannot be made smaller than 800 × 500 pt. Below a width of 776 an empty thread's composer no longer fits the main pane, and below a height of 440 its start cards no longer fit.
- **Window state is remembered:** size, position and full-screen. A position that no longer lands on a display is moved onto the nearest one.
- **Closing the window hides it.** `⌘W` and the red light hide the window, the dock icon shows it again, and `⌘Q` quits. The app keeps running while the window is hidden, so the dock badge and notifications keep working.
- **The last open thread reopens at launch.** *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* The app reopens what was open when it quit:
  - The renderer stores the open thread's id per controller URL. Opening a thread stores it; leaving it for a screen that is not a thread removes it, so a quit on the new-thread screen launches on the new-thread screen.
  - When the stored thread is gone at launch, the id is removed and the new-thread screen shows, because the user did not ask for that thread this time. A gone thread the user opens during use shows "This thread was not found." with a link to start a new thread.
- **Menu:**
  - The standard app, Edit and Window menus, so text editing shortcuts work in every field.
  - The menus, in order: the app menu, File, Edit, Go, Thread, Window. The development build adds View, with Reload and Toggle Developer Tools, after Edit.
  - File › New Thread `⌘N`.
  - Thread › Send `⌘↵`. *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* It is always enabled. It sends what the open thread's composer or the draft holds, as ⏎ in the message field does, and does nothing when there is nothing to send.
  - Go › the first nine threads of the sidebar, `⌘1` to `⌘9`, in sidebar order. *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* Each thread is listed once, by its title: a waiting thread is listed where "Waiting on you" shows it, and a thread a "more" row hides is not listed. With no thread, and while signed out, Go holds one dimmed "No Threads".
  - While the project picker is open, `⌘1` to `⌘9` pick a project instead, as spec 14 says. Choosing a thread in Go with the mouse closes the picker.
  - Sign Out, in the app menu.
- **Dock badge:** the number of threads waiting on you. A thread waits on you while its session has an open Request (`Session.openRequest`, [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)).
  - *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* macOS shows an app's dock badge only once the user has allowed the app to notify. The app asks when the user signs in, so the badge can show from the first waiting thread.
- **Notifications:**
  - When a thread starts waiting on you and the window is not focused, main shows a native notification.
  - Clicking it focuses the window and opens the thread.
  - *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* The notification's title is the thread's title and its body is the question, such as "Run git push?".
  - A thread has at most one notification. A new Request on the thread replaces it; when the new Request opens while the window is focused, the old notification is removed and no new one shows.
  - Launching the app, or signing in, shows no notification for the threads that already wait; the badge counts them.
  - Signing out, or connecting to another controller, hides the badge, removes every notification and empties Go. They stay empty until the user signs in again.
- **Answered anywhere clears everywhere** ([ADR 0027](../adr/0027-a-decision-resolves-when-its-question-is-answered-wherever.md)):
  - When a Request is answered anywhere - here, in the web app or from the CLI - its notification is removed and the badge drops, at the moment the `session` nudge arrives.
  - A Request opening or closing already sends that nudge ([./14-web-app.md](./14-web-app.md) §Live model).
- **Links:** external links open in the default browser, and the window itself never navigates.
- **No signs of a web page:**
  - The chrome cannot be selected as text. Transcript text, code and fields can.
  - Buttons and rows keep the arrow cursor, as native controls do.
  - The window does not bounce as a whole. Scroll areas keep macOS's elastic scrolling.
  - There is no pinch zoom and no page zoom.
  - A focus ring shows only for keyboard focus (`:focus-visible`).
  - Scroll bars are the system's overlay scroll bars, unstyled, so they follow the System Settings choice.
  - Right-clicking text opens the native context menu (Copy, Look Up, Search). Right-clicking chrome opens nothing.
- **The composer draws the `+` attach and voice buttons, with nothing behind them yet.** They keep the composer's full shape, as in the web app ([./14-web-app.md](./14-web-app.md) §App shell). They show their hover and pressed states, and a click does nothing.

## Design system

**The pixel reference.** The pixel reference is the Crew Bureau book and its desktop pages, in [`docs/design/crew-bureau/`](../design/crew-bureau/). The folder is a copy of `prototype/design-systems-2/c1-bureau/` at commit a130074e on the `prototype/design-systems` branch, kept byte for byte and never edited. Its pages link to two sibling folders, copied the same way beside it: `docs/design/shared/` (the book's frame scripts and the brief) and `docs/design/c0-crew/` (the original Crew, for the book's before-and-after frames). Open `docs/design/crew-bureau/index.html` in a browser to read the book.

- Where this text and the pages disagree, the pages decide a measurement and this text decides a behaviour. This is spec 14's rule for its prototypes.
- Behaviour comes from [./14-web-app.md](./14-web-app.md): §App shell (the Threads face), §The thread surface, and §The composer is the thread's configuration.

**Where Bureau changes a behaviour, the desktop follows Bureau.** The changes the first milestone takes from the book's Spec section:

1. **Waiting on you tops the sidebar,** above the threads. The first milestone has only the Threads face, so the section sits at the sidebar's top.
2. **No monospace outside code.** Monospace is kept for code, commands and diffs. Spec 14's monospace time separators, workspace labels and branch values use the UI face.
3. **Six marks.** Queued, cancelled and skipped lose their marks and become words.

**A thread's face is seeded by its session id,** not by its title. The book derives a face from a name. ~~A thread's title is written by the agent after the first message and can change, and a face must not change when its title does.~~ *(Amended 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275): a thread's title is set once, from the opening prompt's first non-empty line, as the contract's `Session.title` says. The id still seeds the face, because two threads can open with the same line, and each is its own colleague.)* The book's stored look (its Spec change 3) is for workflows and assistants, and arrives with them.

**A face shows its colleague's state as a pose.** The eight poses, as the book draws them. Every pose is still, except that the working pose's paws type while its turn runs ([Rules](#rules), rule 2). Slice 4 maps a session's state to a pose in `@hercule/client-core`.

| Pose | Read to assistive technology as | Drawn | Mark |
|---|---|---|---|
| working | working | lowered eyes with a glint, brows, a flat mouth, paws on a typewriter | yes |
| waiting | waiting on you | wide eyes, brows, an "o" mouth, a raised arm with a `--you` palm | yes |
| idle | idle | eyes, a smile | yes |
| asleep | asleep | closed eyes, a small mouth, two z's, desaturated | no |
| failed | failed | eyes, brows, a wavy mouth, a plaster, a red badge with an X | yes |
| paused | paused | line eyes, a flat mouth, an outlined badge | yes |
| done | done | smiling eyes, a smile, a green badge with a check | yes |
| away | can't be reached | offset dots, a dotted mouth, an outlined badge, faded and desaturated | no |

A face's accessible name is its label and its pose's words: "Fix 3-D Secure checkout for EU cards, waiting on you".

**A thread's pose** *(added 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275))* is decided by `decideThreadPose` in `@hercule/client-core`. The first row that matches wins. The sidebar row's end is decided with it (`decideThreadRowEnd`):

| The session | Pose | The row's end |
|---|---|---|
| has an open Request | waiting | the waiting mark |
| is held by the crash-loop guard, or has exited and cannot be resumed | away | its age |
| runs on a runner that is offline or unreachable | away | the word "offline", or its age once the session has exited |
| has exited and can be resumed | asleep | its age |
| is queued | working | the word "queued" |
| is starting or busy | working | the working mark |
| is idle | idle | its age |

- Waiting comes first, because Waiting on you is defined by the open Request. A waiting thread on an offline runner stays waiting: the Request is still the user's to answer, though the answer reaches the agent only when the runner returns.
- A runner the runners list does not hold counts as reachable, because a missing cache entry is not evidence.
- failed, paused and done are never produced yet: a session does not record why it ended, so the app cannot tell done from failed. [#278](https://github.com/theagenticage/hercule/issues/278) adds the end reason.
- [./14-web-app.md](./14-web-app.md) (#162) calls an exited, resumable thread Idle, "indistinguishable from one whose process is running". The desktop draws its row exactly like an idle one (its age, no mark), so that holds for what is drawn. It names the pose asleep, the word [CONTEXT.md](../../CONTEXT.md) gives an assistant's session in the same state, so the foot's idle count means threads that are loaded and free, and the accessible name says "asleep".

**The sidebar** *(added 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275))* follows spec 14's Threads face and the book's session page, with these differences:

- **Sections are capped, as the book's swarm state draws them.** A "more" row expands its section in place.
  - Waiting on you shows its 3 newest threads, then "`<n>` more waiting on you".
  - A project shows at most 5 threads, then "`<n>` more threads". The 5 are chosen in this order: waiting, then working (queued, starting, busy), then the rest; the newest activity first within each, ties broken by session id. The selected thread is always shown as well, so a project can show 6.
  - Shown rows keep the grouped order. A workspace with no shown thread is left out, with its label.
  - Expanding is not stored: a relaunch collapses every section. The book draws no way to collapse one, so there is none.
- **Threads are grouped by project, then by workspace,** as spec 14 says. The book draws no workspace label, so the label is Bureau's lane label, in the UI face (item 2 above). A lane label that follows a row has 8px more space above it than one under a project header, so it does not read as the row's third line. A row's second line is the model's name, because the lane label already names the workspace.
- **A project header has no thread count,** where spec 14 puts one: the book draws none, and the pages decide what is drawn.
- **The threads with no project have a header, "No project",** where spec 14 gives them none. In place of the identity tile, it has the tile's outline in `--faint` with no fill. ~~It has no `+`, because a draft always starts in a project.~~ *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275): a draft can have no project (see **A new thread** below), so the header has a `+` that opens that draft.)* Without a header, a capped project's "more" row sits between two groups and reads as belonging to either.
- **A waiting thread is listed twice:** in Waiting on you, and in its project with the waiting mark, as the book draws it. In Waiting on you, its second line is the open Request as one question: "Run git push?", "Change adyen.ts?", "Change 3 files?", "Read `<file>`?", "Run `<tool>`?", or a question's first line in the agent's words. With nothing waiting, the section is not drawn.
- **The foot counts threads by pose:** "`<n>` working · `<n>` waiting · `<n>` idle".
  - Asleep and away threads are not counted, so a fleet with hundreds of old threads reads "3 working · 2 waiting · 4 idle", not "470 idle".
  - The book's "paused" count is left out, because no thread is paused yet.
  - Every count shows at 0. The waiting count takes `--you-ink` only above 0, because the attention hue means something needs the user.
- **Search `⌘K`, the hide-sidebar button and Settings are drawn and inert** until their slices build them, like the composer's `+` and voice buttons: they show their hover states, do nothing when pressed, and carry `aria-disabled`. `⌘K` is not registered.
- **The thread list reads every page** of `session.query`, so no thread is left out. The web app reads the first 500.

**The thread** *(added 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275))* follows spec 14's thread surface and the book's session pages, with these differences:

- **A turn's work is shown per work stretch,** as the book draws it. A work stretch is the steps between two messages of one turn. Each stretch gets its own divider, and each agent message stands on its own with its face, its meta line and its body. Talk and work keep the order they happened in. Spec 14 and the web app draw one divider per turn, and join the agent's messages under it.
  - The divider reads "Worked for 2m 14s ›" and a summary of the stretch. The summary counts its steps by kind, in the order each kind first appears: "ran 2 commands", "edited 3 files", "searched the web", "used 6 tools", "ran 1 subagent", "made a plan", "compacted the context", "hit 1 error", "did 1 other step". Reasoning is not counted, and a stretch of reasoning alone draws nothing.
  - The book's "read 6 files" is not drawn: no transcript item says that a tool read a file, so such a read counts as a tool.
  - Clicking the divider expands the stretch in place, one line per step, with spec 14's verb, target and result. Expansion is not stored.
  - The stretch that is running reads "Working for 12s ›" and counts up. It shows no divider until its first step that is not reasoning, so no divider shows before the first step, or while the agent only reasons. It does not shimmer, as spec 14's does, because only the working face animates ([Rules](#rules), rule 2). While a Request is open, the stretch stops at the Request's opening and reads "Worked for".
- **Messages carry their own time,** and there are no time separators, where spec 14 draws one above each turn. A user message has its time under the bubble; an agent message has it in its meta line, "Claude Code · Opus 5.5 · 09:04". The time is `09:04` when it falls on today in the system time zone, else `4 Sep 09:04`.
- **The header is the book's:** the crumb with the project's tile and name, one tab per thread of the workspace, and a `+` that starts a new thread in the workspace (spec 14's "+ New thread here"), shown only while the workspace is ready (see **A new thread** below). Spec 14 rejected a `+` beside the tabs; the book draws one, and the pages decide what is drawn. The open thread always has a tab: a thread that has exited no longer holds its workspace, so the workspace does not list it, and its tab is then the last. Open in editor and More are drawn inert, like the sidebar's Search. The book's "Changes +48 -12 | Commit" is left out, because nothing reports those numbers yet.
- **The Requests dock answers from the keyboard only while it has focus:** ↩ allows, ⌥↩ allows always and esc denies, as the book's hints say. When one of its buttons has focus, ↩ presses that button, so a focused Deny is never turned into Allow. A Request that opens never moves focus. The words on the dock are `@hercule/client-core`'s, which no screen may reword, not the book's.
- **The composer's lip** shows a main workspace as "Main workspace" and its branch, and an ephemeral workspace as its branch and the branch it was started from, "fix/3ds-eu-cards from main", as the book draws it. The machine is on the right. The book's "Own worktree" is not used, because [CONTEXT.md](../../CONTEXT.md) keeps "worktree" for the git mechanism.
- **Stop takes Send's place while a turn runs,** as the book's assistant page draws it. Spec 14 draws Stop beside the round send. While a turn runs, ⏎ still sends: the controller steers the message into the turn or queues it behind the turn. Stop keeps Send's 4px left margin, which the book's Stop lacks, so nothing in the row moves when a turn starts or ends.
- **The note "model change applies on send"** sits after the model options selector, in the row's free space. Spec 14 puts it before the selector, where it would push the selector aside when it appears.
- **The composer's menus are Bureau's popovers:** glass, with the `--line` rim, `--r-lg` corners and `--shadow-3`. Spec 14 draws them `--raised`, with a `--line` border and a radius of 10. The book draws no composer menu, so the widths stay spec 14's: 320px for the model options, 360px for the model. The model options menu shows each option as Bureau's lane label above a segmented control.
- **Each thread keeps its Message Draft and its unsent picks while the app runs,** so switching to another thread and back loses nothing. They are held in memory, and quitting the app loses them. The web app loses them when the user switches threads.
- **The composer shrinks while the transcript is scrolled away from its bottom,** as the book's session page draws it:
  - It shrinks while the transcript is more than 12px from its bottom and focus is not inside the composer. Focus on `dock-mini`'s buttons does not count.
  - Shrunk, it is 560px wide and shows the field on one line, with `dock-mini` above it. The queued inputs, the dock's question and answers, the row and the lip are hidden.
  - A click on it focuses the field and scrolls the transcript to its bottom, in one step. Sending also scrolls the transcript to its bottom.
  - The book animates the width, the heights and the scroll. The desktop changes them in one frame, and animates only the 4px drop and the glass ([Rules](#rules), rule 2).
  - While it is shrunk, the transcript keeps the space below its end that the full composer needs, so the shrink never changes how far the transcript can scroll.
  - *(Amended 2026-10-01, [#275](https://github.com/theagenticage/hercule/issues/275).)* While it is full size, the transcript fades out at its bottom, as it fades out under the header. It is hidden below the card, under the lip and the 18px below the lip, and fades in over the card's lower 36px. The book lets the transcript pass under the lip, which has no card behind it. With focus in the composer and the transcript scrolled up, the composer stays full size, and the transcript's lines then collide with the lip's workspace and machine. Shrunk, the composer has no lip, and the transcript still reads under it, as the book draws it.
- **`dock-mini` answers the Request:** its Allow and Deny send the answer, as the dock's do, and do not expand the composer. Its question is the line the sidebar's Waiting on you row shows, such as "Run git push -u origin fix/3ds-eu-cards?", in plain text. The book sets the command in code.
- **A message that is already being written when the app starts listening** shows its text as the controller stores it, 4 KB at a time, and not token by token. This happens when a thread is opened, when the window is shown again, and after a reconnect. It also happens to a message that started while the app was not listening, such as during an outage, whose first rows arrive in the stream's replay. A message that starts while the app listens streams token by token. A token carries no position within its message, so the app cannot place tokens after a gap without risking a hole or a repeat, and it waits for the stored text instead. [#290](https://github.com/theagenticage/hercule/issues/290) gives each token its position. The web app does the same ([spec 14 §Live model](./14-web-app.md#live-model-one-websocket-subscriptions-only)).
- **A paragraph is drawn as markdown once the agent has finished it.** The paragraph the agent is writing is plain text. The message's text is joined before it is split into paragraphs: the stored text, then the streaming tokens after it.
  - A paragraph ends at a blank line outside a code block. A code block being written stays plain text until it closes, so a blank line inside it does not end it.
  - The controller stores an open message every 4 KB, and the cut can fall inside a word or a code block. The cut never ends a paragraph, so a word cut in two stays whole.
  - Once the message ends, its whole text is drawn as markdown.
  - The message renders once per finished paragraph. The tokens in between are painted into the paragraph being written, at most once per frame, without a render.
  - Spec 14 draws the stored text as markdown and the tokens after it as plain text, until the message ends. There, a cut word breaks across two lines, and the tokens' finished paragraphs show their markdown marks.
- **A thread that is gone** shows "This thread was not found." with a link to start a new thread. Any other failure shows [A screen that fails](#reaching-the-controller).

**A new thread** *(added 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275))* follows spec 14's thread creation and the book's `session-empty.html`, with these differences:

- **New thread opens the project picker,** from File › New Thread `⌘N` and the sidebar's New thread row. It is a glass `<dialog>` over a scrim, 520px wide and 18vh from the top. Spec 14 draws it `--raised` with a border; Bureau draws every surface that floats as glass. ↑↓ move and wrap, ⏎ picks, Esc closes, and `⌘1` to `⌘9` pick directly. There is no "New project" row, because the desktop cannot create projects. With no projects there is nothing to pick, so New thread opens the draft with no project at once.
- **A draft can have no project.** The new-thread screen with no project is a draft with no project, and the thread it starts has none. The "No project" header's `+` opens it. Its heading is "What should the agent do?", and it has no start cards.
- **The lip uses [CONTEXT.md](../../CONTEXT.md)'s words, in the UI face.** The book's lip says "New worktree" and sets the branch in monospace. The desktop says "New workspace" or "Main workspace", as the web's workspace menu does, and sets the branch in the UI face (item 2 above). There is no rule between the workspace and the branch, where the web draws one, because the book draws none.
- **The machine menu has no "Add machine →" foot,** because the desktop has no machine screen to open. The foot keeps its sentence: "The thread runs where you say; nothing moves it later."
- **The machine menu leaves out retired runners,** where spec 14 lists every machine. A retired runner can never host a thread again, and runners are never deleted, so the menu would fill up with machines that are gone. A started thread still shows the retired runner it ran on. The web app does the same, because both read `buildRunnerMenu` in `@hercule/client-core`.
- **A draft that cannot start** shows "Can't start yet." and the reason in place of the sentence, and Send is off. Spec 14's Log in button is not drawn yet.
- **A new thread joins only a ready workspace.** A workspace label's `+` and the thread header's `+` show only while the workspace is ready, because the controller refuses to start a thread in a workspace that is still being set up, failed, was deleted or was lost. A draft whose workspace stops being ready while it is open cannot start, and says why: "The workspace it joins could not be set up". Neither can a draft whose machine is retired after the user picked it: the reason is "moss is retired", and the lip's machine reads "moss · retired". The web app does the same, because both read `@hercule/client-core`.
- **The start cards** are the book's "Start from Intake" section under the lip, which spec 14 does not have. They are up to three open Tasks of the draft's project, the most urgent first. Each card shows:
  - the GitHub mark when the Task came from GitHub, else the tasks glyph;
  - "Proposal" when the Task has the `proposed` label, else "Task";
  - its priority as bars at the right: 4 for urgent, drawn in `--fail` as the book does, 3 for high, 2 for normal, 1 for low;
  - its title.

  ~~A click adds the Task's title and description to the Message Draft,~~ *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* A click adds one line that points the agent at the Task, rather than the Task's text:
  - "Pick up ticket https://github.com/owner/repo/issues/42" when the Task's first External Ref is a GitHub issue;
  - "Pick up pull request https://github.com/owner/repo/pull/87" when it is a GitHub pull request;
  - "Start working on task <id>: <title>" otherwise.

  The thread's agent reads the rest itself, with `gh` or `hercule task read`. The message stays short, and text written outside Hercule, such as an issue's body, is never sent as the user's own words. The line goes after a blank line when the field already holds text, and the click focuses the field. The section shows only when the project has open Tasks. The book's "2 new events" is not drawn, because nothing counts new events.
- **The open draft is a row in the sidebar,** as the book draws it: "New thread", with its workspace and machine on the second line, and "draft" at its end. It is the last row of the workspace it joins, as its tab is the header's last. A draft that starts a new workspace has a group of its own under the project's header, and a draft with no project is the last row of "No project".
- **The draft's text and picks are kept while the app runs,** like a thread's Message Draft, one draft per project and workspace.

**How the system is carried over:**

- **Kept as they are:** `tokens.css` and the font files. They are the design system's source. Token names match the web app's (`--bg`, `--surface`, `--raised`, `--ink`, `--muted`, `--faint`, `--line`, `--line-soft`), except that `--attn` becomes `--you` / `--you-ink`.
- **Rebuilt one component at a time:** `system.css` is never copied whole. Each React component takes the rules it needs, so no CSS ships that no component uses.
- **Rewritten as typed modules:** `crew.js` becomes typed modules for faces, poses, icons and marks. Components render their SVG as React elements, never through `innerHTML`.
- **Self-hosted fonts:** fonts are served from the app bundle, and nothing is fetched from a third party.
  - Bricolage Grotesque is the UI face.
  - Limelight is used only for the wordmark and numerals.
  - Recursive is used only for code.

## Performance

**The budgets guide the first milestone; they do not gate it.** *(Amended 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275).)* Slices 1 to 4 were each measured against the budgets before they merged, and a slice that missed one did not merge. From slice 5 on, the milestone's functionality comes first, and performance passes follow it:

- **A slice is not measured against the budgets,** and a reading over one does not stop it. The perf script and the size checks in `pnpm build:desktop` report such a reading and pass.
- **The [rules](#rules) still apply to every slice.** They say how the app is built, and they cost little when followed from the start and much when added later.
- **A performance pass** measures the app, records the measurement in [Measured](#measured), and brings the app within the budgets.
- **Budgets:**
  - Raising a budget is a deliberate change, recorded here with its reason.
  - A budget is lowered once measurements show room to spare.

### Baseline

Measured 2026-09-29 with Electron 44.4.5 (Chromium 152) on macOS 15.8, an M4 Max with 64 GB. The page was an empty, hidden window served from a secure custom scheme:

| Measure | Value |
|---|---|
| Window ready to show, from process spawn | about 300 ms warm, 663 ms cold |
| Processes | 4: browser, GPU, network utility, renderer |
| Working set, summed across processes | about 308 MB: browser 136, GPU 56, utility 40, renderer 76. Shared pages are counted in each process. |
| CPU while idle | about 0% |
| Wakeups per second while idle | browser 1-3, GPU 6-12, renderer 0-2 |

Animation and glass were measured on a visible window on the same machine, counting wakeups per second:

| Page | GPU | Renderer |
|---|---|---|
| A still page | 6 | 0 |
| 40 idle faces, blinking as the Bureau pages draw them | 101 | 29-32 |
| 40 faces, 5 of them in the working pose | 241 | 64 |
| Text streaming at 30 updates a second, composer glass at level 0.4 | 261 | 59 |
| The same, with glass at 0 | 258 | 56 |

The physical footprint of an empty app, measured later with a visible 1440 by 900 window on the same machine's built-in display, is 119 MB summed: browser 40, GPU 54, network utility 7, renderer 18. That is the least any window of this app can cost. The same app with one focused text field read 124 and 139 MB: the extra is in the GPU process, up to 20 MB, about one window-sized frame buffer (2880 by 1800 pixels at 4 bytes each). The field's blinking caret keeps frames coming, and Chromium holds a third frame buffer while frames come.

What the numbers show:

- **Idle faces are not free.** Bureau starts each face's blink at a different time, so with 40 faces on screen one of them is almost always blinking. That keeps the GPU process awake about 16 times as often as a still page, and wakes the renderer about 30 times a second while nothing happens.
- **Glass costs almost nothing on this machine.** Composer glass while streaming measured within noise of no glass.

### Budgets

The reference setup:

- the machine above
- the packaged app
- a controller on loopback
- a thread with 500 transcript rows open

These are starting budgets. The first performance pass measures the real thread screen, and each budget then comes down to the measurement plus 10%.

| Budget | Limit |
|---|---|
| Launch | The window shows within 500 ms of spawn (warm), and the last open thread's transcript paints within 800 ms |
| Processes | The four of the baseline. No hidden windows, and no workers unless a slice justifies one |
| Memory | Summed physical footprint at most 220 MB, and the renderer at most 100 MB *(amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275): with a text field focused and with none, because a focused field costs the GPU process 400 MB more while the glass blur is on screen; see [Measured](#measured))* |
| Idle, window visible, no thread working *(amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275): and no text field focused)* | Renderer: no wakeups from the app except the live connection's 30-second keepalive *(amended 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275): and the change of a time label on screen, which rule 4 allows)*. GPU: at most 12 wakeups a second, the still-page level |
| Idle, window visible, a text field focused | *(Added 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* No wakeups from the app beyond what a focused field costs an empty Electron window: at most 63 a second for the GPU and 4 for the renderer on the reference machine. The field's blinking caret keeps Chromium drawing frames, about 60 a second, however still the rest of the page is |
| Idle, window hidden or minimized | Renderer: no wakeups from the app *(amended 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275): except the live connection's 30-second keepalive, because rule 3 keeps the `session` topic subscribed while hidden)* |
| Streaming | No task on the renderer's main thread longer than 50 ms while a turn streams at full speed. The paragraph being written is painted at most once per frame |
| The thread list's live updates | *(Added 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275).)* At most 16 ms of the renderer's main thread for each `session` nudge, with 500 threads in the list: one frame at 60 Hz. Past it, the list stops reading every thread again on a nudge and updates only the threads the nudge names, and [./14-web-app.md](./14-web-app.md) §Live model is amended in the same change |
| Renderer JavaScript | The JavaScript the first thread screen needs is at most 250 kB gzipped (the web app's budget), checked in CI like `scripts/check-bundle-budget.ts` |
| Main's startup | Main loads only what the first window needs, and imports everything else when it is first used. Main's startup file is at most 160 kB minified, checked in CI |

### Rules

These rules keep the budgets:

1. **The web app's six guardrails apply unchanged** ([./14-web-app.md](./14-web-app.md) §Performance guardrails):
   - the React Compiler
   - selector-based external stores, and never Context for changing data
   - every unbounded list virtualized
   - token deltas flushed at most once per animation frame
   - route-level code splitting with a CI bundle budget
   - TanStack Query for every HTTP read
2. **Nothing animates unless something is happening:**
   - Faces are drawn still in their pose everywhere. Bureau's idle blink is left out of the first milestone, because of the measurement above. It comes back once research finds a way to draw it within the idle budget (see [Post-v1](#post-v1)).
   - Only one continuous animation is allowed: the working pose of the face beside the open thread's running turn, while that turn runs. The sidebar and every other list show still poses and still marks.
   - Animations change only `transform` and `opacity`, and only of an HTML element. Chromium runs such an animation on the compositor thread alone. When the animated element is an SVG element, even an outer `<svg>`, the renderer's main thread also runs style, layout and paint on every frame: 120 times a second on a 120 Hz display. So the working pose's paws are each drawn in an `<svg>` of their own, inside a `<span>` that moves.
   - Transitions answer a user action, last at most `--dur-3`, and change only paint properties: color, background, border-color, box-shadow, opacity and transform. A transition of a layout property, such as `width`, `padding` or `grid-template-rows`, runs layout on every frame. Bureau's composer transitions some of these; slice 6 ports the composer without them, and uses a transform if its growth animates.
   - A change of appearance snaps: the page switches in one frame, with no transition, as the window's native frame does.
   - Reduce motion turns every animation off.
3. **Work stops when nobody is looking.** While the window is hidden or minimized:
   - The renderer drops the open thread's `session:<id>:tap` subscription. Chromium stops animation frames in a hidden window, so buffered token deltas would otherwise pile up without being painted. The `session:<id>:stream` rows keep the transcript current, and the tap resumes when the window is shown.
   - The `session` topic stays subscribed, because the dock badge and notifications depend on it.
   - `backgroundThrottling` stays on.
4. **No polling, and no timers while idle:**
   - Every change reaches the app through a live topic. *(Amended 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275): projects, workspaces and resources have no live topic yet. The app reads them again when the thread list names one it does not know, when a thread in a workspace being set up changes, and after a reconnect, so a rename made elsewhere shows at the next of these. [#279](https://github.com/theagenticage/hercule/issues/279) adds the topics.)*
   - A label that counts time (such as `Worked for 31s`, or a Request's `10m`) runs one timer, only while the label is on screen and the window is visible.
5. **Glass is limited.** It is allowed only on Bureau's glass surfaces: the header pills, the composer, popovers and name tags. The level is one token, `--glass-level`, and at 0 there is no blur at all. *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* At 0 the filter is `none`, not a blur of 0 pixels: Chromium draws a zero blur at the full cost of a real one. Reduce transparency is the one setting that sets the level to 0, and the app's `base.css` sets the filter to `none` with it, because `tokens.css` stays the book's copy.
6. **The first paint is cheap:**
   - Only the Latin subset of Bricolage Grotesque (131 kB) is preloaded.
   - Limelight and Recursive load the first time text uses them.
   - The V8 code cache keeps warm launches from compiling the same scripts twice.
7. **Main does no recurring work.** Main runs nothing on a timer, and it holds no data the renderer already holds.

**Verify at build time:** that a macOS window fully covered by other windows stops animation frames, as a minimized one does. Rule 3 then also covers a covered window.

**Verify at build time:** the cost of glass on the slowest Mac the app supports, before the first release. The M4 Max measurement cannot show that cost.

**Verify in the first performance pass:** whether Chromium's `--double-buffer-compositing` switch is worth it. The switch keeps two window-sized frame buffers instead of three, which saves about 20 MB in the GPU process while frames come, as they do whenever a caret blinks ([Baseline](#baseline)). It can also drop frames. The app takes the switch only if a turn streaming at full speed while the transcript scrolls drops no more frames with it than without it.

### Measuring

- **The perf script.** A script in `apps/desktop` launches the packaged app against a controller in a scratch `HERCULE_HOME`, opens the fixture thread, and reports the budget table.
  - **No tool is attached while it reads memory, CPU and wakeups.** It reads them from a plain launch of the app. An attached Playwright makes the renderer read 7 to 14 MB higher.
  - **The plain launch passes three switches:** `--inspect=0` and `--remote-debugging-port=0` open main's Node inspector and a DevTools port, which the script connects to only while it reads, and `--use-mock-keychain` lets the app read the token saved at sign-in without the real Keychain.
  - **The measured launch is the app's third.** On the second, Chromium writes its code cache, and the renderer reads about 7 MB higher.
    - *(Amended 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275).)* The measured launch starts 3 seconds after the second one quits. On a machine short of memory, macOS drops the Electron framework's pages about 15 seconds after the app quits. A launch after that reads about 70 MB from disk again and is cold: 600 to 700 ms on the reference machine. Slice 4's first runs let the fixture's work outlast those 15 seconds, and so measured cold launches against the warm budget.
    - The script prints the steps of each launch: main's Node ready, the GPU and renderer processes started, the page's start, first paint, the first screen, and the window shown. A cold launch is late from its first step.
  - **Memory is read 13 seconds after the page opens,** from outside the app. The budget limits the physical footprint, which `footprint` reports and Activity Monitor shows. The working set, the resident size `ps` reports and the number `app.getAppMetrics()` gives on macOS, is recorded beside it without a budget. It counts the Electron framework's pages, which all four processes share, once in each process, so it reads about 200 MB above the footprint however little the app holds. Slices 1 and 2 were budgeted on the working set, 420 MB summed and 180 MB for the renderer; slice 3 moved the budget to the footprint.
  - **CPU and wakeups** come from `app.getAppMetrics()`, which the script calls in main through its Node inspector, connecting only for each call. A wakeup is the kernel's count of a process's interrupt wakeups. The visible sample starts 30 seconds after the page opens, so it measures the app at rest, not the one-off timers that fire after a page loads.
  - **The script counts up to 2 renderer wakeups a second as none.** Chromium wakes an idle renderer 0 to 2 times a second on its own, with no app code running ([Baseline](#baseline)), so that is the most the budget's "no wakeups from the app" can read as.
  - *(Added 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* **The script does not yet control whether a text field is focused,** and a focused field changes both memory and wakeups ([Measured](#measured)). The new-thread composer takes focus when its screen opens, but its caret blinks only while macOS has made the app active, and whether macOS does that at a plain launch varies from launch to launch. Measuring both states on purpose, one with nothing focused and one with the composer focused through DevTools focus emulation, is part of [#301](https://github.com/theagenticage/hercule/issues/301).
  - ~~**Long tasks** come from a `PerformanceObserver` in the renderer.~~ *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* **Long tasks** come from a Chromium trace of a turn streaming into the fixture thread, recorded over the page's DevTools connection. A long task is a task on the renderer's main thread that runs over 50 ms: the page cannot react to input until it ends. The trace needs no measuring code in the app. Tracing costs the renderer a little time of its own, so the tasks err long.
- **CI checks what does not depend on the machine:**
  - the renderer bundle budget and main's startup file. While the budgets are guides, a build over one prints a warning and passes.
  - the process count. A new process fails the test, because it changes the process model, which a slice must justify.
  - ~~no long tasks while streaming the fixture, once slice 5 streams. While the budgets are guides, it only reports.~~ *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* CI does not count long tasks. How long a task runs depends on the machine: a task that runs 40 ms on the reference machine can run 80 ms on a slower one.
- **The rest is recorded by each performance pass,** in [Measured](#measured). Launch time, memory, wakeups and long tasks depend on the machine, so they are measured on the reference machine.

### Measured

**Slice 1,** measured 2026-09-29 on the reference machine with the perf script. The window shows the empty shell: the sidebar and the new-thread screen, with no controller. The load average was 7 to 12 while measuring, so launch times on a quiet machine are likely lower.

| Measure | Budget | Measured |
|---|---|---|
| Launch: spawn to first paint, warm | 500 ms | 243 to 283 ms over four runs |
| Processes | 4 | 4 |
| Memory, summed working set | 420 MB | 336 to 345 MB |
| Memory, renderer | 180 MB | 88 to 91 MB |
| Wakeups while visible and idle | renderer none; GPU at most 12 a second | renderer 0; GPU 4 a second |
| Wakeups while hidden | renderer none | renderer 0 |
| Renderer JavaScript for the first screen, gzipped | 250 kB | 84.6 kB |
| Main's bundle, minified | - | 107 kB, 37 kB gzipped |
| The preload, minified | - | 243 bytes |

- **Launch is measured without Playwright.** Playwright holds each new renderer paused until it attaches, which adds its own time to a launch. The perf script spawns the app as a plain process, and reads the page's `first-paint` entry over the Chrome DevTools Protocol once the window is on screen.
- **Slice 1's memory and wakeups were read the old way,** with Playwright attached, so they read higher than slice 2's method would give. Read from a plain launch, slice 1's renderer is about 81 MB.

**Slice 2,** measured 2026-09-29 on the reference machine with the perf script, over five runs. The window shows the signed-in shell against a controller on loopback. The load average was 5 to 13 while measuring. Sizes are counted the way the budget script counts them, 1,024 bytes to a kB.

| Measure | Budget | Measured |
|---|---|---|
| Launch: spawn to first paint, warm | 500 ms | 224 to 258 ms |
| Launch: spawn to the first screen, the signed-in shell | - | 246 to 256 ms |
| Processes | 4 | 4 |
| Memory, summed working set | 420 MB | 343 MB |
| Memory, renderer | 180 MB | 96 MB |
| Physical footprint | - | 149 to 150 MB summed; renderer 28 MB |
| Wakeups while visible and idle | renderer none; GPU at most 12 a second | renderer 0; GPU 0 |
| Wakeups while hidden | renderer none | renderer 0 |
| Renderer JavaScript for the first screen, gzipped | 250 kB | 163.1 kB |
| Main's startup file, minified | 160 kB | 136.6 kB, 45.9 kB gzipped |
| Main's controller check, loaded on first connect | - | 25.8 kB, 7.1 kB gzipped |
| The preload, minified | - | 478 bytes |

- **The renderer's JavaScript** is mostly react-dom (54 kB gzipped), Effect (49 kB), TanStack Router (17.6 kB), the contract (13.2 kB) and TanStack Query (7.4 kB). The contract brings about 3.8 kB of the runner protocol and the plugin host with it.
- **About 16 kB of main's growth is Effect Schema code that only the controller check uses.** The bundler puts each module in one chunk, and startup imports `effect/Schema` too, so that code cannot move into the check's chunk.
- **The renderer is about 15 MB above slice 1,** read the same way. Most of it is building the contract: importing it creates 2,656 Effect Schema objects, and the short-lived copies they make grow V8's young generation from 0.5 to 8 MB. V8 shrinks it again 30 to 60 seconds after load.
  - **The client builds each operation on its first call,** not all 126 when it is created. That saved about 6.5 MB and 10 ms on the first screen.
  - **Loading only the contract groups a screen calls** was prototyped and not taken. Loading only setup and auth saved about 8 MB more, but it needs one entry point per group and a client that takes groups, and the saving shrinks with each slice, because by slice 8 the app calls most groups. It is the first cut to revisit if the renderer nears its budget.
  - **A smaller young generation** (`--js-flags=--max-semi-space-size=1`) saved about 6 MB only in the first minute, and made allocation-heavy work 34 to 49% slower. Not taken.
  - **Escaping the bundle's few non-ASCII characters** saved about 1 MB. V8 stores a script with any non-ASCII character at two bytes per character. Not taken for now: it needs a build plugin, for little gain.
  - **Cheaper schema construction** is the lever left, not yet prototyped. Effect Schema's construction dominates the startup profile.

**Slice 3,** measured 2026-09-29 on the reference machine with the perf script, in one run. The window shows the signed-in shell against a controller on loopback, as in slice 2. The load average was 10.7 while measuring. From this slice on, memory is budgeted on the physical footprint ([Measuring](#measuring)).

| Measure | Budget | Measured |
|---|---|---|
| Launch: spawn to window shown, warm | 500 ms | 304 ms |
| Launch: spawn to first paint | - | 236 ms |
| Launch: spawn to the first screen, the signed-in shell | - | 292 ms |
| Processes | 4 | 4 |
| Memory, summed physical footprint | 220 MB | 155 MB: browser 48, GPU 72, network utility 7, renderer 29 |
| Memory, renderer's physical footprint | 100 MB | 29 MB |
| Working set | - | 356 MB summed; renderer 101 MB |
| Wakeups while visible and idle | renderer none; GPU at most 12 a second | renderer 0; GPU 0 |
| Wakeups while hidden | renderer none | renderer 0 |
| Renderer JavaScript for the first screen, gzipped | 250 kB | 163.8 kB |
| Main's startup file, minified | 160 kB | 137.4 kB |
| The faces, on their own, gzipped | - | 3.9 kB of JavaScript, 0.3 kB of CSS |
| The icons, on their own, gzipped | - | 1.3 kB of JavaScript, 0.1 kB of CSS |
| The marks, on their own, gzipped | - | 0.7 kB of JavaScript, 0.4 kB of CSS |
| Elements in one face, root included | - | 12 to 26, by look and pose |
| Specimen window's renderer, 91 faces and the other pieces | - | 165 MB working set, indicative |

- **No release screen draws a face, an icon or a mark yet,** so the three folders are not in the release bundle. Each size above is a library build of the folder's `index.ts` with React left out. The sidebar brings them into the first screen in slice 4.
- **A face draws one or two elements fewer than the book's,** because the port leaves out the two groups that exist only to animate: the eyes' blink group, and the waving arm's group in the waiting pose.

**Slice 4,** measured 2026-09-29 on the reference machine with the perf script, in two runs of three launches each. The window shows the signed-in shell with the sidebar, fed by a fleet of scripted runners: 40 threads, then 500. The load average was 5.8 to 9.2 while measuring.

| Measure | Budget | Measured |
|---|---|---|
| Launch: spawn to window shown, warm | 500 ms | 344 to 381 ms |
| Launch: spawn to first paint | - | 258 to 310 ms |
| Launch: spawn to the first screen, the signed-in shell | - | 332 to 370 ms |
| Processes | 4 | 4 |
| Memory, summed physical footprint | 220 MB | 194 to 203 MB with 40 threads, 201 to 208 MB with 500: browser 50, GPU 99 to 104, network utility 8, renderer 40 to 46 |
| Memory, renderer's physical footprint | 100 MB | 40 to 41 MB with 40 threads, 46 MB with 500 |
| Working set | - | 376 to 383 MB summed; renderer 115 to 123 MB |
| Wakeups while visible and idle | renderer none; GPU at most 12 a second | renderer 1 a second, which the script counts as none; GPU 0 |
| Wakeups while hidden | renderer none | renderer 0 to 1 a second |
| Age labels, 60 seconds visible | a timer only for an age on screen that shows minutes | 1 fire when the youngest age on screen is 2m; 0 when every age is over an hour |
| Age labels, 60 seconds hidden | no timer | 0 fires |
| Renderer main thread per `session` nudge, 500 threads | 16 ms | 10.7 to 11.1 ms |
| Renderer main thread per `session` nudge, 40 threads | - | 5.7 to 6.8 ms |
| Renderer CPU and controller CPU per nudge, 500 threads | - | 19.5 ms and 29.5 ms |
| Thread list reads per nudge | - | 1 |
| Renderer JavaScript for the first screen, gzipped | 250 kB | 209.1 kB |
| Main's startup file, minified | 160 kB | 137.6 kB |
| Elements in the sidebar's list, one project expanded | - | 287 with 40 threads, 298 with 500 |
| A Request opening, to its Waiting on you row on screen | - | 24 ms |

- **The sidebar brings 39 to 53 MB over slice 3's footprint:** the GPU process reads 27 to 32 MB higher, and the renderer 11 to 17 MB. What in the GPU process grew is not measured yet. The summed footprint has 12 to 26 MB left under its budget for slices 5 to 8.
- **The list draws only the rows on screen,** so 500 threads cost 11 elements more than 40.
- **The figures per nudge err high.** Each is the time over 20 nudges divided by 20, idle time included.
- **The fixture writes the database once.** To give its threads ages, it stops the controller, backdates `last_activity_at`, and starts it again on the same port. The threads and their states come from the fleet. The ages are at most 6 hours 31 minutes, because the lost-runner sweep ends a session on an offline runner once it is older than the 8-hour absolute timeout.
- **A launch through macOS's launcher is slower.** The budget and the table measure a launch spawned directly. `open`, which the Dock and Finder go through, adds about 100 ms: about 430 ms warm. A relaunch more than 15 seconds after quitting is cold ([Measuring](#measuring)).

**Slice 5,** measured 2026-09-30 on the reference machine with the perf script, in one run of four launches and a streamed turn. The first three launches show the new-thread screen, with 40 threads and then 500, as in slice 4. The fourth reopens a thread of 501 transcript rows, with 500 threads in the list, and the streamed turn goes into that thread. The load average was 3.7 to 13.5 while measuring.

| Measure | Budget | Measured |
|---|---|---|
| Launch: spawn to window shown, warm | 500 ms | 318 to 345 ms on the new-thread screen; 421 ms with the long thread open |
| Launch: spawn to the last open thread's transcript painted | 800 ms | 409 ms |
| Launch: spawn to first paint | - | 249 to 289 ms |
| Processes | 4 | 4 |
| Memory, summed physical footprint | 220 MB | 201 to 211 MB with no thread open; **370 MB with the long thread open**: browser 47, GPU 253, network utility 8, renderer 62 |
| Memory, renderer's physical footprint | 100 MB | 43 to 49 MB with no thread open; 62 MB with the long thread open |
| Working set | - | 378 to 386 MB summed with no thread open, 423 MB with the long thread open; renderer 119 to 148 MB |
| Wakeups while visible and idle | renderer none; GPU at most 12 a second | renderer 1 a second, which the script counts as none; GPU 0 |
| Wakeups while hidden | renderer none | renderer 1 a second |
| Age labels, 60 seconds visible | a timer only for an age on screen that shows minutes | 1 fire when the youngest age on screen is 2m; 0 when every age is over an hour |
| Age labels, 60 seconds hidden | no timer | 0 fires |
| Renderer main thread per `session` nudge, 500 threads | 16 ms | 12.5 ms; 13.4 ms with the long thread open |
| Renderer main thread per `session` nudge, 40 threads | - | 5.3 to 5.7 ms |
| Renderer CPU and controller CPU per nudge, 500 threads | - | 22.5 to 24.5 ms and 31.0 to 35.5 ms |
| Streaming at full speed: the longest task on the renderer's main thread | 50 ms | 14.7 ms |
| Streaming at full speed: writes to the paragraph being written | at most one a frame | 1,175 in 2,424 frames |
| Renderer JavaScript for the first screen, the thread's route included, gzipped | 250 kB | **282.1 kB** |
| Main's startup file, minified | 160 kB | 137.6 kB |

- **The streamed turn** is a word every 2 ms for 10 seconds, sent by a scripted runner. It is faster than any real agent, so a frame always has new words to paint.
- **The long thread's GPU memory puts the summed footprint over its budget.** The GPU process reads 253 MB with the long thread open, against 100 to 115 MB with no thread open. A probe turned each effect off in turn, with the long thread open:

  | Change | GPU footprint |
  |---|---|
  | none | 242 to 243 MB |
  | no glass blur | 222 MB |
  | no top fade on the transcript | 208 MB |
  | neither | 135 MB |
  | the transcript hidden | 175 MB |

  - The blur is the glass `backdrop-filter` on the composer, the Requests dock, the queued inputs and the header's pills. The fade is the transcript's `mask-image`, which fades it in below the header.
  - Together they cost about 108 MB with the long thread open, and about 63 MB with a thread of 2 rows. A thread of 2 rows already reads about 293 MB summed.
  - **Accepted for the first prototype** (decided 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275)): the thread is drawn as the book draws it, blur and fade included, and the summed footprint stays over its budget. The budget is not raised. A later performance pass brings the footprint under it.
- **The first screen's JavaScript is 32 kB over its guide.** The chunks loaded at first paint are 219 kB, 10 kB more than slice 4's first screen. The thread's route adds 63 kB, and about 48 kB of that is the markdown parser: `react-markdown`, `remark-gfm` and `remark-breaks`, measured alone in a production build. The shared chunk that holds React DOM is named after the thread's route, `_sessionId-*.js`, because the thread's route is one of the modules that use it; it is not the thread's code.
  - **Handed to [#295](https://github.com/theagenticage/hercule/issues/295)** (decided 2026-09-30): both apps parse markdown with marked's lexer, about 34 kB smaller, and draw it as React elements. Until then, the overrun is accepted for the first prototype, like the footprint's.

**The first milestone's finish,** measured 2026-09-30 on the reference machine with the perf script, after slice 8, in one run of four launches and a streamed turn, as in slice 5. The load average was 3.4 to 10.7 while measuring. In the two launches with 40 threads, the new-thread composer's caret was blinking; in the other two, nothing was focused ([Measuring](#measuring)).

| Measure | Budget | Measured |
|---|---|---|
| Launch: spawn to window shown, warm | 500 ms | 361 to 410 ms on the new-thread screen; 368 ms with the long thread open |
| Launch: spawn to the last open thread's transcript painted | 800 ms | 363 ms |
| Launch: spawn to first paint | - | 235 to 307 ms |
| Processes | 4 | 4 |
| Memory, summed physical footprint, nothing focused | 220 MB | **306 MB** on the new-thread screen with 500 threads; **371 MB** with the long thread open: browser 51, GPU 246, network utility 8, renderer 66 |
| Memory, summed physical footprint, the composer focused | 220 MB | **694 and 696 MB** on the new-thread screen with 40 threads: browser 53 to 55, GPU 589, network utility 8, renderer 44 to 45 |
| Memory, renderer's physical footprint | 100 MB | 44 to 53 MB on the new-thread screen; 66 MB with the long thread open |
| Working set | - | 393 to 410 MB summed on the new-thread screen, 428 MB with the long thread open; renderer 123 to 149 MB |
| Wakeups while visible and idle, nothing focused | renderer none; GPU at most 12 a second | renderer 1 a second, which the script counts as none; GPU 2 |
| Wakeups while visible and idle, the composer focused | renderer at most 4 a second; GPU at most 63 | **renderer 5; GPU 65 and 66** |
| Wakeups while hidden | renderer none | renderer 0 to 1 a second |
| Age labels, 60 seconds visible | a timer only for an age on screen that shows minutes | 1 fire when the youngest age on screen is 2m; 0 when every age is over an hour |
| Age labels, 60 seconds hidden | no timer | 0 fires |
| Renderer main thread per `session` nudge, 500 threads | 16 ms | 10.3 ms; 13.1 ms with the long thread open |
| Renderer main thread per `session` nudge, 40 threads | - | 5.0 to 8.2 ms |
| Renderer CPU and controller CPU per nudge, 500 threads | - | 19.0 to 24.5 ms and 21.5 to 30.5 ms |
| Streaming at full speed: the longest task on the renderer's main thread | 50 ms | 15.6 ms |
| Streaming at full speed: writes to the paragraph being written | at most one a frame | 1,161 in 2,369 frames |
| Renderer JavaScript for the first screen, the thread's route included, gzipped | 250 kB | **300.3 kB**: 240.8 kB at first paint, 59.5 kB for the thread's route |
| Main's startup file, minified | 160 kB | 150.2 kB |

- **A focused text field is what puts the new-thread screen 400 MB over.** The launches with 40 threads read about 390 MB more than the one with 500 on the same screen, all of it in the GPU process. Probes in one session, turning one thing off at a time, found the cause:
  - The glass blur's `backdrop-filter` makes Chromium create render surfaces. With those on screen, macOS cannot take the page's layers as overlays, so Chromium composites every frame itself.
  - While frames keep coming, macOS holds 400 to 470 MB of GPU driver memory for that, and cannot purge it. A blinking caret keeps frames coming, as do typing and a streaming turn. When the frames stop, the footprint drops within about 5 seconds.
  - One blurred element on screen is enough. With the composer focused, the GPU process read 585 MB as drawn, 403 MB without the composer's blur, and 107 MB with no blur anywhere.
- **The focused field's wakeups are Chromium's.** An empty Electron window with one focused text field reads 62 to 63 GPU wakeups a second and 4 in the renderer, so the app adds about 3 and 1. The new budget row for a focused field sets the empty window's reading as the limit.
- **Accepted for the first prototype** (decided 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275)): the app keeps the book's glass, and the summed footprint stays over its budget, far over with a field focused. The budget is not raised. [#301](https://github.com/theagenticage/hercule/issues/301) decides between keeping the blur and avoiding its cost, and drawing the persistent surfaces solid.
- **Reduce transparency still drew a blur, and now draws none.** It sets `--glass-level` to 0, which computed to `backdrop-filter: blur(0px) saturate(1)`. That changes no pixel, but Chromium still drew a backdrop filter for it, at the full 587 MB, against rule 5's "no blur at all". Reduce transparency now also sets the filter to `none`, and an end-to-end test checks it.
- **The first screen's JavaScript grew by 18 kB over slices 6 to 8,** to 50 kB over its guide. [#295](https://github.com/theagenticage/hercule/issues/295) still holds the markdown parser, the largest part of the overrun.

## Slices

Each slice is a reviewable change. The performance budgets guide it and do not gate it ([Performance](#performance)).

1. **Shell and safety.**
   - the `apps/desktop` package
   - `tokens.css` and the font files, because the window's background needs `--bg` in both appearances
   - the `app` scheme and the CSP
   - the security baseline
   - the window: title bar, no flash, theme, remembered state, single instance
   - the IPC contract
   - the dep-lint rules
   - the perf script, and the baseline measured again in the real shell
   - the first end-to-end test
2. **Connect and sign in.**
   - CORS on the controller
   - the connect screen
   - the stored token
   - sign in and sign out. Sign Out lives in the app menu, so this slice brings forward the Sign Out item and the `menu.command` channel. The rest of the menu stays in slice 8.
   - the refused arguments
3. **Design foundation.**
   - font preloading
   - faces, poses, icons and marks as typed modules
   - the live theme
   - the screenshot comparison tool, run on the pieces: slice 3 draws no screen that a Bureau page shows
4. **Sidebar.** Waiting on you, New thread, and threads grouped by project and workspace, kept live.
5. **Thread view.**
   - the transcript and streaming. ~~`transcript.read` returns the whole transcript, with no paging.~~ *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275): `transcript.read` has pages of up to 500 rows since slice 2. The app reads every page in order before it draws the thread, as the web app does.)* A performance pass measures a long thread.
   - ~~turn dividers~~ work stretch dividers *(amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275), see **The thread** in [Design system](#design-system))* and markdown
   - the Requests dock
   - queued inputs, with Steer and Cancel
   - the composer drawn inert, at its full size, so the dock and the queued inputs sit where they will stay *(added 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275))*
6. **The composer on an active thread.**
   - send, steer and queue, stop
   - the model and its options, which stay live
7. **New threads.**
   - the project picker and the Draft Thread
   - the pickers, with the local-runner probe through main
   - starting the thread
8. **Menu and notifications.** The menu, shortcuts, dock badge and notifications.

## Testing

- **Unit tests** sit next to the code they test (AGENTS.md §Source layout). They cover:
  - main's logic
  - decoding against the IPC contract
  - that a face's seed always gives the same face
- **Renderer component tests** work as they do in `apps/web`.
- **End-to-end tests** live in `e2e/desktop/`. They use Playwright's Electron driver to launch the test package (see [Security baseline](#security-baseline)) against the compiled `hercule` binary, in a scratch `HERCULE_HOME`. Each slice adds at least one. They run the production origin, so they cover the CORS path. CI runs them on macOS, the target platform.
  - Each launch passes `--user-data-dir=<scratch dir>`, so the settings file, the token and the single-instance lock never touch the real app's.
  - Each launch passes `--use-mock-keychain`, so no test touches the real Keychain.
  - Each launch removes `ELECTRON_RUN_AS_NODE` and every `HERCULE_*` variable from Electron's environment.
- **Screenshots.** Every slice takes light and dark screenshots of its screens, and they are compared with the Bureau pages before review.
  - *(Added 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275).)* `pnpm --filter @hercule/desktop capture:sidebar-states` captures the sidebar states the book never draws, in both themes, for a check by eye: workspace labels, offline, queued, asleep and away threads, long names, the caps and their "more" rows, and "No project". It writes them to `apps/desktop/out/sidebar-states/`.
- **The Bureau comparison.** `pnpm compare:bureau` compares the app's pieces with the book's, pixel for pixel, in Whitehaven and Orient Express. CI runs it.
  - Two sheets draw the same cells in a 1440 × 900 window: the reference sheet with the book's own `crew.js` from `docs/design/crew-bureau/`, the specimen sheet with the app's components. A cell is a face in a pose, size, shape or wardrobe, the user avatar, a mark or an icon.
  - *(Added 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275).)* It also compares the app's sidebar with the sidebar of the book's `session-active.html`, item by item, with the app fed the book's threads at the book's time.
  - *(Added 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* It also compares the app's thread screen with the main pane of the book's `session-active.html`, item by item, twice: once at rest, and once with the transcript scrolled away from its bottom and the composer shrunk. The book's page is edited where the app draws other words or marks (see **The thread** in [Design system](#design-system)).
  - *(Added 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* It also compares the app's draft screen with the main pane of the book's `session-empty.html`, item by item, with the book's page edited where the app draws other words or marks (see **A new thread** in [Design system](#design-system)).
  - Both sheets render in one Electron, hidden, at DPR 2, in sRGB, with GPU rasterization off. With GPU rasterization, a change in one cell also moved pixels in its neighbours, and the result could vary with the machine's GPU.
  - It fails first if the book's `tokens.css` or font files differ from the app's, or if any cell sits in a different place, so each pixel it reports is a drawing difference.
  - The comparison is exact: no tolerance, on every channel of every device pixel. It writes the reference, the app's capture and a diff image to `apps/desktop/out/bureau-compare/`.
  - The specimen sheet is served only by the dev server. The release build never bundles it, and an eslint rule forbids importing it.
- **The first-frame check.** `apps/desktop/scripts/first-frame.ts` records the window with ScreenCaptureKit as macOS first puts it on screen, and checks that it already holds the whole first screen, focus ring included, for the sign-in screen and the shell in both themes. Re-run it after every Electron upgrade. It rests on Chromium behaviour no other test covers, and an upgrade can change any of it:
  - a hidden window still draws and presents its page's frames;
  - an Element Timing entry's `renderTime` is when its frame was presented, or failed to present;
  - `show()` shows the frame the window holds, not an empty one.
- **The check commands.** The four check commands (AGENTS.md §Check commands) cover `apps/desktop` like every other package.

## Post-v1

The desktop app is itself post-v1 in [./01-overview-and-scope.md](./01-overview-and-scope.md). These are what later milestones add after the first:

- **The Hercule face and its screens:** Intake, Check-in, Tasks, Runs, Workflows, Fleet, Connections and Notifications. Bureau adds the office to them.
- **Assistants,** with the book's stored look (Spec change 3) and a run that wears its workflow's face (Spec change 4).
- **All sessions and Settings,** including Appearance: Bureau's five themes, System, and the glass level.
- **The desktop app as installer:** it runs and upgrades a local controller ([./15-packaging-and-operations.md](./15-packaging-and-operations.md) §Post-v1).
- **The idle blink, back.** Bureau's idle blink returns once research shows how to draw it within the idle budget. Bureau draws it as an animation that repeats every 7.2 seconds on the SVG group of each face's eyes. The eyes move for only about 0.2 seconds of that, but Chromium draws frames for the whole 7.2 seconds. And because an SVG group is animated on the renderer's main thread, the renderer wakes for every frame. Techniques to measure:
  - one shared timer that starts a single 0.2-second blink on one face at a time, so frames are drawn only while an eye is actually closing
  - eyes drawn in their own compositor layer, so a blink never wakes the renderer's main thread
  - blinking only faces in view, and only while the window has focus
- **Auto-update.**
- **Several controllers.**
- **Windows and Linux.** Main keeps the platform calls in one place so they can be swapped.
- **Destroying the renderer when the window closes,** while main keeps a light watch for the dock badge and notifications. This is a candidate if measurements show that the hidden renderer's memory matters. In the first milestone, closing the window hides it ([Native behaviour](#native-behaviour)).

## Sources

Tickets:

- [Desktop app: threads in Crew Bureau (#275)](https://github.com/theagenticage/hercule/issues/275)
- [Web app architecture: observability-first, desktop-shell-ready (#19)](https://github.com/theagenticage/hercule/issues/19)

ADRs:

- [ADR 0037 - The desktop app is its own Electron client of the public API](../adr/0037-the-desktop-app-is-its-own-electron-client-of-the-public-api.md)
- [ADR 0017 - The web app is a static pure client of the public API](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)
- [ADR 0031 - The backend is written on Effect](../adr/0031-the-backend-is-written-on-effect.md)
- [ADR 0027 - A decision resolves when its question is answered, wherever](../adr/0027-a-decision-resolves-when-its-question-is-answered-wherever.md)

Prototype: the Crew Bureau book, [`docs/design/crew-bureau/index.html`](../design/crew-bureau/index.html).
