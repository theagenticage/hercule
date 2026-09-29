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

**Status:** locked 2026-09-29 for [Desktop app: threads in Crew Bureau (#275)](https://github.com/theagenticage/hercule/issues/275), with [ADR 0037](../adr/0037-the-desktop-app-is-its-own-electron-client-of-the-public-api.md). Slice 1 is built. Slices 2 to 8 are not.

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
- **One instance.** A second launch focuses the running window and exits (`app.requestSingleInstanceLock`).
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
- **Main checks the URL.** Main calls `setup.read` on it through the contract's client. This is main's one call to the controller: the renderer cannot make it, because its CSP (below) names only the controller it is connected to.
  - The URL is not a Hercule controller: the connect screen says so, and nothing is saved.
  - The controller's setup is not complete: the app says so and opens `<url>/setup` in the default browser. The desktop app is not the installer yet.
  - The check passes: main saves the URL and reloads the window, so the new CSP names the new controller.
- **Changing controllers.** Changing the controller deletes the stored token (see [Auth and the token](#auth-and-the-token)).

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

`detectLocalRunner(runners, fetch)` in `client-core` takes the `fetch` it probes with. The desktop app passes a `fetch` that asks main through the bridge.

- **Main makes the request.** It sends only `GET http://127.0.0.1:<port>/identity`, and refuses any other host, method or path.
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
- **It is stored together with the controller URL it belongs to,** so one controller's token is never sent to another. Connecting to a different controller deletes it.
- **At boot,** the renderer reads the token once through the bridge, before it creates the client. Its `TokenStore` then reads from memory, and each write is sent to main.
- **Logout and the first 401 remove it,** as on the web.
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

## The IPC contract

`apps/desktop/src/ipc` declares every channel in Effect Schema: its name, its request and its response.

- Main decodes each request against it.
- The preload exposes one typed function per channel, on one object in the renderer's world: `window.bridge`.
  - A renderer → main channel `a.b` is called as `window.bridge.a.b(request)` and returns a promise of the response.
  - A main → renderer channel is declared in a second table. The bridge exposes it as a subscription: `thread.open` becomes `window.bridge.thread.onOpen(listener)`, which returns a function that unsubscribes. The preload passes the listener only the decoded payload, never Electron's IPC event object.
- Nothing else crosses between the layers.

The first milestone's channels:

| Channel | Direction | Purpose |
|---|---|---|
| `token.read` / `token.write` | renderer → main | the stored token (see [Auth and the token](#auth-and-the-token)) |
| `controllerUrl.read` / `controllerUrl.save` | renderer → main | the saved controller URL; checking a new one and saving it. Not the public API's `controller.read`, which describes the controller itself |
| `runnerIdentity.read` | renderer → main | the local-runner probe |
| `badge.set` | renderer → main | the dock badge count |
| `notification.show` / `notification.close` | renderer → main | a thread's notification, keyed by session id |
| `link.open` | renderer → main | opening an `http:` or `https:` link in the default browser |
| `thread.open` | main → renderer | a notification click or a menu shortcut asks for a thread |
| `menu.command` | main → renderer | a menu item the renderer carries out, such as New Thread or Send |

A new channel is added to the contract, and to this table, in the same change.

## Native behaviour

Each item below is an acceptance criterion. The end-to-end test checks it where it can.

- **Title bar:**
  - `titleBarStyle: "hiddenInset"`, with the traffic lights sitting in the sidebar's top strip.
  - `trafficLightPosition: { x: 19, y: 16 }` puts the native lights where the Bureau pages draw them: centres at 26, 46 and 66 pt from the left, 24 pt from the top. The renderer draws no lights of its own.
  - The sidebar's top strip and the thread's chrome row are drag regions. The controls inside them are not.
- **No flash:**
  - The window is created hidden, with `backgroundColor` set to `--bg` of the current appearance: `#f4f3f0` for Whitehaven and `#1a1310` for Orient Express. These are the sRGB values Chromium draws for the `oklch` tokens, and a unit test derives them from `tokens.css`.
  - It is shown on `ready-to-show`.
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
- **The last open thread reopens at launch.**
- **Menu:**
  - The standard app, Edit and Window menus, so text editing shortcuts work in every field.
  - File › New Thread `⌘N`.
  - Thread › Send `⌘↵`.
  - Go › the first nine threads of the sidebar, `⌘1` to `⌘9`, in sidebar order.
  - While the project picker is open, `⌘1` to `⌘9` pick a project instead, as spec 14 says.
  - Sign Out, in the app menu.
- **Dock badge:** the number of threads waiting on you. A thread waits on you while its session has an open Request (`Session.openRequest`, [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)).
- **Notifications:**
  - When a thread starts waiting on you and the window is not focused, main shows a native notification.
  - Clicking it focuses the window and opens the thread.
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

**The pixel reference.** The pixel reference is the Crew Bureau book and its desktop pages: `prototype/design-systems-2/c1-bureau/` on `prototype/design-systems`, at a130074e.

- Where this text and the pages disagree, the pages decide a measurement and this text decides a behaviour. This is spec 14's rule for its prototypes.
- Behaviour comes from [./14-web-app.md](./14-web-app.md): §App shell (the Threads face), §The thread surface, and §The composer is the thread's configuration.

**Where Bureau changes a behaviour, the desktop follows Bureau.** The changes the first milestone takes from the book's Spec section:

1. **Waiting on you tops the sidebar,** above the threads. The first milestone has only the Threads face, so the section sits at the sidebar's top.
2. **No monospace outside code.** Monospace is kept for code, commands and diffs. Spec 14's monospace time separators, workspace labels and branch values use the UI face.
3. **Six marks.** Queued, cancelled and skipped lose their marks and become words.

**A thread's face is seeded by its session id,** not by its title. The book derives a face from a name. A thread's title is written by the agent after the first message and can change, and a face must not change when its title does. The book's stored look (its Spec change 3) is for workflows and assistants, and arrives with them.

**How the system is carried over:**

- **Kept as they are:** `tokens.css` and the font files. They are the design system's source. Token names match the web app's (`--bg`, `--surface`, `--raised`, `--ink`, `--muted`, `--faint`, `--line`, `--line-soft`), except that `--attn` becomes `--you` / `--you-ink`.
- **Rebuilt one component at a time:** `system.css` is never copied whole. Each React component takes the rules it needs, so no CSS ships that no component uses.
- **Rewritten as typed modules:** `crew.js` becomes typed modules for faces, poses, icons and marks. Components render their SVG as React elements, never through `innerHTML`.
- **Self-hosted fonts:** fonts are served from the app bundle, and nothing is fetched from a third party.
  - Bricolage Grotesque is the UI face.
  - Limelight is used only for the wordmark and numerals.
  - Recursive is used only for code.

## Performance

**Performance and resource use come first in every desktop decision.**

- **Before a slice is built,** its plan states what it will cost and how that cost is measured: processes, memory, work while idle, work per streamed token, and bundle bytes.
- **After it is built,** the measurement is recorded in this section.
- **A slice that misses a budget does not merge.**
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

What the numbers show:

- **Idle faces are not free.** Bureau starts each face's blink at a different time, so with 40 faces on screen one of them is almost always blinking. That keeps the GPU process awake about 16 times as often as a still page, and wakes the renderer about 30 times a second while nothing happens.
- **Glass costs almost nothing on this machine.** Composer glass while streaming measured within noise of no glass.

### Budgets

The reference setup:

- the machine above
- the packaged app
- a controller on loopback
- a thread with 500 transcript rows open

These are starting budgets. Slice 5 measures the real thread screen, and each budget then comes down to the measurement plus 10%.

| Budget | Limit |
|---|---|
| Launch | The window shows within 500 ms of spawn (warm), and the last open thread's transcript paints within 800 ms |
| Processes | The four of the baseline. No hidden windows, and no workers unless a slice justifies one |
| Memory | Summed working set at most 420 MB, and the renderer at most 180 MB |
| Idle, window visible, no thread working | Renderer: no wakeups from the app except the live connection's 30-second keepalive. GPU: at most 12 wakeups a second, the still-page level |
| Idle, window hidden or minimized | Renderer: no wakeups from the app |
| Streaming | No task on the renderer's main thread longer than 50 ms while a turn streams at full speed. The tail paints at most once per frame |
| Renderer JavaScript | The JavaScript the first thread screen needs is at most 250 kB gzipped (the web app's budget), checked in CI like `scripts/check-bundle-budget.ts` |
| Main's startup | Main loads only what the first window needs, and imports everything else when it is first used |

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
   - Animations change only `transform` and `opacity`.
   - Reduce motion turns every animation off.
3. **Work stops when nobody is looking.** While the window is hidden or minimized:
   - The renderer drops the open thread's `session:<id>:tap` subscription. Chromium stops animation frames in a hidden window, so buffered token deltas would otherwise pile up without being painted. The `session:<id>:stream` rows keep the transcript current, and the tap resumes when the window is shown.
   - The `session` topic stays subscribed, because the dock badge and notifications depend on it.
   - `backgroundThrottling` stays on.
4. **No polling, and no timers while idle:**
   - Every change reaches the app through a live topic.
   - A label that counts time (such as `Worked for 31s`, or a Request's `10m`) runs one timer, only while the label is on screen and the window is visible.
5. **Glass is limited.** It is allowed only on Bureau's glass surfaces: the header pills, the composer, popovers and name tags. The level is one token, `--glass-level`, and at 0 there is no blur at all.
6. **The first paint is cheap:**
   - Only the Latin subset of Bricolage Grotesque (131 kB) is preloaded.
   - Limelight and Recursive load the first time text uses them.
   - The V8 code cache keeps warm launches from compiling the same scripts twice.
7. **Main does no recurring work.** Main runs nothing on a timer, and it holds no data the renderer already holds.

**Verify at build time:** that a macOS window fully covered by other windows stops animation frames, as a minimized one does. Rule 3 then also covers a covered window.

**Verify at build time:** the cost of glass on the slowest Mac the app supports, before the first release. The M4 Max measurement cannot show that cost.

### Measuring

- **The perf script.** A script in `apps/desktop` launches the packaged app against a controller in a scratch `HERCULE_HOME`, opens the fixture thread, and reports the budget table. Memory, CPU and wakeups come from `app.getAppMetrics()`. Long tasks come from a `PerformanceObserver` in the renderer.
- **CI gates what does not depend on the machine:**
  - the renderer bundle budget
  - the process count
  - no long tasks while streaming the fixture
- **The rest is recorded per slice,** in [Measured](#measured). Launch time, memory and wakeups depend on the machine, so they are measured on the reference machine.

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
- **The wakeups are an upper bound.** The perf script samples them through Playwright, which keeps a connection to main open. Sampled with `top` on the release package started without Playwright, all four processes showed 0 wakeups a second.

## Slices

Each slice is a reviewable change. Its plan states its performance cost first ([Performance](#performance)).

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
   - sign in and sign out
3. **Design foundation.**
   - font preloading
   - faces, poses, icons and marks as typed modules
   - the live theme
   - the screenshot comparison against the Bureau pages
4. **Sidebar.** Waiting on you, New thread, and threads grouped by project and workspace, kept live.
5. **Thread view.**
   - the transcript and streaming
   - turn dividers and markdown
   - the Requests dock
   - queued inputs
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
  - Each launch removes `ELECTRON_RUN_AS_NODE` and every `HERCULE_*` variable from Electron's environment.
- **Screenshots.** Every slice takes light and dark screenshots of its screens, and they are compared with the Bureau pages before review.
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

Prototype: the Crew Bureau book, `prototype/design-systems-2/c1-bureau/index.html` on `prototype/design-systems` at a130074e.
