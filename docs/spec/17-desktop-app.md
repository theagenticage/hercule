# Desktop app

The desktop app is a macOS app built on Electron and drawn in the Crew Bureau design system. Like the web app, it is an ordinary client of the public API, with no privileged path ([ADR 0037](../adr/0037-the-desktop-app-is-its-own-electron-client-of-the-public-api.md), [ADR 0017](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)). It shares the contract and `client-core` with the web app, and nothing else.

This document covers:

- the process model and the packages
- how the renderer reaches the controller, and how the token is stored
- the Electron security baseline and the IPC contract
- the native behaviour the app must have
- the design system
- the first milestone's screens, the Office among them
- the performance budgets and rules
- the slices and the tests

What a thread does - its sidebar, its transcript, its composer, its Requests - is owned by [./14-web-app.md](./14-web-app.md). This document owns how the desktop app draws that behaviour, and what the desktop adds.

**Status:** locked 2026-09-29 for [Desktop app: threads in Crew Bureau (#275)](https://github.com/theagenticage/hercule/issues/275), with [ADR 0037](../adr/0037-the-desktop-app-is-its-own-electron-client-of-the-public-api.md). Slices 1 to 8 are built, ~~except the `link.open` channel (see [The IPC contract](#the-ipc-contract))~~ and the `link.open` channel is built with the first run *(amended 2026-10-02, [A first run in the desktop app that needs no browser and no terminal (#313)](https://github.com/theagenticage/hercule/issues/313), which adds [The first run](#the-first-run))*. *(Amended 2026-10-03, [Office v1 in the desktop app (#332)](https://github.com/theagenticage/hercule/issues/332).)* Slice 9 adds [the Office](#the-office). *(Amended 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* Slices 11 to 19 add [Settings](#settings). *(Amended 2026-10-06, [Desktop app: an assistant's Conversation in Crew Bureau (#448)](https://github.com/theagenticage/hercule/issues/448).)* Slices 20 to 22 add [the assistant](#design-system). *(Amended 2026-10-10, [Write the Intake changes and the build tickets that replace #91 (#395)](https://github.com/theagenticage/hercule/issues/395).)* Slice 24 adds [the Hercule face](#the-hercule-face), slices 25 to 35 add [Intake](#intake), and slice 36 reopens the last screen at launch.

## Scope of the first milestone

The first milestone is threads, in a native shell:

- the sidebar's Threads face, with Waiting on you at the top
- a thread: its live transcript, its Requests and its queued inputs
- the composer on an active thread
- starting a new thread: the project picker, the Draft Thread and the composer's pickers
- connecting to a controller, and signing in and out
- the native behaviour below: the window, the menu and shortcuts, the dock badge and notifications

Everything else comes later (see [Post-v1](#post-v1)). That includes ~~the Hercule face and its screens,~~ the Hercule face's other screens *(amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395))*, ~~assistants,~~ All sessions, ~~Settings,~~ the desktop app as installer, and Windows and Linux.

*(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* The first run moves into v1: from "the app is installed" to a first thread, with no browser and no terminal ([The first run](#the-first-run)). It brings three pieces with it:

- a still room, a subset of the Office that the first run furnishes step by step;
- logging in to a provider, which the draft's Log in button also opens;
- creating a project from a folder, which the project picker's New project row also opens.

~~The live Office stays post-v1, and so does the app installing or updating Hercule's binary.~~ The app installing or updating Hercule's binary stays post-v1 *(amended 2026-10-03, [#332](https://github.com/theagenticage/hercule/issues/332): the live Office no longer does)*. `install.sh` still puts the binary and the app on the Mac ([./15-packaging-and-operations.md](./15-packaging-and-operations.md) §1); the app only runs that binary.

*(Amended 2026-10-03, [Office v1 in the desktop app (#332)](https://github.com/theagenticage/hercule/issues/332).)* The Office moves into v1: the user's threads as colleagues at work in a 3D Bureau office, quiet enough that no fan spins ([The Office](#the-office)). The first run's room stays the still 2D drawing it is.

*(Amended 2026-10-04, [Write the Settings port into spec 17, and its build tickets (#402)](https://github.com/theagenticage/hercule/issues/402).)* Settings moves into v1, as a port of the web app's Settings drawn in Bureau, with an Appearance page the web app does not have ([Settings](#settings)). Providers stays out until the provider remodel ([#406](https://github.com/theagenticage/hercule/issues/406)).

*(Amended 2026-10-06, [Desktop app: an assistant's Conversation in Crew Bureau (#448)](https://github.com/theagenticage/hercule/issues/448).)* Assistants move into v1: the sidebar lists them, and an assistant's Conversation opens in the main pane ([The assistant](#design-system) under Design system). It is a port of the web's conversation screen, and adds no operation to the public API. The stored look stays post-v1, and so do memory, reminders and channels.

*(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#394](https://github.com/theagenticage/hercule/issues/394), [#512](https://github.com/theagenticage/hercule/issues/512).)* The Hercule face and Intake move into v1. Intake is the list of what a source or an agent asks of the user, and it needs a way in; the way in is the sidebar's second face, which [./14-web-app.md](./14-web-app.md) §App shell already settled and the book draws ([The Hercule face](#the-hercule-face), [Intake](#intake)). The face's other screens stay post-v1: Check-in, Tasks, Runs, Workflows and Notifications.

## Architecture

### Process model

The desktop app has three layers. Each has one job.

| Layer | Runs | Owns | Written with |
|---|---|---|---|
| main | Node, in Electron's browser process | the window, the app menu, the `app` scheme and its files, the stored token and settings, notifications, the dock badge, external links, the local-runner probe; for the first run, running the `hercule` binary, the login shell that reads `PATH`, the folder dialog and `git` *(amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313))* | Effect 4 ([ADR 0031](../adr/0031-the-backend-is-written-on-effect.md)) |
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
  - *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* The first run adds no call to the controller: it reuses that check. It does add commands main runs on this Mac: the `hercule` binary, the user's login shell once to read `PATH`, and `git` once per folder picked ([The first run](#the-first-run)). Main links no new package for them, and reads no file in the Hercule Home.

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
  - *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* **A setup URL is the one exception.** That is the address `hercule setup-url` prints, `<origin>/setup?token=<token>`. Main splits it into the origin and the token, checks and saves the origin as above, and keeps the token in memory to hand it to the first run once ([Where the setup token comes from](#the-first-run)). The token is never written to disk. The split lives once in main, and both the connect screen and the first run's remote screen use it.
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
    - The controller's setup is not complete: ~~the app says so and opens `<url>/setup` in the default browser. The desktop app is not the installer yet.~~ main saves the URL and reloads the window, and the app opens [the first run](#the-first-run) on that controller, at its account step. No browser opens *(amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313))*.
    - Otherwise the check passes: main saves the URL and reloads the window, so the new CSP names the new controller.
- **A controller that is down at launch** shows the connect screen, with the saved URL and the "could not reach" line. Connecting checks again. *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* This holds only when a URL is saved. With no saved URL, the app shows the first run's welcome instead of the connect screen ([The first run](#the-first-run)).
- **A controller that does not answer at launch** is treated as down after 5 seconds. A connection can be accepted and never answered, and neither Chromium nor the client gives up on its own. While the app waits, and only once the wait is noticeable, it shows the lockup, "Connecting to `<url>`…", and a Change button that leads to the connect screen.
- **Every request the renderer sends gives up after 5 seconds,** for the same reason, and reports the controller as unreachable. The 5 seconds cover the whole answer, body included, so a controller that sends the headers and then stalls is unreachable too. *(Amended 2026-10-08, [#465](https://github.com/theagenticage/hercule/issues/465).)* `attachment.create` and `attachment.readContent` get a limit of 120 seconds, because each carries an image of up to 10 MiB and the 5 seconds cover the whole body, which a slow link cannot move in 5 seconds. Two operations wait longer on a healthy controller: `session.input` and `input.steer` wait up to 10 seconds for the runner to confirm the message. ~~Slice 6, which adds the composer, gives those two a limit above that wait.~~ *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275): slice 5 gives those two a limit ~~of 15 seconds~~ above that wait, because its queued rows already steer.)* *(Amended 2026-10-08, [#465](https://github.com/theagenticage/hercule/issues/465).)* An input with images waits up to 2 minutes longer, while the runner downloads them, so the limit for those two follows `MAX_INPUT_ANSWER_WAIT` from `@hercule/contract` (10 seconds plus 2 minutes) and sits above it. A limit shorter than the controller's own wait would report a failure for a message that still arrives, and a user who sends it again would send it twice.
- ~~**Onboarding is left to the browser.** Setup and onboarding both happen in the web app, before anyone connects the desktop app, so the desktop app has no onboarding step.~~ **The desktop app sets Hercule up itself** *(amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313))*. Its first run starts Hercule on this Mac, or connects to Hercule on another machine, and then runs setup and onboarding in the app, with no browser and no terminal ([The first run](#the-first-run)). A user who set Hercule up on the web never sees it: the app shows sign-in.
- **Changing controllers.** Changing the controller deletes the stored token (see [Auth and the token](#auth-and-the-token)).
- **A screen that fails** *(added 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275))* shows spec 14's "This screen did not load" screen ([./14-web-app.md](./14-web-app.md), the row "A screen that threw while rendering"), with the failure's own message. It covers a read that fails as well as a render that throws. It differs from the web app's in two ways:
  - It offers **Try again**, which loads every route on screen again, instead of Go to Sessions: the desktop app has no Sessions screen. While the routes load, the button reads "Trying again…" and ignores presses.
  - When the shell itself failed, the screen fills the window, and its foot reads "Controller at `<url>`" with the Change button that leads to the connect screen. It does not say "Connected to", because the failure may be that the controller stopped answering.

### The first run

*(Added 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* The first run takes a new user from "the app is installed" to a first thread, with no browser and no terminal. It decides what this Mac runs, then runs four steps in order: account, providers, GitHub and project. It ends on All set and a draft thread.

- **The pixel reference** is the prototype `docs/design/crew-bureau-2/desktop/first-run.html` and the book's First run chapter ([Design system](#design-system)). Variant B, "Grand opening", is the one built: the Office fills the window under a glass card. Variant A is the fallback. Every state in the prototype's state menu is built, and the prototype's copy is the copy to ship, except where this section says otherwise.
- **When it shows.** At launch with no saved URL, the app opens on the first run's welcome. When the connect check finds that setup is not complete, the app opens the first run at the account step. When the app's settings file says a first run is in progress for the saved controller, the app resumes it (see **Where the first run keeps its place** below).
- **Its own chunk.** The first run and its room are one chunk of the renderer, loaded only on a first run. Main imports the modules that run programs for it the first time they are used. The first run's part of main's startup path is 4.7 kB (see [Measured](#measured)).

**What this Mac runs.** The welcome decides it once:

| What the user does | What runs on this Mac |
|---|---|
| Open the office (the default) | Hercule and its local runner, from login |
| Opens the app on a Mac that is already another machine's runner | The runner, as before. The welcome finds it at launch, never offers Open the office, and offers Connect to it |
| Connect to it, with any address | Only the app |

**Main asks the binary, not the Hercule Home.** Main reads no file in the Home and links no package beyond `@hercule/contract` and `@hercule/client-core` ([ADR 0037](../adr/0037-the-desktop-app-is-its-own-electron-client-of-the-public-api.md)). The binary owns the Home's layout, so the app spells none of it.

- Main runs `~/.local/bin/hercule` by its full path, because a Mac app has no shell `PATH` of its own. It runs three commands: `hercule service status --json`, `hercule service install --json` and `hercule setup-url`. [./15-packaging-and-operations.md](./15-packaging-and-operations.md) §4 has the verbs and the fields their `--json` output prints.
- For each command, main removes every `HERCULE_*` variable from the environment and passes no `--home`, so the binary uses its default Home, `~/.hercule`. A Home anywhere else is not looked for: its user connects with the setup URL, as for another machine.
- Main decodes the output with a schema of its own, for the fields it reads, because ADR 0037 keeps `@hercule/service` out of the app. Output that does not decode counts as a status that failed.
- The renderer never runs a command or reads a file. It asks main through the bridge ([The IPC contract](#the-ipc-contract)).

**Finding the local controller.** At a launch with no saved URL, the welcome shows "Looking for Hercule on this Mac…" while main runs `hercule service status --json`:

- When the Service Unit runs the role `runner`, the welcome shows **runner**: "This Mac is a runner", with Connect to it and no Open the office. Installing again would restart the runner and end the sessions it hosts. Its line says whether the runner is running or stopped; the app does not start it.
- Otherwise main runs the connect check ([The controller URL and the connect screen](#the-controller-url-and-the-connect-screen)) against the `controllerUrl` the status printed. When the check passes, main saves the URL and reloads the window, so the CSP names the controller. Setup not complete is **found**: Open the office goes straight to the account step. Setup complete is **already set up**: the app shows sign-in. *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* That is the sign-in screen any launch with a saved URL shows, where the book draws the welcome with "already set up" and a Sign in button: main has saved the URL and reloaded the window by then, and a launch at a saved controller that is set up opens on sign-in. *(Amended 2026-10-03, [#313](https://github.com/theagenticage/hercule/issues/313).)* The renderer asks for the check and the save: `localController.find` only reports the `controllerUrl`, and the renderer passes it to `controllerUrl.save`, as the connect screen passes the address the user typed.
- Anything else is **fresh**: nothing answers, the connect check refuses what answers, the `controllerUrl` is null, there is no binary, or the status fails. Open the office then starts Hercule, and says what is wrong if that fails.

Status runs once per launch with no saved URL. After the first run the URL is saved, so in practice it runs only on the first launch.

Main finds and starts Hercule one at a time. A reload of the window while Hercule starts finds Hercule again; that find waits for the start, then finds the URL saved and is refused, so the URL is saved and the window reloaded once.

**Starting Hercule.** Open the office, in the fresh state, first runs `hercule service status --json` again. When the Service Unit runs the role `runner`, the welcome shows **runner**. When it runs `serve` and is running, main skips steps 1 and 2 and goes straight to step 3 with the `controllerUrl` the status printed: installing again would restart Hercule and end the sessions its local runner hosts. Otherwise:

1. Main reads the user's `PATH` once, from their login shell: ~~`$SHELL -ilc` prints `PATH` between two markers~~ `$SHELL -ilc` runs `/usr/bin/env -0` between two markers, and main takes `PATH` from that environment, because fish expands `$PATH` to a list separated by spaces *(amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313))*, with stdin closed and a limit of 5 seconds. Main kills the shell's process group soon after the shell exits, so a process the startup files leave running neither keeps main waiting nor stays behind *(amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313))*. The Service Unit records its caller's `PATH` ([./15-packaging-and-operations.md](./15-packaging-and-operations.md) §4), and a Mac app inherits launchd's minimal one, so without this the runner would find no `claude`, `codex` or `git`. The shell runs as a login and interactive shell because many `PATH` lines live in `.zshrc`. The markers drop anything the shell's startup files print, and the closed stdin and the limit keep a prompt from hanging the start. If the read fails, the start fails with that reason: the Service Unit must not record a `PATH` the user does not have.
2. Main runs `hercule service install --json` with that `PATH`. The command installs the Service Unit and starts Hercule, and also starts a unit that is installed but stopped. Main stops it by its PID if it still runs after 90 seconds.
3. When the command exits 0 with the role `serve`, main runs the connect check against the `controllerUrl` it printed, every half second for up to 30 seconds, while nothing answers. When the check passes, main saves the URL and reloads, and the welcome continues as for found. When something answers but the check refuses it, main stops waiting at once, because waiting would not change the answer, and the welcome shows **start-error**. When the command exits 0 with the role `runner`, the Home already said this Mac is a runner, and the welcome shows **runner**.

While this runs, the button holds one spinner and reads "Starting Hercule…". macOS shows its own "Background Items Added" notification when the Service Unit is registered; the welcome's "starts at login" line says so before it appears.

**When Hercule does not start,** the welcome shows one of two states. Both have Try again, which runs the start again, and "It runs on another machine". Neither shows before the command has exited or been stopped, so Try again never starts a second command while the first still runs.

- **no-answer**, which the book calls start-failed: the command exited 0 but nothing answered within 30 seconds, or main stopped the command after 90 seconds. It names the Home's logs folder, the `logsDir` the binary printed last, with Show in Finder, and says that nothing answers at the `controllerUrl`. Main opens the folder itself; the renderer passes no path.
- **start-error**: the command failed, or something answered at the `controllerUrl` but the connect check refused it. For a refusal it shows the line the connect screen shows for the same outcome. For a failed command it shows the last line the command wrote to stderr, without its `hercule: ` prefix. Spec 15 §4 makes every such failure one line that says what to do, and Try again stands for its "run this again". The `PATH` read's error shows here too. With no file at `~/.local/bin/hercule`, the line says Hercule is not installed on this Mac, with the installer's command and Copy.

**Another machine.** Connect to it opens the remote screen, which is the connect screen drawn on the first run's card: one address field, Continue, and Use this Mac. It takes either kind of address:

- **A plain address:** main runs the connect check. When Hercule there is set up, the user signs in. When it is not, the field says to run `hercule setup-url` on that machine and paste the address it prints. Every other outcome shows the connect check's own line.
- *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* Where the remote screen differs from the book:
  - Use this Mac shows only when the user opened the remote screen from the welcome, and goes back to it. It does not show on a runner, which never offers Open the office. It also does not show when main has already saved a controller elsewhere that waits for its setup URL, because going back to this Mac would need a channel that forgets the saved URL.
  - The line for a controller that is not set up names its address, host and port, such as `build-box-1:4937`. The book names the machine, and the app knows only the address.
- **A setup URL:** main splits it into the origin and the token, checks and saves the origin, and keeps the token in memory across the reload ([The controller URL and the connect screen](#the-controller-url-and-the-connect-screen)). The four steps then run on that machine.

This Mac then runs nothing of Hercule. A remote controller runs the same four steps. The providers step lists the controller's own runner, which `controller.read` names in `localRunnerId`, and every "this Mac" in the copy becomes that runner's name. The project step still picks a folder on this Mac, only to read its remote.

**Where the setup token comes from,** in this order:

1. the setup URL the user pasted, which main keeps in memory until the token is used, and then forgets;
2. `hercule setup-url`, when the origin of the address it prints is the saved controller's. After a relaunch, a remote controller's pasted token is gone, and the origin check keeps main from sending that controller this Mac's token instead;
3. otherwise, the user pastes the setup URL, as for another machine.

The token crosses the bridge once and is never stored. Each start of Hercule mints a new token, so a token can be stale by the time it is used. When `setup.complete` refuses it, Try again asks for the token again.

**The four steps.** A ladder beside the card numbers them; a finished step shows a tick.

*(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* As the book draws it in variant B, the ladder floats on glass at the top of the window, over the room. It shows from the account step on, and not on the welcome or the remote screen. Which step shows is decided from the controller's state when the step opens, and the step then stays until the user moves on, even when its fact turns true. A login that ends on the providers step leaves the user there to press Continue. Continue, Do this later, Skip for now and an added project decide again. An error that comes from the controller, such as a refused GitHub token or a failed login, shows the controller's own message, where the book draws an example message.

1. **Account.** `setup.complete { username, password, timezone }`. The username is prefilled with the Mac account name, which main passes. The timezone comes from the Mac, with a Change link. The password hint and its error come from the contract's `MIN_PASSWORD_LENGTH`. Then the app stores the token, writes the first-run record, and marks the web's onboarding steps done ([./14-web-app.md](./14-web-app.md) §Onboarding and first run). *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* The record comes straight after `setup.complete`, so a quit before the onboarding write still resumes the first run. When a write after `setup.complete` fails, Create account tries again, and first asks the controller whether setup already went through, because the controller refuses a second `setup.complete`. *(Amended 2026-10-03, [#313](https://github.com/theagenticage/hercule/issues/313).)* A quit or a relaunch after a failed onboarding write resumes the first run past this step, so leaving All set marks the onboarding steps done when the settings still lack any, before it clears the first-run record.
2. **Providers.** The provider instances of the controller's runner, with whether each harness is on that machine. Each has its own Log in, done in the app with `provider.login` and `provider.submitLoginCode`: Claude Code takes a pasted code, and Codex shows a device code. The device code's expiry comes from the reply's `expiresAt`, never from a number in the app. The login's end arrives on the `provider` live topic, so the app does not poll. "Open sign-in page" opens the vendor's page in the default browser. When no harness is found, each offers Install (`runner.installHarness`). The same login backs the draft's Log in button ([Design system](#design-system), **A new thread**).
   - *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* Where the book draws what is not data, the app draws what it knows:
     - Each row's second line says where the harness is on the runner, as `@hercule/client-core`'s provider row reads it: its path, in monospace, or "installed", "not installed", or why the runner cannot drive it. The book's "Anthropic's coding agent" is a description no record holds.
     - While Install runs, its button reads "Installing…" with no spinner, because rule 2 of [Rules](#rules) allows a spinner only while Hercule starts or a login waits.
     - Copy selects the code where it is drawn and runs the browser's copy command. `navigator.clipboard.writeText` needs the `clipboard-sanitized-write` permission, and main grants the renderer none ([Security baseline](#security-baseline)); the copy command needs only the click. The button then reads "Copied", or "Copy failed", so the user knows to select the code by hand.
     - The draft's Log in opens the login dialog with the login already started, because the user has just asked for it once.
     - Until the controller's runner has joined, the step has no rows. It says that it waits for the runner, and offers Do this later. The book has no such state, because its runner is always there. The runner's arrival comes over the live connection, so the app does not poll.
3. **GitHub.** Sign in with GitHub is the default. The app calls `connection.startDeviceFlow`, shows the user code with Copy, opens its `verificationUri` with Open GitHub, then calls `connection.pollDeviceFlow` at the interval the reply gives until it answers `done`. `pending` and `unreachable` keep waiting, `slow-down` waits longer, and `expired`, `denied` and `failed` show their line with Start again. *(Amended 2026-10-03, [#313](https://github.com/theagenticage/hercule/issues/313).)* The app also ends the wait itself when the code's `expiresAt` passes, even if a poll failed or no reply said `expired`: it sends no further poll and shows the `expired` line with Start again. The step sends no labels. "Paste a token instead" opens the token form, sent with `connection.create`; its "Create one on GitHub" opens GitHub's classic token page with the scopes of [./08-events-and-connections.md](./08-events-and-connections.md) §9.3 already ticked.
   - *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* Once connected, the step names the account and the host it is on, `github.com`, where the book counts the account's repositories: no record holds that count. Its line leaves out the book's "Triage reads it a few times a day", because no copy names a time Triage reads GitHub (see **The room** below).
4. **Project.** Choose a folder opens the native folder dialog. Main runs `git` once in the folder, to read its `origin` remote and current branch, and answers with the remote, a repository with no remote, or a folder that is not a git repository. The project name comes from the folder's name, and the setup command is optional. Adding calls `project.create`, then `resource.create { kind: "repo", remote, setupCommand, projectIds }` with the GitHub Connection, after checking the remote with `client-core`'s `isClonableRemote`. The folder itself is never changed: threads clone from the remote into workspaces of their own. The same form backs the project picker's New project row.
   - *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* What the form draws, where it differs from the book:
     - Choose a folder has no "or drop one here": taking a dropped folder needs a bridge channel that reads its path, which the app does not have. The line is left out rather than drawn with nothing behind it.
     - The folder's card names the folder by its name, in monospace as the book sets its path, with where its repository is hosted and its branch on the line under it.
     - Main also answers when `git` could not read the folder, with git's one line. The form treats it like a folder that is not a git repository: it says which, and offers "Create <name> without a repository".
     - A repository with no remote, or with a remote that `isClonableRemote` refuses (such as a path on this Mac), asks for the remote URL, and still shows the project name and the setup command, where the book shows only the remote.
     - With more than one GitHub Connection, the form clones through the first, and says which under the fields.
     - When the project is created but its repository is not, the form says why: Add project sends the repository again, and "Continue without the repository" goes on with the project as it is. Closing the picker's dialog then opens no draft. The project is in the picker's list, and joins the sidebar with its first thread, as every project does.

*(Amended 2026-10-07, [#459](https://github.com/theagenticage/hercule/issues/459), [ADR 0039](../adr/0039-workspaces-preserve-runner-local-git-state-and-human-work.md).)* **Project repository setup** supersedes the remote-discovery-only behavior above. Show the chosen path and runner, then offer **Use this checkout** and **Create a separate checkout**. Both are explicit choices on every supported runner; platform and local-runner identity never choose a mode. Only a positively identified runner on this Mac permits adopting a native folder. A remote or unidentified runner cannot receive a Mac path; adopting a checkout on a remote runner uses the same public operation and CLI with its explicitly runner-scoped remote path. A remote native folder browser is outside scope.

Picking a folder discovers the repository; only **Use this checkout** calls `workspace.attach`. **Create a separate checkout** selects managed storage and leaves the original checkout untouched. Resolve/reuse the Resource by canonical remote rather than creating duplicate identities. Preserve the existing Connection and missing-credential explanations. Registration leaves the checkout unchanged and runs no setup. Setup applies to newly created managed working copies, including managed main. If project/resource creation succeeds but adoption fails, keep and show those records and retry that adoption without creating duplicates or silently selecting managed mode. Main's typed folder result carries the selected path and repository facts needed by the form; it grants no filesystem backend distinct from the runner.

**Putting a step off.** Providers has "Do this later", and GitHub has "Skip for now". A step put off shows a pause mark in the ladder where a finished step shows a tick, and All set says what is missing and where to finish it. When GitHub was put off, the project step still picks a folder to name the project, but creates the project without a repository, and says so; "Connect GitHub now" goes back to the GitHub step. A project without a repository works: its threads run without a checkout ([./14-web-app.md](./14-web-app.md) §Onboarding and first run).

**All set** shows the furnished room and a summary card, one row per step. "Start your first thread" opens the New thread draft in the new project and clears the first-run record. Without a logged-in provider there are no desks, and the screen offers "Log in to a provider" instead. *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* "Log in to a provider" also clears the first-run record and opens the draft in the new project. The draft cannot start, and its Log in button opens the login ([Design system](#design-system), **A new thread**), so the login lives in one place. *(Amended 2026-10-03, [#313](https://github.com/theagenticage/hercule/issues/313).)* Either button first marks the web's onboarding steps done when the settings lack any (see **Account** above). When that write fails, All set shows the controller's message and keeps the first run, and the button tries again.

**Where the first run keeps its place.** A step's done state comes from the controller:

- account: setup is complete;
- providers: an instance is logged in on the controller's runner;
- GitHub: a GitHub Connection exists;
- project: a project exists.

The app's settings file keeps only what the controller cannot answer: that a first run is in progress for the saved controller, and which steps were put off. Both are written when `setup.complete` succeeds and cleared when the user leaves All set. The controller stores nothing new. Quitting during the first run and launching again resumes at the first step that is neither done nor put off; `client-core` decides which.

**The room** is a still subset of the Office, which stays post-v1. It is built so the Office can grow from it:

- It has the room shell; one wing for the controller's runner; the user's desk and hat stand; the lobby club chair with Hercule, the assistant setup creates, asleep in it; Triage's desk and its tube from the GitHub plaque; and the first thread's desk.
- It has no live updates, no filing cabinets, no other wings and no capsules in the tube.
- The wing has one desk per slot of the runner (`maxConcurrentSessions`, [./03-controller-and-runners.md](./03-controller-and-runners.md) §5.3), up to the 8 a wing holds. Its plate gives the runner's name and the real count.
- Each finished step adds the pieces it created. B's camera then moves to a close shot of them, one shot per step, framed as in the prototype.
- *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* The pieces follow the controller's state, as the steps' done states do. So the wing's desks arrive as soon as a login ends, while the providers step still shows, where the book adds them when the user leaves the step. Before sign-in, the runners cannot be read, so the room on the found and account screens has no wing, where the book draws an empty one.
- Triage is drawn, but no copy names a time it reads GitHub, because Triage is not built yet ~~([#91](https://github.com/theagenticage/hercule/issues/91))~~. *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* Triage is built in slice 34, [Intake: Triage raises core signals (#533)](https://github.com/theagenticage/hercule/issues/533), which replaces #91.
- Hercule's face is the one derived from its ~~name~~ id, like any assistant's, until stored looks arrive (see [Post-v1](#post-v1)). The book draws it with a fixed look. *(Amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* The id seeds the face, so renaming an assistant keeps its face. The account step comes before setup creates the assistant, so there the face is derived from the name the user typed.

Motion, as the book's Motion table draws it ([Rules](#rules), rule 2):

- the veil's opacity lifts when Hercule answers, and the user can sign in or set it up there. The remote screen keeps the room dark while it waits for a controller's setup URL, as the book does *(amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313))*;
- the camera moves one layer's `transform` over `--dur-3`;
- after the camera stops, new pieces settle from 14px above, with `transform` and `opacity` over `--dur-3`;
- a spinner shows only while Hercule starts or a login waits;
- nothing else moves. With Reduce motion, the room is redrawn in place.

### Content-Security-Policy

Main sends this header with every file the `app` scheme serves. `<controller>` is the saved controller's origin, and `<controller-ws>` is the same origin with `ws:` or `wss:`.

```
default-src 'self'; script-src 'self'; connect-src <controller> <controller-ws>; img-src 'self' data: blob: https:; font-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'
```

- **`connect-src` names exactly one controller.** The web app's policy has to allow ten loopback ports for its local-runner probe. The desktop policy does not, because main runs that probe (below).
- **Before a controller is saved,** `connect-src` is `'none'`.
- **`style-src` has no `'unsafe-inline'`.** No component in the first milestone needs a `<style>` element at run time. React sets element styles through the CSSOM, which `style-src` does not govern.
- **Any relaxation is recorded here, with its reason,** as spec 14 does for the web app.
  - *(Amended 2026-10-08, [#465](https://github.com/theagenticage/hercule/issues/465).)* **`img-src` allows `blob:`.** The images attached to prompts are read with the bearer token in a header (`attachment.readContent`), never with the token in a URL, so the renderer shows them through object URLs, which are `blob:` URLs. A `blob:` URL names bytes the renderer itself holds and loads nothing from another origin. The web app's policy has the same relaxation ([./14-web-app.md](./14-web-app.md) §Auth in the client).
  - *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#390](https://github.com/theagenticage/hercule/issues/390).)* **`img-src` allows `https:`.** A signal's blocks carry images from the source, such as an avatar or an image in a GitHub comment ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#95-blocks)), and Intake draws them inline. The renderer loads them only for the open signal, never for a row in the list, so a list of 200 signals fetches no image. Loading an image tells its host that the user opened the signal; what that leaks, and whether images should be proxied, is [Content from untrusted sources: images, tracking and the CSP (#503)](https://github.com/theagenticage/hercule/issues/503). The header becomes `img-src 'self' data: blob: https:`. The web app's policy has the same relaxation ([./14-web-app.md](./14-web-app.md)).

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

~~**Verify at build time:** whether an unsigned development build prompts for Keychain access when `safeStorage` is first used. A signed build must not prompt.~~ *(Amended 2026-10-01, [#308](https://github.com/theagenticage/hercule/issues/308).)* **After an update, the Keychain gives the new build the old build's key only when both builds have the same designated requirement.** `codesign` writes the requirement into the signature, and the Keychain item that holds `safeStorage`'s key trusts the app that meets it. Measured on 2026-10-01 with a small probe program, built twice, that stores a Keychain item and reads it with user interaction turned off:

- **Ad hoc signed,** each build gets the requirement `cdhash H"..."`, the hash of that one build. The second build failed to read the first build's item, with `errSecAuthFailed` (-25293). The app then deletes the token, and the user signs in again ([When the Keychain fails](#auth-and-the-token), above).
- **Signed with the same self-signed certificate,** both builds get `identifier "..." and certificate leaf = H"..."`: the bundle identifier and the hash of the certificate. The second build read the item without a prompt.

So the released app is signed with one certificate for every build ([Security baseline](#security-baseline)), and an update keeps the sign-in. The user signs in once more in two cases: on the first update from an ad hoc build to a certificate-signed one, and on the first update after the certificate changes, including the switch to a Developer ID.

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
- *(Added 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* **`--hercule-binary=<path>` is a test switch like `--use-mock-keychain`.** It names the binary main runs in place of `~/.local/bin/hercule` ([The first run](#the-first-run)). It is not on the allow-list, and main reads it only while the inspector is open. So a released app never lets anyone choose which binary main runs, and the end-to-end tests can run a stand-in.

*(Amended 2026-10-01, [#308](https://github.com/theagenticage/hercule/issues/308).)* **The released app is signed with one self-signed code-signing certificate,** the same for every build, until an Apple Developer ID replaces it together with notarization. The certificate keeps the app's designated requirement the same from build to build, so the Keychain keeps trusting the app after an update ([Auth and the token](#auth-and-the-token)). How the certificate is made and stored is in [docs/signing-certificate.md](../signing-certificate.md).

- The `edge-build` job in CI signs the release package with it ([./15-packaging-and-operations.md](./15-packaging-and-operations.md) §1). A build without the certificate, such as a pull request's, is signed ad hoc.
- **The hardened runtime is on for a build signed with the certificate.** Among other things, it stops macOS from loading a library named in `DYLD_INSERT_LIBRARIES` into the app, which would otherwise run inside a process the Keychain trusts with the token's key. Its entitlements, in `apps/desktop/build/entitlements.mac.plist`, allow two exceptions and nothing else:
  - `allow-jit`, which V8's compiler needs;
  - `disable-library-validation`, because the self-signed certificate has no Team ID, and with library validation on macOS refuses to load Electron's frameworks into the app. So the libraries the app itself loads are not checked against its signature; a Developer ID, which has a Team ID, removes this exception.
- An ad hoc build, such as a pull request's or the test package, runs without the hardened runtime. CI runs the packaging test on the signed `edge` build too, so a build under the runtime is checked to start.
- **Gatekeeper does not trust the certificate.** The app still opens, because the installer downloads it with `curl`, which sets no quarantine flag.

## The IPC contract

`apps/desktop/src/ipc` declares every channel in Effect Schema: its name, its request and its response.

- Main decodes each request against it.
- The preload exposes one typed function per channel, on one object in the renderer's world: `window.bridge`.
  - A renderer → main channel `a.b` is called as `window.bridge.a.b(request)` and returns a promise of the response.
  - A main → renderer channel is declared in a second table. The bridge exposes it as a subscription: `destination.open` becomes `window.bridge.destination.onOpen(listener)`, which returns a function that unsubscribes. Main encodes each payload against the table before it sends it. The preload passes the listener only that payload, never Electron's IPC event object. The preload does not decode it, because the preload links nothing but Electron.
- Nothing else crosses between the layers.

**Errors across the bridge:**

- **An outcome the user can cause is part of the response,** as a tagged union. `controllerUrl.save`, for example, answers with one of its outcomes, and the connect screen shows each one. Errors cannot carry a type across the bridge: Electron copies only an error's message to the page.
- **A refused message is a bug.** Main refuses a message that does not decode, a sender other than the app's main frame, and a request that makes no sense in main's current state. It logs the refusal, and the promise in the renderer rejects with its message. The renderer never shows a refusal to the user as if the user had caused it.
- **A defect,** an error nobody expected, rejects the promise too, and Electron logs it.

The first milestone's channels. *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* `goMenu.set` is added, because the Go menu lists the threads the sidebar shows and only the renderer knows them. `waitingThreads.set` replaces `badge.set`, `notification.show` and `notification.close`: the renderer sends every thread waiting on the user, and main decides the badge and which notifications to show or remove. Main then keeps which notifications it has shown, so a reload of the page cannot show them again, and main knows whether the user is signed in before the page sends anything, so a page still leaving the shell after a sign-out cannot bring them back.

*(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* The first run adds the channels from `localController.find` to `firstRunProgress.read` / `firstRunProgress.save` below, and builds `link.open`. Main finds and starts Hercule on this Mac by running the installed binary, `~/.local/bin/hercule`, with no shell, no `HERCULE_*` variable and no `--home`, and decodes its `--json` output with a schema of its own, so the app links no `@hercule/service` (ADR 0037). `controllerUrl.save` also takes a setup URL, the controller's origin followed by `/setup?token=<token>` as `hercule setup-url` prints it. When that controller is not set up, main keeps the token in memory only, for `setupToken.read` to return once. `controllerUrl.save` saves a controller that is not set up, as it saves one that is, and no longer opens the browser for it; its outcome `SetupIncomplete` is gone.

| Channel | Direction | Purpose |
|---|---|---|
| `token.read` / `token.write` | renderer → main | the stored token (see [Auth and the token](#auth-and-the-token)) |
| `controllerUrl.read` / `controllerUrl.save` | renderer → main | the saved controller URL; checking a new one, a controller's origin or a setup URL, and saving it. Not the public API's `controller.read`, which describes the controller itself |
| `localController.find` | renderer → main | at a launch with no controller URL saved: runs `hercule service status --json`~~, and saves the controller's URL when one answers at the address it reports. Answers `Saved`~~ and reports what it found, saving and checking nothing. Answers `Found` (the controller's origin the status printed, which the renderer then saves through `controllerUrl.save`) *(amended 2026-10-03, [#313](https://github.com/theagenticage/hercule/issues/313): a read that saved would be a write behind a read)*, `Runner` or `NotFound` (with the status command's error line, if any). Waits for a `localController.start` that runs |
| `localController.start` | renderer → main | runs `hercule service install --json` with the `PATH` of the user's login shell, then waits up to 30 seconds for Hercule to answer and saves its URL. Answers `Saved`, `Runner`, `NotInstalled`, `StartFailed` (one line), `NoAnswer` (the origin and the logs folder), or the connect check's refusal as `controllerUrl.save` answers it (`Redirected`, `NotController`, `OriginNotAllowed`, `PreflightRefused`), which stops the wait at once. Installs nothing over a runner or over a Hercule that runs already; waits for a `localController.find` or `localController.start` that runs; stops an install that runs for 90 seconds |
| `logsFolder.show` | renderer → main | opens in Finder the logs folder the binary last reported. The renderer passes no path |
| `setupToken.read` | renderer → main | the saved controller's setup token: the one from a pasted setup URL, once, else the one `hercule setup-url` prints on this Mac when it names the saved controller's origin. Answers `Token` or `PasteNeeded` |
| `macUser.read` | renderer → main | the name of the user's account on this Mac, for the first run's username field |
| `folder.pick` | renderer → main | the system's folder dialog, and the picked folder as `/usr/bin/git` describes it: `Cancelled`, `Repository` (its `origin` remote and branch), `NoRemote`, `NotGit` or `GitFailed` (git's error line). Main removes the user name and password from an `http:` or `https:` remote before it answers, because an `insteadOf` rule in the user's git config can put a token there, and the remote is saved on the controller |
| `firstRunProgress.read` / `firstRunProgress.save` | renderer → main | the first-run steps the user put off, kept in the settings file for the saved controller; saving another controller's URL removes them |
| `runnerIdentity.read` | renderer → main | the local-runner probe |
| `goMenu.set` | renderer → main | the first nine items of the Go menu, top to bottom, each a destination (a thread or an assistant) and the title it shows *(amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453): was the threads the sidebar shows, by session id)* |
| ~~`badge.set`~~ | ~~renderer → main~~ | ~~the dock badge count~~ |
| ~~`notification.show` / `notification.close`~~ | ~~renderer → main~~ | ~~a thread's notification, keyed by session id~~ |
| ~~`waitingThreads.set`~~ | ~~renderer → main~~ | ~~every thread waiting on the user, for the dock badge and the threads' notifications~~ |
| `waiting.set` | renderer → main | *(Added 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453), replacing `waitingThreads.set`.)* ~~every Request waiting on the user, one per thread or assistant: its destination, its request id, and the title and question its notification shows~~ every thread and assistant waiting on the user, once each: its destination, the id of its newest open Request, the ids of all its open Requests, and the title and body its notification shows *(amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453): the notification shows the newest Request and counts the others, and main must tell a Request that opened from one that closed, so it is sent every open id)*. Main keys each notification by its destination and counts the list on the dock badge. A destination whose newest Request was not open in the last list gets a new notification, replacing its old one; a notification whose Request is no longer open is removed, and none takes its place |
| `urgentSignals.set` | renderer → main | *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#394](https://github.com/theagenticage/hercule/issues/394).)* every open signal on To do whose priority is `urgent`, the ones Intake shows under Now: its signal id, and the title and body its notification shows. Main keys each notification by signal id. A signal that was not in the last list gets a notification while the window is not focused; a notification whose signal left the list is removed. A signal back from snooze is new to the list, so it notifies again. Main counts none of them on the dock badge. It works as `waiting.set` does, so main keeps what it has shown across a reload of the page |
| `link.open` | renderer → main | opening an `http:` or `https:` link in the default browser. ~~Not built yet: it arrives with the draft's Log in button, which is its first caller.~~ Built with the first run *(2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313))*. A link the user clicks already opens in the default browser without it (see [Security baseline](#security-baseline)) |
| `appearance.read` | renderer → main | *(Added 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* the Appearance kept in the settings file, answered synchronously from main's memory. `theme-init.js` calls it once per page load, before the first paint |
| `appearance.save` | renderer → main | *(Added 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* saves the Appearance to the settings file, and repaints the window's background for the theme in use |
| `firstScreen.report` | renderer → main | the frame that draws the first screen, fonts included, has reached the window, so main can show the window (see [Native behaviour](#native-behaviour)) |
| ~~`thread.open`~~ | ~~main → renderer~~ | ~~a notification click or a Go menu item asks for a thread~~ |
| `destination.open` | main → renderer | *(Added 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453), replacing `thread.open`.)* a notification click or a Go menu item asks for a destination: `{ kind: "thread", sessionId }` or `{ kind: "assistant", assistantId }`. Main passes it back as the renderer sent it and never acts on its kind. *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* A third kind, `{ kind: "signal", signalId }`, opens Intake with that signal selected |
| `menu.command` | main → renderer | a menu item the renderer carries out, such as New Thread, Send or Settings… *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* Go › Intake and View's two faces add one command each |

A new channel is added to the contract, and to this table, in the same change.

*(Amended 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* [Settings](#settings) adds `appearance.read` and `appearance.save`, and the `openSettings` command on `menu.command`. `appearance.read` is the contract's only synchronous channel, because the page needs its theme before it paints.

*(Amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* An assistant waiting on the user gets the dock badge, a notification and a Go menu item, as a waiting thread does. So `waiting.set` replaces `waitingThreads.set`, `destination.open` replaces `thread.open`, and `goMenu.set` takes destinations: a destination is a thread or an assistant, and only the renderer knows how to open each.

*(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* [Intake](#intake) adds `urgentSignals.set`, the `signal` destination and three commands on `menu.command`: open Intake, show the Threads face and show the Hercule face. Their names leave the product name out, as every identifier does. A Now signal gets its own channel, not a row in `waiting.set`, because it is not an agent waiting: it never counts on the dock badge, and its notification says what a source asks, not what an agent asks. `goMenu.set` is unchanged, because the Go menu lists no signals.

## Native behaviour

Each item below is an acceptance criterion. The end-to-end test checks it where it can.

- **Title bar:**
  - `titleBarStyle: "hiddenInset"`, with the traffic lights sitting in the sidebar's top strip.
  - `trafficLightPosition: { x: 19, y: 16 }` puts the native lights where the Bureau pages draw them: centres at 26, 46 and 66 pt from the left, 24 pt from the top. The renderer draws no lights of its own.
  - The top 52 pt of the window drags it, across its full width. The shell draws this as one strip over the top of the window that paints nothing and is not a compositing layer; the sidebar's top strip and the thread's chrome row both sit inside it. Each control placed in the band is marked `no-drag`, so it takes clicks.
- **No flash:**
  - The window is created hidden, with `backgroundColor` set to `--bg` of the current appearance: `#f4f3f0` for Whitehaven and `#1a1310` for Orient Express. These are the sRGB values Chromium draws for the `oklch` tokens, and a unit test derives them from `tokens.css`. *(Amended 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* The colour is `--bg` of the theme in use, any of Bureau's five ([Settings](#settings) › Appearance).
  - It is shown when the frame that draws its first screen, fonts included, has reached the window, or 3 seconds after its page first painted, whichever is first. It is also shown at once when its page fails to load or its renderer exits. Showing on `ready-to-show` would show an empty page for a few frames: `ready-to-show` fires when the bare HTML first paints, 50 to 80 ms before the first screen has painted.
  - The 3-second limit means a renderer that fails before it reports still gets its window. It sits well above the "connecting" screen's 1-second delay, because that delay starts only once the renderer's code has loaded and its router has started, and fonts and a few frames follow it. So a healthy renderer shows its window by reporting, even on a slow Mac's cold launch. A crash or a failed load does not wait for the limit.
  - The renderer reports its first screen through the IPC contract once the frame that draws it has been presented: it times a sentinel element that draws nothing with Element Timing, whose entry arrives only once its frame has been presented, or has failed to present. A frame that fails to present is rare; the window then shows a frame early, and the screen appears with the next frame. Two animation frames are not enough, because the second can run before the first frame has reached the window. The "connecting" screen reports too, so a slow controller does not keep the window hidden.
  - When the appearance changes, main updates the background colour. *(Amended 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* So does a change on the Appearance page.
- **Theme follows the system, live:** Whitehaven when macOS is light, Orient Express when it is dark, through `prefers-color-scheme`. ~~Bureau's other three themes, and a glass setting, arrive with Settings.~~ *(Amended 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* These are the defaults. Appearance picks the day and the night theme, or one theme that does not follow the system, and the glass level ([Settings](#settings)).
- **Accessibility settings:**
  - Reduce transparency sets `--glass-level` to 0, which removes the blur completely.
  - Reduce motion stops every animation.
  - *(Amended 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* Each is on when macOS's setting is on or the Appearance page's is. The app's toggle can add the setting, never remove macOS's.
- **Window size:**
  - The first launch opens a 1440 × 900 pt window, the size of the Bureau pages, centred on the display. On a smaller display it fills the work area.
  - The window cannot be made smaller than 800 × 500 pt. Below a width of 776 an empty thread's composer no longer fits the main pane, and below a height of 440 its start cards no longer fit.
- **Window state is remembered:** size, position and full-screen. A position that no longer lands on a display is moved onto the nearest one.
- **Closing the window hides it.** `⌘W` and the red light hide the window, the dock icon shows it again, and `⌘Q` quits. The app keeps running while the window is hidden, so the dock badge and notifications keep working.
- **The last open thread reopens at launch.** *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* The app reopens what was open when it quit:
  - The renderer stores the open thread's id per controller URL. Opening a thread stores it; leaving it for a screen that is not a thread removes it, so a quit on the new-thread screen launches on the new-thread screen.
  - When the stored thread is gone at launch, the id is removed and the new-thread screen shows, because the user did not ask for that thread this time. A gone thread the user opens during use shows "This thread was not found." with a link to start a new thread.
  - *(Amended 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* With Appearance's Open on set to The office, a launch opens the Office instead.
- *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#394](https://github.com/theagenticage/hercule/issues/394) §12.)* **~~The last open thread~~ The last screen reopens at launch.** It replaces the stored thread above:
  - The renderer stores the last screen per controller URL, in place of the thread id. Every screen counts: a thread, the new-thread screen, an assistant's Conversation, the Office, Intake, and each later screen with no rule of its own.
  - Settings, the first run, the connect screen and sign-in are not stored. Opening one leaves the stored screen as it was, so Intake, then Settings, then a quit reopens Intake.
  - Only the screen is restored: not Intake's tab or view, not a selection, not a scroll position. The split's widths are kept as they always are.
  - A stored screen that is gone at launch, such as a deleted thread, falls back to the new-thread screen, as a gone thread does above.
  - A thread id stored before this change reads as that thread's screen, so the first launch after the update still reopens the thread.
  - When the app restarts itself to install an update, it should reopen exactly where the user was, Settings section included, so they can look at the new version. The app does not update itself yet ([Post-v1](#post-v1)), so this waits for that.
  - With Open on set to The office, a launch still opens the Office.
- **Menu:**
  - The standard app, Edit and Window menus, so text editing shortcuts work in every field.
  - The menus, in order: the app menu, File, Edit, Go, Thread, Window. The development build adds View, with Reload and Toggle Developer Tools, after Edit.
  - *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* The release build has a View menu too, after Edit: View › Threads `⌥⌘1` and View › Hercule `⌥⌘2` switch [the sidebar's face](#the-hercule-face). They are `⌥⌘` because `⌘1` to `⌘9` already pick an item in Go. The development build adds Reload and Toggle Developer Tools to the same menu, under a separator.
  - *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* Go › Intake `⌘⇧I`, after Go › Office, opens [Intake](#intake).
  - File › New Thread `⌘N`.
  - Thread › Send `⌘↵`. *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* It is always enabled. It sends what the open thread's composer or the draft holds, as ⏎ in the message field does, and does nothing when there is nothing to send.
  - *(Added 2026-10-03, [#332](https://github.com/theagenticage/hercule/issues/332).)* Go › Office `⌘⇧O`, the first item of Go, opens [the Office](#the-office).
  - Go › the first nine threads of the sidebar, `⌘1` to `⌘9`, in sidebar order. *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* Each thread is listed once, by its title: a waiting thread is listed where "Waiting on you" shows it, and a thread a "more" row hides is not listed. With no thread, and while signed out, Go holds one dimmed "No Threads". *(Amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* A waiting assistant is listed too, by its name, where Waiting on you shows it, so `⌘1` to `⌘9` count the items in sidebar order. "No Threads" shows only when there is nothing to list.
  - While the project picker is open, `⌘1` to `⌘9` pick a project instead, as spec 14 says. Choosing a thread in Go with the mouse closes the picker.
  - Sign Out, in the app menu.
  - *(Amended 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* Settings… `⌘,`, in the app menu under About, opens [Settings](#settings).
  - *(Amended 2026-10-05, [#410](https://github.com/theagenticage/hercule/issues/410).)* File › New Thread, Go › Office and Settings… are dimmed while signed out, as Sign Out is, because only the shell carries them out: on the connect and sign-in screens, choosing one would do nothing. *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* So are Go › Intake, View › Threads and View › Hercule.
- **Dock badge:** the number of threads waiting on you. A thread waits on you while its session has an open Request (~~`Session.openRequest`~~ `Session.openRequests` is not empty, whoever asked: its own agent or a subagent *(amended 2026-10-05, [#355](https://github.com/theagenticage/hercule/issues/355))*, [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)).
  - *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* macOS shows an app's dock badge only once the user has allowed the app to notify. The app asks when the user signs in, so the badge can show from the first waiting thread.
  - *(Amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* The badge also counts the assistants waiting on you. An assistant waits on you while its current session, the newest session of its main conversation, has an open Request (see [The assistant](#design-system)).
  - *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#394](https://github.com/theagenticage/hercule/issues/394) §3.)* The badge keeps one meaning, an agent is blocked on you, so it counts threads and assistants only, never signals. Intake's count shows on the sidebar instead ([The Hercule face](#the-hercule-face)). Waiting on you stays agent Requests only, for the same reason.
- **Notifications:**
  - When a thread starts waiting on you and the window is not focused, main shows a native notification.
  - Clicking it focuses the window and opens the thread.
  - *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* The notification's title is the thread's title and its body is the question, such as "Run git push?".
  - A thread has at most one notification. A new Request on the thread replaces it; when the new Request opens while the window is focused, the old notification is removed and no new one shows.
  - *(Added 2026-10-05, [#355](https://github.com/theagenticage/hercule/issues/355); [#353](https://github.com/theagenticage/hercule/issues/353).)* A thread can have several Requests open at once. Its notification shows the newest, and its body ends with "+N more waiting" when others are open. A subagent's Request names it: the body starts with "<subagent> asks:". Clicking the notification opens the thread, where the dock pages through every Request. When a Request closes and others stay open, the notification is not shown again.
  - Launching the app, or signing in, shows no notification for the threads that already wait; the badge counts them.
  - Signing out, or connecting to another controller, hides the badge, removes every notification and empties Go. They stay empty until the user signs in again.
  - *(Added 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* An assistant waiting on you gets a notification by the same rules as a thread. Its title is the assistant's name, and clicking it opens the assistant's Conversation, `/assistants/$assistantId`. *(Amended 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* While the Office is open, the click opens the Conversation in the Office's drawer instead ([The Office](#the-office)).
  - *(Added 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* Main keys each notification by where its click goes: the thread, or the assistant, never the session. So an assistant has at most one notification, as a thread does, also when rotation gives its Conversation a new session.
  - *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#394](https://github.com/theagenticage/hercule/issues/394) §3.)* **A new Now signal** gets a notification while the window is not focused: a signal of priority `urgent` that arrives on To do. No other signal notifies.
    - Its title is the signal's source and its body is the signal's title, such as "PagerDuty" and "Checkout error rate above 5%".
    - Clicking it focuses the window and opens Intake with that signal selected.
    - A Now signal back from snooze counts as new, so it notifies again. A snoozed signal never notifies ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#97-snooze-and-not-urgent)).
    - The rules above hold for it too: launching the app or signing in shows no notification for Now signals already open; signing out or connecting to another controller removes them.
    - A signal that leaves Now, because it is resolved anywhere, snoozed or lowered with Not urgent, loses its notification when the `signal` push arrives.
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
- **The composer draws the ~~`+` attach and~~ voice ~~buttons~~ button, with nothing behind ~~them~~ it yet.** ~~They keep~~ It keeps the composer's full shape, as in the web app ([./14-web-app.md](./14-web-app.md) §App shell). ~~They show their~~ It shows its hover and pressed states, and a click does nothing. *(Amended 2026-10-08, [#465](https://github.com/theagenticage/hercule/issues/465): `+` attach now attaches images; see [Images in prompts](#images-in-prompts).)*

## Design system

**The pixel reference.** The pixel reference is the Crew Bureau book and its desktop pages, in [`docs/design/crew-bureau/`](../design/crew-bureau/). The folder is a copy of `prototype/design-systems-2/c1-bureau/` at commit a130074e on the `prototype/design-systems` branch, kept byte for byte and never edited. Its pages link to two sibling folders, copied the same way beside it: `docs/design/shared/` (the book's frame scripts and the brief) and `docs/design/c0-crew/` (the original Crew, for the book's before-and-after frames). Open `docs/design/crew-bureau/index.html` in a browser to read the book.

*(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* **The pixel reference is now the book's second edition,** in [`docs/design/crew-bureau-2/`](../design/crew-bureau-2/). Open `docs/design/crew-bureau-2/index.html` to read it. The second edition started as a copy of the first, and #313 changed it in three ways:

- The Office's scene styles moved to `office.css`, and `office.js` shares its drawing code, so the first run furnishes the same room. The Office page draws the same pixels as before.
- It adds the First run chapter and its page, `desktop/first-run.html` ([The first run](#the-first-run)).
- `crew.js` and `desktop/session-empty.html` gain the fresh install: Hercule's look, and the draft's starter threads and intake note (**A new thread**, below).

The first edition stays in `docs/design/crew-bureau/`, byte for byte as above, as the record of what #275 was built from. Everything below that names "the book" means the second edition, and `pnpm compare:bureau` compares the app with it.

- Where this text and the pages disagree, the pages decide a measurement and this text decides a behaviour. This is spec 14's rule for its prototypes.
- Behaviour comes from [./14-web-app.md](./14-web-app.md): §App shell (the Threads face), §The thread surface, and §The composer is the thread's configuration.

**Where Bureau changes a behaviour, the desktop follows Bureau.** The changes the first milestone takes from the book's Spec section:

1. **Waiting on you tops the sidebar,** above the threads. ~~The first milestone has only the Threads face, so the section sits at the sidebar's top.~~ *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#512](https://github.com/theagenticage/hercule/issues/512).)* It sits above both faces, under the face switch, as the book draws it ([The Hercule face](#the-hercule-face)).
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
| has an open Request (any agent's, *amended 2026-10-05, [#355](https://github.com/theagenticage/hercule/issues/355)*) | waiting | the waiting mark |
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
  - Waiting on you shows its 3 newest threads, then "`<n>` more waiting on you". *(Amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* Waiting threads and waiting assistants share the section and its cap: the 3 with the newest activity show, whichever they are.
  - A project shows at most 5 threads, then "`<n>` more threads". The 5 are chosen in this order: waiting, then working (queued, starting, busy), then the rest; the newest activity first within each, ties broken by session id. The selected thread is always shown as well, so a project can show 6.
  - Shown rows keep ~~the grouped order~~ the project's order, newest created first *(amended 2026-10-08, [#473](https://github.com/theagenticage/hercule/issues/473))*. ~~A workspace with no shown thread is left out, with its label.~~ *(Amended 2026-10-08, [#473](https://github.com/theagenticage/hercule/issues/473): there are no workspace labels.)*
  - Expanding is not stored: a relaunch collapses every section. The book draws no way to collapse one, so there is none.
- ~~**Threads are grouped by project, then by workspace,** as spec 14 says. The book draws no workspace label, so the label is Bureau's lane label, in the UI face (item 2 above). A lane label that follows a row has 8px more space above it than one under a project header, so it does not read as the row's third line. A row's second line is the model's name, because the lane label already names the workspace.~~
  *(Amended 2026-10-08, [#473](https://github.com/theagenticage/hercule/issues/473).)* **Threads are grouped by project only, newest created first.** Spec 14 groups a project's threads by workspace; the desktop does not, so a project reads as one list, as T3 Code's sidebar does.
  - A row has three lines: the title and its end, the model's name, and the workspace in `--faint`: the branch for a worktree, `<repo> · <machine>` for a main workspace, "No workspace" for none. The machine's name is never cut short. The row is 59px tall with its text centred, which leaves about 5px above and below the text, so neighbouring rows read as separate threads.
  - *(Amended 2026-10-08, [#484](https://github.com/theagenticage/hercule/issues/484).)* **A thread row's age is the time since the thread was created**, the time the list is sorted by, so the order and the labels agree. The age in the header's tabs stays the time since the thread's last activity.
  - Inside a project, threads are sorted by when they were created, newest first, ties by session id. Projects are sorted by their newest thread's creation time, then by project id, the draft's project first and "No project" last. Sorting by latest activity made a row climb to the top whenever its thread worked, so the list moved under the user's pointer; a thread's creation time never changes, so a row only moves when a new thread starts. The cap above still picks waiting and working threads first, so a hidden thread that starts working appears in its place.
  - Hovering a thread row for 400ms shows a details card beside the sidebar: the full title, the project, the machine, the branch and the model with its provider's mark. It is one glass popover for the whole list, takes no pointer events and no focus, and hides when the pointer leaves the rows, on a click, on scroll and when the window is resized. Moving to another row while it shows switches it at once. The row's accessible description carries the same details.
  - A row whose composer holds unsent text or images, and the draft's row, take a light tint and a pencil before the title, so unsent work is found again. Picks alone do not count.
  - The workspace label's `+` and its workspace-details button leave the sidebar: the thread header's `+` and the composer's workspace button do the same. A workspace no thread uses, kept or failed, is no longer shown in the sidebar; [#472](https://github.com/theagenticage/hercule/issues/472) gives it a place.
- **A project header has no thread count,** where spec 14 puts one: the book draws none, and the pages decide what is drawn.
- **The threads with no project have a header, "No project",** where spec 14 gives them none. In place of the identity tile, it has the tile's outline in `--faint` with no fill. ~~It has no `+`, because a draft always starts in a project.~~ *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275): a draft can have no project (see **A new thread** below), so the header has a `+` that opens that draft.)* Without a header, a capped project's "more" row sits between two groups and reads as belonging to either.
- **A waiting thread is listed twice:** in Waiting on you, and in its project with the waiting mark, as the book draws it. In Waiting on you, its second line is the open Request as one question: "Run git push?", "Change adyen.ts?", "Change 3 files?", "Read `<file>`?", "Run `<tool>`?", or a question's first line in the agent's words. With nothing waiting, the section is not drawn. *(Amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* A waiting assistant is listed twice the same way: in Waiting on you, and in the Assistants section with its word in `--you-ink`.
- **The foot counts threads by pose:** "`<n>` working · `<n>` waiting · `<n>` idle".
  - Asleep and away threads are not counted, so a fleet with hundreds of old threads reads "3 working · 2 waiting · 4 idle", not "470 idle".
  - The book's "paused" count is left out, because no thread is paused yet.
  - Every count shows at 0. The waiting count takes `--you-ink` only above 0, because the attention hue means something needs the user.
- *(Added 2026-10-03, [#332](https://github.com/theagenticage/hercule/issues/332).)* **New thread, Search and Office share one row** at the sidebar's top. The book draws New thread and Search as two rows, and puts the office's row in the Hercule face's Work section. ~~The desktop has only the Threads face, and~~ The Office belongs to both faces, so its way in sits in the part of the sidebar both faces share *(amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395): the desktop now has both faces, and the Office's row is still not repeated under Work)*. New thread keeps its label and `⌘N`. Search (`⌘K`, still inert) and Office (`⌘⇧O`) are icon buttons, each with a tooltip that gives its name and shortcut. The Office button shows as pressed while the Office is open.
- **Search `⌘K`, the hide-sidebar button ~~and Settings~~ are drawn and inert** until their slices build them, like the composer's ~~`+` and~~ voice ~~buttons~~ button *(amended 2026-10-08, [#465](https://github.com/theagenticage/hercule/issues/465))*: they show their hover states, do nothing when pressed, and carry `aria-disabled`. `⌘K` is not registered. *(Amended 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* The foot's Settings button opens [Settings](#settings), and shows as pressed while Settings is open. *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* The foot is the same on both faces, and its Settings button is the Hercule face's Settings row ([The Hercule face](#the-hercule-face)).
- **The thread list reads every page** of `session.query`, so no thread is left out. The web app reads the first 500.

**The thread** *(added 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275))* follows spec 14's thread surface and the book's session pages, with these differences:

- **A turn's work is shown per work stretch,** as the book draws it. A work stretch is the steps between two messages of one turn. Each stretch gets its own divider, and each agent message stands on its own with its face, its meta line and its body. Talk and work keep the order they happened in. Spec 14 and the web app draw one divider per turn, and join the agent's messages under it.
  - The divider reads "Worked for 2m 14s ›" and a summary of the stretch. The summary counts its steps by kind, in the order each kind first appears: "ran 2 commands", "edited 3 files", "searched the web", "used 6 tools", "ran 1 subagent", "made a plan", "compacted the context", "hit 1 error", "did 1 other step". Reasoning is not counted, and a stretch of reasoning alone draws nothing. *(Amended 2026-10-10, [#479](https://github.com/theagenticage/hercule/issues/479).)* The list also has "read 3 files" and "searched 2 times".
  - ~~The book's "read 6 files" is not drawn: no transcript item says that a tool read a file, so such a read counts as a tool.~~
    *(Amended 2026-10-10, [#479](https://github.com/theagenticage/hercule/issues/479).)* **The summary counts reads and searches,** from the `file_read` and `file_search` item kinds the adapters emit ([./06-providers.md](./06-providers.md) section 6.3, [#477](https://github.com/theagenticage/hercule/issues/477)). "read 3 files" counts distinct paths, as "edited 3 files" does. "searched 2 times" counts searches, and reads "searched once" for one.
  - Clicking the divider expands the stretch in place, ~~one line per step, with spec 14's verb, target and result~~ *(Amended 2026-10-10, [#479](https://github.com/theagenticage/hercule/issues/479).)* one row per step, as below. Expansion is not stored. This departs from spec 14: its rows are a verb, a target and a result, and the web app keeps them.
    - **A row is an icon, a label and a chevron.** The icon shows the step's kind. The label is the verb in the UI face, then the target, for example "Read /tmp/411-shots/app.png", on one line and cut with an ellipsis. A target that is code (a command, a path, a search pattern, also when a tool call names one) is in mono. A target that is words (a web search's query, a subagent's or a tool's description, an error's message) is in the UI face, because mono is kept for code ([Design system](#design-system), item 2). The time the step started shows on hover only, through CSS, with no timer. The chevron at the end shows only when the row has something to open. When hidden, it keeps its space, so the columns line up.
    - **Each kind has a verb and an icon.** `buildWorkRows` in `@hercule/client-core` decides them:
      - `file_read`: "Read", eye
      - `file_search`: "Searched", search
      - `command_execution`: "Ran", terminal
      - `file_change`: "Edited", file
      - `web_search`: "Searched the web", globe
      - `tool_call`: the tool's name, puzzle
      - `subagent`: "Subagent", crew
      - `plan`: "Planned", list
      - `reasoning`: "Thought", sparkle
      - `context_compaction`: "Compacted the context", more
      - `error`: "Error", close
      - an unknown kind: "Step", more
    - **Two or more steps of one kind in a row fold into one row:** "Read 3 files", "Searched 2 times", "Ran 3 commands", "Edited 2 files", "Searched the web 2 times", "Used WebFetch 3 times", with the tool's name. A tool call folds only with calls of the same tool. A subagent call, reasoning, a plan, a compaction, an error and an unknown step never fold. The folded row opens to its steps.
    - **Opening a step shows the text it returned:** `item.completed`'s `detail.content`. A string result is used as it is; the adapter has already cut it to 4096 characters. A list of content blocks (Claude Code's tool result) is read for its text blocks, joined by line breaks, and the client cuts that text to 4096 characters, cutting each block to the room left so a long result never builds a long string. A cut never leaves half a character at the end. ~~Any other block, such as an image, is not drawn.~~ Any other block is not drawn. *(Amended 2026-10-10, [#478](https://github.com/theagenticage/hercule/issues/478).)* An image the tool returned is drawn under the text, as the bubble's 210px tiles at 4:3, as many as fit in a row; a click opens it in the lightbox, named "Image 1", "Image 2" and so on among the step's stored images. The runner stores each image and leaves a reference in the content ([./06-providers.md](./06-providers.md)), so a tile reads its thumbnail through `attachment.readContent` the first time it draws, and an image that could not be kept is a quiet line with the reason, in the faint ink. A step that returned images and no text has something to open, and draws no empty text box. Codex sends no result content today, so a Codex step has nothing to open and shows no chevron. The text sits in a scroll box with a maximum height, in the book's mono face, each line kept whole and scrolling sideways. Only an open step puts its text in the page.
    - **A failed step shows a quiet failure mark,** in `--muted`, not tomato (`--fail`), as the warning line's dot does. A declined, running or awaiting-approval step shows that word in `--faint`.
    - **The transcript keeps which rows are open,** as it keeps which stretches are expanded, so a row stays open when it scrolls out of the mounted range and back. A row keeps its key when a second step folds onto it, so an open row stays open and then shows its steps. It is not stored.
  - The stretch that is running reads "Working for 12s ›" and counts up. It shows no divider until its first step that is not reasoning, so no divider shows before the first step, or while the agent only reasons. It does not shimmer, as spec 14's does, because only the working face animates ([Rules](#rules), rule 2). While a Request is open, the stretch stops at the Request's opening and reads "Worked for".
  - *(Amended 2026-10-09, [#504](https://github.com/theagenticage/hercule/issues/504), replacing the 2026-10-08 amendment of [#481](https://github.com/theagenticage/hercule/issues/481).)* **The thread never draws an agent row with no text.** A face and a meta line with nothing beside them read as a response that has started, and a response can take minutes to begin. The face is drawn only beside text, because the first thing the agent does after the user's message may be tool calls, not a message. While the agent has drawn nothing, a status line stands where the next block will be, in the divider's drawing (muted, 12px, indented to the message column, with its rule):
    - **"Working for 12s"** from the start of the wait, counting up: right after the user's message, while the agent only reasons, and after a message when the next step is not yet a tool call. The start is the stretch's own start, so when the first step arrives the line becomes the stretch's divider and the count goes on.
    - **"Starting…"** while no turn has started: a session or a subagent that is starting.
    - **"Writing…"** while the agent has started a message and not yet written a word. The message's row is hidden, and shows once the first word lands in the paragraph being written. The live hook paints that paragraph outside React, so the stylesheet decides, not the component.
    - **No line** while a running work stretch is the last block: its "Working for" divider already says it.
    - Each line is a live region (`role="status"`) whose spoken text changes with the state, "Starting", "Working" or "Writing", and not with the count, so a screen reader does not read the seconds out.
- *(Added 2026-10-08, [#476](https://github.com/theagenticage/hercule/issues/476).)* **A runtime warning is a quiet line where it happened,** such as a retried request, or an event the runner shrank or dropped because it was larger than a frame ([./06-providers.md](./06-providers.md) section 6). The line is the book's `.dot`, named "Warning" for screen readers, the warning's text as the runner wrote it, and its time, all in 12px `--muted` where the waiting note sits. The book draws no warning in a thread, so the line is built from the book's parts. It is quieter than the book's notice card and the waiting note, because the work went on and the user owes no answer.
  - The dot is muted, not coloured. The book has no caution colour, and its two near ones mean something else: tomato (`--fail`) means something failed, and marigold (`--you`) means it is the user's move. A retry or a shrunk event is neither.
  - The text wraps, and the dot stays on its first line. The text is selectable, so it can be copied into an issue; the time is not.
  - A warning does not end a work stretch. A run of retries would otherwise split one divider into many, so the stretch's divider stays above the warning and the steps after it still join it.
  - A subagent's warning shows on the subagent's page, because each page reads only its own agent's rows.
  - The thread specimen shows two warnings among the Fix thread's work with `?state=warning`. `pnpm compare:bureau` does not compare that state, because the book has nothing to compare it with.
- **Messages carry their own time,** and there are no time separators, where spec 14 draws one above each turn. A user message has its time under the bubble; an agent message has it in its meta line, "Claude Code · Opus 5.5 · 09:04". The time is `09:04` when it falls on today in the system time zone, else `4 Sep 09:04`.
  - *(Amended 2026-10-10, [#511](https://github.com/theagenticage/hercule/issues/511).)* **A message another session's agent sent names that agent.** It is the user's bubble, on the right, with three differences:
    - A chip above the bubble names the agent, on the right, its right edge on the bubble's and the time's. The chip is the book's `.mention`: the agent's 18px idle face and its name, bold, in the agent's `--who-ink`. The chip is at most 240px wide, and a longer name ends in an ellipsis, with no tooltip: only a session's title can be that long, and the chip links to the thread, which shows it in full. The chip's width never widens the bubble: a short bubble under a long name keeps its own width, and the chip reaches past it to the left. A chip that links is lit with the book's `--hover` while the pointer is on it, as a row the book can open is, with the arrow kept; "Another agent", which links nowhere, is not.
    - The bubble takes the agent's `--who-tint`. In the dark theme the tint is mixed 70% into the neutral bubble's colour, because the full dark tint reads as a block of colour, and a tint mixed into `--surface` is darker and greyer than the user's bubble beside it.
    - The message is a group named "Message from" and the agent's name, so a screen reader never takes it for the user's.

    The name and the link follow `describeSender` from `@hercule/client-core`, so both apps agree. An assistant's session shows the assistant's name and face and links to its page. Any other session the user can read shows its title and links to its thread; a session with an empty title is named "session 7c82ebeb", the tail of its id, so the chip is never blank. A session the user cannot read, deleted or forbidden, shows "Another agent" in its chip and "Message from another agent" as the group's name, with no link, and is never an error. The thread's loader reads each sender once: as soon as the transcript and the queued inputs have arrived, it reads every sender they name, and waits for those reads up to one second (`SENDER_READ_WAIT_MS` in `@hercule/client-core`, shared with the web app), and never longer: a sender that answers in time is named, chip and tint included, at the first paint, and a controller that never answers one cannot keep the thread from opening. A sender still unread after that wait, or one that first appears while the thread streams, fills in when its read answers. Until then, the message is the plain bubble with the chip's row held empty at its height, and a queued row holds the chip's place empty where the owner's row shows its clock, untinted, so nothing moves when the name arrives and nothing names a sender that may be wrong. A read that fails, for a network error or a 5xx, shows "Another agent" as an unreadable sender does, and is not made again while the app holds it: not retried, not by the next message that mounts, not when the thread opens again, and not when the window is focused again. A read that answered is not made again while the app holds it either, which is while a screen shows the sender and for five minutes after, because the name comes from the session's title, Agent and conversation, which never change; no push reads it again.

    A message steered into a running turn says so under its bubble, "Steered · 09:04", the owner's as well as an agent's. The owner's other messages are drawn exactly as before.

    **A queued input from another session's agent** shows the same chip where the owner's row shows its clock, with the face's left edge where the clock's is. The row's glass is tinted with the agent's `--who-tint`, 60% in light and 35% in dark, and its rim is the glass's, as on the owner's rows. The row is a group named "Queued message from" and the agent's name. Steer and Cancel work as on the owner's rows. The row keeps the book's items as its own direct children (the clock or the chip, the images, the text, the status, Steer and Cancel), each in a grid track of its own, so a note under the text starts where the text starts, however wide the chip is. An owner's row on its own is drawn exactly as before.

    Several queued rows stack into one block, owner's and agents' alike: only the top row has the glass's lit top edge, and a row under another draws no line along its top, so one 1px line parts two rows and the block has one outline. Before #511 each row drew its whole rim, and two rows met in a 2px line.

    The chip's link opens the sender's thread or assistant in the main pane, so in the Office's drawer it leaves the Office today. Whether the drawer should open the sender in place is open, in [#511](https://github.com/theagenticage/hercule/issues/511).
- **The header is the book's:** the crumb with the project's tile and name, one tab per thread of the workspace, and a `+` that starts a new thread in the workspace (spec 14's "+ New thread here"), shown only while the workspace is ready (see **A new thread** below). Spec 14 rejected a `+` beside the tabs; the book draws one, and the pages decide what is drawn. The open thread always has a tab: a thread that has exited no longer holds its workspace, so the workspace does not list it, and its tab is then the last. Open in editor and More are drawn inert, like the sidebar's Search. The book's "Changes +48 -12 | Commit" is left out, because nothing reports those numbers yet. *(Amended 2026-10-06, [#440](https://github.com/theagenticage/hercule/issues/440).)* At the header's right end, a toggle shows and hides the thread's side pane, pressed while the pane is open. A subagent's page draws it too; the Office's drawer, which has no side pane, does not.
- **The Requests dock answers from the keyboard only while it has focus:** ↩ allows, ⌥↩ allows always and esc denies, as the book's hints say. When one of its buttons has focus, ↩ presses that button, so a focused Deny is never turned into Allow. *(Amended 2026-10-01, [#309](https://github.com/theagenticage/hercule/issues/309).)* A `question` request offers no decision, so no key decides it and esc does nothing on it: the user turns a question down with Stop. On a question, ↩ on the dock, on a choice or in the own-answer field, and ⌘↵ anywhere in the dock, go to the next question or send the answers. ⌘↵ there never reaches the composer's Send. A secret question shows the warning that its answer is stored like any other, 12px in `--you-ink`, 4px under the question. A Request that opens never moves focus. The words on the dock are `@hercule/client-core`'s, which no screen may reword, not the book's.
- **The composer's lip** shows a main workspace as "Main workspace" and its branch, and an ephemeral workspace as its branch and the branch it was started from, "fix/3ds-eu-cards from main", as the book draws it. The machine is on the right. The book's "Own worktree" is not used, because [CONTEXT.md](../../CONTEXT.md) keeps "worktree" for the git mechanism.
- **Stop takes Send's place while a turn runs,** as the book's assistant page draws it. Spec 14 draws Stop beside the round send. While a turn runs, ⏎ still sends: the controller steers the message into the turn or queues it behind the turn. Stop keeps Send's 4px left margin, which the book's Stop lacks, so nothing in the row moves when a turn starts or ends.
- **The note "model change applies on send"** sits after the model options selector, in the row's free space. Spec 14 puts it before the selector, where it would push the selector aside when it appears.
- **The composer's menus are Bureau's popovers:** glass, with the `--line` rim, `--r-lg` corners and `--shadow-3`. Spec 14 draws them `--raised`, with a `--line` border and a radius of 10. The book draws no composer menu, so the widths stay spec 14's: 320px for the model options, 360px for the model. The model options menu shows each option as Bureau's lane label above a segmented control.
- **Each thread keeps its Message Draft and its unsent picks while the app runs,** so switching to another thread and back loses nothing. They are held in memory, and quitting the app loses them. The web app loses them when the user switches threads.
- **The composer shrinks while the transcript is scrolled away from its bottom,** as the book's session page draws it:
  - It shrinks while the transcript is more than 12px from its bottom and focus is not inside the composer. Focus on `dock-mini`'s buttons does not count.
  - Shrunk, it is 560px wide and shows the field on one line, with `dock-mini` above it. When the dock shows the Request pager's line, that line stays above `dock-mini`, so "Open subagent ›" stays one click away *(amended 2026-10-06, [#440](https://github.com/theagenticage/hercule/issues/440))*. The queued inputs, the dock's question and answers, the row and the lip are hidden.
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
- *(Added 2026-10-05, [#355](https://github.com/theagenticage/hercule/issues/355); decided by [#354](https://github.com/theagenticage/hercule/issues/354). Prototype: branch `prototype/subagents-ui`, commit 6253a529, `apps/desktop/src/renderer/specimens/subagents-prototype/`, which now opens with the chosen settings.)* **Subagents** follow spec 14's §The thread surface (spawn lines, the side pane and its Subagents surface, the tally, a subagent's page, the Request pager), with these differences:
  - **A subagent has a face,** seeded by its session id and its subagent id together, so its hue and shape never change. Spawn lines and the Subagents surface's rows show the face where the web shows a state mark. Faces in the surface are still in their pose; only the face of the open page's running turn animates (rule 2 of [Rules](#rules)).
  - **A subagent's page is marked by a tinted crumb:** the header crumb reads ~~"<parent thread> › <subagent>"~~ "<thread> › <ancestors> › <subagent>", from the thread down through the subagent's ancestors, as on the web *(amended 2026-10-06, [#440](https://github.com/theagenticage/hercule/issues/440))*, and the subagent's crumb is in its hue, with a ring and a "subagent" tag. Louder marks were tried and dropped: a band, a frame, a wash and a gradient.
  - **The brief card** is tinted in the subagent's hue. In dark it reads as a loud block in the prototype; the build tones it down.
  - ~~**The side pane's tab titles** shrink to a few letters at 1280px with the pane open. The build decides what the header gives up, as on the web.~~ **The header gives way** at 1280px with the side pane open, judged by the row's own width, as on the web. The sibling tabs' titles shrink first, to about four letters and an ellipsis. Then the open tab's title is cut, with its whole title in a tooltip. On a subagent's page, the thread's crumb is at most 260px wide and the subagent's crumb at most 340px, and the ancestors' crumbs are cut with an ellipsis first *(amended 2026-10-06, [#440](https://github.com/theagenticage/hercule/issues/440))*.
  - The side pane's background is `--surface`, as the main pane's.
  - The Subagents surface reads the record only, so the sidebar, the Waiting on you rows and `dock-mini` need nothing new: `dock-mini` answers ~~the oldest open Request, as the dock shows it first~~ the Request the dock shows: the oldest, unless the user paged to another *(amended 2026-10-06, [#440](https://github.com/theagenticage/hercule/issues/440))*.
  - *(Added 2026-10-06, [#440](https://github.com/theagenticage/hercule/issues/440).)* **The side pane's state is kept per thread, in memory.** The pane starts closed. Whether it is open and which surfaces it holds are kept per thread for as long as the app runs, so each thread shows the pane as the user left it there, and quitting the app forgets them. Its width is kept across launches. Spec 14 keeps the state per browser tab, for every thread alike.

**A new thread** *(added 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275))* follows spec 14's thread creation and the book's `session-empty.html`, with these differences:

*(Amended 2026-10-07, [#459](https://github.com/theagenticage/hercule/issues/459), [ADR 0039](../adr/0039-workspaces-preserve-runner-local-git-state-and-human-work.md).)* **Workspace choices and details** follow [spec 14](./14-web-app.md)'s amended composer behavior. Honor an explicit saved default; otherwise a project-level coding Thread chooses **New workspace**. **Use main workspace** explains sharing, and a workspace's `+` explicitly chooses those existing files. Starting a Thread in main files preserves its actual branch. A new worktree chooses current committed state, a local branch or fetched remote branch/default, with no dirty tracked-file copying or implicit local fallback.

A compact workspace details surface shows runner, actual or last-observed branch/HEAD, starting revision, resolved base commit when applicable, ownership and manual retention or automatic deadline. Display stale age, unavailable adopted checkouts, failed/interrupted preparation and retained-cleanup reasons with an actionable next step. Provide keyboard-accessible **Refresh**, **Discard workspace** and **Detach existing checkout**. Discard explains loss of remaining tracked, untracked and ignored files and requires the explicit discard choice. Detach explains that files stay and lists derived worktrees that retain their Git source. Active holders block either action. Workspace live-topic invalidation refreshes queries using existing conventions; client-core owns interpretation. Full editor/diff integration remains outside scope.

- **New thread opens the project picker,** from File › New Thread `⌘N` and the sidebar's New thread row. It is a glass `<dialog>` over a scrim, 520px wide and 18vh from the top. Spec 14 draws it `--raised` with a border; Bureau draws every surface that floats as glass. ↑↓ move and wrap, ⏎ picks, Esc closes, and `⌘1` to `⌘9` pick directly. ~~There is no "New project" row, because the desktop cannot create projects. With no projects there is nothing to pick, so New thread opens the draft with no project at once.~~ *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* The last row is New project, as in spec 14. It opens the first run's project form ([The first run](#the-first-run), step 4) as a glass dialog, and a project it adds opens the draft in that project. With no projects, the picker has two rows: No project, which opens the draft with no project, and New project. That way a user with no projects can still start a thread, as before. The dialog has no Connect GitHub button, because the desktop app connects GitHub only in its first run: without a GitHub Connection, the form says to connect GitHub in the web app, and adds the project without its repository. ~~The dialog reads the Connections as it opens, and a failed read shows in the dialog, with the screen behind it left as it was.~~ *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* The shell reads the Connections as it opens, with the sidebar's records, so the dialog never waits for them.
- **A draft can have no project.** The new-thread screen with no project is a draft with no project, and the thread it starts has none. The "No project" header's `+` opens it. Its heading is "What should the agent do?", and it has no start cards.
- **The lip uses [CONTEXT.md](../../CONTEXT.md)'s words, in the UI face.** The book's lip says "New worktree" and sets the branch in monospace. The desktop says "New workspace" or "Main workspace", as the web's workspace menu does, and sets the branch in the UI face (item 2 above). There is no rule between the workspace and the branch, where the web draws one, because the book draws none.
- **The machine menu has no "Add machine →" foot,** because the desktop has no machine screen to open. The foot keeps its sentence: "The thread runs where you say; nothing moves it later."
- **The machine menu leaves out retired runners,** where spec 14 lists every machine. A retired runner can never host a thread again, and runners are never deleted, so the menu would fill up with machines that are gone. A started thread still shows the retired runner it ran on. The web app does the same, because both read `buildRunnerMenu` in `@hercule/client-core`.
- **A draft that cannot start** shows "Can't start yet." and the reason in place of the sentence, and Send is off. ~~Spec 14's Log in button is not drawn yet.~~ When the reason is a provider instance that is not logged in, spec 14's Log in button follows the reason. It opens the same login as the first run's providers step ([The first run](#the-first-run), step 2), in a glass dialog, and the draft can start once the login ends *(amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313))*.
- **A new thread joins only a ready workspace.** ~~A workspace label's `+` and~~ The thread header's `+` *(amended 2026-10-08, [#473](https://github.com/theagenticage/hercule/issues/473): the sidebar has no workspace labels)* shows only while the workspace is ready, because the controller refuses to start a thread in a workspace that is still being set up, failed, was deleted or was lost. A draft whose workspace stops being ready while it is open cannot start, and says why: "The workspace it joins could not be set up". Neither can a draft whose machine is retired after the user picked it: the reason is "moss is retired", and the lip's machine reads "moss · retired". The web app does the same, because both read `@hercule/client-core`.
- **The start cards** are the book's "Start from Intake" section under the lip, which spec 14 does not have. ~~They are up to three open Tasks of the draft's project, the most urgent first.~~ *(Amended 2026-10-03, [#300](https://github.com/theagenticage/hercule/issues/300).)* They are up to three open Tasks of the draft's project, the most urgent first and newest first within one priority. Each card shows:
  - the GitHub mark when the Task came from GitHub, else the tasks glyph;
  - ~~"Proposal" when the Task has the `proposed` label, else "Task";~~ "Task" *(amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#392](https://github.com/theagenticage/hercule/issues/392): a proposal is now a signal on Intake, and its Task exists only once the user accepts it, so every open Task is a Task)*;
  - its priority as bars at the right: 4 for urgent, drawn in `--fail` as the book does, 3 for high, 2 for normal, 1 for low;
  - its title.

  ~~A click adds the Task's title and description to the Message Draft,~~ *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* A click adds one line that points the agent at the Task, rather than the Task's text:
  - "Pick up ticket https://github.com/owner/repo/issues/42" when the Task's first External Ref is a GitHub issue;
  - "Pick up pull request https://github.com/owner/repo/pull/87" when it is a GitHub pull request;
  - "Start working on task <id>: <title>" otherwise.

  The thread's agent reads the rest itself, with `gh` or `hercule task read`. The message stays short, and text written outside Hercule, such as an issue's body, is never sent as the user's own words. The line goes after a blank line when the field already holds text, and the click focuses the field. The section shows only when the project has open Tasks. The book's "2 new events" is not drawn, because nothing counts new events.
- *(Added 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* **Starter threads take the start cards' place while ~~Intake is empty~~ the project has no open Task,** *(amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395): Intake now holds Signals, and the start cards draw open Tasks, so the condition names Tasks)* as the book's `session-empty.html?state=first` and `?state=first-no-repo` draw them. A new user then still has something to start from.
  - Three starters sit under "Or start from one of these", each with the book's glyph and title, such as "Get to know it" or "Something to plan". `@hercule/client-core` picks the set:
    - a project with a repository gets starters about code, such as "Walk me through how webshop is put together";
    - a project without one gets starters about knowledge work: "Make me a short presentation about …", "Research … and summarise what you find, with sources" and "Write a one-page plan for …". Hercule is for work that is not code too, and a thread in such a project runs without a checkout.
  - Picking a starter fills the composer and focuses it. It does not send, so the user can finish the sentence.
  - Under the starters, one line says what fills Intake: ~~Triage brings what needs work from GitHub~~ *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* your review requests and mentions on GitHub, and what Triage finds there, or, without a GitHub Connection, the line says to connect GitHub. The line names no time of day, because Triage runs on a schedule the user can change ([The Triage tab](#the-triage-tab)).
  - Once ~~Intake holds anything~~ the project has an open Task, the draft shows the start cards as above *(amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395))*.
- **The open draft is a row in the sidebar,** as the book draws it: "New thread", ~~with its workspace and machine on the second line,~~ and "draft" at its end. ~~It is the last row of the workspace it joins, as its tab is the header's last. A draft that starts a new workspace has a group of its own under the project's header, and a draft with no project is the last row of "No project".~~ *(Amended 2026-10-08, [#473](https://github.com/theagenticage/hercule/issues/473).)* It is the first row of its project, because it is the newest thread there, and has a thread row's three lines: "New thread", the model's name, and where it will work and on which machine.
- **The draft's text and picks are kept while the app runs,** like a thread's Message Draft, one draft per project and workspace.

**The assistant** *(added 2026-10-06, [Desktop app: an assistant's Conversation in Crew Bureau (#448)](https://github.com/theagenticage/hercule/issues/448); prototype: branch `prototype/desktop-assistant`, commit c733f1b9, `apps/desktop/src/renderer/specimens/assistant-prototype/`, variant B)* follows spec 14's §The assistant conversation and the book's `desktop/assistant.html`, with the differences below. To the user, an assistant is one continuous Conversation. The sessions behind it never show: no link, no "Show work", no session id.

- **The book's layout is not followed.** The book draws a bar header and a rail beside the Conversation. The desktop draws the Conversation full width, under a floating header, and the rail opens as a drawer. This is the first screen on which the desktop does not follow the book's layout, decided with the prototype: the rail holds little the app can fill yet (see the drawer below), and the Conversation is the screen.
- **The sidebar's Assistants section** ~~sits after the projects, as the book's `crew.js` draws it~~. Each row is the assistant's face in its pose, its name, and the pose's word at the row's end (`describePose`), in `--you-ink` while it waits on the user. Every assistant is listed, by name. The section is not capped. With no assistant, it is not drawn.
  - *(Amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* The section is pinned at the bottom of the sidebar, just above the foot, outside the scrolling thread list. It stays in the same place however many threads there are, also when there are none. The book's `crew.js` draws it inside the scroll, after the projects. The desktop does not follow the book here, because a fixed place is where the user finds their assistants without scrolling past every thread. The section's padding is adjusted for its pinned place. The section takes at most 40% of the sidebar's height; past that, its rows scroll under its heading, with the system's overlay scroll bar.
  - *(Amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* The rows are sorted by name, alphabetically. A row's face is still, in every pose ([Rules](#rules), rule 2). The row of the open Conversation is selected.
- **An assistant's pose** is `decideThreadPose` of its newest conversation session, ~~which `findNewestConversationSession` finds,~~ and that session's runner. The two tables agree: an open Request is waiting, a held or unresumable session or an offline runner is away, an exited one asleep. An assistant with no session yet is idle, because the next message starts its first one. ~~No new `client-core` function is needed.~~ *(Amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* `decideAssistantPose` in `@hercule/client-core` decides the pose by these rules, from the assistant's current session (the newest session of its main conversation) and that session's runner; the assistant's screen uses it for its header. `buildAssistantRows` builds the section's rows with it, from the assistants, their current sessions and the runners, in alphabetical order.
- **An assistant's face is derived from its id,** as a thread's is from its session id. The stored look stays post-v1 (the book's Spec change 3)~~, so the book's cloche, beret and headset are not drawn~~. *(Amended 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* An assistant wears headwear that a thread never wears: a cloche, a beret or a headset, drawn as the book's `crew.js` draws them. The id chooses which one (`buildAssistantLook`), so the headwear needs no stored look. It is drawn wherever an assistant's face is drawn: the sidebar's Assistants section, the Waiting on you row, the Conversation's header, Settings › Assistants, Settings › Permission profiles and the Office. When the look's accessories hold a homburg, the headwear replaces it, because a head wears one hat.
- **Assistant sessions show only in the Assistants section.** The thread list still reads `session.query` with `thread: true`, so an assistant's session is never a row of a project, and the foot counts threads only. For each assistant, the Assistants section reads the newest session of its web conversation: `session.query` with the conversation's id, newest first, one row. Assistants are few, so this is a handful of reads, and it never reads the sessions of workflow runs, which are not threads either.
  - *(Amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* The conversation is the assistant's main Conversation, the one every Hercule app shows, named by `Assistant.mainConversationId`. The newest session is read by that id, newest by creation time, and never by the assistant's agent. The reads come in two waves: `assistant.query` goes out together with the thread list's reads, and as soon as it answers, one `session.query` per assistant goes out.
  - *(Amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* A `session` push reads an assistant's current session again only when the push could have changed it. A current session changes only when it changes itself or when a newer session starts in its conversation, and either way the changed session belongs to that conversation. Each `session` push names, beside the ids of the changed sessions, the conversation each of them belongs to, or none for a thread or a workflow run's session ([./14-web-app.md](./14-web-app.md#live-model-one-websocket-subscriptions-only)). So, by `buildQueryKeys` in `@hercule/client-core`:
    - a push that names a session of an assistant's conversation reads that assistant's current session again, once however many of its sessions the push names;
    - a push that names only threads or workflow run sessions reads no assistant's;
    - a push with no ids, ~~as after a reconnect~~ as the controller sends first on every subscription *(amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454))*, reads every assistant's again, and so does a push from a controller that does not send the conversations yet.

    The reads are keyed `conversationSession`, outside the `sessions` prefix, so the thread list's invalidation does not reach them. The web app keys its read of a Conversation's current session the same way, and `buildQueryKeys` applies the same rule there.
  - An assistant that waits on the user is also a row of Waiting on you: its face, its name, and the open Request as one question, as a thread's row shows it. The row opens the Conversation, where the Request is answered. ~~The dock badge and the notifications count it as one waiting thread.~~ *(Amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* It counts on the dock badge, gets a notification titled with the assistant's name, and is listed in the Go menu where Waiting on you shows it ([Native behaviour](#native-behaviour)). Its row, its notification and its Go item all open `/assistants/$assistantId`. *(Amended 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* While the Office is open, they open the Conversation in the Office's drawer instead ([The Office](#the-office)).
- **The floating header** is the book's glass pill row, over the Conversation's top: the face, the name and the pose's word on the left; on the right the drawer's pill, with the heart and memory icons, and "`<name>`'s record", which opens Settings › Assistants on the assistant's tab. The book's channel pills are not drawn, because the desktop shows no channels.
- **The drawer** is the book's rail, as a glass panel from the right edge, opened by the header's pill and closed by the pill, by esc or by a click outside it. Its three sections are drawn and inert, at half opacity with no clicks (the book's rule for a button that cannot act), because nothing serves them yet:
  - **Heartbeat** shows the assistant's schedule from `Assistant.heartbeat`: "Every `<n>` h, `<hh:mm>` to `<hh:mm>`" and the day's strip with a tick at each beat, read with Settings' two cron functions (slice 16). No beat is marked spoke or quiet, because heartbeats do not fire yet ([#94](https://github.com/theagenticage/hercule/issues/94)). A schedule that is not an interval shows its cron expression. An assistant with no heartbeat shows "No heartbeat".
  - **Reminders** shows "No reminders", because no operation reads them.
  - **Memory** shows "Nothing remembered yet", because no operation reads it ([#93](https://github.com/theagenticage/hercule/issues/93)).
  - The prototype fills the three sections with sample data so their look can be judged. Its screenshots keep that design, and [Desktop app: bring the assistant's drawer to life (#450)](https://github.com/theagenticage/hercule/issues/450) builds it as the data arrives. The app never draws data it does not have, so the header pill shows its icons without numbers, and the composer's lip shows nothing until memory and heartbeats exist.
- **Messages.** The owner's message is the thread's bubble, with its time under it. A reply is the book's message: the face, ~~"`<name>` · `<hh:mm>`"~~ *(amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454))* the name with its time after it in small type and no dot between them, as the book draws "Ada <small>09:20</small>", and the text. Times follow the thread's rule. A day stamp ("Today", "Yesterday", "4 Sep") sits above the first message of each day, as the book draws it, where spec 14 draws a time stamp above each of the owner's messages.
  - *(Added 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454).)* The name in a reply's meta line is the message's stored sender label: the assistant's name when the reply was written. A renamed assistant's earlier replies keep the earlier name. The time follows the thread's rule: `09:04` today, else `4 Sep 09:04`.
  - *(Added 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454).)* A day stamp reads "Today", "Yesterday", "4 Sep" in the current year, and "4 Sep 2025" in an earlier one. Days are counted in the system time zone, as the thread's times are.
  - Only the face of the ~~newest reply moves, and only while its turn runs~~ *(amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454))* open reply moves, and only while its turn runs ([Rules](#rules), rule 2). Every other face is still, in the idle pose. A stored reply's face is still also when it is the newest, because its text is complete.
  - "@Milo" in a reply is plain text. The book draws it as the other assistant's chip, but nothing says which assistant a name means.
- **A notice** is the book's notice: the assistant's face, then the notice's text as the controller writes it, such as "Ada was interrupted: its turn was stopped", and its time. The book draws the face in the failed pose and the words before the colon in bold. The desktop draws every notice's face in the failed pose and the text in one weight. The two kinds of notice, "was interrupted" and "can't be reached", differ only in their text, and the app reads no meaning from text. Today the user's own Stop also produces a notice, so it wears the failed face too. Once [#451](https://github.com/theagenticage/hercule/issues/451) lands, the controller records a Stop as "You stopped Ada", drawn like an answered Request, and a notice always means the assistant could not answer.
- **The streaming reply** follows the thread: the newest session's `:stream` and `:tap`, the paragraph being written as plain text with the book's caret in the assistant's hue, and markdown once the paragraph ends. ~~The open reply is drawn from the session until the Conversation's message with the same `turnId` arrives on the `conversation` topic, which then takes its place.~~
  - *(Amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454).)* The open reply shows only the text of the running turn that is not yet stored as a message. Which text that is depends on the assistant's `reply` mode, because the two modes store a turn's text differently:
    - `turn-end`: the controller stores one message when the turn ends: the turn's last text, or, when the turn failed or was stopped, all its texts joined. So the open reply is the turn's newest text alone: its first text, then its second in the first's place. ~~Once any reply with the turn's `turnId` is stored, the open reply is gone.~~ *(Amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454).)* Once a reply holds that text, or the turn's joined reply is stored, the open reply shows no text. The controller leaves out of that message any text the turn already stored as a reply, before a change from `segments` to `turn-end` ([./12-assistants.md](./12-assistants.md) §9).
    - `segments`: the controller stores one message for each text as it completes, each with the turn's `turnId`. ~~When `k` replies with that `turnId` are stored, the open reply is the turn's texts after the first `k`.~~ *(Amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454).)* Texts are stored in the order they complete, so a stored text means every text that completed before it is stored too. The open reply is the turn's texts that completed after the last stored one, and the text being written. This holds when the newest page of messages does not reach the turn's first replies, as after a turn that stored more replies than a page holds.
    - The app never compares texts to find which are stored. ~~It counts replies by `turnId`.~~ *(Amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454).)* Each reply records the text it holds as `itemId`, the id of that text's item in the transcript ([./12-assistants.md](./12-assistants.md) §9). A text is stored when a reply with the turn's `turnId` holds its `itemId`. A reply with the turn's `turnId` and no `itemId` is the joined reply of a turn that failed or was stopped: it holds every text of the turn that no reply held before it, so together with the replies that hold one text it hides every text of the turn, and it ends the turn even before the turn's end row arrives. A reply that holds one text does not end the turn, because the reply mode applies at once ([./12-assistants.md](./12-assistants.md) §7, "When a change to the assistant reaches its session"): after a change from `segments` to `turn-end`, the texts stored as segments do not end the running turn, and the text being written still shows. So in `turn-end` mode the caret alone shows from the moment the turn's reply is stored until the turn's end row arrives. A notice never carries a `turnId`, so a notice never hides an open reply.
  - *(Amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454).)* While the current session is busy and has no text that is not yet stored, the open reply is still drawn: the assistant's face in its pose, its name, and the caret alone as its body. The face is in the working pose while the turn runs, and in the waiting pose while a Request is open. When the turn ends with no text, the row is removed. The caret does not blink ([Rules](#rules), rule 2).
  - *(Amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454).)* The open reply needs the running turn's rows. The screen reads the current session's transcript with `transcript.read`, newest first, page by page, until it reaches the row where the running turn started, or the transcript's start. It keeps the rows from that turn's start on, oldest first. It never reads the whole transcript, where a thread does. The live `:stream` continues after the last row read. The rows that `:stream` adds are trimmed to the running turn's start as they land, so the screen holds one turn's rows at most, however long the session runs, and the sentence above stays true while the session goes on.
- **The current session can change.** Rotation, and a message to an unavailable assistant, give the Conversation a new session. When the `conversation` topic names the open Conversation, the screen reads it again, and when its newest session changed, it drops the old session's `:stream` and `:tap` and subscribes to the new one's.
  - *(Amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454).)* A `conversation` push that names the open Conversation, or names no conversation, ~~as after a reconnect~~ as the controller's first push on every subscription does *(amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454))*, also reads the current session again. The part of the screen that holds `:stream` and `:tap` is keyed by the current session's id. So a new session id drops the old session's subscriptions and subscribes to the new session's.
- **Earlier messages.** The screen reads the newest page of `conversation.queryMessages` and reads the page before when the user scrolls within one screen of the top. A Conversation never ends, so it is never read whole, where a thread is. The book draws no Show earlier messages button, so there is none.
  - *(Amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454).)* A `conversation` push reads only the newest page again, never every page the screen holds. The newest page is merged into the held pages by each message's position. When the newest page does not reach the newest message held, messages are missing between them, so the screen starts over from the newest page alone. Leaving the Conversation drops its pages and the running turn's rows.
- **A Request is answered in the Conversation,** on the thread's Requests dock above the composer, with `session.respondToApprovalRequest` ~~on the newest session~~ *(amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454))* or `session.respondToQuestion` on the current session, as on a thread. The dock draws the assistant's face where a thread's draws the thread's. Spec 14 links to the session instead. *(Amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454).)* When several Requests are open, the dock pages between them with the Request pager, as a thread's does: "2 of 3" and its arrows. The pager names no asker and has no "Open subagent ›", because the Conversation shows no subagents. Allow always works as on a thread. An answered Request leaves a record in the Conversation, a quiet centred line such as "You allowed Ada to run `tail`", once the controller writes one ([#451](https://github.com/theagenticage/hercule/issues/451)). Until then, the answer leaves no line.
- **The composer** is the thread's, with fewer controls:
  - no model, model options or access mode. The model is a setting of the assistant (Settings › Assistants), not a choice per message.
  - no channel pick, and no lip, until the lip has memory and the next heartbeat to show.
  - `+` and voice are drawn inert, as on a thread.
  - ⏎ sends with `conversation.send`, also while a turn runs: the controller steers the message into the running turn ([./12-assistants.md](./12-assistants.md) §2). ~~The message shows as a bubble at once, and no queued row is drawn, because the Conversation shows nothing of the session behind it.~~ *(amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454))* The message shows as a bubble when `conversation.send` returns the stored message, and the draft is cleared then. The bubble is never drawn before the message is stored. A send that fails keeps the draft and shows the thread's error line under the composer. No queued row is drawn, because the Conversation shows nothing of the session behind it.
  - Stop takes Send's place while a turn runs and calls `session.interrupt` on the newest session. The controller's notice then reads "`<name>` was interrupted: its turn was stopped", until [#451](https://github.com/theagenticage/hercule/issues/451) makes it the record "You stopped `<name>`".
  - The Message Draft is kept per assistant while the app runs, as a thread's is.
- **Left out of the book's page,** because no operation reads them: the `.refs` chips under a reply, "heartbeat · 09:00" in a reply's meta line, the reminder card in a reply, the action buttons under a reply, the count of quiet check-ins, and the channel pills and channel pick.
- *(Added 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* **An empty Conversation** is the prototype's greeting: the assistant's face at 76px in the idle pose, its name as the heading, and "Send a message to start. `<name>` falls asleep after a quiet spell and picks up where it left off."
- **An assistant that is gone** shows "This assistant was not found." Any other failure shows [A screen that fails](#reaching-the-controller). *(Amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* It is the headline alone, with no link. It is the same not-found screen as a gone thread's, which keeps its link to start a new thread.

**How the system is carried over:**

- **Kept as they are:** `tokens.css` and the font files. They are the design system's source. Token names match the web app's (`--bg`, `--surface`, `--raised`, `--ink`, `--muted`, `--faint`, `--line`, `--line-soft`), except that `--attn` becomes `--you` / `--you-ink`.
- **Rebuilt one component at a time:** `system.css` is never copied whole. Each React component takes the rules it needs, so no CSS ships that no component uses.
- **Rewritten as typed modules:** `crew.js` becomes typed modules for faces, poses, icons and marks. Components render their SVG as React elements, never through `innerHTML`.
  - *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#394](https://github.com/theagenticage/hercule/issues/394) §11.)* **A plugin's mark comes from the plugin,** with the plugin's record ([./05-plugins.md](./05-plugins.md#2-manifest)). The app draws each of its paths as a React `<path d={…} fill="currentColor">` in a 16 × 16 `<svg>`, so the mark takes the colour of the text around it and follows the theme. It draws nothing else from the plugin: no SVG document, no `<style>`, no colour. A plugin with no valid mark gets its name's initial in a rounded square. The Bureau's GitHub and Gmail marks move into those two plugins, and the app keeps no copy of them.
- *(Added 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* **A button that cannot act yet is drawn at half opacity,** in its own colours, as the book's first-run page draws it, and takes no hover or press. Before the second edition the book drew no disabled button, and the app followed macOS: the button lost its accent and its label turned faint. This changes Sign in and the dock's buttons too.
- **Self-hosted fonts:** fonts are served from the app bundle, and nothing is fetched from a third party.
  - Bricolage Grotesque is the UI face.
  - Limelight is used only for the wordmark and numerals.
  - Recursive is used only for code.

## The Office

*(Added 2026-10-03, [Office v1 in the desktop app (#332)](https://github.com/theagenticage/hercule/issues/332).)* The Office draws the user's threads as colleagues at work in a 3D Bureau office. Each thread has a desk in its project's room. It walks to the user's desk when it waits on them, and to the Lounge when it is idle. One look shows what the fleet is doing, and the Office stays quiet enough that no fan spins ([Performance](#performance)). *(Amended 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* Every assistant is a colleague too, in a fixed room of its own kind, the Secretariat.

- **The pixel reference** is option A, the Bureau floor, of the 3D office prototype on the branch `prototype/office-3d`, in `apps/desktop/src/renderer/specimens/office-prototype/`. Its README lists what it does, what it costs and its rough parts. The prototype stays on its branch. v1 moves the code it keeps to `apps/desktop/src/renderer/office/`, not to `screens/office/`, which holds the first run's room.
- **The first run's room stays the still 2D drawing** it is ([The first run](#the-first-run)). The two are drawings of one Office. A later change can draw the first run's room as a still view of the 3D Office.
- **The words** are [CONTEXT.md](../../CONTEXT.md)'s: the Office, and the Office Map it is built from.

**The way in.**

- The sidebar's Office button, in the top row beside New thread and Search (see **The sidebar** in [Design system](#design-system)), and Go › Office `⌘⇧O`, the first item of the Go menu.
- The Office is the route `/office`, drawn in the main pane beside the sidebar. ~~The selected colleague is in the URL, `/office?session=<id>`, so a reload keeps it.~~ The thread open in the drawer is in the URL, `/office?session=<id>`: a sidebar row, the Go menu and a notification open a thread in the drawer by going there (next point), and the sidebar marks the row of the thread the drawer shows *(amended 2026-10-04, [#332](https://github.com/theagenticage/hercule/issues/332): the router uses memory history, so nothing in the URL outlives a reload, and the window reloads only in the development build or when the user signs out or changes controller, where the selection should go)*. *(Amended 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* The assistant open in the drawer is in the URL the same way, `/office?assistant=<id>`.
- While the Office is open, a thread clicked in the sidebar, chosen in the Go menu, or opened from a notification selects its colleague and opens its thread in the drawer, without leaving the Office. A thread with no colleague (see below) opens its thread screen, as it does from any other screen. *(Amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* ~~An assistant has no colleague in the Office yet, so an assistant clicked in the sidebar, chosen in the Go menu or opened from a notification leaves the Office for its Conversation.~~ *(Amended 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* An assistant works the same way: clicked in the sidebar, chosen in the Go menu, or opened from a notification, it selects its colleague and opens its Conversation in the drawer, without leaving the Office. Every assistant has a colleague, so none leaves the Office. The sidebar marks the row of the assistant the drawer shows.

**Who is in the Office.** `decideOfficeSeating` in `@hercule/client-core` decides it, from the records the sidebar already reads: threads, projects, workspaces and runners. *(Amended 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* It also takes the assistants and their current sessions, which the sidebar's Assistants section already reads. The Office reads nothing else, and adds no operation, live topic or launch read to the API.

- The Office seats the threads the sidebar's foot counts: those whose pose is working, waiting or idle. Asleep and away threads have no colleague, so hundreds of old threads never fill the Office. The sidebar still lists them.
- *(Added 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* **Every assistant is always drawn, in every pose,** unlike a thread. Assistants are few, the sidebar lists every one of them, and an assistant that can't be reached should be easy to spot. Each assistant has its own corner in the Secretariat (see the fixed rooms below), and the corners follow the sidebar's order, by name. `decideOfficeSeating` returns the assistants in that order as `secretariat`. An assistant with no session yet is idle, as in the sidebar.
- Each project with a seated thread has a room. Rooms keep the order in which the controller lists the projects, and are not sorted ~~by latest activity as the sidebar's projects are~~ by their threads *(amended 2026-10-08, [#473](https://github.com/theagenticage/hercule/issues/473): the sidebar's projects are sorted by their newest thread's creation time)*: a room is a place, and a place that moves whenever a thread works cannot be found again. The threads with no project share one room, "No project", which comes last.
- Inside a room, desks are grouped by workspace, in ~~the sidebar's~~ the web sidebar's workspace order (`rankLane`) *(amended 2026-10-08, [#473](https://github.com/theagenticage/hercule/issues/473): the desktop sidebar no longer groups by workspace)*, so threads that share a working copy sit side by side. Inside a workspace the oldest thread sits first, so a desk keeps its place when a new thread starts.
- A thread with an open Request stands in the queue at the user's desk, longest waiting first. An idle thread sits in the Lounge. Both keep their desk, to walk back to. *(Amended 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* A waiting assistant stands in the same queue, together with the threads, longest waiting first. An idle assistant stays at its writing desk, not in the Lounge.
- A colleague wears its thread's look: `buildLook` seeds it with the session id, as for the sidebar's faces, so a thread's face and its colleague match. *(Amended 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* An assistant's colleague wears the assistant's look: `buildAssistantLook` seeds it with the assistant's id, as for the sidebar's faces.
- *(Added 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* A pose change never builds the building again. Only adding, removing or renaming an assistant changes the Secretariat, as only a new room or desk changes the rest of the building.

**The Office Map.** The Office is built from a plain, typed `OfficeMap` value in the renderer, not from code that knows the Bureau. v1 has one map, the Bureau. The value holds:

- its id and its name;
- the name of its growth strategy: `"gallery-wings"`, wings of rooms along the Gallery, the main corridor;
- what a wing and a room stand for. In v1 a wing stands for nothing (`wing: "none"`) and a room for a project (`room: "project"`). A map of a code base would set `wing: "project"` and `room: "module"`;
- the furniture at each desk;
- the fixed rooms, each with its furniture and the spots that furniture offers: a seat, a place to stand, a place in the queue.

The growth strategy, the furniture's geometry and the animations stay in code. The value has no schema, and nothing imports or stores a map: both arrive with the Office Map system ([Seed: the Office Map system (#336)](https://github.com/theagenticage/hercule/issues/336)).

**The fixed rooms:**

| Room | What happens there |
|---|---|
| Your Office | The user's desk, and the queue in front of it |
| The Lounge | Idle colleagues sit there |
| The Triage room | Triage's desk and the case board. The desk stays empty until Triage exists ~~([#91](https://github.com/theagenticage/hercule/issues/91))~~ ([#533](https://github.com/theagenticage/hercule/issues/533), amended 2026-10-10 by [#395](https://github.com/theagenticage/hercule/issues/395)), and Triage's sessions then sit there. The first run's room draws Triage at that desk, so Triage shows in the first run and not yet in the Office |
| The Secretariat *(added 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505))* | Every assistant has its corner there: a writing desk, an armchair and a bookcase. One longcase clock stands against the north wall. The room is the annex south of Your Office |
| The Lobby | The front door, from the street |

*(Added 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* **The front row** holds four fixed rooms along the street, in this order: Triage, the Lounge, Your Office, the Lobby. **The Secretariat is an annex:** it stands south of Your Office, between it and the street, as wide as Your Office, and its one door opens into Your Office. A waiting assistant has a short walk to the queue. The building is then a T, so it grows in two directions: project rooms widen it, and assistants deepen the Secretariat a row of two corners at a time. The second assistant opens the second column, which widens Your Office once, to the Secretariat's width; from then on only the depth grows. A fifth room in the front row would have made the building one room wider for every user, and with few projects every row is stretched to the building's width. An Office Map names its one annex, and the room it stands south of, in `annex`. With no assistant there is no Secretariat, so no annex and no lawn: an empty room would cost GPU memory and depth for nothing, and the Office looks as it did before assistants.

*(Added 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* **The lawn.** The pavement stays one straight line along the street, at the Secretariat's south wall. The ground either side of the Secretariat, between the front row and the pavement, is lawn, and a paved path crosses it from the front door to the pavement. The lawn west of the Secretariat holds picnic tables, up to three. Nobody walks on the lawn yet: the tables are scenery, and a later ticket may send colleagues out to them.

*(Added 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* **The Secretariat** is one room shared by every assistant, not a room each. Most users have one to three assistants, so a room each would be mostly empty walls, and every room costs GPU memory. A room in the Office Map also stands for a project, so rooms for assistants would need a second kind of room in the rows meant for projects.

- **Each assistant's corner** is a writing desk, an armchair and a bookcase, grouped together. The corners follow the sidebar's order, by name (`buildAssistantRows`). The room grows with the number of assistants, as the Lounge grows by its seating groups. With one assistant, the room still looks furnished, not bare.
- **The bookcase** has empty shelves, sized for 24 topic books and one ledger: 24 is memory's topic cap (spec 12 §6.4), and the ledger stands for `core`. The shelves are empty because memory does not exist yet ([#93](https://github.com/theagenticage/hercule/issues/93)), so an assistant remembers nothing. A bookcase has no hover state and no click.
- **The longcase clock** stands against a wall, where it reads well from the overview. Its hands show the current local time and move once a minute, which costs one frame a minute. They move also while the Office stands still, because a clock that stops on battery is wrong. While the window is hidden, the clock draws no frames, and when the window shows again, the hands jump to the time. The hands cast no shadow, so the sun's shadows, which are drawn once, are never drawn again for them. The pendulum hangs still, and the clock has no chime, no hover state and no click.
- The clock and the bookcases come to life with [#506](https://github.com/theagenticage/hercule/issues/506), once heartbeats ([#94](https://github.com/theagenticage/hercule/issues/94)) and memory exist. Until then neither shows anything that is not true: the clock tells the real time, which claims nothing about heartbeats, and the shelves are empty.
- "Secretariat" is a room name, like the Lounge, and is set in the UI face, as every room name is.

*(Added 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* **Where an assistant is, by pose.** The pose is `decideAssistantPose`'s, as in the sidebar.

| Pose | Where | What it does |
|---|---|---|
| working | its writing desk | writes |
| idle | its writing desk | the Office's happenings: reads the newspaper, sips tea, fetches tea |
| waiting | the queue at Your Office, together with threads, longest waiting first | raises its hand, as a thread does, and walks back to its desk once answered |
| asleep | its armchair | dozes: eyes closed, head tilted. Only the ambient breathing moves, and nothing moves while the Office stands still |
| away | its armchair | wears the away face, and its name tag reads "can't be reached" (`describePose`) |

Moving between poses uses the same walks as a thread's pose change:

- **Waking,** from asleep or away to working or idle: the assistant stands, stretches and walks to its desk.
- **Falling asleep, or going away:** it walks to its armchair, sits and dozes.

The prototype's Post Room, Parlour, Library, Records, Dispatch and Reading Room are left out, because nothing happens in them yet.

**Room names and plaques are set in the UI face.** The prototype set them in Limelight, which is used only for the wordmark and numerals ([Design system](#design-system)), and room names in it are hard to read.

**Selecting a colleague:**

- Hovering over a colleague makes it perk up and shows its name tag.
- Clicking a colleague glides the camera to it and follows it, and opens its card. The card shows the colleague's face, its thread's title and pose, its ~~open Request~~ oldest open Request *(amended 2026-10-06, [#440](https://github.com/theagenticage/hercule/issues/440))* with the Requests dock's answers, and its room, machine and model. The card's words are `@hercule/client-core`'s, as the dock's are.
- Answering from the card answers the Request as the dock does. The colleague lowers its hand and walks back to its desk.
- Open thread on the card, or ⏎, opens the thread screen as a drawer from the right, over the Office. The drawer is the thread screen itself, with its transcript, Requests dock and composer.
  - *(Added 2026-10-06, [#440](https://github.com/theagenticage/hercule/issues/440).)* The drawer shows the thread's spawn lines and the Request pager. Their links open the subagent's page in full, which leaves the Office. The drawer has no tally and no side pane. It holds the `subagent` topic while it shows a thread, so the spawn lines' states stay current.
- *(Added 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* **An assistant's card** shows:
  - its face, its name and "Assistant", where a thread's card shows the thread's title;
  - the pose's word;
  - its oldest open Request, with the Requests dock's answers;
  - its room, "Secretariat", the machine and the model;
  - "Last active 2 h ago", from its current session's `lastActivityAt`. The line is not drawn when the assistant has no session.

  The card's words are `@hercule/client-core`'s, as for a thread.
- *(Added 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* Open conversation on an assistant's card, or ⏎, opens the assistant's Conversation screen as a drawer from the right, over the Office, as Open thread does for a thread. The drawer holds the transcript, the Requests dock and the composer. It does not hold the Conversation's own drawer (Heartbeat, Reminders, Memory), as the thread drawer has no side pane. It holds the `conversation` live topic while it shows an assistant.
- The top bar holds the overview, the Rooms directory and one count per pose. Each count selects the next colleague in that pose. *(Amended 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* The counts include assistants. The Rooms directory lists the Secretariat under "The Office", and `countColleaguesByRoom` counts its assistants.

**Keys:**

| Key | What it does |
|---|---|
| Esc | Steps back one level: the drawer, then the card and the selection, then the room |
| Tab / ⇧Tab | Selects the next or previous colleague waiting on the user, longest waiting first, threads and assistants alike *(amended 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505))*. Only while the focus is on the Office itself: in the top bar, the card, the drawer and the menus, Tab moves the focus as everywhere else |
| ⏎ | Opens the selected colleague's thread in the drawer. *(Amended 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* For an assistant, opens its Conversation in the drawer |
| Q / E | Turns the building 45 degrees |
| `=` / `-` | Zooms in and out |
| F | Finds the followed colleague again |

**The pointer,** a Mac trackpad first and a mouse second: two-finger scroll pans; a pinch zooms toward the pointer, as a mouse wheel does; a left drag grabs the floor; a right or ⌥ drag orbits; a double click on the floor glides there. Walls between the camera and the room in view drop to the dado rail, so the room can always be seen.

**Fixed settings.** v1 has no controls. The theme follows the app's theme, and the light follows the theme: day in a light theme, evening in a dark one. Name tags are the prototype's Smart setting, and its characters are Bean. Its quality is sharp on a Retina display, with the sun's shadows drawn once and redrawn only when the building changes, and no ambient occlusion, which draws the whole Office a second time in every frame. Its liveliness is Calm, and Still when the Office stands still ([Performance](#performance)). While the Office is open, the window draws no blur, and its glass surfaces draw solid ([Rules](#rules), rule 5).

**Printer rage** is the Office's one activity. At random, and at most once every 5 minutes for the whole Office, a working colleague walks to the printer, kicks it and walks back. A colleague that waits on the user never goes, and neither does an assistant, which writes at its own desk while it works *(amended 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505))*. The printer is furniture in the Office Map that offers a spot and an animation, the pattern later activities follow. It never happens while the Office stands still. A trigger on a thread's failed tool calls is left to the Office Map system, because it could fire too often.

**The colleagues' looks:**

- Hats sit on the head, not painted on it.
- Two more of the eight sets of accessories in `WARDROBE` (`apps/desktop/src/renderer/faces/look.ts`) gain a tache, so four of eight wear one. The sidebar's faces wear the same looks, so the book's ACCESSORIES table in `crew.js` changes with it, and `pnpm compare:bureau` keeps comparing equal looks.
- The Office draws details the sidebar's faces have no room for: waistcoat buttons, a watch chain, a pocket square, a flower in the buttonhole, spats. They never contradict the face: a detail is chosen from the look, as an accessory is.
- *(Added 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* An assistant wears its headwear, a cloche, a beret or a headset chosen from its id, as its face does everywhere else (see **The assistant** in [Design system](#design-system)). A thread never wears it.

**What v1 leaves out:**

- the prototype's controls panel and Simulate;
- the performance readout, which only a development build shows;
- the Tower and the Campus, whose code stays on the prototype branch;
- event flow and the pneumatic tubes ([Revisit event flow and the tubes in the Office (#331)](https://github.com/theagenticage/hercule/issues/331));
- the book's "Office: List | Floor" switch, because the List is All sessions, which is post-v1;
- ~~assistants and~~ the sessions of workflow runs, because the app lists only threads. *(Amended 2026-10-06, [#448](https://github.com/theagenticage/hercule/issues/448).)* The app now lists assistants too. ~~The Office still seats only threads, until a ticket decides where an assistant sits.~~ *(Amended 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* Assistants sit in the Secretariat, so only the sessions of workflow runs are left out.

## The Hercule face

*(Added 2026-10-10, [Write the Intake changes and the build tickets that replace #91 (#395)](https://github.com/theagenticage/hercule/issues/395); decided in [The desktop Hercule face (#512)](https://github.com/theagenticage/hercule/issues/512) and [#394](https://github.com/theagenticage/hercule/issues/394) §1.)* The sidebar has two faces, as [./14-web-app.md](./14-web-app.md) §App shell settled and the book's sidebar draws them (`crew.js`): **Threads**, the user's threads and assistants, and **Hercule**, the places of Hercule itself. [Intake](#intake) is the Hercule face's first screen. #512 builds the face, as slice 24.

A row for Intake above the threads, on the Threads face, was considered and dropped: it is the "Stack" form that spec 14 rejected after its prototype rounds ([#51](https://github.com/theagenticage/hercule/issues/51)).

**The switch.** A segmented control, **Threads | Hercule**, sits at the top of the sidebar, under the traffic lights' strip, as the book draws it.

- Under it come the shared row of New thread, Search and Office, then Waiting on you. Both show on both faces. Then comes the face's own list, and the foot, which is the same on both faces.
- The control is reachable with Tab, and ← and → move between its two segments, like any segmented control. View › Threads `⌥⌘1` and View › Hercule `⌥⌘2` switch it from anywhere ([Native behaviour](#native-behaviour)).
- **The Hercule segment shows Intake's To do count,** "Hercule 8", in marigold, the book's `count--you`, and hides it at 0. So the work that waits on Intake stays in sight while the user works in threads. The count is defined under [Intake](#intake). The segment's accessible name carries it: "Hercule, 8 to do".

**The face follows the screen:**

- Intake shows the Hercule face.
- A thread, the new-thread screen and an assistant's Conversation show the Threads face.
- The Office and Settings keep the face that was showing, because their ways in sit on both faces: the Office in the shared row, Settings at the foot. So nothing on the sidebar moves when Settings opens, as [The frame](#the-frame) requires.
- The switch changes the face without leaving the open screen. The next screen that has a face of its own sets it again.
- At launch, a screen that keeps the face shows the Threads face.

**The rows.** Only rows whose screen exists are drawn, in the book's order, and each new screen adds its row. ~~No row is drawn inert.~~ *(Amended 2026-10-10, [#512](https://github.com/theagenticage/hercule/issues/512).)* Fleet and Connections are the exception: they lead to Settings sections that are not built yet, Machines ([#417](https://github.com/theagenticage/hercule/issues/417)) and Connections ([#416](https://github.com/theagenticage/hercule/issues/416)). Until those land, both rows are drawn inert, as the Settings list draws its unbuilt rows ([The frame](#the-frame)): they show their hover state, do nothing when pressed, and carry `aria-disabled` and the tooltip "Not built yet". The Connections row carries its red dot all the same. Each row becomes a link when its section is built, with no change to the face. With Intake built, the face reads:

- **Work:** Intake, with its To do count in marigold, hidden at 0. The Office's row is not repeated here: it is in the shared row, because it belongs to both faces ([#332](https://github.com/theagenticage/hercule/issues/332)).
- **System:** Fleet, which opens Settings › Machines, and Connections, which opens Settings › Connections and carries the red dot Settings' list carries ([The frame](#the-frame)).
- **Settings is the foot's Settings button.** The book draws Settings twice, as a row in System and as the foot's button, and both open Settings. The desktop draws it once, at the foot, on both faces; on the Hercule face it sits below Fleet and Connections, where the System section's last row would be.
- A row is selected while its screen is open. Fleet and Connections are selected while their Settings section is open, as the foot's button is pressed.
- Before Intake is built (slice 24 alone), the face holds ~~the System section only~~ Waiting on you, which sits above both faces, and the System section, with Fleet and Connections inert *(amended 2026-10-10, [#512](https://github.com/theagenticage/hercule/issues/512))*, and the segment shows no count.

**The face's rows are a plain list,** not a virtualized one. The list is bounded: it holds one row per screen, so rule 1, which virtualizes every unbounded list, does not reach it ([Rules](#rules)).

### What the Hercule face costs

The plan for slice 24, measured by it and recorded in [Measured](#measured):

| Cost | Expected | Measured by |
|---|---|---|
| Processes | none added | the perf script's process count |
| Memory | the face's rows only | the perf script, with the Hercule face showing |
| Idle | no work: no timer, no polling, no animation | the perf script's idle sample, with the Hercule face showing |
| Reads | none beyond Intake's To do count, which arrives on the `signal` topic the app holds once Intake is built. Before that, none | the Network panel, once |
| The first screen's JavaScript | grows by the switch, the face's rows and the two View commands; they join the first screen's chunk | `pnpm build:desktop`'s bundle check, before and after |

## Intake

*(Added 2026-10-10, [Write the Intake changes and the build tickets that replace #91 (#395)](https://github.com/theagenticage/hercule/issues/395); decided in [The desktop Intake screen in spec 17 (#394)](https://github.com/theagenticage/hercule/issues/394) and the tickets it draws on: [#385](https://github.com/theagenticage/hercule/issues/385), [#386](https://github.com/theagenticage/hercule/issues/386), [#387](https://github.com/theagenticage/hercule/issues/387), [#388](https://github.com/theagenticage/hercule/issues/388), [#390](https://github.com/theagenticage/hercule/issues/390), [#391](https://github.com/theagenticage/hercule/issues/391), [#392](https://github.com/theagenticage/hercule/issues/392), [#393](https://github.com/theagenticage/hercule/issues/393), [#397](https://github.com/theagenticage/hercule/issues/397), [#398](https://github.com/theagenticage/hercule/issues/398).)* Intake is the list of what a source or an agent asks of the user: each item is a Signal. This section owns how the desktop draws it. What a signal is, how it is raised, when it leaves, and what its answers do are owned by [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) §9, starting at [The record](./10-triage-intake-and-notifications.md#91-the-record). Every operation named here is in [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md#signal). Intake shows no Notification: Notifications are Hercule's reports on itself, and go to Check-in.

- **The pixel reference** is the Intake drawing, [`docs/design/intake-directions/asks/desktop/intake.html`](../design/intake-directions/asks/desktop/intake.html), drawn on the book's tokens and system. Where the drawing and this section disagree, this section decides: #394 changed the section names, `↩`, the toast, Undo and inbox zero's motion after the drawing was made.
- **The route** is `/intake`, a child of the shell, and a chunk of its own (rule 6). The way in is the Hercule face's Intake row and Go › Intake `⌘⇧I`.
- **The screen,** top to bottom: the bar, with the tabs, the views and the header menu; under it [the split](../design-language.md#the-split), with the list as its main column and the open signal in its side pane; under the list, the foot.

### The count and attention

- **The To do count** is every open signal on To do, across every tab, `fyi` and the triage workflow's rows included. A snoozed signal never counts, until its snooze runs out. Example: 1 Now, 4 from GitHub and 3 from triage show as 8. A count that left rows out would make inbox zero untrue.
- It shows on the Hercule segment, on Intake's row, and on Intake's tabs. It hides at 0.
- **A new Now signal notifies** while the window is not focused ([Native behaviour](#native-behaviour)). Nothing else on Intake notifies.
- **The dock badge, Waiting on you and the Go menu show no signals.** They stay about agents waiting on the user.

### Tabs

- **The tab set is stable:** All, then each plugin with at least one signal kind on, with its mark, then Triage, only while a triage workflow is named ([The Triage tab](#the-triage-tab)). A plugin's tab stays while it has nothing open, so tabs never move under the pointer.
- **Core signals have no tab of their own** unless the triage workflow raised them. Those from another workflow, an assistant, the user or Hercule show under All, each labelled with its source.
- **A tab's count is its To do count,** in every view, hidden at 0.
- **When the tabs do not fit the bar:**
  1. The plugin tabs drop their names and keep the mark and the count. The name moves to the tooltip and the accessible name.
  2. If they still do not fit, tabs from the end move into a trailing **More ▾** menu, each with its name, mark and count. More shows the summed To do count of what it holds, in marigold, when it is above 0.
  - All and Triage never shrink and never move into More.
- A tab shrunk to its mark keeps the mark when Appearance's Marks is off, because nothing else names it. Rows follow the Marks setting, as every row with a source mark does ([Appearance](#appearance)).

### Views

The bar's four views: **To do**, **Later**, **Done** and **Everything**. To do, Later and Done list signals, as `signal.query`'s views define them ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#97-snooze-and-not-urgent)). Everything lists events ([Everything](#everything)). The view and the tab combine: GitHub's tab in Later lists GitHub's snoozed signals.

- **Later** shows when each signal comes back: "Back Monday 09:00".
- **Done** shows each signal's outcome, newest first, as [When a signal leaves](./10-triage-intake-and-notifications.md#96-when-a-signal-leaves) records it. A replaced signal reads "Replaced by a newer one" and links its successor.

### The list on To do

- **Sections on the All tab:**
  - **Now:** the signals of priority `urgent`, pinned at the top. The section is drawn only while it holds a row.
  - **Signals:** plugin signals, and core signals from other workflows, from assistants, from the user and from Hercule, each labelled with its source. "Signals" is the one word for them across the app, the CLI and the docs.
  - **From triage:** the rows the named triage workflow raised, drawn quieter.
  - A plugin's tab shows Now and Signals for that plugin only. The Triage tab shows From triage only.
- **Hercule's offers,** the Ignore Rule suggestions ([Ignore Rules](./10-triage-intake-and-notifications.md#99-ignore-rules)), sit in Signals with Hercule's face as their mark. They are not on the Triage tab, because triage did not raise them.
- **Order inside each section:** the rows marked "Back" first, oldest `until` first, then the rest oldest first. Now too: the signal that has waited longest comes first.
- **A row** is one line, cut with an ellipsis, in both densities: the source's mark, the title, then who asks, the kind and where, then the age. The split's motion depends on rows of one line ([The split and its minimums](#the-split-and-its-minimums)).
  - A signal of priority `high` shows a small marigold mark at the row's end. It does not reorder the list.
  - A Now row shows its Your work line, such as "Fixing in *Fix 3-D Secure checkout*", when a thread or a Task is on it; otherwise who asks, the kind and where. "Escalates at 11:23" waits for a `when` block, which has no schema yet.
  - `unsure` shows its kind: "Unsure".
  - A row whose snooze ran out shows "Back".

### Row controls and the bulk bar

A row shows its controls on hover and on keyboard focus. Every control here only changes the user's own list and sends nothing to the source, which is why the design language lets them sit on a row ([../design-language.md](../design-language.md)). An answer, which sends something, is never on a row.

| Row | Controls |
|---|---|
| To do: a plugin kind, or `fyi` | Snooze, Done, checkbox |
| To do: `proposal`, `offer` or `unsure` | Snooze, checkbox |
| Now | Snooze, Done, Not urgent, checkbox |
| Back | as its kind |
| Later | Unsnooze, and Done when its kind has one |
| Done view | none |
| Everything | none |

- **Done's tooltip is its describe line,** such as "Takes it off your list. GitHub is not told". Done is the core's action ([Actions, Done and Hand to an agent](./10-triage-intake-and-notifications.md#94-actions-done-and-hand-to-an-agent)); the app calls `signal.markDone`.
- **Dismiss is never on a row.** It is an answer, in the pane.
- **Checks.** A checked row wears the selected tint. Checks belong to one view, and switching views clears them.
- **The bulk bar** shows while any row is checked: "3 selected", then its buttons.
  - Snooze always shows. Done shows when at least one checked row has it. In Later, the bar offers Unsnooze and Done.
  - The app sends only the ids the action applies to. With one `github/mentioned` and two `proposal` rows checked, Done sends one id.
  - Rows the action skipped stay checked, so the bar then reads "2 selected · Snooze".
  - There is no confirmation step: the highlight below shows what a button will do before the click.
- **The bulk highlight.** While the pointer or keyboard focus is on a bulk button:
  - the checked rows it skips fade to 40% opacity;
  - the rows it acts on get a 2px accent rule at their left edge, in green, because it marks the move the user is about to make;
  - the bar names the split: "Done 3 · keeps 2 proposals". The wording names kinds, never "from triage", because any run can raise a core kind.
  - When the button acts on every checked row, nothing fades and every row gets the rule.
  - The highlight shows with no delay, so it keeps up with the pointer. On `E` or a click, the acted-on rows hold for one beat, `--dur-2`, then leave; the skipped rows return to full opacity, still checked. With Reduce motion, the highlight shows with no transition and the beat is skipped.
- **No Undo** in v1. A mistaken Done stays done and is found in the Done view; a mistaken snooze is undone with Unsnooze in Later.

### Snooze and Not urgent

- **Snooze** opens a menu of five choices, from client-core, in the user's time zone setting:
  1. In 1 hour
  2. This afternoon at 14:00, shown before 13:00; This evening at 18:00, from 13:00 until 17:00; greyed out after 17:00, so the keys never move
  3. Tomorrow 09:00
  4. Monday 09:00, a week ahead on a Monday
  5. Pick a time
  - The app calls `signal.snooze`; Unsnooze calls `signal.unsnooze`. What a snooze does to a signal is [Snooze and Not urgent](./10-triage-intake-and-notifications.md#97-snooze-and-not-urgent)'s. A Now signal can be snoozed.
- **Not urgent** sits on a Now row, and in the pane of a Now signal. It calls `signal.lowerPriority`, which lowers the signal from `urgent` to `high`: the row moves to Signals and wears the `high` mark. It sends nothing to the source. It only lowers: v1 has no way to raise a signal to Now.

### The pane

The open signal fills the split's side pane. Top to bottom:

- **The provenance line:** the source's mark and name, and the kind's label, such as "GitHub · Mentioned". A plugin signal's line links its kind's row in Settings › Intake, with the signal's Connection selected: `/settings/intake?kind=github/mentioned&connection=<id>` ([Settings](#settings)). A core signal's line names its source, links nothing, and reads "Hercule" for the core's own offers.
- **The title,** who asks, where, and when.
- **The blocks,** drawn as [Blocks](./10-triage-intake-and-notifications.md#95-blocks) defines them, at most 8:
  - Text as markdown.
  - Messages as a conversation: each message with its author's avatar, or initials when there is none, its time and text. The message that mentions the user carries a marigold rule at its left. A message's file and line, its recipients, its attachments' names, "and N more" for the messages left out, and "Read the rest" for a cut message, which opens its `url`.
  - Change as the branch pair, the file count, additions and deletions, and the checks' summary.
  - Checks as one row per failed or pending check, with its log in monospace when it has one, then the passed count and "and N more".
  - A block of a type the app does not know draws one quiet line, "This part can't be shown here.", never nothing, so the user knows something was left out.
  - Images inside blocks load only here, for the open signal ([Content-Security-Policy](#content-security-policy)).
- **Your work and Sources** have fixed places outside the blocks, under them: Your work names the threads and Tasks on the signal, such as "Fixing in *Fix 3-D Secure checkout*" or "Triage at 11:00 added 38 events to this task"; Sources links the events behind it. Both are computed on read, never stored.
- **The build-failed line.** When the plugin could not draw the signal, a quiet line reads "GitHub couldn't draw this signal. Showing the event as it came in." ([Actions, Done and Hand to an agent](./10-triage-intake-and-notifications.md#94-actions-done-and-hand-to-an-agent)).
- **A Screening line,** when the signal was raised without one: "Not screened: the Screener failed" or "Not screened: no workflow screens signals" ([Screening and the Screener](./10-triage-intake-and-notifications.md#98-screening-and-the-screener)).
- **The answers,** at the foot of the pane, in this order: the plugin's actions, then Hand to an agent (one per workflow that takes the signal's kind), then Done. At most one is primary, drawn as the suggested answer. Each answer shows its describe line on hover and on focus. What each does is [Actions, Done and Hand to an agent](./10-triage-intake-and-notifications.md#94-actions-done-and-hand-to-an-agent)'s.
  - **The Reply box.** An action with a `field`, such as Reply, Request changes or Comment, opens a text box with its placeholder. The box shows the typed text in full, and the describe line leaves it out. `⌘↩` or the button calls `signal.act { signalId, actionId, text }`.
  - Every other answer calls `signal.act { signalId, actionId }`, except Done, which calls `signal.markDone`.
  - **A proposal** offers Accept, the primary answer, which creates the Task, and Dismiss. The pane shows the Task Accept will create.
  - **Hercule's offer** offers Ignore, the primary answer, and Dismiss. Its pane counts the matching open signals when it opens: "3 open now".
  - **A failed answer** shows its error under its button, in `--fail`, as a failed save does in Settings. The typed text stays, so the user can try again. It never goes in a toast.
  - In the Done view, the outcome shows in place of the answers. A "Handed to *workflow*" outcome shows the run's state, such as running or failed, read-only; it never puts the signal back on To do.
  - A teammate's review on a team review request shows as context in the pane. It does not end the signal.
- **Resolved elsewhere.** When the open signal is resolved while it is open, from GitHub, the CLI or another client, the pane stays, and the outcome shows in place of the answers: "Resolved elsewhere: answered on GitHub by Ana". A reply being typed is kept. The pane changes only when the user moves on.
- **The pane's menu** holds "Open on GitHub" (the source's name), and "Ignore signals like this…" for a plugin kind. It is hidden for core kinds, and never on a row.
  - **The Ignore dialog** lists the kind's match fields, each a checkbox with its label and the signal's value, all checked. At least one must stay checked. It says how many open signals the rule will also take off the list: "This also takes 3 open signals off your list". It links the kind's row in Settings › Intake: "To stop all review requests, switch the kind off". Create calls `ignoreRule.create` ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md#ignorerule)); what a rule does is [Ignore Rules](./10-triage-intake-and-notifications.md#99-ignore-rules)'s.
- **The pane's foot** lists the keys.

### The Triage tab

The Triage tab shows the signals the named triage workflow raised: the signals whose `origin.workflowId` is the workflow the user setting `intake.triageWorkflowId` names, set at the first run to the shipped Triage. The app picks them out of the To do list it already holds, so the tab needs no read of its own. What triage does is [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) §1 and §2's.

- **The header:** "Last ran 11:00 · 212 events · next 13:00". The count is Intake's events inside the last run's window ([Intake's events and handlings](./10-triage-intake-and-notifications.md#910-intakes-events-and-handlings)); "next" is the workflow's trigger's `nextFireAt`. After a failed run it reads "Last run failed 11:00"; the failure itself goes to Check-in.
- **The summary:** the run's final message, under the header, in a quiet tone, on the Triage tab only.
- **The header's menu** has "Use another workflow…", a picker of workflows. When the named workflow is deleted or disabled, the tab shows "No triage workflow. Pick one", with the same picker, and the header hides.
- There is no Run now in v1.

### Everything

Everything lists events, not signals: Intake's events, newest first, back to the retention horizon. Which events those are, and what came of each, is [Intake's events and handlings](./10-triage-intake-and-notifications.md#910-intakes-events-and-handlings)'s. The app reads them with `event.query` and its `intake` flag ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md#event)).

- **The header** states the horizon: "Events from the last 90 days".
- **A search field** searches titles and authors. Typing waits about 200ms before it queries.
- **The filter menu** has no title and no counts. Its options are captions: "All events", "Raised a signal", "Pending triage" and the others. Its accessible label is "What came of it". The word "handling" is never shown.
- **A row** shows the system's mark, the title, the author, the time, and what came of the event: the first 2 handlings, in spec 10's order, then "+N" for the rest, such as "→ signal · on your To do list · +2". A fixed number needs no measuring on resize, and a test can check it.
  - "→ ignored · rule *text*" links the rule's row in Settings › Intake, or reads "deleted" when the rule is gone.
- **No counts and no row controls** on Everything.
- **The event pane** holds, top to bottom: the system's mark, the event kind and "Open in *system*"; the title and the time it was received; **What came of it**, one block per handling, each with its link; then the Connection and the event's refs. No body and no payload. The kind links its row in Settings › Intake, with the event's Connection selected.
- **It does not update live.** It reads again when it opens and when the search or the filter changes. It is virtualized (rule 1) and read page by page.

### The split and its minimums

Intake uses [the split](../design-language.md#the-split): the list is the main column and has the width, and the pane takes the rest.

- The list's width starts at the drawing's 432px. Its minimum is 360pt and the pane's is 400pt. Below a window of about 1032pt, with the sidebar showing, the pane hides and its toggle says why: "Widen the window to show the pane".
- With the pane closed, rows are at most 960px wide.
- A click on a row selects it and opens the pane. The pane closes when nothing is selected.
- **Esc:** the first Esc closes the pane and keeps the row selected; a second Esc clears the selection. Anything smaller, such as an open menu, is let go first.
- Opening and closing animate the list's width with the pane's slide, the one width animation rule 2 allows ([Rules](#rules)), because every row is one line. A row that wraps would end the exception.

### Keys

Keys work only while focus is in the list or the pane, never while it is in a text field.

| Key | Does |
|---|---|
| `J` / `K`, `↓` / `↑` | moves the selection down or up |
| `X`, `⇧J` / `⇧K`, `⇧↓` / `⇧↑` | checks the selected row; the shifted keys check while moving |
| `↩` | on a row: opens the pane and puts focus on the suggested answer, whose describe line is then in view. A second `↩` presses it |
| `E` | Done, on the checked rows or else the selected one |
| `H`, then `1` to `5` | Snooze, with the menu's choice |
| `U` | Unsnooze, in Later |
| `R` | opens the Reply box; nothing when the signal has no action with a field |
| `⌘↩` | sends the Reply box |
| `O` | opens the signal on its source, in the default browser |
| Esc | steps back, as above |

`↩` never answers from the list in one press. The drawing's `↩` took the suggested answer at once, so `J`, `J`, `↩` could approve a pull request the user never read. The Requests dock already answers from the keyboard only while it has focus.

### Motion

Every animation here is `transform` or `opacity` on an HTML element, at most `--dur-3` per step, and stops with Reduce motion. Rule 2's amendments allow it ([Rules](#rules)).

**Inbox zero's arrival** plays only when the user's own action empties To do. Opening Intake on an empty list, or a change made elsewhere that empties it, shows the same picture still. With Reduce motion, it shows still.

1. The last row fades, over `--dur-1`, and the pane slides shut.
2. The sunburst draws itself: 24 brass rays, each its own HTML `<span>`, long and short in turn, grow outward from their inner end, `scaleY` from 0 to 1 over 320ms, each 12ms after the one before, clockwise from the top. The drawing animated SVG paths, which rule 2 forbids.
3. At 120ms, Hercule hops in: the face scales from 0.6 to 1 on `--ease-spring` while its wrapper hops 8px, in the pose `done`.
4. At 260ms, six brass sparks fly out from behind Hercule and fade, once.
5. From 240ms, "Inbox zero", the line, the cleared count, the source pills and the triage line rise 6px each, 60ms apart.

The arrival takes 800ms, and then nothing runs. **The line** follows the moment, in the user's time zone setting:

- "The rest of the morning is yours." before 12:00;
- "The rest of the afternoon is yours." from 12:00;
- "Go home." from 18:00;
- "Have a good weekend." on Friday from 12:00;
- "Nothing needs you this weekend." all day on Saturday and Sunday.

With a triage workflow named, the triage line under it reads "triage runs at 13:00", from its trigger's `nextFireAt`.

**Changes the user did not make:**

- A new signal fades in and drops into place over `--dur-2`. The rows below make room with a transform, never by animating height.
- A signal resolved elsewhere leaves as the user's own Done does: it fades, then the gap closes.
- A burst animates as one block: a triage run that raises 30 signals slides in once, not as 30 rows one after another.
- **Nothing moves under the pointer.** While the pointer is over the list, arrivals and departures wait, and apply with their motion once it leaves. Otherwise the user aims at Approve on #1294, a Now row arrives above it, and they approve the wrong signal.
- The keyboard selection stays on the same signal, never on the same position.
- Only rows on screen animate. A change to a row out of view applies at once.

### The foot, the toast and failures

- **The foot** sits under the list: "7 cleared today. 3 left on their own: answered elsewhere or withdrawn. See Done." With none left on their own: "7 cleared today. See Done." With none cleared, there is no foot. "Today" starts at midnight in the user's time zone setting. A replaced signal is not counted.
- **The toast** says what the user's last move did: "Approved #1294", "Snoozed until Monday 09:00", "Marked 3 done. Kept 2 proposals". It fades after 5 seconds, stays while the pointer is on it, and the next toast replaces it. It has no Undo.
- A failed answer shows under its button, never in a toast ([The pane](#the-pane)). A failed Done, Snooze or Not urgent shows its error in the toast's place, in `--fail`, and the rows stay where they were.

### What the screen reads

- `signal.query`'s To do view, read whole, because it is short by nature; Later and Done page by page.
- `event.query` with `intake` for Everything, page by page.
- The triage workflow's last run, and its trigger's `nextFireAt`.
- `plugin.query`, for each plugin's name and mark.
- The `signal` live topic. A push names the signals that changed, and the app reads To do again. The topic stays subscribed while the window is hidden, as `session` does, because the Hercule segment's count and Now's notifications depend on it ([Rules](#rules), rule 3). The shell subscribes to it, not the screen.
- The To do list is virtualized like every list (rule 1), though it is read whole.
- The first page of Later, soonest first, gives the soonest snooze's `until` for the snooze timer ([Rules](#rules), rule 4). The shell reads it with the count, so the timer runs while Intake is closed.

**Interpretation goes to `@hercule/client-core`,** each function with its own tests: the sections and their order, which controls a row gets, the tab set and what moves into More, which checked rows a bulk action takes with the bar's and the toast's wording, the foot's two numbers, the triage header, the snooze choices, the handlings' cut-off, and the inbox zero line. How that splits into functions, and their names, is the implementer's choice. One possible split: `groupSignalsIntoSections`, `decideSignalRowControls`, `buildIntakeTabs`, `planBulkAction`, `countClearedToday`, `describeTriageHeader`, `buildSnoozeChoices`, `cutHandlings`, `describeInboxZero`.

### What Intake costs

The plan for slices 25 to 35, each measuring its part and recording it in [Measured](#measured). No prototype measurement comes first: Intake is lists and text, the work the thread list already measured.

| Cost | Expected | Measured by |
|---|---|---|
| Processes | none added | the perf script's process count |
| Idle | no work, except one timer, set for the soonest snooze's `until`. It fires once; the app then reads To do again and sets the next. The app also reads To do again when the Mac wakes. The `signal` topic sends nothing while nothing changes. The toast's 5-second fade is a one-shot timer after a user action, not idle work | the perf script's idle sample, with Intake open and a snooze due in an hour |
| Lists | To do read whole; Later and Done page by page; Everything virtualized and page by page, with no live updates | the perf script, with 200 signals on To do |
| Memory | within the app's memory row with Intake open and 200 signals on To do | the perf script |
| Per push | one compositor-only animation, only for rows on screen; a burst is one animation | the Performance panel, once, with a burst of 30 |
| Inbox zero | 800ms of compositor-only animation per arrival, nothing after | the Performance panel, once |
| Opening or closing the split | layout on each frame of the transition, no dropped frame with 50 rows in the list, nothing after | the Performance panel, once |
| Images | loaded only for the open signal | the Network panel, once |
| The first screen's JavaScript | grows only by the Go item, the `/intake` route stub, the `signal` subscription and the count. Intake is a chunk of its own, loaded the first time it opens | `pnpm build:desktop`'s bundle check, before and after |

## Settings

*(Added 2026-10-04, [Write the Settings port into spec 17, and its build tickets (#402)](https://github.com/theagenticage/hercule/issues/402), for [Desktop Settings: a quick port, and a new model for providers (#401)](https://github.com/theagenticage/hercule/issues/401).)* Settings is a port. It brings the web app's Settings to the desktop, drawn in Bureau, with the Appearance page added. It adds no operation to the public API. The one new piece of state is the Appearance, which main keeps in its settings file.

- **The pixel reference** is the book's three settings pages: `desktop/settings-appearance.html`, `desktop/settings-assistants.html` and `desktop/settings-connections.html`. *(Amended 2026-10-09, [#494](https://github.com/theagenticage/hercule/issues/494).)* A fourth page, `desktop/settings-profiles.html`, draws Permission profiles.
- **The book does not draw the other sections:** Profile, Threads, Machines, Plugins and System. Their content is the web screen's ([./14-web-app.md](./14-web-app.md) §V1 screen inventory). They are drawn only from the pieces the three pages use: `set-sec` with its heading and lead, `set-row` with `set-label`, the segmented control, the toggle, the select field, the table rows of the Connections page, and the tabs of the Assistants page.
- **What a section shows is what the contract holds.** Where the book draws something no operation reads or writes, the section leaves it out and says so below. A row is never drawn with data the app does not have.
- **The renderer imports no web code.** It never imports `@hercule/ui` or `apps/web`. What the web screens interpret, such as thread defaults, provider rows, assistant forms and config fields, is already in `@hercule/client-core`, and the desktop calls the same functions. A web helper that is still in `apps/web` moves to `client-core`, with its test, in the slice that first needs it on the desktop.

### The frame

The frame is the book's: the app's sidebar stays, and the main pane holds the Settings list beside one centred column.

- **Three columns.** The sidebar is ~~the Threads face, unchanged~~ the face that was showing, unchanged *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#512](https://github.com/theagenticage/hercule/issues/512))*, 272px. The main pane holds the book's `.settings` grid: the Settings list, 216px, then the section's body, whose column is at most 760px wide and is centred.
  - The book draws the sidebar on its Hercule face, with a Settings row selected. ~~The desktop has only the Threads face ([Scope](#scope-of-the-first-milestone)), so the sidebar shows the threads, and~~ *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#512](https://github.com/theagenticage/hercule/issues/512).)* Settings keeps the face that was showing ([The Hercule face](#the-hercule-face)). The foot's Settings button shows as pressed while Settings is open, as the Office button does for the Office.
  - *(Decided 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* The Settings list does not replace the sidebar, as [#401](https://github.com/theagenticage/hercule/issues/401) first proposed. The book's frame keeps the threads one click away, and nothing on the sidebar moves when Settings opens.
- **The way in:**
  - the sidebar foot's Settings button, which is no longer inert;
  - the app menu's Settings… `⌘,`, under About, as macOS places it. It sends `openSettings` on `menu.command`.
  - Both open the section last opened while the app runs, and Appearance the first time, as the book's foot button links to it. The section is not kept across launches. *(Amended 2026-10-09, [#494](https://github.com/theagenticage/hercule/issues/494).)* For Permission profiles, the section remembered is its list, `/settings/permission-profiles`, never one profile's page.
- **The way back** is the sidebar: a thread, New thread~~ or the Office~~, the Office or Intake *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395))* leaves Settings. Settings has no close button and no back button, because the sidebar never left.
- **The header** is the book's `.bar`: the crumb "Settings /", the section's name as the title, and on the right either the section's primary button ("New assistant", "Add a Connection", "Add a machine") or, on Appearance, "Saved on this Mac". The other sections have nothing on the right. *(Amended 2026-10-09, [#494](https://github.com/theagenticage/hercule/issues/494).)* Permission profiles' list has the primary button "New profile". The page of one profile has the crumb "Settings / Permission profiles /", with "Permission profiles" a link back to the list, the profile's name as the title, and nothing on the right.
- **The Settings list** is the book's, in its order:
  - You: Profile, Appearance, Threads, Intake *(amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395): the book's list has no Intake row; it sits under You, after Threads, because what Intake shows is the user's own choice)*
  - Crew: Assistants, Connections, Providers, Machines
  - Safety: Identities, Permission profiles, Secrets, Bounds
  - System: Plugins, System
  - The open section's row is selected. Connections carries the book's red dot while a Connection's status is `error` or `needs-reauth`.
- **Rows that lead nowhere yet are drawn and inert:** Providers, Identities, ~~Permission profiles,~~ Secrets and Bounds. They show their hover state, do nothing when pressed and carry `aria-disabled`, like the sidebar's Search. Each has a tooltip: "Not built yet". They are drawn rather than hidden so the list keeps the shape the book gives it, and does not change shape when they are built. *(Amended 2026-10-05, [#410](https://github.com/theagenticage/hercule/issues/410).)* A section whose slice has not been built yet is drawn inert the same way, and its slice makes its row lead to it. The Connections row shows its dot while inert. *(Amended 2026-10-09, [#494](https://github.com/theagenticage/hercule/issues/494).)* Permission profiles' row leads to its section, and is selected on the list and on a profile's page.
  - Providers comes with the provider remodel ([Write the provider remodel into the specs, CONTEXT.md and an ADR, and its build tickets (#406)](https://github.com/theagenticage/hercule/issues/406)). Until then, a runner's providers are logged in to from Machines.
  - Identities, ~~Permission profiles~~ and Bounds are empty states in the web app too. *(Amended 2026-10-09, [#494](https://github.com/theagenticage/hercule/issues/494).)* Permission profiles is built on the desktop: the web app's screen still says "Permission profiles are not editable yet" ([./14-web-app.md](./14-web-app.md) §V1 screen inventory). Secrets is left out of this port: the secrets a section needs, such as a Connection's token or a provider's key, are set from that section.
- **A narrow window.** At the window's smallest width, 800, the body column is about 230px. While the body is narrower than 520px, a `set-row` stacks its control under its label, and a table drops to one column per row. Nothing clips and nothing scrolls sideways. This is a container query on the body, so the sidebar and the list keep their widths.
- **Saving.** A control saves when it changes, because the book draws no Save button. A text field saves when it loses focus, or on `⌘↵`. A failed save puts the field back to the saved value and shows the error, in `--fail`, under its row. *(Amended 2026-10-09, [#494](https://github.com/theagenticage/hercule/issues/494).)* A toggle button, such as a grant's verb on Permission profiles, saves when it is pressed and goes back to its saved state when the save fails.
- **Routes.** Settings is the layout route `/settings`, a child of the shell, with one child route per section: `/settings/appearance`, `/settings/assistants` and so on. Each is a chunk of its own (rule 6), and none is on the bundle check's list of first-screen routes. Each section's loader prefetches what it reads, and the section subscribes to its live topics only while it is open. *(Amended 2026-10-09, [#494](https://github.com/theagenticage/hercule/issues/494).)* Permission profiles has two routes: `/settings/permission-profiles`, its list, and `/settings/permission-profiles/$id`, one profile's page. Each is a chunk of its own. The page of an id that names no profile navigates to the list instead, replacing its entry in the history. *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* Intake's section is `/settings/intake`. It takes two optional search parameters: `kind`, a signal kind or an event kind, whose row it scrolls to and highlights, and `connection`, a Connection id, which it selects in the plugin's Connection control. Intake's provenance line and Everything's event pane link it this way, such as `/settings/intake?kind=github/mentioned&connection=<id>`. A kind or a Connection that no longer exists is ignored, and the section opens as plain `/settings/intake`.

### Appearance

Appearance draws every control on the book's page. Every control is saved on this Mac, in main's settings file.

| Control | Choices | Default | What it changes |
|---|---|---|---|
| Theme | Whitehaven, Styles, Orient Express, Nile, End House | - | the theme in use while Follow the system is off |
| Follow the system | on or off, with a day theme (Whitehaven or Styles) and a night theme (Orient Express, Nile or End House) | on, Whitehaven by day, Orient Express by night | switches with macOS's appearance between the day and the night theme |
| Density | Comfortable or Compact | Comfortable | the sidebar's thread rows, see below |
| Text size | four steps | the second | the size of text everywhere except titles, see below |
| Glass | 0 to 100% | 40% | `--glass-level` |
| Reduce transparency | on or off | off | every glass surface solid, whatever the Glass level |
| Open on | ~~Threads or The office~~ Where I left off or The office *(amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395))* | ~~Threads~~ Where I left off | what the app shows at launch |
| Reduce motion | on or off | off | every animation stopped, as macOS's Reduce motion stops them |
| Marks | on or off | on | the source marks on rows |

- **The theme cards.** The card of the theme in use is pressed. Picking a card turns Follow the system off and uses that theme. With Follow the system on, the two selects pick the day and the night theme. A day theme is light and a night theme is dark, so the window's frame always matches macOS's.
- **Density** is saved on this Mac, like every other row. It is a choice about how one client draws its rows, and the desktop and the web draw them differently, so a user may want a different density in each.
  - Compact draws each thread row in the sidebar on one line: its face, its title, its mark and its age. Waiting on you keeps its second line, because the open Request is what the user acts on.
  - The book's line, "Compact fits 30% more rows in Intake and the roster", names screens the desktop does not have. The desktop's line is "Compact draws each thread on one line, so more fit in the sidebar." *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* Intake's rows are one line in both densities ([The list on To do](#the-list-on-to-do)), so Density does not change them, and the desktop's line stays.
  - The desktop neither reads nor writes `ui.threadRows`, the user setting the web's Threads › Display row saves on the controller ([./14-web-app.md](./14-web-app.md) §V1 screen inventory, Settings > Threads). That setting stays the web's own.
- **Text size** has four steps. Each step moves the text tokens `--t-11` to `--t-16` by one pixel: the second step is the tokens as they are, the first is one pixel smaller, and the third and fourth are one and two pixels larger. The title tokens, `--t-18`, `--t-20` and `--t-num`, do not change, as the book's line says: "Transcripts follow; titles stay modest." Rows grow with their text; none has a fixed height that clips it.
- **Glass and Reduce transparency.** The page's `--glass-level` is the Glass level.
  - Reduce transparency, the app's or macOS's, sets the level to 0 and the filter to `none`, as the Office does. A Glass level of 0 sets the filter to `none` too (rule 5).
  - The app's toggle and macOS's setting both count: either one makes the glass solid. While macOS's is on, the app's toggle shows as on and is disabled, because turning it off would change nothing. Reduce motion works the same way.
  - `tokens.css` stays the book's file. The renderer never writes `--glass-level` itself: an inline value on the root element would beat the Office's rule, which is not `!important`. It sets a custom property of its own on the root, and a `:root` rule in `base.css` derives `--glass-level` from it. The Office's rule and the Reduce transparency rules are more specific or `!important`, so both still win.
- **Reduce motion** stops what macOS's Reduce motion stops: the CSS animations and transitions, the Office's colleagues (which then stand still) and the first run's room. One renderer function answers whether the app should hold still, from both settings. Every place that reads `prefers-reduced-motion` today calls it instead.
- **Open on.** With ~~Threads, a launch opens the last open thread or the new-thread screen~~ Where I left off, a launch opens the last screen, such as a thread or Intake *(amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#394](https://github.com/theagenticage/hercule/issues/394))* ([Native behaviour](#native-behaviour)). A settings file saved before this change holds `threads`, which reads as Where I left off. With The office, a launch opens the Office, with no thread in its drawer. The stored ~~last thread~~ last screen is kept, not removed, so switching back to ~~Threads~~ Where I left off still reopens it *(amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395))*. A first run, the connect screen and sign-in come first either way.
- **Marks** shows or hides the source marks: the mark of the system a row's work came from, such as GitHub on a start card. Today only the draft's start cards draw one. A row that later draws a source mark follows the same setting. *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* Intake's rows, its pane's provenance line and Everything's rows follow it. A tab shrunk to its mark keeps it, because nothing else names the tab ([Tabs](#tabs)).

**How the Appearance reaches the window before its first paint.** Main reads the settings file at launch, before it creates the window, so main knows the Appearance before any page exists. Main holds the Appearance though the renderer holds it too, an exception to rule 7, for the reason it holds the window state: it paints the window's background before a renderer exists.

- Main creates the window with the `backgroundColor` of the theme in use: Follow the system's day or night theme by `nativeTheme`, else the chosen theme. Each of the five themes has its exact sRGB `--bg` in `window-background.ts` and in `base.css`, and the unit test that derives them from `tokens.css` covers all five.
- `public/theme-init.js` reads the Appearance through the bridge's `appearance.read`, a synchronous call, and sets `data-theme`, the text size, Reduce transparency and Reduce motion on the root element before the first paint. It still listens to `prefers-color-scheme` and switches between the day and the night theme.
  - `appearance.read` is the IPC contract's only synchronous channel. It has to be: the page must know its theme before it paints, and an asynchronous answer arrives after. Main answers it from memory, without touching the disk. A page that reloads, as it does after the controller URL changes, reads the current Appearance again.
- A change made on the Appearance page applies in the renderer at once, in one frame, with no transition (rule 2), and is sent to main with `appearance.save`. Main writes the file and repaints the window's background. The renderer holds the only window, so main sends nothing back.

### The sections

Each section lists what it reads and writes through the contract, its live topics, and where it differs from the web screen and the book.

**Profile.** Not drawn by the book.

- Reads `user.read`, `settings.read` and `connection.query`. Writes `settings.update` (`user.timezone` and `github.defaultConnectionId`) and `auth.logout`. Live topic: `connection`.
- Shows the user's avatar and name, the time zone, the default GitHub account, and Sign out.
- Same as the web screen. Sign out is also in the app menu, as it is today.
- *(Amended 2026-10-05, [#410](https://github.com/theagenticage/hercule/issues/410).)* **The time zone's hint differs from the web screen's:** "Schedules run in this zone, such as a workflow's cron trigger and an assistant's heartbeat. This app shows times in your Mac's time zone." The web's hint says every time on screen is read in this zone, but the desktop shows times in the Mac's time zone (see "Messages carry their own time" under [Design system](#design-system)), because the Mac's clock follows the user when they travel. The setting decides when schedules run on the controller.

**Threads.** Not drawn by the book.

- Reads `settings.read`, `runner.query`, `provider.query` and `profile.query`. Writes `settings.update` (`thread.instanceId`, `thread.model`, `thread.accessMode`, `thread.profileId`, `thread.workspace`). Live topic: `provider`.
- The defaults a new thread starts with: provider instance and model, access mode and permission profile, and the workspace a thread opens in.
- Differs from the web screen: no Display row. The desktop's density is Density on Appearance, saved on this Mac.

**Intake.** Not drawn by the book. *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); decided in [#397](https://github.com/theagenticage/hercule/issues/397) and [#394](https://github.com/theagenticage/hercule/issues/394).)*

- Reads `plugin.read` and `connection.read`, which return the value in effect for every kind with the level it comes from, and `ignoreRule.query` ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md#ignorerule)). Writes `plugin.updateIntake` ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md#runner-plugin-provider-controller-grant-family-infra)), the `intake` field of `connection.update` ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md#connection)) and `ignoreRule.delete`. Live topics: `plugin` and `connection`. What the switches mean, and how the three levels combine, is [./05-plugins.md](./05-plugins.md#82-intake-settings)'s; the server works out the levels, so the section merges nothing.
- A lead line at the top: "Workflows and subscriptions receive every event, whatever you choose here."
- One `set-sec` per plugin that declares a signal kind or an event kind, with its mark and name. Under the heading, a segmented control: "All GitHub connections | work | personal", one segment per Connection of the plugin. "All" edits the plugin's level, and a Connection's segment edits that Connection's.
- Three lists in each `set-sec`:
  - **Signals:** one row per signal kind, with its label, its description and a toggle.
  - **Events available to triage:** one row per event kind, with its label and a toggle.
  - **Ignore Rules:** one row per rule of the plugin's kinds, with the rule's text, "caught 142 in the last 90 days", and Delete. A rule belongs to no Connection, so the list is the same under every segment. With no rules, the list is not drawn.
- **A row that differs from the level below shows where its value comes from,** under its label: "Off · all GitHub connections" when a Connection follows the plugin's choice, or "On · this connection" when the Connection has its own. Such a row has Reset, which writes the value the level below gives, so the server removes the entry.
- Saves on change, as every section does. A toggle that fails goes back to its saved value and shows the error under its row.
- The search parameters `kind` and `connection` ([The frame](#the-frame)) select the segment, then scroll to the kind's row and highlight it once, with the selected tint, which fades over `--dur-3`.
- Differs from the web screen: the web app has no Intake in v1, so it has no such section ([./14-web-app.md](./14-web-app.md#the-intake-view)).

**Assistants.** The book's `settings-assistants.html`.

- Reads `assistant.query`, `provider.query` and `profile.query`, and *(amended 2026-10-07, [#414](https://github.com/theagenticage/hercule/issues/414)/[#415](https://github.com/theagenticage/hercule/issues/415))* `settings.read`: the user's time zone places the heartbeat timeline's "now" line when the heartbeat sets no time zone of its own. The profiles and the settings have no live topic, so the loader reads them each time the section opens. Writes `assistant.create`, `assistant.update` and `assistant.delete`. Live topics: `assistant` and `provider`.
- The book's tabs, one per assistant, with its face and name, and New assistant in the header.
- The book's profile block: the large face and the name.
- How it works:
  - *(Amended 2026-10-07, [#414](https://github.com/theagenticage/hercule/issues/414)/[#415](https://github.com/theagenticage/hercule/issues/415).)* a lead under the heading that says when a saved change reaches the assistant's session, as spec 12 §7 asks of the Assistants settings screen. The book draws no lead there. The sentence is the web form's, from one `client-core` function both apps call;
  - the web form's fields: name, persona (`systemPrompt`), provider instance and model, permission profile, access mode, and reply mode (Turn end or Segments);
  - disallowed tools, as the book's chips with Add, and an × on each chip;
  - ~~the delete move, at the foot of the section, with a confirmation.~~ *(Amended 2026-10-07, [#414](https://github.com/theagenticage/hercule/issues/414).)* The delete move is its own section, "Delete `<name>`", at the foot of the page after Rotation, with a confirmation. At the foot of How it works it would sit between the fields and the Heartbeat, where a destructive move is easy to hit while editing.
- **Heartbeat,** as the book draws it: the toggle, the lead, "Every `<n>` h from `<hh:mm>` to `<hh:mm>` in Web chat", and the day's timeline with a tick at each beat and a "now" line. Under it, the prompt the heartbeat sends.
  - The contract stores the schedule as a five-field cron expression. Two `client-core` functions, each with its own tests, convert between the two:
    - one that reads a cron expression as an interval and a window of hours, or answers that it is not one;
    - one that builds the cron expression from an interval and a window.
  - A schedule that is not an interval and a window, set from the CLI for one, shows as its cron expression, with the line "Set outside the app. Choosing an interval here replaces it."
  - The target is always Web chat, because `target` has no other value yet. The select is drawn with one choice.
- **Rotation,** as the book draws it: "At `<n>`% of the context or `<n>`k tokens, and daily at `<hh:mm>`", from `contextFraction`, `maxContextTokens` and `dailyAt`.
- *(Amended 2026-10-07, [#414](https://github.com/theagenticage/hercule/issues/414)/[#415](https://github.com/theagenticage/hercule/issues/415).)* Until the controller runs heartbeats and rotations ([#94](https://github.com/theagenticage/hercule/issues/94)), each of the two sections says so in one muted line under its lead, so the user is never told a schedule runs when it does not. The lines go when #94 lands.
- Differs from the web screen: disallowed tools, heartbeat and rotation are new, because the web screen has no fields for them.
- **Left out of the book's page,** because no operation reads or writes them, or the desktop has no screen for them:
  - the role beside each name ("personal", "ops"), because an assistant has no role;
  - the line under the name, "personal assistant · working in Web chat", ~~and Open Conversation, because the desktop has no conversation screen~~ because an assistant has no role and the desktop shows no channels. *(Amended 2026-10-06, [#448](https://github.com/theagenticage/hercule/issues/448).)* Open Conversation is drawn, and opens [the assistant's Conversation](#design-system);
  - the context bar and Start fresh under Rotation;
  - Where the assistant listens, its channel bindings;
  - the Memory and Reminders column. Without it, the body is the one centred column.

**Connections.** The book's `settings-connections.html`.

- Reads `connection.query` and `plugin.query` (for the Connection types). Writes `connection.create`, `connection.update`, `connection.delete`, `connection.setCredentials`, `connection.startOAuth`, `connection.startDeviceFlow` and `connection.pollDeviceFlow`. Live topic: `connection`.
- One section, "Connections", in the book's table: each row has the type's mark (a generic mark for a type with none), "`<type>` · `<label>`" with the account name under it, its health, and `⋯` with Reconnect, Configure and Delete.
  - Health is the status as one word, as the book draws "healthy": `connected` reads "healthy", `needs-reauth` "needs sign-in", `disabled` "disabled", and `error` shows its `statusDetail` in `--fail`.
- Add a Connection, in the header, lists the types the plugins declare and runs their setup:
  - pasted credentials;
  - the device flow, as the first run's GitHub step runs it;
  - OAuth: the app calls `connection.startOAuth` with the controller's origin, the origin the web app sends, so the redirect the provider has registered still matches. It opens the authorization URL in the default browser with `link.open`. The browser ends on the web app's Connections page, which shows the outcome. The app shows "Finish in your browser" with Cancel, and the new Connection arrives on the `connection` topic. A failed flow creates no Connection, so the browser is where a failure shows.
- Same as the web screen in what it does; the web draws it as rows, the desktop as the book's table.
- **Left out of the book's page,** because no operation reads them: the stats strip (events in 24 hours, sources, channels, reconnecting), the Default Topic column ([#324](https://github.com/theagenticage/hercule/issues/324) removed it from the web), the Last 24 hours and Events columns, and the Channels section with its bound assistants. With no channel plugin and no binding operation, every Connection is drawn in the one table, so the book's split into event sources and channels is left out too.

**Machines.** Not drawn by the book. It is the web's Fleet list and runner page in one section.

- Reads `runner.query`, `runner.read`, `provider.query`, `session.query` (the runner's queue) and `runner.queryJoinTokens`. Writes `runner.update`, `runner.drain`, `runner.undrain`, `runner.refreshFacts`, `runner.retire`, `runner.installHarness`, `runner.probe`, `provider.login`, `provider.submitLoginCode`, `secret.set`, `runner.createJoinToken` and `runner.revokeJoinToken`. Live topics: `runner`, `provider` and `session`.
- One tab per runner, as Assistants has one per assistant, with its name and whether it is online.
- For the selected runner:
  - its facts and version;
  - its sessions against its capacity, as `describeCapacity` describes them;
  - its name and capacity, edited in place;
  - its provider rows: one `ProviderLogin` per provider instance, the row the first run and the draft's Log in already use, with Install, Log in, Enter key and Probe now;
  - Drain or Undrain, Refresh facts, and Retire with the question `buildRetireQuestion` builds.
- Add a machine, in the header, shows the join command and the open join tokens, each with Revoke.
- Differs from the web screen: the list and the runner page are one section with tabs, not two screens.

**Permission profiles.** The book's `settings-profiles.html`. *(Added 2026-10-09, [#494](https://github.com/theagenticage/hercule/issues/494).)*

- Reads `profile.query`, `agent.query` and `assistant.query`. Writes `profile.create`, `profile.update` and `profile.delete`. Live topic: `assistant`. Profiles and agents have no live topic, so the loader reads them each time the section opens.
- Two pages, as the book draws them:
  - **The list,** `/settings/permission-profiles`. A lead line, "A profile bounds what a session may do through the API. Every agent and assistant runs on one.", then a table with one row per profile, sorted by name with the shipped profiles first. Each row has:
    - a shield mark;
    - the name, with "Shipped with Hercule" or "Made by you" under it;
    - the grant count as "`<n>` of 42", with a meter;
    - Used by: the faces of the agents and assistants on the profile, at most three, and up to two of their names, then "and `<n>` more", or "Nothing";
    - a chevron.
  - A click on a row opens the profile's page. **New profile,** in the header, calls `profile.create` for a profile named "New profile", or "New profile 2" and so on while the name is taken, with no grants, and opens its page.
  - The table narrows as the book draws it: below 600px of body, Used by is dropped, and below 400px the shield is dropped as well. This replaces, for this table, the narrow-window rule above that a table drops to one column per row.
  - **The profile's page,** `/settings/permission-profiles/$id`, in four sections:
    - **Profile.** The Name field, at most 128 characters. It saves on change with `profile.update`. A name that is empty or only spaces is not saved, and the field shows the saved name again. Assistants' Name field works the same way. A shipped profile can be renamed too; that a shipped profile is known by its name is tracked in [#496](https://github.com/theagenticage/hercule/issues/496).
    - **Grants,** with "`<n>` of 42" at the heading's right. A lead, "What a session on this profile may do through the API. A change reaches its sessions on their next call." One row per grant family, in the contract's order, with the family's label and what it covers. The family's verbs are a group of toggle buttons in the segmented control's track: any number may be pressed, and a pressed verb shows a check. Each press saves on change, with `profile.update` carrying the whole grant list. A failed save puts the toggle back and shows the error under the row of the grant that failed, also when a later press was already saving behind it.
    - **Used by.** The agents and assistants on this profile, read-only: the face, the name, and "Agent" or "Assistant". Its lead is "Change an assistant's profile on Assistants.", with Assistants a link to that section. With none, "No agent or assistant uses `<name>`."
    - **Delete `<name>`.**
      - A shipped profile has no Delete. It shows the line "`<name>` is shipped with Hercule, so it cannot be deleted. Edit its grants instead."
      - A profile that agents or assistants use shows Delete… disabled, with a hint that names its agents: "Milo and pr-review use it. Move them to another profile first."
      - Any other profile shows Delete…, with the hint "Removes it and its grants." It opens a confirmation, "Delete `<name>`?" with "This removes `<name>` and its grants. This cannot be undone.", and then calls `profile.delete`. If the controller refuses, for example because a live session still uses the profile, the confirmation stays open and shows the refusal.
- **`unrestricted` asks first.** Threads run on it unless the user picks another profile (the thread defaults in Settings › Threads), so a change to it reaches every such thread.
  - Its Grants section shows an amber note: "Unrestricted is meant to hold every grant, so a session on it can do anything you can. Give it only to work you would do yourself."
  - Every change to its grants, a removal or putting a grant back, opens the confirmation "Change unrestricted?" first. It says which grant changes and that threads run on unrestricted unless the user picks another profile, with Cancel and Change. Cancel leaves the grant as it was.
- Differs from the web screen: the web app's screen is an empty state. Nothing is left out of the book's page.

**Plugins.** Not drawn by the book.

- Reads `plugin.query`. Writes `plugin.enable`, `plugin.disable`, `plugin.retry`, `plugin.resetState` and `plugin.configure`. Live topic: `plugin`.
- One `set-sec` per plugin: its name and status, what it contributes, its settings as fields built from its config schema by `client-core`'s config fields, and its moves.
- Same as the web screen.

**System.** Not drawn by the book.

- Reads `controller.read`: the controller's version and id, the default runner and the local runner. Writes nothing.
- The web screen's text, the access-mode fallback chain, read-only.
- Differs from the web screen: it shows `controller.read`, which the web screen does not. `controller.update` is not used, as in the web app.

### What Settings costs

The rules apply as everywhere ([Rules](#rules)); the costs below are what each slice measures and records in [Measured](#measured).

| Cost | Expected | Measured by |
|---|---|---|
| Processes | none added | the perf script's process count |
| The first screen's JavaScript | grows only by the foot button's handler, the `openSettings` command, the `/settings` route stub and `theme-init.js`'s reading of the Appearance | `pnpm build:desktop`'s bundle check, before and after |
| Settings' chunks | one per section, loaded the first time it opens. Appearance, the largest, draws five theme previews from components the first screen already holds | the bundle check's table, which lists every chunk |
| Memory | within the app's memory row with any section open: Settings holds one section's reads at a time | the perf script, with Appearance and then Machines open *(Amended 2026-10-09, [#494](https://github.com/theagenticage/hercule/issues/494).)* and then Permission profiles |
| Idle | the idle row, with any section open: no timer, no polling, and no animation; the heartbeat timeline's "now" line moves only when the section is opened again | the perf script's idle sample, with Machines open *(Amended 2026-10-09, [#494](https://github.com/theagenticage/hercule/issues/494).)* and then Permission profiles |
| Intake's reads *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* | `plugin.read` once per plugin and `connection.read` once per Connection of it, each time the section opens or a segment changes; `ignoreRule.query` once; `plugin` and `connection` as its live topics, which the shell already holds. No polling | the perf script, with Settings › Intake open |
| Permission profiles' reads *(Amended 2026-10-09, [#494](https://github.com/theagenticage/hercule/issues/494).)* | `profile.query` and `agent.query` once each time the section opens, no polling, and `assistant` as its only live topic. The page draws one toggle for each of the 42 grants and one row for each user of the profile | the perf script, with Permission profiles open |
| Launch | `appearance.read` adds one synchronous message, answered from memory, before the first paint | the perf script's launch steps, before and after |
| A change of theme or text size | one frame that restyles the page; the Office redraws once, from its existing watch on `data-theme` | the Performance panel, once, recorded in [Measured](#measured) |
| Dragging the Glass slider | a restyle per input event while the user drags, nothing after | the Performance panel, once |

Settings does not open a live topic the shell does not already need, except while a section that reads it is open.

### What subagents cost

*(Added 2026-10-05, [#355](https://github.com/theagenticage/hercule/issues/355); [ADR 0037](../adr/0037-the-desktop-app-is-its-own-electron-client-of-the-public-api.md).)* The plan for the subagents build, measured by that build and recorded in [Measured](#measured):

| Cost | Expected | Measured by |
|---|---|---|
| Processes | none added | the perf script's process count |
| The first screen's JavaScript | grows only by the spawn line and the tally; the side pane and the subagent page are their own chunk, loaded the first time one opens | `pnpm build:desktop`'s bundle check, before and after |
| Live topics | `subagent` only while a thread is open, on its own page or in the Office's drawer, and a nudge causes a refetch only when it names the open thread. ~~The thread's subagent list is read once more right after the topic is subscribed, because a subscription made after connect gets no re-read and a nudge sent before it is lost.~~ The thread's subagent list is read once more on the controller's first push on the subscription, which names no session, because a nudge sent before the subscription is lost *(amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454))*. The controller sends at most one nudge per session per second. A subagent's page holds one agent's `:stream` and `:tap` in place of the thread's, never both | the perf script, with a thread whose four subagents run |
| Work per streamed token | unchanged: a subagent's tokens reach the app only while its page is open, and then take the thread's path | the Performance panel, once, on a subagent's page |
| Memory | within the app's memory row with the side pane open on 20 subagents: the list is records, never transcripts | the perf script |
| Idle | the idle row with the side pane open and every subagent ended: no timer, and the durations of ended subagents do not tick | the perf script's idle sample |
| Running subagents | a running row's duration ticks at most once a second, and only while it is on screen; faces in the surface are still | the Performance panel, once |
| Resizing the pane | layout per pointer move while the user drags, nothing after | the Performance panel, once |

### What the assistant costs

*(Added 2026-10-06, [#448](https://github.com/theagenticage/hercule/issues/448); [ADR 0037](../adr/0037-the-desktop-app-is-its-own-electron-client-of-the-public-api.md).)* The plan for [the assistant](#design-system), measured by slices 20 to 22 and recorded in [Measured](#measured):

| Cost | Expected | Measured by |
|---|---|---|
| Processes | none added | the perf script's process count |
| The first screen's JavaScript | grows only by the sidebar's Assistants section, the Waiting on you row for an assistant, and the `/assistants/$id` route stub. The Conversation and its drawer are one chunk, loaded the first time a Conversation opens | `pnpm build:desktop`'s bundle check, before and after |
| Live topics | the shell adds `assistant`, because the sidebar lists assistants. A `session` nudge already reaches the shell; ~~with it, the shell reads the assistants' newest sessions again, as it reads the thread list again. A nudge cannot tell the shell which assistant a new session belongs to, so it cannot read less.~~ *(amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453): it reads an assistant's newest session again only when the nudge names a session of that assistant's conversation, or names none. A nudge about a thread or a workflow run's session reads no assistant's session, see [The assistant](#design-system))* `conversation` is subscribed only while a Conversation is open, and a nudge causes a read only when it names that Conversation. The open Conversation holds one session's `:stream` and `:tap`, as a thread does | the perf script, with a Conversation open while its assistant replies |
| Launch | the sidebar's reads grow by `assistant.query` and one `session.query` per assistant, ~~sent together with the thread list's~~ in two waves: `assistant.query` with the thread list's reads, then the sessions as soon as it answers, because each session is read by its assistant's main Conversation *(amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453))* | the perf script's launch steps, before and after, with 5 assistants |
| Work per streamed token | unchanged: the reply takes the thread's path | the Performance panel, once, while a reply streams |
| Memory | within the app's memory row with a Conversation of 2,000 messages open, scrolled to its top: only the pages read hold messages, and leaving the Conversation drops them | the perf script |
| Idle | the idle row, with a Conversation open and the drawer open: no timer, no polling and no animation. The drawer's sections and the header's pill compute nothing after they first draw; the heartbeat strip draws no "now" line | the perf script's idle sample |
| Opening the drawer | one transform transition of `--dur-3`, nothing after | the Performance panel, once |

### Images in prompts

*(Added 2026-10-08, [#465](https://github.com/theagenticage/hercule/issues/465).)* The desktop composers attach images as the web app's do: behaviour, limits and wording are owned by [./14-web-app.md](./14-web-app.md) §Images in prompts. This section owns only how the desktop draws them and what that costs.

- **Where.** The thread's composer (`screens/thread/composer.tsx`), the new thread's composer (`screens/new-thread/draft-composer.tsx`) and their shared frame (`screens/session/composer-frame.tsx`) take paste, drop and the `+` attach's file picker. The user's bubble and the queued input rows show the images.
- **Drawn in Bureau's tokens.** The shelf, its 64×64 tiles, the 20px remove button with `aria-label="Remove <name>"`, the bottom strip, the dashed drop outline with "Drop images to attach", and the bubble's grid follow the shared measurements of spec 14, with Bureau's hairline, radius and focus-ring tokens in place of the web app's.
- **The lightbox** is a dialog in Bureau's `glass-dialog` style: the image at most 92vw × 86vh, the caption "<name> (i/n)", ← and → between images, Esc or a click on the scrim to close.
- **Only small thumbnails are kept.** A tile, a bubble image and a queued input's image each draw a thumbnail of their own size in device pixels. To build one, the image is decoded at full size with `createImageBitmap`, cropped to fill the box as `object-fit: cover` does, scaled down, and stored as a small WebP, which the `<img>` shows through an object URL; the full decode is closed straight away. Thumbnails are built one after another, so at most one image is decoded at full size at a time, and ten 4K screenshots on the shelf hold ten small WebPs, not ten full images. The query cache keeps a sent image's thumbnail, not its full bytes; only the lightbox reads and draws an image at full size, and an upload leaves its file in the cache, so the bubble of the message that sends it does not read the image back. *(Amended 2026-10-08, [#465](https://github.com/theagenticage/hercule/issues/465): this said each image is decoded straight at its display size, which cannot crop it.)*
- **The strip holds one short word** on one line, "Uploading…", "Failed", "Expired" or "Unsupported", and the tile's tooltip the whole reason, as [./14-web-app.md](./14-web-app.md) §Images in prompts has it.
- **Object URLs are revoked** when a tile is removed, when its message is sent and when the component unmounts.

### What images in prompts cost

*(Added 2026-10-08, [#465](https://github.com/theagenticage/hercule/issues/465); [ADR 0037](../adr/0037-the-desktop-app-is-its-own-electron-client-of-the-public-api.md).)* The plan for the images build, measured by that build and recorded in [Measured](#measured):

| Cost | Expected | Measured by |
|---|---|---|
| Processes | none added | the perf script's process count |
| Dependencies | none added | `package.json` |
| The first screen's JavaScript | grows only by the shelf, the lightbox and client-core's attachment module | `pnpm build:desktop`'s bundle check, before and after |
| Memory | within the app's memory row with 10 pasted 4K screenshots on the shelf: thumbnails are decoded at display size, and object URLs are revoked when they leave the screen | the perf script, or a one-off run recorded in [Measured](#measured) |
| Idle | the idle row with images on the shelf: no timer and no polling | the perf script's idle sample |
| Work per streamed token | unchanged: a bubble's images load once, when the bubble first draws | the Performance panel, once |
| Uploads | at most three at a time, each on its own request; nothing runs after they answer | the Network panel, once |

## Performance

*(Amended 2026-10-07, [#459](https://github.com/theagenticage/hercule/issues/459).)* **Workspace lifecycle performance gates this change.** Before UI implementation, the expected cost is zero additional persistent processes, zero Git/inspection work while idle and zero Git/inspection work per streamed token. Inspection is bounded and coalesced per workspace on decision-menu open, explicit refresh, completed turns/exit and start/resume. Measure comparable before/after fixtures with the existing desktop scripts: total/per-process memory, idle CPU/wakeups, streaming work and bundle-byte delta. Record actual readings in this section when implemented. A new budget miss requires correction before #459 acceptance; previously accepted unrelated misses stay identified separately. The historical first-milestone guide below does not waive this issue's gate.

**Workspace lifecycle, issue #459**, measured 2026-10-07 against `cbb9719a` with the unchanged `apps/desktop/scripts/perf.ts` fixture: two 40-Thread launches, Profile, 500 Threads, a 501-row transcript, streaming and subagents. Both builds use the compiled controller and disposable Homes. The final run used `caffeinate -di` only for the measurement's lifetime after macOS idle sleep invalidated an earlier attempt.

Footprint readings in MB and launch in ms. Each cell is Before / After, using the same fixture and sampling method:

| Fixture | Browser | GPU | Network | Renderer | Summed | Window shown |
|---|---|---|---|---|---|---|
| 40 threads, run 1 | 51.3 / 53.4 | 180.5 / 590.1 | 7.9 / 7.7 | 48.5 / 48.3 | 288.2 / 699.5 | 352 / 396 |
| 40 threads, run 2 | 51.6 / 53.3 | 584.1 / 591.5 | 7.8 / 7.9 | 49.6 / 48.7 | 693.0 / 701.5 | 354 / 376 |
| 40 threads, Settings › Profile open | 51.8 / 53.7 | 106.8 / 112.0 | 7.7 / 7.8 | 54.9 / 55.0 | 221.2 / 228.4 | 362 / 377 |
| 500 threads, run 1 | 51.3 / 52.9 | 585.6 / 590.2 | 7.8 / 7.8 | 55.7 / 56.0 | 700.5 / 706.8 | 366 / 389 |
| 500 threads, a thread of 501 transcript rows open | 52.4 / 53.9 | 254.2 / 275.7 | 8.0 / 8.1 | 67.4 / 67.9 | 382.1 / 405.6 | 408 / 417 |

- The process count remains four. No persistent process, idle inspection or per-token Git work is added. Source-menu opening, explicit Refresh and session/turn completion initiate bounded, coalesced observations; the workspace live topic replaces polling. The source/renderer regression tests exercise these boundaries.
- Hidden renderer CPU is 0.0% with one wakeup/s in all five ordinary launches. Visible renderer CPU ranges from 0.7% to 1.3%; wakeups are one or five/s in both builds. GPU wakeups are zero or approximately 64/s in both builds. The age clock retains zero hidden fires and the expected visible count.
- At 500 Threads, renderer main-thread work per nudge is 13.7 / 14.6 ms for the list and 11.6 / 10.5 ms with the transcript open, within the 16 ms budget. Both builds perform 20 Thread-list reads for 20 nudges.
- The longest streaming task is 15.1 / 13.5 ms, with zero tasks over 50 ms. Paragraph writes are 1,173 in 2,435 frames / 1,191 in 2,437 frames, below one write per frame.
- With 20 subagents, renderer footprint is 69.6 / 68.1 MB with the pane closed and 86.0 / 84.5 MB open. Both builds use four processes and stop running-row work while hidden.
- Main's startup file is 157.5 / 158.5 kB, below 160 kB. The first screen is 313.6 / 315.5 kB gzip, an increase of 1.9 kB. The pre-existing 250 kB renderer guide overage remains separate from this change.
- Summed footprint already exceeds 220 MB in every baseline fixture, with large GPU variation; the baseline range is 221.2-700.5 MB and the final range is 228.4-706.8 MB. Visible GPU/renderer wakeup guide misses also occur in the baseline. These measurements identify the existing guide misses; they do not attribute variable GPU footprint to this feature. Renderer footprint stays below 100 MB throughout, and the measured launch, transcript, nudge and streaming budgets pass.

**The budgets guide the first milestone; they do not gate it.** *(Amended 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275).)* Slices 1 to 4 were each measured against the budgets before they merged, and a slice that missed one did not merge. From slice 5 on, the milestone's functionality comes first, and performance passes follow it:

- **A slice is not measured against the budgets,** and a reading over one does not stop it. The perf script and the size checks in `pnpm build:desktop` report such a reading and pass.
- **The [rules](#rules) still apply to every slice.** They say how the app is built, and they cost little when followed from the start and much when added later.
- **A performance pass** measures the app, records the measurement in [Measured](#measured), and brings the app within the budgets.
- **Budgets:**
  - Raising a budget is a deliberate change, recorded here with its reason.
  - A budget is lowered once measurements show room to spare.

*(Amended 2026-10-03, [Office v1 in the desktop app (#332)](https://github.com/theagenticage/hercule/issues/332).)* **The Office's budgets gate the Office.** A change to the Office that misses one of [its budgets](#the-offices-budgets) does not merge. A 3D view that draws frames all the time is the one part of the app that can spin a fan and drain a battery, so its cost is held from its first merge, not by a later pass. The rest of the app keeps the rule above.

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
- **Glass costs almost nothing on this machine.** Composer glass while streaming measured within noise of no glass. *(Amended 2026-10-03, [#332](https://github.com/theagenticage/hercule/issues/332).)* That holds over a page that changes little. Over the Office's canvas, which changes with every frame, glass costs much more (see [Rules](#rules), rule 5).

### Budgets

The reference setup:

- the machine above
- the packaged app
- a controller on loopback
- a thread with 500 transcript rows open

These are starting budgets. The first performance pass measures the real thread screen, and each budget then comes down to the measurement plus 10%.

| Budget | Limit |
|---|---|
| Launch | The window shows within 500 ms of spawn (warm), and ~~the last open thread's transcript paints~~ the last screen's content paints within 800 ms *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#394](https://github.com/theagenticage/hercule/issues/394): the app reopens the last screen, which may be Intake, so the budget is measured with Intake reopening too.)* |
| Processes | The four of the baseline. No hidden windows, and no workers unless a slice justifies one. *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* [The first run](#the-first-run) starts short-lived commands: the `hercule` binary, the login shell once and `git` once per folder. Each exits or is stopped before the step that started it ends, and none stays running. The controller and runner it starts are Hercule's own processes, under the Service Unit, not the app's |
| Memory | Summed physical footprint at most 220 MB, and the renderer at most 100 MB *(amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275): with a text field focused and with none, because a focused field costs the GPU process 400 MB more while the glass blur is on screen; see [Measured](#measured))* |
| Idle, window visible, no thread working *(amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275): and no text field focused)* | Renderer: no wakeups from the app except the live connection's 30-second keepalive *(amended 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275): and the change of a time label on screen, which rule 4 allows)*. GPU: at most 12 wakeups a second, the still-page level |
| Idle, window visible, a text field focused | *(Added 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* No wakeups from the app beyond what a focused field costs an empty Electron window: at most 63 a second for the GPU and 4 for the renderer on the reference machine. The field's blinking caret keeps Chromium drawing frames, about 60 a second, however still the rest of the page is |
| Idle, window hidden or minimized | Renderer: no wakeups from the app *(amended 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275): except the live connection's 30-second keepalive, because rule 3 keeps the `session` topic subscribed while hidden)* |
| Streaming | No task on the renderer's main thread longer than 50 ms while a turn streams at full speed. The paragraph being written is painted at most once per frame |
| The thread list's live updates | *(Added 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275).)* At most 16 ms of the renderer's main thread for each `session` nudge, with 500 threads in the list: one frame at 60 Hz. Past it, the list stops reading every thread again on a nudge and updates only the threads the nudge names, and [./14-web-app.md](./14-web-app.md) §Live model is amended in the same change |
| Renderer JavaScript | The JavaScript the first thread screen needs is at most 250 kB gzipped (the web app's budget), checked in CI like `scripts/check-bundle-budget.ts`. *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* The first run and its room are one chunk, loaded only on a first run, and are not on the check's list of first-screen routes. The first screen grows only by the bridge calls the first run adds, and by New thread's Log in button, the one part of the first run the app keeps on the draft itself *(amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313))*. The project picker, the provider login and New project dialogs, and the draft's starter threads and Intake note are each loaded the first time they show, so they are not part of it |
| Main's startup | Main loads only what the first window needs, and imports everything else when it is first used. Main's startup file is at most 160 kB minified, checked in CI. *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* Main imports the modules that run the Hercule binary, git and the folder dialog, which the first run and the New project dialog use, the first time they are used, so those modules add nothing to the startup file. The first run's IPC channels, their handlers and its progress in the settings file stay in the startup file, because main checks every IPC call against its channel's schema from launch. The 160 kB counts the startup file and every chunk it imports statically, because the bundler can move code the startup file shares with a lazy module into a chunk of its own. Main's build puts everything main imports statically into `index.js`, so today that is one file |

#### The Office's budgets

*(Added 2026-10-03, [Office v1 in the desktop app (#332)](https://github.com/theagenticage/hercule/issues/332).)* The reference Office is the reference machine above, with the Office open in a 1440 × 900 window at 2x, the Bureau map, 16 colleagues on 3 runners, and its light on Theme.

| Budget | Limit |
|---|---|
| Frames | The colleagues' ambient life draws at most 30 frames a second, never 60 or 120. While the camera moves, and while the user drags or zooms, the Office draws at most 60, so a glide stays smooth |
| Window hidden, minimized or covered | No frames, and no wakeups from the Office |
| Standing still: on battery, or with Reduce motion | No frames while nothing happens, so the idle row above applies. A thread whose pose changes walks where its new pose takes it, and frames stop once it arrives. *(Amended 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505).)* So does an assistant. The Secretariat's clock draws one frame a minute, so its hands keep the time |
| CPU, window visible, on mains power | Averaged over 30 seconds, with the camera at rest: the renderer at most 17.9% of one core, the GPU process at most 12.3% of one core: the first measurement's highest readings plus 10% ([Measured](#measured)) |
| Leaving the Office | Within 5 seconds, the app is back within the idle row: the Office releases its WebGL context and everything it built |
| The first screen's JavaScript | The Office and three.js are a chunk of their own, loaded the first time the Office opens. The first screen grows only by the sidebar's Office button, the Go menu item and the route |
| Memory with the Office open | Summed physical footprint at most 1,602 MB, and the renderer at most 181 MB: the first measurement's highest readings plus 10% ([Measured](#measured)) |
| The Office's chunk | At most 241.5 kB gzipped: the first measurement plus 10% |

- **The idle row and the Office.** The idle row allows the renderer no wakeups from the app and the GPU at most 12 a second. An Office drawing 30 frames a second wakes the renderer about 65 times a second, and the GPU process about 300 with the glass and about 430 without it, though its CPU then falls from 31% to 12% of one core. A living Office can never meet the idle row. The idle row is the limit for the app while nothing happens. On mains power, a visible Office is something happening: its colleagues live, and the CPU row above holds its cost instead. When the Office stands still, the idle row applies to it again.
- **An unfocused window keeps its 30 frames a second** while it is visible. A living Office on a second screen is what the Office is for. Whether the Office should stand still in more cases is decided after the first measurement.
- **Why the CPU limits are what they are.** The research for #332 ([#333](https://github.com/theagenticage/hercule/issues/333)) measured the prototype with the reference fleet, in % of one core for the renderer and the GPU process:
  - as it was, with no cap: 88 frames a second, 45 and 85;
  - capped at 30 frames a second: 16 and 31;
  - capped, and without the glass: 14 and 12, so the glass costs the GPU process about 19;
  - capped, without the glass, and at the prototype's Medium quality (no ambient occlusion, a pixel ratio of 1.5, shadows drawn every frame): 9 to 10 and 7 to 8;
  - standing still: 0 and 0, with no wakeups;
  - hidden, and covered by another of the app's windows: 0 frames. A minimized window was not measured, because the research's harness could not minimize its window; Chromium's source treats it as hidden.

  The settings v1 ships (a pixel ratio of 2, shadows drawn once, no ambient occlusion), capped and without the glass, measured 9.1 and 7.7, the mean of two runs (from 7.6 to 10.6, and from 6.5 to 8.9).

  The limits started above the capped reading, at 20% and 35%, so v1 could ship with the cap alone. The Office's first measurement in the app brought them down to its highest readings plus 10%, as every budget comes down ([Measured](#measured)).
- **Memory and the chunk took their limits from the Office's first measurement** ([Measured](#measured)), because before it no measurement of the Office inside the packaged app existed, and a limit would have been a guess. The memory limits come from the highest of eight launches, so the swing between launches, about 7%, does not fail the next change. With the Office open, the app holds several times the app's own Memory row: almost all of it is the GPU process's, and bringing it down is [#370](https://github.com/theagenticage/hercule/issues/370). The first run's room already reads above the app's memory budget ([#330](https://github.com/theagenticage/hercule/issues/330)).

### Rules

These rules keep the budgets:

1. **The web app's six guardrails apply unchanged** ([./14-web-app.md](./14-web-app.md) §Performance guardrails):
   - the React Compiler
   - selector-based external stores, and never Context for changing data
   - every unbounded list virtualized
     - *(Amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* The sidebar's Assistants section is an exception: a plain list, at most 40% of the sidebar's height, that scrolls on its own. A user has a handful of assistants, so every row is drawn. Revisit this once people run many.
     - *(Amended 2026-10-09, [#494](https://github.com/theagenticage/hercule/issues/494).)* Settings › Permission profiles is another: the profile list, and the Used by list on a profile's page, are plain lists. A user keeps a handful of profiles, and each profile is carried by a handful of agents, so every row is drawn. Revisit this once people run many.
   - token deltas flushed at most once per animation frame
   - route-level code splitting with a CI bundle budget
   - TanStack Query for every HTTP read
2. **Nothing animates unless something is happening:**
   - *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#394](https://github.com/theagenticage/hercule/issues/394).)* Motion may tell the user that something happened. Such motion plays once, on `transform` and `opacity` of HTML elements, at most `--dur-3`, and only on elements on screen. It never loops or repeats. [Intake](#motion)'s arriving and leaving signals are the first.
   - Faces are drawn still in their pose everywhere. Bureau's idle blink is left out of the first milestone, because of the measurement above. It comes back once research finds a way to draw it within the idle budget (see [Post-v1](#post-v1)).
   - Only one continuous animation is allowed: the working pose of the face of the message the open thread's agent is writing, while its turn runs. *(Amended 2026-10-09, [#504](https://github.com/theagenticage/hercule/issues/504): a face is drawn only beside text, so no face animates while the thread shows only a status line or a work divider.)* *(Amended 2026-10-06, [#448](https://github.com/theagenticage/hercule/issues/448).)* On an assistant's Conversation, it is the face of the newest reply, while its turn runs. The sidebar and every other list show still poses and still marks.
     - *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* The one other is a spinner, and only while Hercule starts or a login waits in [the first run](#the-first-run) or the draft's Log in. Each is a wait the user started, and each ends: the start after at most 90 seconds for the command and 30 for the answer, a login when it ends or its code expires.
     - The first run's room moves only when a step finishes: the camera moves one layer's `transform`, and new pieces settle with `transform` and `opacity`, each over `--dur-3`, by the rules below.
     - *(Amended 2026-10-03, [#332](https://github.com/theagenticage/hercule/issues/332).)* The Office's colleagues live: they walk, type, sip tea and sleep, at most 30 frames a second, while the Office is on screen and does not stand still ([The Office's budgets](#the-offices-budgets)). The Office draws them into one WebGL canvas, and the rules below for CSS animations do not apply inside it. The Office's panels and its drawer follow those rules.
   - Animations change only `transform` and `opacity`, and only of an HTML element. Chromium runs such an animation on the compositor thread alone. When the animated element is an SVG element, even an outer `<svg>`, the renderer's main thread also runs style, layout and paint on every frame: 120 times a second on a 120 Hz display. So the working pose's paws are each drawn in an `<svg>` of their own, inside a `<span>` that moves.
   - Transitions answer a user action, last at most `--dur-3`, and change only paint properties: color, background, border-color, box-shadow, opacity and transform. A transition of a layout property, such as `width`, `padding` or `grid-template-rows`, runs layout on every frame. Bureau's composer transitions some of these; slice 6 ports the composer without them, and uses a transform if its growth animates.
     - *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#394](https://github.com/theagenticage/hercule/issues/394).)* [The split](../design-language.md#the-split) is the one exception. Opening or closing its side pane may animate its sized column's width, for at most `--dur-3`, and only while that column's rows are one line cut with an ellipsis. One-line rows do not wrap, so a frame of the transition lays out the column without measuring text again. Intake is the first to use it ([The split and its minimums](#the-split-and-its-minimums)), and [What Intake costs](#what-intake-costs) measures it.
     - *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#394](https://github.com/theagenticage/hercule/issues/394).)* A one-shot arrival the user's own action caused may chain steps, each within `--dur-3`, at most 800ms in all. Intake's inbox zero is the first ([Motion](#motion)).
   - A change of appearance snaps: the page switches in one frame, with no transition, as the window's native frame does.
   - Reduce motion turns every animation off. *(Amended 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* macOS's Reduce motion or the Appearance page's. *(Amended 2026-10-03, [#332](https://github.com/theagenticage/hercule/issues/332).)* With Reduce motion, the Office stands still as it does on battery, and its camera moves in one step where it would glide.
3. **Work stops when nobody is looking.** While the window is hidden or minimized:
   - The renderer drops the open thread's `session:<id>:tap` subscription, and the open subagent's `session:<id>:subagent:<subagentId>:tap` *(amended 2026-10-05, [#355](https://github.com/theagenticage/hercule/issues/355))*, and the open Conversation's newest session's `:tap` *(amended 2026-10-06, [#448](https://github.com/theagenticage/hercule/issues/448))*. Chromium stops animation frames in a hidden window, so buffered token deltas would otherwise pile up without being painted. The `session:<id>:stream` rows keep the transcript current, and the tap resumes when the window is shown.
   - The `session` topic stays subscribed, because the dock badge and notifications depend on it. *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* So does the `signal` topic, because the Hercule segment's count and Now's notifications depend on it ([Intake](#what-the-screen-reads)).
   - `backgroundThrottling` stays on.
   - *(Added 2026-10-03, [#332](https://github.com/theagenticage/hercule/issues/332).)* The Office draws its frames from `requestAnimationFrame`, which Chromium stops in a hidden, minimized or covered window. The colleagues' timers count only the time the window is shown, so they pause with the frames, and the first frame after the window is shown again advances the colleagues by one frame, not by the time it was hidden. While the Office stands still, it runs no timer that repeats~~.~~ *(amended 2026-10-09, [#505](https://github.com/theagenticage/hercule/issues/505))*, except the Secretariat's clock, which moves its hands once a minute. The clock's timer counts only the time the window is shown, as the colleagues' timers do, so a hidden window gets no wakeups from it, and the hands jump to the time when the window shows again. An Office with no assistants has no clock, so it runs no clock timer either.
4. **No polling, and no timers while idle:**
   - Every change reaches the app through a live topic. *(Amended 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275): projects, workspaces and resources have no live topic yet. The app reads them again when the thread list names one it does not know, when a thread in a workspace being set up changes, and after a reconnect, so a rename made elsewhere shows at the next of these. [#279](https://github.com/theagenticage/hercule/issues/279) adds the topics.)* *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* The shell also subscribes to the `connection` topic, so a GitHub Connection made in the web app while the desktop app runs reaches the New project form and the starters' line without a reload. *(Amended 2026-10-06, [#448](https://github.com/theagenticage/hercule/issues/448).)* It also subscribes to the `assistant` topic, so the sidebar's Assistants section follows an assistant made, renamed or deleted elsewhere.
   - A label that counts time (such as `Worked for 31s`, or a Request's `10m`) runs one timer, only while the label is on screen and the window is visible.
   - *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* Intake runs one timer, set for the soonest snooze's `until`, because a snooze ends with no push: nothing changes on the controller when its time comes. It fires once; the app reads To do again and sets the next. It runs whether the window is visible or not, because Now's notifications must reach the user while the window is hidden. A Mac that wakes from sleep reads To do again.
   - *(Added 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* Two waits in [the first run](#the-first-run) poll, because nothing else can tell the app their outcome. Both are bounded waits the user started, and neither runs while the app is idle:
     - GitHub's device flow: the protocol requires the client to ask, so the renderer calls `connection.pollDeviceFlow` at the interval GitHub gives, until the flow is done, expires or is denied.
     - The connect check after `hercule service install`: main checks every half second for at most 30 seconds, because the controller announces nothing while it starts.
     - A provider's login does not poll: its end arrives on the `provider` live topic.
5. **Glass is limited.** It is allowed only on Bureau's glass surfaces: the header pills, the composer, popovers and name tags. The level is one token, `--glass-level`, and at 0 there is no blur at all. *(Amended 2026-09-30, [#275](https://github.com/theagenticage/hercule/issues/275).)* At 0 the filter is `none`, not a blur of 0 pixels: Chromium draws a zero blur at the full cost of a real one. Reduce transparency is the one setting that sets the level to 0 (the Office, below, also sets it while it is open), and the app's `base.css` sets the filter to `none` with it, because `tokens.css` stays the book's copy. *(Amended 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* The level is Appearance's Glass level, 40% unless the user moves it, and a level of 0 sets the filter to `none` too. Reduce transparency and the Office still win over it.
   - *(Added 2026-10-03, [#332](https://github.com/theagenticage/hercule/issues/332).)* Glass over the Office costs far more than glass over a still page. On the reference machine, the Office's glass (its top bar, room labels and panels) costs the GPU process about 19 points of one core at 30 frames a second. Two causes add up:
     - the page under a blur changes with every frame the Office draws, so the blur is drawn again each time;
     - by Chromium's source, one `backdrop-filter` anywhere in the window turns off macOS's own compositing of the window's layers (Core Animation), so the GPU process composites every layer of the window for each frame the Office draws. This cause was read from the source. A later measurement found the GPU process woke as often with glass on the top bar alone as with all of the glass, so the compositing does change. But the cost follows how much is blurred: glass on the top bar alone cost the GPU process about 4 points, a quarter of what all of the glass cost with v1's settings (14). That was one session, with the camera at rest.
   - So the window draws no blur while the Office is open *(decided 2026-10-03, [#332](https://github.com/theagenticage/hercule/issues/332))*. The Office sets the glass level to 0 for the whole window, through the same tokens as Reduce transparency. Its top bar, card, name tags and room labels, and the thread drawer's composer and Requests dock, draw as solid Bureau surfaces, with the glass's rim and shadow. Leaving the Office brings the glass back. [Research: frosted glass over the Office at close to no cost (#341)](https://github.com/theagenticage/hercule/issues/341) looks for a way to bring it back over the Office.
6. **The first paint is cheap:**
   - Only the Latin subset of Bricolage Grotesque (131 kB) is preloaded.
   - Limelight and Recursive load the first time text uses them.
   - *(Added 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* Everything the first screen imports statically is built into one chunk, the first-screen chunk. Split into files, the first screen costs more bytes: each file is compressed apart, and the files import and export names from each other, which the minifier cannot shorten across a file boundary. One chunk measured 7.4 kB smaller gzipped (see [Measured](#measured)). The app's files are read from the local disk, so splitting buys no caching in return.
   - A screen or dialog that is not on the first screen is imported with `import()`, and is a chunk of its own, loaded the first time it shows: the first run, the project picker, the New project and provider login dialogs, and the draft's starter threads. *(Amended 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* Each section of [Settings](#settings) is a chunk of its own too. *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* So is [Intake](#intake).
   - App code imports each icon from its own module, never from the icons folder's list of every icon, and eslint enforces it. The bundler places a module by what imports it, so an icon only a lazy screen draws then loads with that screen.
   - The V8 code cache keeps warm launches from compiling the same scripts twice.
7. **Main does no recurring work.** Main runs nothing on a timer, and it holds no data the renderer already holds. *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* The first run's start of Hercule is the one exception, and it ends: the half-second connect check of rule 4, the 90-second limit on `hercule service install`, and the 5-second limit on reading the login shell's `PATH`.

**Verify at build time:** that a macOS window fully covered by other windows stops animation frames, as a minimized one does. Rule 3 then also covers a covered window. *(Amended 2026-10-03, [#332](https://github.com/theagenticage/hercule/issues/332).)* The research for the Office found the reverse gap: a window covered by another of the app's windows stopped its frames, and a minimized one could not be measured. The Office's first measurement checks a minimized window, and a window covered by another app's window.

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
- *(Added 2026-10-03, [#332](https://github.com/theagenticage/hercule/issues/332).)* **The Office is measured with the Office's own fleet,** because a scratch controller has no 16 working threads to seat. Its measurement opens the Office with the reference fleet in the repository's Electron, and reads each process's CPU and wakeups from `app.getAppMetrics()`, frames from the page, and draw calls from three.js.
  - **CPU is a share of one core:** the growth of `cumulativeCPUUsage`, in seconds, divided by the seconds sampled. `percentCPUUsage` cannot be used for this: on macOS, Electron divides it by the number of logical CPUs, so on the reference machine's 16 it reads one sixteenth of a share of one core.
- **CI checks what does not depend on the machine:**
  - the renderer bundle budget and main's startup file. While the budgets are guides, a build over one prints a warning and passes.
  - ~~the process count. A new process fails the test, because it changes the process model, which a slice must justify.~~ *(Amended 2026-10-01, [#275](https://github.com/theagenticage/hercule/issues/275).)* The process count is checked by the end-to-end suite, which runs on a developer's Mac, not in CI (see [Testing](#testing)). A new process fails that test, because it changes the process model, which a slice must justify.
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
- **The fixture writes the database once.** To give its threads ages, it stops the controller, backdates `created_at` and `last_activity_at`, and starts it again on the same port. The threads and their states come from the fleet. The ages are at most 6 hours 31 minutes, because the lost-runner sweep ends a session on an offline runner once it is older than the 8-hour absolute timeout.
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

**Answering a question in the dock,** measured 2026-10-01 with `pnpm build:desktop`'s size checks, on `main` at 339b8e52 (Before) and on this change (After), for [#309](https://github.com/theagenticage/hercule/issues/309). The dock's questions add no process, no work while idle, no work per streamed token and no memory beyond one question's draft: the dock renders only while the session waits on a request.

| Measure | Budget | Before | After |
|---|---|---|---|
| Renderer JavaScript for the first screen, the thread's route included, gzipped | 250 kB | 300.9 kB | **302.5 kB**: the thread's route grew from 59.2 to 60.4 kB, and the chunks at first paint from 240.6 to 241.1 kB |
| Main's startup file, minified | 160 kB | 150.2 kB | 151.3 kB |

The first screen was already over its guide budget, and [#295](https://github.com/theagenticage/hercule/issues/295) holds that overrun. This change adds 1.6 kB to it. 1.2 kB is the question form in the thread's route, which loads after first paint. The other 0.4 kB at first paint, and the 1.1 kB in main, are the contract's new operation and the schema of its answers, which main and the renderer both link. That is accepted: the question form has to ship with the thread, and nothing smaller answers a question.

**Main's part of the first run,** measured 2026-10-02 with `pnpm build:desktop`'s size checks, on the branch base 50ca5fb7 (Before) and on this change (After), for [#313](https://github.com/theagenticage/hercule/issues/313). Main starts no process and does no work until the first run asks: each `localController.*`, `setupToken.read` and `folder.pick` call runs short-lived programs (the installed `hercule`, the user's login shell before an install, or `git`) and waits for them, and `localController.start` polls the controller twice a second for at most 30 seconds. Nothing runs while idle or per streamed token, and no memory is held beyond the remembered logs folder and a pasted setup token, until the first run takes it.

| Measure | Budget | Before | After |
|---|---|---|---|
| Main's startup, minified: the startup file and the chunks it imports statically | 160 kB | ~~154.9 kB, one file~~ 151.3 kB, one file *(corrected 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313): 154.9 was the same file counted in thousands of bytes; see "The first run, measured on the app" below)* | 156.9 kB: `index.js` 40.9 kB and a shared Effect Schema chunk of 116.0 kB |
| Main's first-run modules, loaded the first time the first run asks | - | - | 7.7 kB |
| Renderer JavaScript for the first screen, the thread's route included, gzipped | 250 kB | - | 302.7 kB |

- **The startup file now imports a chunk.** The first-run modules are imported lazily, and the bundler moves the code they share with the startup file, the Effect Schema runtime, into its own chunk, which the startup file imports statically. The size check counted only `index.js`, so it read 40.9 kB. It now follows the startup file's static imports and counts them too. Since the code-splitting group in `vite.main.config.ts` (see "The first run, measured on the app" below), everything main imports statically is built into `index.js` again, and the startup is one file.
- **The renderer's first screen** was not measured on the base. This change touches the renderer only in the connect screen's line for a controller that is not set up; the 0.2 kB over [#309](https://github.com/theagenticage/hercule/issues/309)'s After is that and the contract's new schemas.

**The screens the first run shares with the app,** measured 2026-10-02 with `pnpm build:desktop`'s size checks, on the branch base b50ee76d (Before) and on this change (After), for [#313](https://github.com/theagenticage/hercule/issues/313): the project picker, the provider login dialog, the New project dialog, and the draft's starter threads and Intake note, together with the entry guard that sends a fresh Mac to the first run. They start no process. They do no work while idle and none per streamed token. The dialogs hold memory only while they are open. The starters are a fixed list, chosen from what the draft already reads and from the user's Connections, which the draft reads once and the live connection keeps current.

| Measure | Budget | Before | After |
|---|---|---|---|
| Renderer JavaScript for the first screen, the thread's route included, gzipped | 250 kB | 302.5 kB in 6 chunks: 241.8 kB at first paint, 60.7 kB for the thread's route | **295.6 kB** in 5 chunks: 234.6 kB at first paint, 60.9 kB for the thread's route |
| The same, with the Before built into one first-screen chunk, as the After is | 250 kB | 295.1 kB in 5 chunks: 234.4 kB at first paint, 60.7 kB for the thread's route | 295.6 kB |
| The project picker, the dialogs and the starters, each loaded the first time it shows | - | - | 14.8 kB in 7 chunks |

- **The first screen is one chunk now** (rule 6). On the Before alone, building everything the first screen imports statically into one chunk saves 7.4 kB, from 302.5 to 295.1 kB. Without it, the bundler gave each set of modules that the first screen shares with a lazy chunk a chunk of its own. Each file was compressed apart, and the files imported and exported names from each other, which the minifier cannot shorten across a file boundary. This change's lazy chunks made that worse: before the first-screen chunk, they put the first screen in 19 chunks, at 309.9 kB.
- **The change itself adds 0.5 kB** against the Before built the same way: 0.2 kB at first paint, 0.2 kB in the thread's route, and 0.1 kB of rounding. Only those totals can be measured. The sizes below are each module's size before minifying and compressing, from the bundler's report, and show where the bytes went:
  - The entry guard and the first run's route: `controller-url-outcome.ts` +1.0 kB, the first-run route's definition +0.6 kB (its screen is a chunk of its own), `entry-guard.ts` +0.6 kB, the first run's bridge reads in `queries.ts` +0.5 kB, and the route tree +0.1 kB. The connect screen lost 1.1 kB.
  - The draft: the starters' lazy import and their own Suspense boundary in `start-cards.tsx` +1.6 kB, and New thread's Log in button in `draft-screen.tsx` +0.9 kB.
  - The shell's lazy project picker and New project dialog, in `_shell.tsx`: +0.4 kB.
  - `readValidationIssues` in client-core's `errors.ts`: +0.3 kB. The provider login dialog uses it to tell a rejected code, and the rest of `errors.ts` is already on the first screen, so the bundler keeps the module whole there.
  - The icons: +1.1 kB, because a module per icon repeats the imports each icon needs. The stop and clock icons, which only the thread screen draws, moved from first paint into the thread's route.
  - The project picker left the first screen: -6.3 kB, with the project list it alone reads.
- **The first round of this change put 7.9 kB at first paint,** at 249.7 kB, 310.4 kB in 13 chunks. The bundler's report named what did it:
  - the icons the dialogs and the starters draw, 4.6 kB before compressing, because the app imported every icon through the icons folder's list;
  - the starters, 4.4 kB;
  - client-core's `buildProviderRows`, 2.1 kB, which only the provider login dialog draws, but whose module also held the model count the composer's model menu shows;
  - the glass dialog and the project picker, 2.8 kB;
  - and about 1 kB from compressing 13 files apart.
- **The project picker and the starters show a moment later the first time,** after one read of a file from the local disk. Until then the draft shows nothing in the starters' place, as it does until its tasks are read. The launch time was not measured for this change.
- **The Before is 0.2 kB under the entry above's After,** on the commit that recorded it. Two builds of b50ee76d both read 302.5 kB, with the thread's route at 60.7 kB. The entry above may have measured a working tree before its last commit.
- The first screen was already over its guide budget, and [#295](https://github.com/theagenticage/hercule/issues/295) holds that overrun. This change brings it 6.9 kB closer, all of it from the first-screen chunk.

**The first run, measured on the app,** 2026-10-02 on the reference machine, on the branch base f962cc91 (Before) and on 332a0f6f (After), for [#313](https://github.com/theagenticage/hercule/issues/313). *(Added 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* Sizes come from `pnpm build:desktop`'s size checks, 1,024 bytes to a kB. Everything else comes from the end-to-end suite's test package, run against the stand-in `hercule` binary and a scratch Hercule Home, with provider logins and GitHub's device flow answered by the test. The real `hercule service` was not run.

| Measure | Budget | Before | After |
|---|---|---|---|
| Renderer JavaScript for the first screen, the thread's route included, gzipped | 250 kB | 302.7 kB in 6 chunks: 242.0 kB at first paint, 60.7 kB for the thread's route | **296.4 kB** in 6 chunks: 235.1 kB at first paint, 61.2 kB for the thread's route |
| The first run's chunk, gzipped | - | - | 23.9 kB, and 2.7 kB of CSS |
| Everything a first run loads, gzipped | - | - | 36.7 kB in 7 chunks: the first run's chunk, the provider login and New project chunks, and four small chunks they share with the app |
| The project picker, the dialogs and the starters, each loaded the first time it shows | - | - | 15.9 kB in 9 chunks: New project 4.9 kB, the provider login 4.5 kB, the picker 1.8 kB, the steps' frame 1.7 kB, the starters 1.6 kB, the Connections helpers 0.7 kB, the glass dialog 0.5 kB, and two 0.1 kB files that only pass on New project and the provider login |
| Main's startup, minified: the startup file and the chunks it imports statically | 160 kB | 151.3 kB, one file | **157.0 kB**: `index.js` 40.9 kB and a shared Effect Schema chunk of 116.0 kB |
| Main's first-run modules, loaded the first time the first run asks | - | - | 7.7 kB |
| Processes after the first run | 4 | 4 | 4: the browser, GPU, utility and renderer processes, and nothing else |
| Launch after the first run: spawn to window shown, warm | 500 ms | 372, 341 and 449 ms | 358, 328 and 346 ms |

- **The first screen is 0.8 kB over the entry above's After,** 295.6 kB. The clock icon is now a 0.5 kB chunk of its own in the thread's route, because since 2ef96b67 the first run's account and GitHub steps import it as well as the thread screen's queued inputs. The other 0.3 kB was not traced to a module.
- **The picker, the dialogs and the starters read 15.9 kB in 9 chunks,** against 14.8 kB in 7 in the entry above. The first run's chunk imports New project and the provider login directly, and the rest of the app loads them lazily. So the bundler gives the code they share with the first run, the steps' frame and the Connections helpers, chunks of their own, and points the app's lazy imports at the two 0.1 kB files, which only pass the dialogs on. Which two of these four chunks the entry above did not have, and where its other 1.1 kB went, was not traced: its build was not kept.
- **Main's startup grew by 5.7 kB, against the budget's "add nothing to the startup file".** The first-run modules themselves stay out of it. The growth comes from the split the entry above describes: the bundler moved the Effect Schema runtime, which the startup file shares with the lazy first-run modules, into a chunk the startup file imports statically, and the two files together read 5.7 kB more than the one file did. The startup is still 3.0 kB under 160 kB. The entry above recorded the Before as 154.9 kB: that is the same 151.3 kB file counted in thousands of bytes, so the growth it implied, 2.0 kB, was too small. Its After of 156.9 kB is this table's 157.0 kB, rounded part by part.
- **Main's startup is now 156.0 kB, 4.7 kB over the Before,** measured after the review's fixes with the same size check. Two of those fixes took it down:
  - Waiting for a started controller with a loop of `Effect.sleep`, rather than `Effect.repeat` with a `Schedule`: -1.7 kB. The bundler keeps the code `Effect.repeat` needs in the `Effect` module, which is in the startup file, so the `Schedule` module loaded at every launch.
  - Building everything main imports statically into `index.js`, with one code-splitting group in `vite.main.config.ts`: -1.2 kB. The split cost more in the names the two files exported to each other than the group costs in the few Effect helpers only the lazy connect check uses, which the group puts in `index.js` because their modules are among its static imports.
- **The 4.7 kB that remains is the first run's part of the startup path.** By the source map, before minifying across modules: the IPC channels' schemas 0.9 kB, parsing a setup address when a controller URL is saved 0.5 kB, the IPC handlers 0.5 kB, main's entry 0.4 kB, the `ThisMac` service, which imports the rest of the first run's main code when first called, 0.4 kB, the first run's progress in the settings file 0.3 kB, Effect's `Redacted` and `Record` code 0.6 kB, which the base's startup file did not have and which the lazy connect check uses (without the group, the `Redacted` code sits in the connect check's chunk), the check that a device login code lasts at most a day, which the protocol's `LoginUrl` adds and main links through the contract 0.4 kB, and 0.6 kB in smaller parts. None of it can move without changing how main works: main checks every IPC call against its channel's schema from launch, and saving a controller URL is on the startup path. The budget row now states this cost instead of "nothing".
- **No first-run code loads after the first run.** A launch after it parsed only the first-screen chunk, the bundler's runtime and `theme-init.js`, read from the page's DevTools connection. The Before parsed its three first-screen chunks and `theme-init.js`.
- **Processes during the first run.** Open the office ran `service status --json` twice, once when the welcome looked for Hercule and once when the start began, then the login shell, then `service install --json`. At most two of these programs ran at once, beside the app's three helper processes. All had exited before the account step showed. Picking a folder ran `git`, which exited before a process list sampled about every 40 ms could see it. After the app quit, no process it started was left. A launch with a controller saved ran no `hercule` command.
- **On a runner Mac and on another machine's controller,** nothing was installed or started. A runner Mac ran `service status --json` once. Connecting to a controller elsewhere that is not set up ran `service status --json` and `setup-url`, which reads the token for a controller on this Mac, and no `service install`. A controller set up elsewhere ran `service status --json` once, and the app showed sign-in.
- **`hercule service status` was not timed,** because it reads launchd, and no test may run the real binary. It is left for the walk-through on a fresh Mac. Take it with `/usr/bin/time -l hercule service status --json`, which prints the wall time and the peak memory.
- **Reduce motion keeps the room still.** With Reduce motion emulated through Playwright's `emulateMedia`, which sets the same `prefers-reduced-motion` media query the macOS setting does, and in light and in dark, no animation ran after Create account or after Do this later, and two screenshots 1.2 seconds apart, starting the moment the providers step showed, were identical. Without it, Create account ran the room's `room-settle` and `room-label-settle` animations, two of each.

Idle at each step of the first run, with the window visible, read from a plain launch with nothing attached. Each launch opens on the step and settles for 4 seconds, and then `app.getAppMetrics()` is read over 10 seconds. That is sooner than [Measuring](#measuring)'s 30 seconds, so a timer that fires once after a page loads would show here; none did. The renderer's 0 to 2 wakeups a second count as none, as there.

| Step | GPU wakeups a second | Renderer wakeups a second | Notes |
|---|---|---|---|
| Welcome | 6 to 15 | 1 to 2 | |
| Hercule starting | 309 to 320 | 64 to 73 | the spinner, 0.8% of a core in the GPU process and 0.15% in the renderer. *(Amended 2026-10-03, [#332](https://github.com/theagenticage/hercule/issues/332).)* These were likely read from `percentCPUUsage`, a share of the whole machine (see [Measuring](#measuring)), so about 13% and 2.4% of one core; [#339](https://github.com/theagenticage/hercule/issues/339) checks them |
| Account | 62 to 65 | 4 | the password field is focused; three of four launches, sampled again on 8754b1dd |
| Providers | 4 | 1 | |
| A provider login waiting | 301 | 36 | the spinner; read with Playwright attached |
| GitHub | 3 | 1 | |
| GitHub's code waiting | 327 | 64 | the spinner; read with Playwright attached |
| Project | 4 | 1 | |
| All set | 6 | 1 | |
| After the first run: the draft, its composer focused | 60 to 65 | 4 to 5 | the Before reads 51 to 65 and 4 to 5 on the same screen |

- **The waiting steps cost what rule 2's spinner costs,** about 300 GPU wakeups a second, for as long as the wait lasts. That is a 120 Hz display drawing every frame while something turns. Each wait ends by itself, as rule 2 requires. Between waits, every step is at the still-page level.
- **The two focused screens read at the focused-field budget** of 63 GPU and 4 renderer wakeups a second, and at most 2 GPU and 1 renderer wakeups over it. A focused field costs an empty window 62 to 63 and 4, and the app adds about 3 and 1 to that, as the first milestone's finish found on the new-thread screen.
  - The account step was sampled again on 2026-10-03, on 8754b1dd after the review's fixes, in four plain launches, with a load average of 5 to 13. Three read 62, 63 and 65 GPU wakeups and 4 in the renderer.
  - The first of the four, the launch that installed Hercule and reloaded the window, read 4 and 1, the still-page level. Its caret was most likely not blinking: whether macOS makes the app active at a plain launch varies ([Measuring](#measuring)).
  - The first sample, 71 and 6 on 332a0f6f, was not repeated. Its load average was not recorded.
  - The draft read up to 65 and 5, and the Before reads the same on the draft, so that reading is not this change's.
- **The launch was measured as [Measuring](#measuring) describes,** with two differences: one launch under Playwright warms the code cache, and three plain launches follow, 3 seconds apart. The Before's third launch, 449 ms, was slow from main's first step. The load average was not recorded, and other end-to-end suites ran on the machine during the session, each with its own app and controllers, so a busy machine is the likely cause of the 449 ms. A second set of launches 10 minutes earlier read 355 to 379 ms for the After and 365 to 381 ms for the Before.

Memory at each step of the first run, and after it, read as [Measuring](#measuring) describes, 2026-10-03 on the reference machine, on 24b95a9f (After) and on main's 83446e6b (Before), in one session with no other suite running. Each screen was read in two plain launches, each the third launch or later on its user data directory. In every launch the window was active; the second column names the field that had the focus. Sizes are in MB; the processes are the browser, GPU, network utility and renderer, in that order.

| Screen | Focused | Summed physical footprint (budget 220) | Footprint by process (renderer's budget 100) | Working set, summed; renderer |
|---|---|---|---|---|
| Welcome | nothing | **270 to 271** | 49 to 50, 178, 7, 37 | 380 to 381; 113 |
| Account | the password field | **701** | 53, 588, 7, 53 | 411; 136 |
| Providers | nothing | **295 to 296** | 54 to 55, 189, 7, 44 to 45 | 397; 121 |
| GitHub | nothing | **280** | 54, 176, 7, 42 | 392; 118 |
| Project | nothing | **289** | 54, 185, 7 to 8, 42 | 393 to 394; 118 to 119 |
| All set | nothing | **290 to 293** | 54, 185 to 186, 7 to 8, 44 to 45 | 395; 120 to 121 |
| After the first run: the draft | the composer | **667** | 54, 565, 7, 41 | 387 to 388; 117 to 118 |
| Before: the connect screen | the address field | 161 to 164 | 49 to 50, 74, 7, 31 to 34 | 354 to 362; 107 |
| Before: sign-in | the username field | 158 to 166 | 50, 68 to 76, 7, 33 | 369; 109 |
| Before: the draft, after sign-in | the composer | **658** | 49 to 50, 560 to 561, 7, 41 | 388; 119 |

- **Every first-run screen is over the summed budget,** by 50 to 76 MB with nothing focused. The excess is in the GPU process, which holds 176 to 189 MB. On main's connect and sign-in screens it holds 68 to 76 MB, and in an empty window 54 MB ([Baseline](#baseline)). The first run draws the office room behind every card. What in the first run's screens holds the extra memory was not traced. The renderer stays under its own budget, at 37 to 53 MB. All six first-run readings are under the 306 MB the first milestone's finish entry above recorded for the new-thread screen with nothing focused.
  - **The overage is accepted for #313,** because the first run happens once and leaves nothing behind (the bullet on what stays after it, below). [#330](https://github.com/theagenticage/hercule/issues/330) traces what holds the memory and brings the first run's screens under the budget, or records why it cannot.
- **The account step reads 701 MB, 535 MB over main's sign-in screen,** although both open with a field focused. The GPU process holds 588 MB on the account step. That is the cost the first milestone's finish entry above describes for a caret blinking over the glass blur, which was accepted for the first prototype until [#301](https://github.com/theagenticage/hercule/issues/301) decides. Main's connect and sign-in screens, each with a field focused, read 158 to 166 MB, with 68 to 76 MB in the GPU process. That is about the empty window's 54 MB plus the up to 20 MB a focused field costs it ([Baseline](#baseline)). So a focused field alone does not cost the 400 MB: of the screens in this table, the 400 MB shows on the account step and on the draft, on both sides, and not on main's connect and sign-in screens.
- **Nothing of the first run stays after it.** A plain launch after the first run parsed only the first-screen chunk, the bundler's runtime and `theme-init.js`, read from the page's DevTools connection after memory was read. Idle from 30 seconds for 10 seconds, it read 63 GPU and 5 renderer wakeups a second, and the Before read 63 and 4 to 5. So no first-run timer is left.
- **The draft reads 9 MB over the Before,** 667 MB against 658 MB, both with the composer focused, and both over the budget as the first milestone's finish found. The browser process holds 4 to 5 MB more, the GPU process 4 to 5 MB more, and the renderer the same 41 MB. Where the browser process's extra comes from was not traced.
- **How each screen was reached:**
  - The welcome: no controller saved, and a stand-in `hercule` binary that reports nothing installed.
  - The steps after the account: a set-up scratch controller on loopback, signed in once, with the first run's put-off list in the settings file set to the steps before the one measured. The controller ran with a `PATH` that holds no coding agent, so the providers step was not done.
  - The draft: the same controller, with the first run's progress removed from the settings file, as leaving All set does.
  - The Before: no controller saved for the connect screen, and a set-up scratch controller saved for sign-in and, after one sign-in, the draft.
- **The account step is read after a reload, not straight after a plain launch,** because a plain launch cannot open on it. With a controller on this Mac that is not set up, the app opens on the welcome, which greets Hercule as found. So each launch set the mark Open the office leaves in the page's session storage, through the page's DevTools connection, and then main reloaded the window with `webContents.reload()`, as it does once Hercule answers. Memory was read 13 seconds after the reload. The install did not run, because Hercule was already running.
- **The one-minute load average was 4.0 to 6.1** at each launch, and 4.7 at the start of the session.

**The Office, v1,** measured 2026-10-03 and 2026-10-04 on the reference machine, for [#332](https://github.com/theagenticage/hercule/issues/332). *(Added 2026-10-04, [#332](https://github.com/theagenticage/hercule/issues/332).)* This is the Office's first measurement, so it sets the Office's memory and chunk limits ([The Office's budgets](#the-offices-budgets)).

In the app: the packaged test app, launched plainly as [Measuring](#measuring) describes, its third launch or later, against a scratch controller. The fleet is the reference Office: 16 colleagues, 4 working, 4 waiting on the user and 8 idle, on 3 runners and in 3 projects of 6, 5 and 5 threads. The controller also held its own runner, retired, and one exited thread, which has no colleague; the leave row leaves the Office for that thread's screen. The window is 1440 × 900 at 2x, so the Office's canvas is 1168 × 900 beside the sidebar, 2336 × 1800 pixels. Light theme, nothing focused, the camera at rest.

- **CPU** is a share of one core: the growth of `cumulativeCPUUsage` over 30-second windows, starting 45 seconds after the Office opened. `ps` agreed within 0.1.
- **Memory** is the physical footprint of the four processes, read with `footprint` 13 seconds after the screen opened.
- **Sizes** come from `pnpm build:desktop`'s size checks, 1,024 bytes to a kB.
- **The one-minute load average** was 4 to 6, and 11 in one window, from other programs on the machine.

| Measure | Budget | Measured |
|---|---|---|
| Frames, camera at rest | at most 30 a second | 30.1, out of 120 animation frames a second |
| CPU, camera at rest | renderer 20%, GPU process 35% | renderer 6.2 to 16.3%, GPU process 5.1 to 11.2%, over 15 windows in 3 launches |
| Wakeups, camera at rest | - | renderer 45 to 64 a second, GPU process 267 to 273 |
| Leaving the Office | the idle row within 5 seconds | renderer 1 to 3 wakeups a second from 5 to 15 seconds after leaving, in 5 launches; from 15 seconds on, 0 to 2, the level of a thread screen the Office never opened. GPU process 0 to 5 |
| Memory with the Office open | the first reading plus 10% | **1,359 to 1,457 MB** summed, in 8 launches; the renderer 146 to 165 MB. On the thread screen just before: 325 to 331 MB, and 56 to 60 MB |
| The Office's chunk, gzipped | the first reading plus 10% | 219.6 kB, 786.1 kB before gzip |
| Renderer JavaScript for the first screen, gzipped | 250 kB, a guide | 297.8 kB in 7 chunks. Before the Office, 296.7 kB in 6 |

- **The limits this sets** are the highest readings plus 10%: with the camera at rest, 17.9% of one core for the renderer and 12.3% for the GPU process; with the Office open, 1,602 MB summed and 181 MB for the renderer; and 241.5 kB for the chunk. The table in [The Office's budgets](#the-offices-budgets) states them.
- **The Office adds 1.1 kB to the first screen.** The first-screen chunk grew by 1.0 kB, for the Office's part of the shell: the sidebar's Office button, the route and the Go menu's item. The thread screen became a chunk of its own, because the Office's drawer loads it too. The first screen was over the 250 kB guide before the Office. Main's startup file is 156.1 kB, against 156.0 kB before.
- **Almost all of the Office's memory is in the GPU process:** 1,154 to 1,236 MB, against 210 MB on the thread screen. The page's own WebGL allocations are 404 MB:
  - the composer's target, 241 MB: 4× multisampled half-float colour and depth, and their resolved copies;
  - the 4096 × 4096 shadow map, 128 MB: its depth texture, and a colour texture three.js adds that nothing reads;
  - geometry, 20 MB; the environment map, 9 MB; the name tags' and labels' textures, 7 MB.

  The graphics driver's memory in the GPU process grows by 876 MB when the Office opens. So about 450 MB is held by the driver beyond those allocations and the canvas, and was not traced. Bringing the Office's memory down is [#370](https://github.com/theagenticage/hercule/issues/370).
- **The composer allocated two targets before the review,** and the summed footprint read 1,505 MB in two launches with 4 colleagues. With one target, the same setup read 1,260 and 1,271 MB.
- **CPU at rest reads at different levels for the same work.** In some windows the renderer read 6 to 7%, in others 13 to 16%, with the same frames, wakeups and JavaScript per frame. The likely cause is which kind of core macOS runs the processes on, efficiency or performance, but reading that needs root, so it was not proven. The highest window is under the limits.
- **A profile of the renderer at the lower level** puts the Office's frame at 3.2% of its wall time: three.js 2.5%, the simulation 0.2% and the name tags 0.1%. React ran in no sample, and no frame forced a layout. The rest of the renderer's CPU is Chromium's own work for each frame. The profile was taken with 4 colleagues, before the composer change.
- **The stage asks for 120 animation frames a second and draws one in four.** The skipped ones cost the renderer about 1% of a core. Asking for 30 a second is [#367](https://github.com/theagenticage/hercule/issues/367).
- **The renderer is back within the idle row 15 seconds after leaving, not 5.** A trace of the 45 seconds after leaving shows no call into the Office's chunk. The extra wakeups are Chromium's and V8's clean-up of what the Office released:
  - from 0 to 5 seconds, the compositor frees the canvas's resources, about 28 times a second;
  - around 5 seconds, V8's memory reducer runs two major garbage collections that return the Office's memory, 15 ms of the main thread in all;
  - until about 15 seconds, the tail of that clean-up, background sweeping and the compositor freeing tiles, wakes the renderer 1 to 3 times a second. When it ends varies from launch to launch.

  From 15 seconds on, the renderer reads like a thread screen the Office never opened: 0 to 2 wakeups a second. That screen's own renderer reads 2 a second from 45 seconds after it opens, from Chromium's periodic purge of its memory allocator, with no Office involved.

  **The miss is accepted for #332,** so the Office can ship. No code of the Office's runs after it leaves, and the renderer is back within the idle row 10 seconds late. The budget stays at 5 seconds. [#379](https://github.com/theagenticage/hercule/issues/379) brings the app within it, or records why it cannot.
- **Leaving frees what the Office built.** 5 to 15 seconds after leaving, the four processes summed 321.5 MB and the page held no canvas. Over 10 visits, the page held 0 WebGL contexts and 0 canvases after each one, and its listeners stayed at 205. Before the review's fix, each visit left one WebGL context behind, because three.js keeps the last renderer in a lookup table; the Office now clears it when it leaves. The JavaScript heap grew from 14.1 to 16.2 MB over the 10 visits, all of it V8's compiled code: the three.js objects counted the same after each visit.

The rows below were read on the prototype's page, not in the app, because the measuring page inside the app is [#339](https://github.com/theagenticage/hercule/issues/339). The Before is the prototype at 6fcb3634 on `prototype/office-3d`. The After is the Office's engine before the review's fixes and the composer change. Both ran from a Vite dev server in the repository's Electron, with the glass turned off by a style rule, the reference fleet of 16, and 30-second samples after 25 seconds.

| Measure | Budget | Before | After |
|---|---|---|---|
| CPU, camera at rest | renderer 20%, GPU process 35% | 51.9%, 43.8% | 7.8%, 6.3% |
| Frames and CPU, camera moving | at most 60 a second | 97 frames; with the glass on, 56.7%, 93.2% | 60 frames; 21.3%, 14.7% |
| Window visible, not focused | 30 a second | - | 30.2 frames; 8.9%, 7.0% |
| Standing still | the idle row | - | 0 frames; 0.3%, 0%; no wakeups |
| Window hidden or covered | no frames | 0 frames | 0 frames, no wakeups |
| Draw calls | - | 1,801 | 591 |

- **While the camera moves, the sun's shadows are drawn again 17 to 19 times a second,** because the walls that drop to the dado rail change height. That is most of the camera's cost ([#358](https://github.com/theagenticage/hercule/issues/358)). The CPU limits apply with the camera at rest.
- **With the glass on, the After read 8.8% and 23.9% at rest, and 19.1% and 55.9% while the camera moved.** That is why the window draws no blur while the Office is open (rule 5).
- **At ten times the fleet,** 160 colleagues, #333 read 21.4% and 14.9% in one run: over the renderer's limit, which is set for the reference fleet. The building drawn into a texture ([#340](https://github.com/theagenticage/hercule/issues/340)) and merging more meshes are the levers before fleets grow.
- **A minimized window was not measured:** the measuring script's call to minimize its window had no effect. Chromium treats a minimized window as hidden, and the hidden row read no frames and no wakeups.
- **Standing still was read with the battery reported as discharging** by an override in the measuring script, not on a Mac running on battery.
- **`apps/desktop/scripts/perf.ts` read CPU from `percentCPUUsage`** until this change, a share of the whole machine. It now reports a share of one core ([Measuring](#measuring)).

**Settings: the frame, Profile and System,** measured 2026-10-05 with `pnpm build:desktop`'s size checks and `apps/desktop/scripts/perf.ts`, on `main` at 959696a8 (Before) and on this change (After), for [#410](https://github.com/theagenticage/hercule/issues/410). Settings adds no process, no timer, no polling and no live topic: Profile reads what the shell already holds, and System reads the controller's record once each time it opens.

| Measure | Budget | Before | After |
|---|---|---|---|
| Processes | none added | 4 | 4 |
| Renderer JavaScript for the first screen, gzipped | 250 kB, a guide | 297.8 kB in 7 chunks, of 20 built | **298.4 kB** in 8 chunks, of 26 built |
| Settings' chunks, gzipped, none on the first screen | one per section | - | the frame and the list 2.1 kB, Profile 1.7 kB, System 1.3 kB, and three chunks they share: the Connection helpers 1.0 kB, the setting row 0.4 kB and the time zones 0.3 kB |
| Main's startup, minified | 160 kB | 156.1 kB | 156.2 kB |
| Memory with Profile open, 40 threads | summed 220 MB, renderer 100 MB | - | **217.2 MB** summed: browser 51.9, GPU 105.5, network utility 7.5, renderer 52.3 |
| Idle with Profile open, window visible | the idle row | - | renderer 0.6% of a core and 1 wakeup a second, GPU process 0% and 0; hidden, 1 a second each |
| Launch, spawn to window shown | 500 ms | - | 378 ms; Settings is not on the launch path |

- **The first screen grows by 0.6 kB:** the foot's Settings link, the `openSettings` command, the shell's handler for it and the route tree's entries for Settings. Each section is its own chunk and loads the first time it opens.
- **Memory and idle were read with Profile open, not Appearance and Machines** as [What Settings costs](#what-settings-costs) asks, because those sections are not built yet. Their slices read them. With Profile open the app reads within the memory row, where the new-thread screen of the same launch setup reads 690 MB with its composer focused: Profile focuses no field, so the GPU process holds 105.5 MB against 586 MB.
- **The one-minute load average was 8.4** at the Settings launch, from other programs on the machine.

**Codex subagent usage reports,** measured 2026-10-06 with `pnpm build:desktop`'s size checks, for [#437](https://github.com/theagenticage/hercule/issues/437). The desktop imports the shared contract's new usage-report schemas. This change adds no desktop process, timer or polling. Desktop rendering and streamed-token handling are unchanged. Runtime memory, CPU and wakeups were not remeasured.

| Measure | Earlier PR build, b9ca7602 | Final implementation, 3b9b6e58 | Budget |
|---|---|---|---|
| Renderer JavaScript for the first screen, gzipped | 299.2 kB | 299.3 kB | 250 kB, guide |
| Main's startup file, minified | 156.9 kB | 157.2 kB | 160 kB, guide |

The earlier sizes come from that commit's CI build; the final sizes come from the local build. This comparison measures the review corrections, not the full branch against its base. The renderer already exceeded its guide in the earlier build. The guide and exact pixel comparison gate remain unchanged; the final local comparison matched every cell and pixel in both themes and all seven regions.

**The assistant, slice 20: Assistants in the sidebar,** measured 2026-10-06 on the reference machine with `pnpm build:desktop`'s size checks and `apps/desktop/scripts/perf.ts`, on `main` at 1a3e789d (Before) and on the working tree of branch `t3/desktop-assistant-sidebar` (After), for [#453](https://github.com/theagenticage/hercule/issues/453). Both sides used the fixture with 40 threads and 5 assistants: Hercule, which setup creates, and Ada, Milo, Juno and Rex. The After launch numbers are the medians of three runs of the script, each read on its third launch, with Settings › Profile open. The slice adds no process, no timer and no polling. The sidebar's faces are still.

| Measure | Budget | Before | After |
|---|---|---|---|
| Processes | none added | 4 | 4 |
| Renderer JavaScript for the first screen, gzipped | 250 kB, a guide | 299.3 kB in 8 chunks, of 26 built | **302.1 kB** in 9 chunks, of 30 built |
| The assistant's screen, gzipped, not on the first screen | its own chunk | - | 1.4 kB, and the route's two stubs 0.2 kB and 0.1 kB |
| Main's startup, minified | 160 kB | 157.2 kB | 157.4 kB |
| Launch, spawn to window shown, 5 assistants | 500 ms | 372 ms | 385 ms (382 to 410) |
| Launch steps, ms from spawn | - | Node ready 104, GPU 140, renderer 175, page start 236, first paint 264, first screen 364 | Node ready 106, GPU 139, renderer 176, page start 237, first paint 289, first screen 379 |
| Memory, 40 threads and 5 assistants, Profile open | summed 220 MB, renderer 100 MB | 219.5 MB summed: browser 52.0, GPU 107.7, network utility 7.5, renderer 52.4 | **220.7 MB** summed (220.4 to 221.9): browser 52.0, GPU 106.4, network utility 7.6, renderer 54.6 |
| Idle, window visible | the idle row | renderer 0.9% of a core and 1 wakeup a second, GPU process 0; hidden, 1 a second each | renderer 0.7% of a core and 1 wakeup a second, GPU process 0; hidden, 1 a second each |
| Live topics: reads per `session` push | - | 1: the thread list | ~~6: the thread list and one current session per assistant, 120 reads for 20 nudges in every launch~~ *(amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453))* **1**: the thread list, and no assistant's current session. 20 thread-list reads and 0 current-session reads for 20 nudges, in every launch. Each nudge moves one thread between busy and idle, so it names a session the thread list holds. A push that names a session of an assistant's conversation reads that one assistant's again, a push about a workflow run's session reads none, and a push that names no session reads every assistant's |
| Live topics: reads per `assistant` push | - | none: not subscribed | 1: `assistant.query`. A new assistant adds one `session.query`, for its current session |
| Live topics, with a Conversation open while its assistant replies | as [What the assistant costs](#what-the-assistant-costs) lists | - | not measured in this slice: the Conversation is slice 21 |
| Work per streamed token, while a reply streams | unchanged | - | not measured in this slice: slice 21 |
| Memory with a Conversation of 2,000 messages open | the memory row | - | not measured in this slice: slice 21 |
| Idle with a Conversation and its drawer open | the idle row | - | not measured in this slice: slices 21 and 22 |
| Opening the drawer | one transform transition | - | not measured in this slice: slice 22 |

- **The first screen grows by 2.8 kB:** the sidebar's Assistants section, the Waiting on you row for an assistant, the shell's reads of the assistants and their current sessions, and the `/assistants/$assistantId` route's entry. It was over its guide before, and is now 52.1 kB over it.
- **Summed memory is now over its 220 MB budget, by 0.7 MB** in the median and by 1.9 MB in the highest run. The renderer holds 2.2 MB more, for the 5 assistants' records, their current sessions and their rows. The budget is a guide during the first milestone ([Performance](#performance)), so the slice does not stop here, and the next performance pass brings the app back within it.
- **Launch is 13 ms later in the median,** most of it between the page's start and its first screen, where the second wave of reads lands: `assistant.query` goes out with the thread list's reads, and the 5 `session.query` reads as soon as it answers. The machine was busy, so this is no more than an upper bound.
- **The live-topic reads were counted in the page** during the script's 20 `session` nudges, in all fifteen measured launches of the three runs, by a one-off copy of the perf script with a `PerformanceObserver` for resource entries added for this measurement. The copy was not kept: the script itself counts only the thread list's reads. The fixture sends no `assistant` push, so that row is read from the code: an `assistant` push invalidates only the assistants' keys, and a current session is read only for an assistant the cache does not hold yet.
- **The thread list's live updates with 500 threads** read 11.4 to 16.2 ms of the renderer's main thread a nudge, and 13.0 to 17.6 ms with a long thread open. Two of the six readings are over the 16 ms row, by 0.2 and 1.6 ms. ~~Each nudge now also reads the 5 current sessions.~~ *(amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453): each nudge names a thread's session, so it reads no current session.)* Before was not measured on this row.
- **The one-minute load average** before the three Profile launches was 12.9, 26.8 and 6.3, and from 5.4 to 26.8 across all fifteen launches, from other programs on the machine. Before was measured at 5.5 to 6.9.

**Subagents,** measured 2026-10-06 on the reference machine with `pnpm build:desktop`'s size checks, `apps/desktop/scripts/perf.ts` and DevTools traces of the test package, on `main` at 1a3e789d (Before) and on this change (After), for [#440](https://github.com/theagenticage/hercule/issues/440). Each row is a row of [What subagents cost](#what-subagents-cost). The perf script ran on both builds back to back; its subagent scenario exists only in the After build, so those rows have no Before. The subagent scenario opens a thread with 20 subagents, 4 of them running, 2 failed and the rest done. The traces stand in for the Performance panel: the same scenario, recorded with `Tracing.start` over the DevTools protocol.

| Measure | Budget | Before | After |
|---|---|---|---|
| Processes | none added | 4 | 4 |
| Renderer JavaScript for the first screen, the thread's route included, gzipped | grows only by the spawn line and the tally | 299.5 kB in 8 chunks, of 26 built | ~~**308.9 kB** in 12 chunks, of 34 built: first paint 237.7 to 239.1 kB, the thread's route 61.8 to 69.8 kB~~ *(amended 2026-10-07, [#440](https://github.com/theagenticage/hercule/issues/440), measured again on the merge of `main` at acb79ce5, against that `main`)* 310.7 kB in 13 chunks, of 38 built, against 302.3 kB in 9, of 30: first paint 240.6 to 240.6 kB, the thread's route 61.7 to 70.1 kB |
| The side pane and the subagent page, gzipped | their own chunks, loaded the first time one opens | - | the side pane 5.6 kB; the subagent page 2.9 kB and 0.4 kB. None is on the first screen |
| Main's startup, minified | 160 kB | 157.2 kB | 157.4 kB |
| The web app's first screen, gzipped | 250 kB | 221.3 kB | 221.3 kB |
| Launch, spawn to window shown | 500 ms | 377 to 409 ms | 353 to 408 ms |
| Live topics | `subagent` only while a thread is open; a subagent's page holds its own `:stream` and `:tap` in place of the thread's | - | as expected at every step: the thread's page, the subagent's page visible and hidden, the thread's page again, and Settings with no thread open |
| Nudges | none for another thread; at most one a second for the open thread | - | another thread's 11 changes: 0 reads; the open thread's 4 changes a second: 11 pushes and 11 reads in 10.1 s |
| Work per streamed token, the thread's page, 501 rows | longest task 50 ms; one paragraph write a frame at most | 14.5 ms; 1,185 writes in 2,382 frames | 15.1 ms; 1,171 writes in 2,381 frames |
| Work per streamed token, a subagent's page | unchanged from the thread's page | - | as the thread's page, within the noise: side pane closed, 1.72 s of renderer main thread in 7 s of streaming against 1.78 s on the thread's page (median of 4 runs; 1.68 to 1.74 s and 1.71 to 1.81 s); side pane open, 1.91 s against 1.99 s. Longest task 13.4 ms against 12.4 ms. Both pages: about 835 paragraph writes in 840 frames, for about 2,880 WebSocket frames |
| A subagent streaming while the thread's page is open | its tokens do not reach the app | - | 5 WebSocket frames, 299 bytes in 15 s |
| Memory, side pane closed, then open on 20 subagents | summed 220 MB, renderer 100 MB | - | **818 MB, then 869 MB summed**, GPU process 692.5 then 721.7 MB; renderer 66.2 then 86.4 MB |
| Idle, side pane open, every subagent ended | renderer at most 2 wakeups a second, GPU at most 12 | - | visible: renderer 1, GPU 1; hidden: renderer 0. No duration changed |
| Running subagents, side pane open | a duration ticks at most once a second, only on screen; faces still | - | the three running rows on screen: 10 changes each in 10 s; the running row off screen: 0; hidden: 0. 0 running animations in the pane |
| Resizing the side pane | layout per pointer move, nothing after | - | 64 layouts for 61 pointer moves, longest task 8.2 ms; after the pointer is released, 1 write of the width and 4 layouts in 3 s |

- *(Amended 2026-10-07, [#440](https://github.com/theagenticage/hercule/issues/440).)* **First paint no longer grows.** `main` now names the asking subagent on the Request, in the controller ([#453](https://github.com/theagenticage/hercule/issues/453)), so the shell no longer reads the subagent, and the 2.1 kB below left first paint with it. The thread's route grows by 8.4 kB, as the row above shows. The bullet below is the measurement before that merge.
- ~~**The first screen grows by more than the spawn line and the tally, a miss.**~~ The spawn line and the tally are not at first paint at all: they are in the thread's route chunk. First paint still grows by 1.4 kB. It grew by 3.4 kB until `nameSubagent` moved into its own module (`subagents/name.ts`) and the pills the new-thread screen's header shares moved out of `thread-header.tsx` into `header-pills.tsx`. The 1.4 kB is three things; the sizes are each source gzipped on its own, so they are approximate and do not add up exactly:
  - naming the asking subagent in a notification, about 2.1 kB: `useQueries` and its observer from TanStack Query (about 1.5 kB), the shell's read of each asking subagent, and `waiting-threads` with `nameSubagent`;
  - the routes' declarations and loaders, about 0.6 kB: the subagent route, the `$sessionId` route split into a layout and its index, and the route tree's entries, less the single `$sessionId` route they replace;
  - the query and live wiring, about 0.3 kB: the subagent queries in `queries.ts`, the `subagent` live topic in `live.ts`, `live/keys.ts` and the contract.

  The header pays some of it back: first paint now holds only the shared pills (1.3 kB) in place of the whole thread header (2.0 kB), which moved to the thread's route with the side pane's toggle. The thread's route grows by 8.0 kB: the spawn line, the tally, the Request pager and the thread header (they ship in the thread page's chunk, `agent-page`), the side pane's toggle and its state, and four small chunks the open thread loads with it: the subagents' descriptions and the Stop hook, the drafts, the route's component and its not-found screen.
- **A subagent's page costs no more per streamed token than a thread's page.** A first trace read 25% more on the subagent's page, but it compared unlike pages: the subagent's page with the side pane open and four subagents running, against another thread's page with the pane closed and nothing running. The row above is measured again with the same token stream on both pages:
  - One thread per run, with 20 subagents. The thread's own agent streams twice and one subagent streams twice, each for 10 s at a word every 2 ms, while the other agent waits on a command. Each stream is traced on its own page, once with the side pane closed and once open.
  - Each trace starts 1 s after the first token is on screen and lasts 7 s, so it ends before the stream does and holds no page load.
  - Four runs, each on a new thread and a new launch of the test package. Half the runs trace the thread's page first, half the subagent's page.
  - In each run, the subagent's page took 2% more to 7% less than the thread's page with the pane closed (median 4% less), and 2% to 7% less with the pane open (median 3% less). The two transcripts differ: the thread's holds the spawn lines and the composer, about 1,370 layout objects, and the subagent's the brief card and the status card, about 860.
- **Opening the side pane costs about 12% more renderer work per streamed token, on either page** (10% to 16% across the runs). The largest part, about a third, is pre-paint, which grows by about 80% (90 to 161 ms on the thread's page), and each layout then covers about 2,950 objects in place of 1,370; the pane itself is repainted once a frame, from cache, in about 0.02 ms. Its cause within the pane is not looked for here. It stays well inside the streaming budget.
- **The summed footprint is over the memory row, and the cause is not found.** The GPU process holds 692 to 722 MB. That is not the composer's blinking caret: the trace with four subagents running shows one painted frame a second, from the ticking durations. The renderer stays inside its 100 MB, and the side pane open on 20 subagents adds 20.2 MB to it. The new-thread screen in the same run reads 689 to 696 MB summed in both builds, so the GPU process is as large before this change as after it: the summed miss predates #440, and this change does not cause it.
- With four subagents running and the window visible, the renderer wakes 5 times a second and the GPU process 39 times; hidden, 0 each.
- The 4 layouts after the drag match the idle rate with durations ticking, 1.2 a second, so the release adds none of its own.
- The Office's drawer was not measured: the perf script covers the thread's page, a subagent's page and Settings.
- The one-minute load average was 5.5 to 18.2 at the Before launches and 5.7 to 16.4 at the After launches, and 4.1 to 5.3 during the streaming traces, which waited for it to fall to about 4 before each run. Other worktrees' test runs were on the machine.

**The assistant, slice 21: The Conversation** *(added 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454))* shipped without being measured. Its rows in [What the assistant costs](#what-the-assistant-costs) stay open: live topics with a Conversation open while its assistant replies, work per streamed token while a reply streams, memory with a Conversation of 2,000 messages open, and idle with a Conversation open. They are measured in a later performance pass, together with slice 22's rows. The budgets guide the first milestone and do not gate it ([Performance](#performance)), so the slice does not wait for them.

**Settings › Assistants,** measured 2026-10-07 on the reference machine with `pnpm build:desktop`'s size checks and one run of `apps/desktop/scripts/perf.ts`, on the working tree of branch `t3/desktop-settings-414-415`, for [#414](https://github.com/theagenticage/hercule/issues/414) and [#415](https://github.com/theagenticage/hercule/issues/415). The perf script now opens Settings › Assistants as well as Settings › Profile, so the row with Profile open is from the same run. The section adds no process, no timer, no polling and no live topic of its own: its loader reads the profiles and the settings each time it opens, and the assistants and the providers only when the cache does not hold them yet, and the heartbeat timeline's "now" line moves only when the section is opened again.

| Measure | Budget | Profile open | Assistants open |
|---|---|---|---|
| Processes | none added | 4 | 4 |
| The Assistants chunk, gzipped, not on the first screen | its own chunk | - | 11.3 kB of JavaScript and 0.6 kB of CSS, and the chunks it shares with the other sections |
| Memory, 40 threads | summed 220 MB, renderer 100 MB | 226.3 MB summed: browser 54.0, GPU 110.3, network utility 7.8, renderer 54.2 | **267.3 MB** summed: browser 54.1, GPU 147.2, network utility 7.7, renderer 58.2 |
| Idle, window visible | the idle row | renderer 0.9% of a core and 1 wakeup a second, GPU process 0% and 0; hidden, renderer 0 | renderer 0.4% of a core and 1 wakeup a second, GPU process 0% and 0; hidden, renderer 1 a second |
| Launch, spawn to window shown | 500 ms | 379 ms | 363 ms; Settings is not on the launch path |

- **Summed memory is over its budget with either section open,** by 6 MB with Profile and by 47 MB with Assistants. The renderer holds 4 MB more with Assistants open, for the section's reads and its longer page. The GPU process holds 37 MB more, and the cause is not found: the GPU process wakes 0 times a second with the section open, so no caret or animation is drawing. The budget is a guide during the first milestone ([Performance](#performance)), so the slice does not stop here.
- **Accepted** (decided 2026-10-07, [#414](https://github.com/theagenticage/hercule/issues/414)/[#415](https://github.com/theagenticage/hercule/issues/415)): the section ships drawn as the book draws it, and the summed footprint stays over its budget while it is open. The budget is not raised. A later performance pass finds what the GPU process holds, together with the other GPU overages recorded here ([#301](https://github.com/theagenticage/hercule/issues/301), [#330](https://github.com/theagenticage/hercule/issues/330)).
- **One run, not the median of three.** The numbers move by a few MB between runs; the slice 20 rows above read 220.4 to 221.9 MB summed for Profile across three runs.
- **The one-minute load average was 2.1** at the Profile launch and **4.2** at the Assistants launch, from other programs on the machine.

**Images in prompts,** measured 2026-10-08 on the reference machine with `pnpm build:desktop`'s size checks and one run of `apps/desktop/scripts/perf-images.ts`, on the working tree of branch `feat/465-images-in-prompts`, for [#465](https://github.com/theagenticage/hercule/issues/465). The script opens a thread on the 40-thread fixture, attaches ten generated 3840 × 2160 PNG screenshots (4.0 MB of PNG in all) through the composer's file picker, and reads the footprint after each step, each time after a garbage collection and 10 s of settling. The plain `<img>` comparison runs last, because Chromium keeps its full decodes after the URLs are revoked, which would inflate every reading after it.

| Step | Summed | Browser | GPU | Renderer | Processes |
|---|---|---|---|---|---|
| Thread open, 10 files held, nothing drawn | 300.2 | 54.6 | 194.0 | 43.6 | 4 |
| 10 on the shelf, WebP thumbnails | 307.4 | 53.9 | 192.5 | 52.7 | 4 |
| All 10 removed | 300.7 | 48.3 | 191.4 | 52.8 | 4 |
| Sent: 10 in the bubble, 210 × 158 | **825.2** | 53.5 | **702.8** | 60.6 | 4 |
| 10 plain `<img>` on object URLs, 64 × 64 | **1,400.4** | 51.8 | 992.3 | **348.6** | 4 |
| Plain images removed, URLs revoked | 1,113.6 | 51.5 | 995.1 | 59.4 | 4 |

| Measure | Budget | Measured |
|---|---|---|
| Processes | none added | 4 |
| Dependencies | none added | none |
| The first screen's JavaScript, gzipped | grows only by the shelf, the lightbox and client-core's attachment module | 322.2 kB, up 6.3 kB from 315.9 kB; this includes the contract's and client-core's attachment code. The lightbox is a chunk of its own, 0.8 kB, loaded the first time an image is previewed. Main's startup file is 159.0 kB, inside its 160 kB |
| Idle, 10 on the shelf, window visible | the idle row | renderer 0.6% of a core and 1 wakeup a second, GPU process 0% and 0 |

- **The thumbnails stay.** Ten images on the shelf cost the renderer 9 MB as WebP thumbnails, and about 290 MB as plain 64 × 64 `<img>` tiles on the files' object URLs, which decode each image at full size. The plain tiles also grow the GPU process by about 290 MB, and it does not give that back when the tiles are removed and their URLs revoked. The difference is not small, so the simpler plain approach is not used.
- **Sending ten images grows the GPU process by about 510 MB, and the cause is not found.** The renderer stays at 61 MB. The bubble already draws 210 × 158 thumbnails at the device pixel ratio, not the full images, in this run. Building the thumbnails is not the cause: a one-off variant of `perf-images.ts`, not kept, built ten thumbnails without drawing or sending them, in three ways, and the GPU process stayed at 184 MB after each: from a full decode at 128 × 128, from a full decode at 420 × 316, and straight from the file at 420 × 316. Whether drawing the bubble's thumbnails, or something else in the send, holds the memory is still open, and a text-only send, as a control, was not measured. The budget is a guide during the first milestone ([Performance](#performance)), so the build does not stop here; the later performance pass that looks at the GPU process ([#301](https://github.com/theagenticage/hercule/issues/301), [#330](https://github.com/theagenticage/hercule/issues/330)) takes this one too.
- **Summed memory is over the 220 MB row before any image is attached,** at 300 MB, as the other entries on the thread page record.
- **Work per streamed token and the uploads' network use were not measured.** A bubble's images are read once, when the bubble first draws, and at most three uploads run at a time.
- **One run, not the median of three.** The one-minute load average was 5.6 at spawn and 5.5 at the end, from other worktrees' runs on the machine.

**Settings › Appearance, slice 12,** measured 2026-10-08 on the reference machine with `pnpm build:desktop`'s size checks, five runs of `apps/desktop/scripts/perf.ts` before the change and one after (its five launches on the new-thread screen), and one Chromium trace each of a theme change and a Glass drag in the packaged app, on the working tree of branch `feat/411-appearance-themes-glass`, for [#411](https://github.com/theagenticage/hercule/issues/411). The page adds no process, no timer, no polling and no live topic.

| Measure | Budget | Measured |
|---|---|---|
| Processes | none added | 4 |
| Launch, spawn to first paint and to window shown | `appearance.read` adds one synchronous message, answered from memory | before: first paint 236 to 288 ms, shown 346 to 420 ms; after: first paint 216 to 270 ms, shown 343 to 368 ms. The message is lost in the spread between launches |
| The first screen's JavaScript, gzipped | grows only by the foot button's handler, the route stub and `theme-init.js`'s reading of the Appearance | 324.2 kB, up 1.2 kB from 323.0 kB; `theme-init.js` is 1.5 kB, up from 0.8 kB. The first screen was over its 250 kB guide before this change |
| Main's startup file, minified | 160 kB | 148.0 kB, down from 159.1 kB: `@hercule/protocol` now declares `"sideEffects": false` and keeps the identity port in a module of its own, so main no longer takes in the whole protocol through the contract (spec 14) |
| The Appearance chunk, gzipped, not on the first screen | its own chunk | 3.6 kB of JavaScript and 1.0 kB of CSS |
| A change of theme | one frame that restyles the page | one frame with two style passes, 2.0 ms and 1.6 ms: the snap's computed-style read, then the frame's own. One layout |
| Dragging the Glass slider | a restyle per input event while the user drags, nothing after | 20 input events over the drag, 36 style passes and 18 ms of style work in all, one save on release, and no style pass or frame after it |

- **The theme change restyles twice in its frame,** because `theme-init.js` reads a computed style while transitions are off, so no control fades. The second pass costs 1.6 ms, and a snap without it would start every transition on the page.
- **A few small style passes follow a theme change,** 0.2 ms in all, over the next few frames. Their cause was not traced; they end on their own.
- **Memory was not measured with the Appearance page open.** The perf script opens Profile and Assistants, and the Appearance page reads nothing from the controller.
- **The one-minute load average was 3.1 to 9.5** at the After launches, from other worktrees' runs on the machine.

**The flat sidebar,** measured 2026-10-08 on the reference machine with `pnpm build:desktop`'s size checks, on `main` at d1c8e7a4 (Before) and on the working tree of branch `t3/desktop-sidebar-flat-threads` (After), for [#473](https://github.com/theagenticage/hercule/issues/473). The change adds no process, no read, no live topic and no polling. The hover card is one popover element for the whole list, and its 400ms delay is the only timer, running only while the pointer rests on a thread row. Typing in a composer does not draw the sidebar again: the set of threads with unsent work keeps its identity until a thread gains or loses unsent work. A thread row grows from 35px to 59px for its third line and the space around its text, so the virtualized list mounts fewer rows for the same height. The end-to-end suite's check that a project of 500 threads mounts about as many rows as one of 40 still passes.

| Measure | Before | After |
|---|---|---|
| The first screen's JavaScript and CSS, gzipped | 323.0 kB | 324.8 kB (+1.8 kB) |
| Main's startup file | not measured; the change touches no file main links | 159.1 kB |

**Runtime warnings in the transcript,** measured 2026-10-08 with `pnpm build:desktop`'s size checks and `gzip -9` on the built files, on the working tree of branch `fix/476-oversized-runner-events`, for [#476](https://github.com/theagenticage/hercule/issues/476). Before and After were built from the same tree, which already held the runner's and protocol's side of #476; only the renderer's change lies between them. The line adds no process, no timer, no polling and no live topic: a warning is one more transcript row, read and streamed like every other.

| Measure | Budget | Measured |
|---|---|---|
| The first screen's JavaScript, gzipped | grows only by the line's component and its case in the transcript | 324.5 kB, up 0.2 kB from 324.3 kB: the agent page's chunk is 13.2 kB, up from 12.9 kB, and the transcript's chunk is 52.5 kB, down 2 bytes. The first screen was over its 250 kB guide before this change |
| CSS, gzipped | a few rules | the agent page's CSS up 100 bytes, to 1,042 bytes; the first screen's CSS up 24 bytes, to 9,833 bytes, because `.time` and `.dot` moved into `controls.css` from Settings' and the assistant's CSS, which shrank by 51 and 13 bytes |
| Work while idle | none | none: the line has no state, no timer and no animation |
| Work per streamed token | unchanged | unchanged: tokens are still painted into the paragraph being written, without a render, and a warning line is a memoized component whose props never change |

- **The numbers above predate a rebase onto `main` at d05f2f7a,** which brought in the flat sidebar (#473) and #481. On the rebased tree, `check-bundle-budget` reports 326.3 kB for the first screen's JavaScript and CSS, gzipped; the warning line's share was not measured again.
- **The transcript's virtual list guesses a warning's height** as 17.4px per line at about 110 characters a line, and measures it once drawn, as it does every block.

**Settings › Permission profiles,** measured for [#494](https://github.com/theagenticage/hercule/issues/494) with `pnpm build:desktop`'s size checks against a build of `main`. The rows `apps/desktop/scripts/perf.ts` measures were not run for this change and stay TBD. The section adds no process, no timer, no polling and no live topic of its own beyond `assistant`: its loader reads the profiles and the agents each time it opens.

| Measure | Budget | Measured |
|---|---|---|
| Processes | none added | TBD |
| The Permission profiles chunk, gzipped, not on the first screen | its own chunk | the list 1.7 kB and the profile's page 3.7 kB, each a route chunk; 1.8 kB of code shared by the two, and 1.1 kB of CSS. The first screen is 326.4 kB against `main`'s 326.3 kB |
| Memory, 40 threads | summed 220 MB, renderer 100 MB | TBD |
| Idle, window visible | the idle row | TBD |
| Launch, spawn to window shown | 500 ms | TBD |

**Assistants in the Secretariat,** measured 2026-10-09 on the reference machine, for [#505](https://github.com/theagenticage/hercule/issues/505). Before is `main` at 0fbace29, and After is this change. Sizes come from `pnpm build:desktop`'s size checks, 1,024 bytes to a kB. The CPU, standing still, hidden and memory rows are read as **The Office, v1** above reads them, in the packaged test app with the reference Office plus 3 assistants: one working, one idle and one asleep. The change adds no process, no read and no live topic. Its one new timer is the clock's, once a minute, counting only the time the window is shown.

| Measure | Budget | Before | After |
|---|---|---|---|
| Processes | none added | 4 | 4 |
| The Office's chunk, gzipped | 241.5 kB | 219.3 kB | 223.8 kB |
| Renderer JavaScript for the first screen, gzipped | 250 kB, a guide; unchanged by this change | 326.8 kB in 14 chunks | 327.3 kB in 14 chunks: the shell's sidebar and the client-core helpers it shares with the Office |
| CPU, camera at rest, reference Office plus 3 assistants | renderer 17.9%, GPU process 12.3% | renderer 18.7 to 24.6%, GPU process 10.8 to 15.0%; 30 frames a second | renderer 21.4 to 24.6%, GPU process 11.1 to 14.6%; 30 frames a second |
| Standing still | no frames, except state-change walks and the clock's one frame a minute | 175 to 263 frames in 60 s, all in its first 10 s, while colleagues out on an errand walk back; none after | 59, 89 and 927 frames in 60 s, for the same reason; none after. The first launch stopped within 10 s and the second within 30 s. The third caught a longer errand, and its frames stopped by 50 s |
| Window hidden | no frames and no wakeups | 0 to 1 frames in 13 s, the one drawn as the window hides; renderer 3 wakeups a second, GPU process 0 | 0 to 1 frames in 13 s; renderer 3 wakeups a second, GPU process 0 |
| Memory with the Office open | summed 1,602 MB, renderer 181 MB | summed 1,327 to 1,335 MB, renderer 144 to 154 MB | summed 1,357 to 1,421 MB, renderer 158 to 165 MB |

**The CPU row misses its budget before this change as well as after it.** On `main`, without assistants, the renderer read 18.7 to 24.6% at rest, against the 17.9% it read for v1 (6.2 to 16.3%). This change adds three assistants and reads within that same range, so it does not cause the miss. The machine's load average was 2.5 to 8 during both runs, with other work running, and the miss needs its own look on a quiet machine. That is a follow-up, not part of #505.

**Work stretch rows,** for [#479](https://github.com/theagenticage/hercule/issues/479). The rows add no process, no read, no live topic and no timer. Everything comes from the transcript the thread already holds.

| Measure | Budget | Measured |
|---|---|---|
| Processes | none added | none added |
| Reads and live topics | none added | none added: a step's result text is already in the cache |
| Memory | unchanged | a step's result content is held by reference to the transcript row it came from, never copied; its text is in the page only while that step is open; which rows are open is a set of keys in the transcript's state, never saved |
| Work while idle | none | none: the time on hover is CSS, with no timer |
| Work per streamed token | unchanged | unchanged: a token streams in the tail and rebuilds nothing. The transcript's blocks are rebuilt when its rows change, as before, and the `item.completed` handler in that pass only stores a reference to the result content. A stretch's rows, and its steps' result text, are read only while the stretch is open |

Bundle: the first screen is 327.5 kB gzipped before (14 chunks) and 331.6 kB after (20 chunks), 4.1 kB more: the row code, its styles, and the step icons the app did not draw before, which split into chunks of their own. Measured with `pnpm build:desktop`'s budget check on the change's base and on the change.

**Images in tool results,** measured 2026-10-10 with `pnpm build:desktop`'s budget check on the renderer's `vite build`, on #479's branch at 0bd4d53d (Before) and on this change (After), for [#478](https://github.com/theagenticage/hercule/issues/478). The images add no process, no live topic and no timer.

| Measure | Budget | Measured |
|---|---|---|
| Processes | none added | none added |
| Reads | only for an image in view | a tile reads its image once, when an open step first draws it, and keeps the small WebP thumbnail, as a bubble's image does; the lightbox reads the full image only while it is open |
| Memory | unchanged until a step with images is opened | a closed step holds only the image's reference, which is in the transcript row already |
| Work while idle | none | none |
| Work per streamed token | unchanged | unchanged: images are read from a step's result content only while its stretch is open, with its text |
| The first screen's JavaScript, gzipped | grows only by the step's image code | 332.3 kB, up 0.7 kB from 331.6 kB, across 20 chunks both times: the agent page's chunk is 16.1 kB, up from 15.5 kB, and the transcript's chunk up 20 bytes. The tiles, the thumbnails and the lazy lightbox were already in the bundle for images in prompts |

- **The numbers above predate a rebase onto #479's branch at a75c13a9,** which changed client-core's row reading only; the share was not measured again.
- **The memory of a step with many large images was not measured.** It follows the thumbnail rule of images in prompts, whose readings are in [Measured](#measured).

**The sender of a message,** measured 2026-10-10 with `pnpm --filter @hercule/desktop build`, the renderer's `check-bundle-budget` and `gzip -9` on the built files, on the working tree of branch `feat/511-agent-message-sender-clients`, for [#511](https://github.com/theagenticage/hercule/issues/511). Before and After were built from the same tree, which already held client-core's side of #511; only the renderer's change lies between them. The change adds no process, no timer, no polling and no live topic: each sender is one cached read, made by the thread's loader or when the sender first appears.

| Measure | Budget | Measured |
|---|---|---|
| The first screen's JavaScript, gzipped | grows only by the sender's read and the loader's prefetch | 329.3 kB, up 1.7 kB from 327.6 kB. The first-screen chunk is 255.9 kB, up 1.0 kB: the sender's read, `describeSender`, and `collectSenderSessionIds`, which finds the senders in one pass over the rows without grouping them into turns. The first screen was over its 250 kB guide before this change |
| The thread's chunks, gzipped | the chip and its case in the transcript and the queue | the transcript's chunk 53.0 kB, up 0.4 kB; the agent page's chunk 14.1 kB, up 0.3 kB |
| CSS, gzipped | a few rules | the transcript's CSS up 53 bytes, to 1,311 bytes; the messages' CSS up 59 bytes, to 904 bytes; the agent page's CSS up 117 bytes, to 1,254 bytes. The first screen's CSS is unchanged |
| Work while idle | none | none: the chip has no state, no timer and no animation |
| Work per streamed token | unchanged | unchanged: tokens are still painted into the paragraph being written, without a render. A message from an agent is a memoized component whose props stay the same from one stored row to the next, except a message sent with images, whose list of images is built again with each row |

- **A sender is read once and not again while the app holds it,** which is while a screen shows it and for five minutes after. Its key is outside the `session` prefix, so the pushes of a sender that is itself busy read nothing. The name comes from fields of the session that never change, so nothing is lost.
- **The owner's bubble and queued row are pixel-identical before and after,** in both themes at 1x and 2x: the specimen's screenshots compare byte for byte. The one change to the owner's rows is in a stack of them, by design: a row under another draws no line along its top, so two rows meet in one 1px line rather than two.
- **The review's fixes,** measured the same way against the renderer built from `76f4a1cd`: the chip's width left out of the bubble's, the linked chip's hover, the dark agent bubble mixed into the neutral bubble, the chip's edge on the bubble's, one outline for a stack of queued rows, and each row's and each message's markup written once. The first screen is 8 bytes larger, at 328.9 kB across its chunks. The transcript's chunk is 69 bytes larger and the agent page's chunk 444 bytes smaller, because the queued row's markup is written once. The transcript's CSS is 35 bytes larger and the messages' CSS 30 bytes larger; the agent page's CSS is 14 bytes smaller. The hover adds no work while idle: it is a CSS rule, with no handler.
- **The loader waits for senders at most one second,** measured the same way against the renderer built from `a8f51a4c`: the thread's loader waits for its senders' reads up to `SENDER_READ_WAIT_MS`, one second, and never longer, and a read that failed is not made again when a message mounts or the thread opens again. The first-screen chunk is 103 bytes larger, at 258.8 kB gzipped; the transcript's chunk and the agent page's chunk change by 2 to 4 bytes. The wait is one timer per thread open, cleared as soon as the reads settle, so it adds no work while idle; it removes work too: a sender whose read fails was read again each time one of its messages mounted, and is now read once.
- **The queued row keeps the book's items as its direct children,** measured the same way against the renderer built from `550bff43`: two wrapper spans fewer per queued row, and a grid track per item in their place. The agent page's CSS is 81 bytes larger, at 1,321 bytes, and its chunk 13 bytes smaller, at 13.8 kB; the first screen is unchanged. Every box of the owner's and the agent's rows, with and without images, buttons and notes, measures the same as before, except the text beside a linked chip, which stood 6px further right until the fix below, and the change adds no work while idle or per streamed token.
- **The second review's fixes,** measured against the renderer built from `1b6bf8ab`: a linked chip in a queued row keeps the 6px its hover light takes back, so the row's text starts where it did before the grid, and a sender's read that failed is not made again when the window is focused. The agent page's CSS grows by one rule and stays at 1.31 kB gzipped as Vite reports it; the first-screen chunk gains one query option and stays at 258.8 kB. Neither adds work while idle or per streamed token, and the focus change removes a read per focus for each failed sender.
- **The numbers above were measured before #479 and #478 merged into this branch,** on a base without the work stretch rows or the tool result images. After the merge, `pnpm build:desktop`'s budget check reads the first screen at 334.1 kB gzipped across 20 chunks, 1.8 kB over main's 332.3 kB, in line with the 1.7 kB measured above.

**The Hercule face,** measured 2026-10-10 on the reference machine for [#512](https://github.com/theagenticage/hercule/issues/512), slice 24. Memory and idle come from one run of the perf script, in which the launch "40 threads, the Hercule face showing" opens on the new-thread screen like the plain 40-thread launches, then shows the Hercule face through View › Hercule before it reads. The load average was 2.2 to 12.2 while measuring, and another worktree's perf run was going at the same time. The bundle comes from `pnpm build:desktop`'s budget check on `a9fc51cf`, the change's base (Before), and on the change (After). For memory and idle, Before is the Threads face in the same run, from the plain 40-thread launches: a base run would differ from it by load, not by the face.

| Measure | Budget | Before | After |
|---|---|---|---|
| Processes | none added | 4 | 4: browser, GPU, network utility, renderer |
| Memory, 40 threads, new-thread screen | the face's rows only | renderer 49.3 and 51.5 MB, the Threads face in the same run | renderer **50.3 MB**, Hercule face; summed 671.5 MB against 693.7 and 694.7 MB |
| Idle, window visible | no timer, no polling, no animation | the Threads face in the same run: renderer 1.2 to 1.3% of a core and 5 wakeups a second; hidden, 1 | renderer **1.1%** and **5** wakeups a second; hidden, 1 |
| Reads | none | - | none: the System section's red dot reads the Connections the shell's loader already caches |
| The first screen's JavaScript, gzipped | grows by the switch, the face's rows and the two View commands | 334.1 kB across 20 chunks; first-screen chunk 256.4 kB | **335.8 kB**, up 1.7 kB; first-screen chunk 258.3 kB, up 1.9 kB |
| The first screen's CSS, gzipped | a few rules | 9.99 kB | 10.06 kB |
| Main's startup file | the View menu | 148.1 kB | 148.5 kB |

- **The summed footprint is over its row on both faces, as before this change.** The new-thread screen focuses its composer, and the GPU process holds 563 to 587 MB and wakes 63 to 67 times a second for its caret, whichever face shows. That miss predates #512 and is already recorded above, where Settings' Profile reads 105.5 MB in the GPU process against 586 MB for this screen. The renderer's 5 wakeups a second while visible are over the 2 a second row for the same reason, on both faces: the Settings launches of the same run, which focus no field, read 1 a second.
- **A face switch keeps one list mounted.** Both faces draw into the same virtualized list, with other items: the Hercule face passes Waiting on you, with the System section's plain rows after it. So a switch mounts no second list, and a focused Waiting on you row, which both faces draw, keeps its focus.
- **The launches after "500 threads, run 1" were not measured.** Before the long-transcript launch, the perf script opens "Thread 500" from the sidebar, and that step timed out in two runs, one of them at load 2.0. The cause is not this change, which touches neither the sidebar's order nor its folding: with 500 threads the sidebar shows five rows a project and folds the rest under "120 more threads", and "Thread 500" is among the folded rows, so the script finds no row to click. [#538](https://github.com/theagenticage/hercule/issues/538) fixes the step. The launches before it completed, and the script now reports each launch as soon as it is measured, so the failure no longer takes their readings with it.
- **The switch has no state outside the sidebar.** The face is not saved, and a launch on a screen that keeps the face shows the Threads face, as [The Hercule face](#the-hercule-face) requires.

## Slices

Each slice is a reviewable change. The performance budgets guide it and do not gate it ([Performance](#performance)), except the Office's budgets, which gate slices 9 and 10 *(amended 2026-10-03, [#332](https://github.com/theagenticage/hercule/issues/332))*.

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
9. **The Office.** *(Added 2026-10-03, [Office v1 in the desktop app (#332)](https://github.com/theagenticage/hercule/issues/332).)* [The Office](#the-office), on the user's real threads:
   - the prototype's code moved to `apps/desktop/src/renderer/office/`, without the Tower, the Campus, the controls and Simulate
   - the route, the sidebar's top row and Go › Office
   - `decideOfficeSeating` in `@hercule/client-core`, with its tests, and the Bureau's `OfficeMap` value
   - the card, answering from it, and the drawer
   - the performance work: the 30-frame cap, standing still on battery and with Reduce motion, no ambient occlusion, shadows drawn once, and the static furniture merged by material
   - the bug fixes: colleagues walking through walls, legs inside chairs and sofas, poor paths, and hats painted on
   - room names and plaques in the UI face
   - the first measurement, recorded in [Measured](#measured)
10. **The Office's life.** *(Added 2026-10-03, [#332](https://github.com/theagenticage/hercule/issues/332).)* Printer rage, the tache on four of eight looks, and the Office's own details on the colleagues.

*(Added 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* Slices 11 to 19 build [Settings](#settings). Slice 11 comes first, and slice 13 needs slice 12 and slice 16 needs slice 15; the others can be built in any order after slice 11. Each slice records its costs in [Measured](#measured), as [What Settings costs](#what-settings-costs) lists them.

11. **Settings' frame, with Profile and System.**
    - the `/settings` layout route and one child route per section, each a chunk of its own
    - the header, the Settings list with its inert rows and the Connections dot, and the narrow-window stacking
    - the way in: the foot's Settings button, pressed while Settings is open, and Settings… `⌘,` with the `openSettings` command
    - saving on change, and a failed save shown under its row
    - Profile and System, the two smallest sections
12. **Appearance: themes and glass.**
    - the Appearance in main's settings file, `appearance.read` and `appearance.save`
    - `theme-init.js` applying the stored Appearance before the first paint
    - the five themes' `--bg` in `window-background.ts` and `base.css`, and main's window background for the theme in use
    - the page's Theme cards, Follow the system with its day and night theme, Glass with its demo, and Reduce transparency
13. **Appearance: density, text size, start and motion, marks.**
    - Density, saved on this Mac, and the sidebar's one-line rows
    - Text size, through the text tokens
    - Open on, Reduce motion, and Marks on the start cards
    - the Bureau comparison of the Appearance page
14. **Threads.** The thread defaults.
15. **Assistants: the web's form.** The tabs, the profile block, the web form's fields, New assistant and delete.
16. **Assistants: disallowed tools, heartbeat and rotation.**
    - the disallowed tools' chips
    - Heartbeat with its timeline and prompt, and the two `client-core` functions that read and build its cron expression
    - Rotation
    - the Bureau comparison of the Assistants page
17. **Connections.** The table, its moves, Add a Connection with the three setups, and the Bureau comparison of the Connections page.
18. **Machines.** The runner tabs, a runner's facts, queue, edit and moves, its provider rows, and Add a machine.
19. **Plugins.**

*(Added 2026-10-06, [#448](https://github.com/theagenticage/hercule/issues/448).)* Slices 20 to 22 build [the assistant](#design-system), in order. Slice 22's heartbeat needs slice 16's cron functions, and its Open Conversation needs slice 15. Each slice records its costs in [Measured](#measured), as [What the assistant costs](#what-the-assistant-costs) lists them. *(Amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454).)* Slice 21 shipped without recording them; see [Measured](#measured).

20. **Assistants in the sidebar.**
    - the `assistant` topic in the shell, and each assistant's newest session, read by `Assistant.mainConversationId`
    - the Assistants section, pinned above the foot, with each assistant's face, pose and word from `buildAssistantRows`
    - an assistant in Waiting on you, in the dock badge, in notifications and in the Go menu
    - the `/assistants/$id` route, drawing ~~the floating header~~ the floating header's left pill (face, name and word) over an empty Conversation; the drawer's pill and "`<name>`'s record" come with slice 22 *(amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453))*
21. **The Conversation.**
    - the messages, the day stamps and the notices, with earlier pages read on scroll
    - the streaming reply, and following a new session after rotation
    - the composer: send, Stop and the kept Message Draft
    - the Requests dock
    - the Bureau comparison of the Conversation
22. **The drawer.**
    - the header's pill, and the drawer with its three inert sections
    - "`<name>`'s record", and Open Conversation in Settings › Assistants

*(Added 2026-10-09, [#494](https://github.com/theagenticage/hercule/issues/494).)* Slice 23 builds Settings' Permission profiles section, and records its costs in [Measured](#measured), as [What Settings costs](#what-settings-costs) lists them. It needs slice 11, the frame.

23. **Permission profiles.**
    - the list, its table and New profile
    - a profile's page: Name, Grants with their toggles, Used by and Delete
    - the confirmation for a change to `unrestricted`, and the refusal shown in the delete confirmation
    - the Bureau comparison of the four states of the book's page

*(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* Slice 24 builds [the Hercule face](#the-hercule-face) ([#512](https://github.com/theagenticage/hercule/issues/512)). Slices 25 to 35 build [Intake](#intake), in order, after slice 24. Each of them is vertical: it ships its backend, as the specs that own it describe, and its desktop part together. So Intake shows from slice 25, and fills in as each feature lands. Slice 36 stands alone and needs none of them. Each slice records its costs in [Measured](#measured), as [What the Hercule face costs](#what-the-hercule-face-costs) and [What Intake costs](#what-intake-costs) list them; a slice that changes the bundle or the work done while idle names the rows it records.

24. **The Hercule face.** The sidebar gains the Threads | Hercule switch, with the System section's Fleet and Connections rows, the face rule, and View › Threads `⌥⌘1` and View › Hercule `⌥⌘2`. Records: the first screen's JavaScript, memory and idle, with the Hercule face showing.
25. **The first signal on screen.** ([#524](https://github.com/theagenticage/hercule/issues/524)) A signal raised with `hercule signal raise` shows on Intake. The slice adds the Signal record and `signal.raise`, `signal.query`'s To do view, `signal.read`, `signal.act` and `signal.withdraw`, so a proposal raised by hand can be accepted and creates its Task; the Intake row, Go › Intake `⌘⇧I` and the Hercule segment's count; the list in its Now and Signals sections; the pane with all four block types and the fallback line; the answers with their describe lines and the Reply box; the keys; the split and its minimums; and the notification for a new Now signal, with `urgentSignals.set`. Blocked by slice 24 ([#512](https://github.com/theagenticage/hercule/issues/512)). Records: the first screen's JavaScript, Intake's chunk, idle with Intake open, and opening or closing the split.
26. **Done, Snooze and Not urgent.** ([#525](https://github.com/theagenticage/hercule/issues/525)) A signal can leave To do by the user's hand. The slice adds `signal.markDone`, `signal.snooze`, `signal.unsnooze` and `signal.lowerPriority`; the row controls and checks; the bulk bar and its highlight; the snooze menu and "Back" rows; the Later and Done views; the foot; and the toast. Records: idle with a snooze due in an hour, because the snooze timer is the screen's one idle timer.
27. **GitHub review requests and mentions.** ([#526](https://github.com/theagenticage/hercule/issues/526)) The first plugin signals arrive: a review request and a mention raise signals on their own. The slice adds the plugin path that raises them, the manifest's marks on tabs, rows and the provenance line, the GitHub tab, GitHub's answers, and "Resolved elsewhere" when the source answers.
28. **GitHub's other kinds.** ([#527](https://github.com/theagenticage/hercule/issues/527)) Assignment, requested changes and failed checks raise signals too. The slice adds those kinds, and the Checks block's log lines.
29. **Settings › Intake.** ([#528](https://github.com/theagenticage/hercule/issues/528)) The user can switch each signal kind on or off, and choose which event kinds are available to triage. The slice adds the [Intake section](#the-sections) with its Signals and Events available to triage lists, `plugin.updateIntake`, `connection.update`'s `intake`, and the provenance line's link with its `kind` and `connection` parameters. Records: the section's chunk.
30. **Everything.** ([#529](https://github.com/theagenticage/hercule/issues/529)) The Everything view lists Intake's events and what came of each. The slice adds `event.query`'s `intake` flag, the handlings, the search and the filter, and the event pane. Records: the view's memory with a long list.
31. **Screening and the Screener.** ([#530](https://github.com/theagenticage/hercule/issues/530)) A signal can wait for the shipped Screener before it shows. The slice adds the Screener and the Screening path, the "Waiting for the Screener" and "Screened out" handlings, and the "Not screened" lines in the pane.
32. **Gmail signals.** ([#531](https://github.com/theagenticage/hercule/issues/531)) Mail that needs the user shows on Intake. The slice adds Gmail's signal kinds, its tab and mark, and the Messages block's recipients and attachments.
33. **Ignore Rules.** ([#532](https://github.com/theagenticage/hercule/issues/532)) The user can stop a kind of signal by its match fields. The slice adds Ignore Rules, Hercule's offer in Signals, "Ignore signals like this…" and its dialog, the Ignore Rules list in Settings › Intake, and the "ignored" handling in Everything.
34. **The Triage tab.** ([#533](https://github.com/theagenticage/hercule/issues/533)) Triage's signals get their own place. The slice adds the shipped Triage workflow raising core signals, the From triage section, and the Triage tab with its header, summary and workflow picker. A proposal's Accept already works from slice 25, where a proposal can be raised by hand.
35. **Inbox zero and changes from elsewhere.** ([#534](https://github.com/theagenticage/hercule/issues/534)) Intake moves when something happens. The slice adds inbox zero's arrival and its line, the motion of signals that arrive and leave without the user, bursts as one block, and nothing moving under the pointer. Records: per push with a burst of 30, and inbox zero.
36. **Launch on the last screen.** ([#535](https://github.com/theagenticage/hercule/issues/535)) The app reopens where the user left it. The slice adds the stored last screen for each controller URL, Open on's Where I left off, and reading a stored `threads` value and an old stored thread id. It needs no other slice. Records: the launch budget, reopening a thread and reopening Intake.

## Testing

- **Unit tests** sit next to the code they test (AGENTS.md §Source layout). They cover:
  - main's logic
  - decoding against the IPC contract
  - that a face's seed always gives the same face
- **Renderer component tests** work as they do in `apps/web`.
- **End-to-end tests** live in `e2e/desktop/`. They use Playwright's Electron driver to launch the test package (see [Security baseline](#security-baseline)) against the compiled `hercule` binary, in a scratch `HERCULE_HOME`. Each slice adds at least one. They run the production origin, so they cover the CORS path. ~~CI runs them on macOS, the target platform.~~ *(Amended 2026-10-01, [#275](https://github.com/theagenticage/hercule/issues/275).)* They run on a developer's Mac, before a pull request that changes the desktop app, and not in CI. They check windows, pixels and timing, and CI's virtual Macs differ from a user's Mac in all three: a 1024 × 768 screen at 1x with the Dock showing, Reduce motion and Reduce transparency on, and a slow machine. There, 5 of the 98 tests that pass on a developer's Mac failed. In one, macOS shrank a saved 1000 × 700 window to fit a work area 679 points high, as it should, and the test expected the window to keep its size.
  - *(Amended 2026-10-01, [#308](https://github.com/theagenticage/hercule/issues/308).)* One file does run in CI: the `edge-build` job runs `e2e/desktop/package.test.ts` on the certificate-signed release package, which only that job builds, under the hardened runtime. The test checks the fuses, `app.asar`, the signature, and that the app starts and quits; none of that depends on the screen or the machine's speed.
  - Each launch passes `--user-data-dir=<scratch dir>`, so the settings file, the token and the single-instance lock never touch the real app's.
  - Each launch passes `--use-mock-keychain`, so no test touches the real Keychain.
  - Each launch removes `ELECTRON_RUN_AS_NODE` and every `HERCULE_*` variable from Electron's environment.
  - *(Added 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* Each launch that opens main's inspector passes `--hercule-binary=<path in the user data dir>`, so main runs that path in place of `~/.local/bin/hercule` and no test runs this Mac's own `hercule service`: even `status` reads this Mac's launchd, and `install` writes `~/Library/LaunchAgents/` whatever the Home is. With no file there, main finds no binary. A first-run test writes a stand-in there with `e2e/desktop/stand-in-binary.ts`: a script with a scratch Home that answers `service status --json`, `service install --json` and `setup-url`. Its `serve` kind starts the compiled `hercule serve` in that Home on install, in a session of its own as launchd would, with a `PATH` of only `/usr/bin` and `/bin`, so its runner finds no coding agent and the providers step is never done whatever the Mac has installed *(amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313))*; the others fail the install with one line (`start-error`), report a runner (`runner`), or report no Service Unit with nothing answering (`fresh`). Main accepts the switch only where it accepts every argument: in a development run, or with the inspector open. A release package refuses it.
- **Screenshots.** Every slice takes light and dark screenshots of its screens, and they are compared with the Bureau pages before review.
  - *(Added 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275).)* `pnpm --filter @hercule/desktop capture:sidebar-states` captures the sidebar states the book never draws, in both themes, for a check by eye: ~~workspace labels~~ workspace lines and unsent rows *(amended 2026-10-08, [#473](https://github.com/theagenticage/hercule/issues/473))*, offline, queued, asleep and away threads, long names, the caps and their "more" rows, and "No project". It writes them to `apps/desktop/out/sidebar-states/`.
- **The Bureau comparison.** `pnpm compare:bureau` compares the app's pieces with the book's, pixel for pixel, in Whitehaven and Orient Express. CI runs it.
  - Two sheets draw the same cells in a 1440 × 900 window: the reference sheet with the book's own `crew.js` from ~~`docs/design/crew-bureau/`~~ `docs/design/crew-bureau-2/` *(amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313))*, the specimen sheet with the app's components. A cell is a face in a pose, size, shape or wardrobe, the user avatar, a mark or an icon.
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
- *(Added 2026-10-03, [#332](https://github.com/theagenticage/hercule/issues/332).)* **The Office's tests:**
  - `decideOfficeSeating` has unit tests for the rooms and their order, the desks inside a room, the queue and the Lounge, and the threads left out;
  - an end-to-end test opens the Office from the sidebar's button and from `⌘⇧O`, and checks that a hidden window draws no frames.
- *(Added 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* **Settings' tests:**
  - `pnpm compare:bureau` compares the main pane of each of the book's three settings pages with the app's section, item by item, then pixel for pixel, in Whitehaven and Orient Express: Appearance, Assistants and Connections. *(Amended 2026-10-09, [#494](https://github.com/theagenticage/hercule/issues/494).)* Permission profiles joins them, in the four states of `settings-profiles.html`: the list, Reviewer's page, `unrestricted`'s page, and `unrestricted`'s page with the confirmation open. The app is fed the book's profiles and their agents. The book's sidebar is not compared there, because it is the Hercule face; the sidebar is compared against `session-active.html` as before. As for the thread, the book's page is edited where the app leaves something out or draws other words ([Settings](#settings)): the Assistants page loses the role, the line under the name, ~~Open Conversation,~~ *(amended 2026-10-06, [#448](https://github.com/theagenticage/hercule/issues/448): Open Conversation stays)* the context bar, Start fresh, the bindings and the Memory and Reminders column; the Connections page loses the stats strip, three columns and the Channels section; the Appearance page takes the desktop's Density line.
  - The book's `settings-assistants.html` draws its sidebar's and its Settings list's group headings larger than its two other settings pages do. Slice 16 finds the cause. If the page is at fault, the slice fixes the book's page, as design tickets edit the book, and says so in its pull request.
  - `pnpm --filter @hercule/desktop capture:settings` captures every section in all five themes, and Appearance at each text size and density, for a check by eye. It writes them to `apps/desktop/out/settings/`. The sections the book does not draw are checked this way.
  - Unit tests cover the heartbeat's two `client-core` functions, main's Appearance in the settings file, `theme-init.js` with a stored Appearance (one theme, and the day and night themes as macOS changes), and the window background of all five themes.
  - An end-to-end test opens Settings from the foot button and from `⌘,`, checks that the inert rows do nothing, changes the theme and the glass level, relaunches, and checks that the window's first frame already has the chosen theme. A second checks that Open on The office launches into the Office. *(Amended 2026-10-09, [#494](https://github.com/theagenticage/hercule/issues/494).)* The first no longer checks Permission profiles' row, which now leads to its section. A test of its own, `e2e/desktop/settings-permission-profiles.test.ts`, creates a profile in Permission profiles, changes one of its grants, renames it and deletes it through its confirmation, and checks that a shipped profile shows no Delete.
- *(Added 2026-10-06, [#448](https://github.com/theagenticage/hercule/issues/448).)* **The assistant's tests:**
  - `pnpm compare:bureau` compares the Conversation's column with the book's `assistant.html`, item by item, then pixel for pixel, in Whitehaven and Orient Express: a reply, an owner's message, a day stamp, a notice and the composer. The book's page is edited where the app leaves something out or draws other words: the quiet check-ins, the refs chips, the reminder card, the action buttons, "heartbeat · 09:00", the mention chip, the channel pick and the model pill go, and the notice loses its bold. *(Amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454): the composer's lip goes too, because memory and heartbeats are not built yet.)* The header and the drawer are not compared, because the book draws a bar and a rail; they are checked by eye, against the prototype.
  - `pnpm --filter @hercule/desktop capture:assistant` captures ~~the Conversation and the open drawer in all five themes, and the sidebar with an assistant in each pose,~~ *(amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453): the sidebar with an assistant in each pose, plus the assistant screen (header pill, empty Conversation, not found), in all five themes; ~~the Conversation and the open drawer join it with slice 22~~)* *(amended 2026-10-07, [#454](https://github.com/theagenticage/hercule/issues/454): the Conversation's scenes join it with slice 21, in all five themes; the open drawer joins it with slice 22)* for a check by eye.
  - An end-to-end test opens an assistant from the sidebar, sends a message, answers a Request on the dock and stops a turn, against a real controller whose assistant runs on a scripted runner, as the composer's test does. A second checks that the window, hidden while a reply streams, drops the tap and shows the whole reply when shown again.
- *(Added 2026-10-10, [#512](https://github.com/theagenticage/hercule/issues/512).)* **The Hercule face's tests:**
  - `pnpm compare:bureau` compares the face switch as part of the sidebar, against `session-active.html`, item by item, then pixel for pixel, in Whitehaven and Orient Express. The Hercule face itself is checked by eye: `pnpm --filter @hercule/desktop capture:sidebar-states` captures it.
  - A unit test covers the face rule, `decideScreenFace`. Integration tests cover the switch, its arrow keys and the list its tabs control, View's two commands, the inert Fleet and Connections rows with the Connections dot, the face following the screen, a new Draft Thread included, a Waiting on you row that keeps its focus when it opens a thread, and the Go menu, which lists the Threads face's rows on either face.
  - End-to-end tests change the face from the switch, from View › Threads and View › Hercule, and with ← and →, without leaving the open thread, and check that the switch, inside the window's drag strip, does not drag the window. A second checks that the Office and Settings keep the Hercule face and that opening a thread shows the Threads face.
- *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* **Intake's tests:**
  - Unit tests cover each `client-core` function Intake calls ([What the screen reads](#what-the-screen-reads)): the sections and their order, the row controls, the tabs and More, the bulk plan with its wording, the foot's counts, the triage header, the snooze choices at each hour that changes them, the handlings' cut-off, and the inbox zero line at each moment, the weekend included.
  - `pnpm compare:bureau` compares the app's Intake with the Intake drawing, [`docs/design/intake-directions/asks/desktop/intake.html`](../design/intake-directions/asks/desktop/intake.html), item by item, then pixel for pixel, in Whitehaven and Orient Express. The app is fed the drawing's signals at the drawing's time. As for the thread, the drawing's page is edited where the app draws other words: the section names, the `↩` hint and the toast. The sidebar is compared against `session-active.html` as before, and the Hercule face is checked by eye.
  - `pnpm --filter @hercule/desktop capture:intake` captures the states the drawing does not show, in all five themes, for a check by eye: each block type and the fallback line, the build-failed line, a failed answer, Resolved elsewhere, the bulk highlight, Later, Done, Everything and its event pane, the Triage tab with a failed run, the Ignore dialog, inbox zero, tabs moved into More, and the pane hidden in a narrow window. It writes them to `apps/desktop/out/intake/`.
  - End-to-end tests, each against the compiled binary in a scratch `HERCULE_HOME`. The tests of the screen raise their signals with `hercule signal raise`:
    - Intake opens from the Hercule face's row and from `⌘⇧I`, and the face follows the screen; `⌥⌘1`, `⌥⌘2` and the switch's arrow keys change the face without leaving the screen.
    - The Hercule segment's count follows a raised signal, a Done and a snooze.
    - A new Now signal notifies only while the window is not focused, and a click on the notification opens Intake with the signal selected.
    - The keys answer a signal: `J`, `↩`, a second `↩`, and `E` on a checked row.
    - Settings › Intake switches a kind off for one Connection, and Reset brings it back.
    - The app relaunches on Intake, and on a thread, when that was the last screen.
    - With the window hidden, the snooze timer still brings a signal back and its notification shows.
- **The check commands.** The four check commands (AGENTS.md §Check commands) cover `apps/desktop` like every other package.

## Post-v1

The desktop app is itself post-v1 in [./01-overview-and-scope.md](./01-overview-and-scope.md). These are what later milestones add after the first:

- **The Hercule face's other screens:** ~~Intake,~~ Check-in, Tasks, Runs, Workflows~~, Fleet, Connections~~ and Notifications. Bureau adds the office to them. *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#512](https://github.com/theagenticage/hercule/issues/512).)* The face and Intake are slices 24 to 35. Fleet and Connections are rows that open Settings › Machines and Settings › Connections; screens of their own come later, if ever.
- *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#394](https://github.com/theagenticage/hercule/issues/394).)* **On Intake:**
  - Undo, for Done, snooze and answers;
  - raising a signal to Now, the reverse of Not urgent;
  - "Accept and start *agent*" on a proposal, which creates the Task and starts work on it;
  - ordering the list by hand ([#513](https://github.com/theagenticage/hercule/issues/513));
  - Run now on the Triage tab;
  - the web app's Intake ([./14-web-app.md](./14-web-app.md#the-intake-view));
  - images in blocks loaded through the controller, not from their source ([#503](https://github.com/theagenticage/hercule/issues/503)).
- ~~**Assistants,** with~~ *(Amended 2026-10-06, [#448](https://github.com/theagenticage/hercule/issues/448): assistants are slices 20 to 22.)* **The stored look:** the book's stored look (Spec change 3) and a run that wears its workflow's face (Spec change 4).
- *(Added 2026-10-06, [#448](https://github.com/theagenticage/hercule/issues/448).)* **On an assistant's Conversation** ([#450](https://github.com/theagenticage/hercule/issues/450)): the drawer's Heartbeat, Reminders and Memory live, once heartbeats fire ([#94](https://github.com/theagenticage/hercule/issues/94)) and operations read reminders and memory ([#93](https://github.com/theagenticage/hercule/issues/93)); the header pill's numbers and the composer's lip with them; the refs chips; and channels, with Slack and Discord conversations.
- **All sessions ~~and Settings,~~ ~~including Appearance: Bureau's five themes, System, and the glass level~~.** *(Amended 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* Settings is slices 11 to 19, except its Providers section, which comes with the provider remodel ([#406](https://github.com/theagenticage/hercule/issues/406)).
- *(Added 2026-10-04, [#402](https://github.com/theagenticage/hercule/issues/402).)* **Settings' Identities, Secrets and Bounds,** drawn inert until then. *(Amended 2026-10-09, [#494](https://github.com/theagenticage/hercule/issues/494).)* Permission profiles is slice 23. **On Assistants:** memory, reminders, channel bindings and Start fresh, once operations read and write them. **On Connections:** the event counts and the Channels section, once operations read them.
- **The desktop app as installer:** it ~~runs and~~ installs and upgrades ~~a local controller~~ Hercule's binary ([./15-packaging-and-operations.md](./15-packaging-and-operations.md) §Post-v1). Starting a local controller with the binary already there is in v1, as part of [the first run](#the-first-run) *(amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313))*.
- ~~*(Added 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* **The live Office.** The first run's still room grows into the Office: live updates, the other wings, filing cabinets and capsules in Triage's tube.~~ *(Amended 2026-10-03, [#332](https://github.com/theagenticage/hercule/issues/332): the live Office is slice 9.)* **The Office Map system:** growth by wings built as the fleet grows, more maps, importing a map, maps of a code base, colleagues that go where their work takes them, and more activities ([#336](https://github.com/theagenticage/hercule/issues/336)). Event flow and the tubes ([#331](https://github.com/theagenticage/hercule/issues/331)). The first run's room drawn as a still view of the 3D Office.
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
- [A first run in the desktop app that needs no browser and no terminal (#313)](https://github.com/theagenticage/hercule/issues/313)
- [Office v1 in the desktop app (#332)](https://github.com/theagenticage/hercule/issues/332), with its research ([#333](https://github.com/theagenticage/hercule/issues/333)) and scope ([#334](https://github.com/theagenticage/hercule/issues/334))
- [Desktop Settings: a quick port, and a new model for providers (#401)](https://github.com/theagenticage/hercule/issues/401) and [Write the Settings port into spec 17, and its build tickets (#402)](https://github.com/theagenticage/hercule/issues/402)
- [Desktop app: an assistant's Conversation in Crew Bureau (#448)](https://github.com/theagenticage/hercule/issues/448), with its prototype on branch `prototype/desktop-assistant`
- [Web app architecture: observability-first, desktop-shell-ready (#19)](https://github.com/theagenticage/hercule/issues/19)
- *(Added 2026-10-10.)* [Write the Intake changes and the build tickets that replace #91 (#395)](https://github.com/theagenticage/hercule/issues/395), [The desktop Intake screen in spec 17 (#394)](https://github.com/theagenticage/hercule/issues/394), [The desktop Hercule face (#512)](https://github.com/theagenticage/hercule/issues/512), and the Intake decisions they draw on: [#385](https://github.com/theagenticage/hercule/issues/385), [#386](https://github.com/theagenticage/hercule/issues/386), [#387](https://github.com/theagenticage/hercule/issues/387), [#388](https://github.com/theagenticage/hercule/issues/388), [#390](https://github.com/theagenticage/hercule/issues/390), [#391](https://github.com/theagenticage/hercule/issues/391), [#392](https://github.com/theagenticage/hercule/issues/392), [#393](https://github.com/theagenticage/hercule/issues/393), [#397](https://github.com/theagenticage/hercule/issues/397), [#398](https://github.com/theagenticage/hercule/issues/398)

ADRs:

- [ADR 0037 - The desktop app is its own Electron client of the public API](../adr/0037-the-desktop-app-is-its-own-electron-client-of-the-public-api.md)
- [ADR 0017 - The web app is a static pure client of the public API](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)
- [ADR 0031 - The backend is written on Effect](../adr/0031-the-backend-is-written-on-effect.md)
- [ADR 0027 - A decision resolves when its question is answered, wherever](../adr/0027-a-decision-resolves-when-its-question-is-answered-wherever.md)
- *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* [ADR 0040 - Intake holds Signals; Notifications are Hercule's own messages](../adr/0040-intake-holds-signals-notifications-are-hercules-own-messages.md)

Prototype: the Crew Bureau book, ~~[`docs/design/crew-bureau/index.html`](../design/crew-bureau/index.html)~~ its second edition, [`docs/design/crew-bureau-2/index.html`](../design/crew-bureau-2/index.html) *(amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313))*.

*(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* Intake's pixel reference: the Intake drawing, [`docs/design/intake-directions/asks/desktop/intake.html`](../design/intake-directions/asks/desktop/intake.html).
