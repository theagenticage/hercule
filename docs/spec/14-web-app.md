# Web app

The web app is Hydra's primary surface: a static single-page application served by the controller at its own origin, and an undistinguished client of the same public API that agents and the `hydra` CLI use ([ADR 0017](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md), [ADR 0013](../adr/0013-agents-operate-hydra-through-the-public-api.md)). Live-ness is an overlay on one WebSocket that carries subscriptions only. Client logic lives in framework-agnostic packages so a later desktop app reuses it wholesale. This document pins the stack, the package structure, the live model, client-side auth, the performance guardrails, the v1 screen inventory, the two prototyped views (check-in and Intake), the workflow editor, and the pointers to the design language and prototype assets.

## Architecture

- **Static SPA, no SSR, ever.** Vite builds the bundle; the controller serves it at its origin. In development the controller proxies to the Vite dev server. No rendering runtime beside the controller and no privileged UI path.
- **Pure client.** Every query and mutation goes through the public HTTP API. The web app can do nothing an agent cannot do through the same contract. Nothing is reachable over the WebSocket that HTTP cannot answer.
- **Version skew.** None in v1: the controller serves its own matching bundle. Clients read the server version at WebSocket hello so a desktop-era client can detect skew (t3-code pattern).
- **Serving is a controller concern.** The web bundle is part of the controller's module graph only; the runner entrypoint MUST NOT import it (mode isolation, [./15-packaging-and-operations.md](./15-packaging-and-operations.md)).

### Stack

| Concern | Choice |
|---|---|
| Build | Vite |
| UI runtime | React 19 with the React Compiler on from day one |
| Routing | TanStack Router, file-based routes, route-level code splitting |
| HTTP read state | TanStack Query for all HTTP reads; no hand-rolled fetch state |
| Styling and components | Tailwind + shadcn/ui (components are owned code in the repo, so any can be rebuilt on other primitives later without API breaks; chosen over t3-code's Base-UI-custom path) |
| Lists | TanStack Virtual for every unbounded list |
| Workflow editor | CodeMirror 6 + React Flow with elk/dagre layout (see [Workflow editing](#workflow-editing)) |

## Packages and desktop-shell readiness

One pnpm monorepo: `apps/controller`, `apps/runner`, `apps/web`, `packages/contract`, `packages/protocol`, `packages/client-core`, `packages/ui`, `packages/cli`, plugins as packages.

| Package | Contents | Framework |
|---|---|---|
| `packages/contract` | The Effect HttpApi declaration (input/output/error schemas per operation) and the Effect RPC group for live topics ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md), [ADR 0031](../adr/0031-the-backend-is-written-on-effect.md)) | Effect Schema |
| `packages/protocol` | The versioned controller-runner WebSocket message schema ([./03-controller-and-runners.md](./03-controller-and-runners.md)), in Effect Schema; not imported by the web app | Effect Schema |
| `packages/client-core` | Promise-returning wrapper over the derived HttpApi client; RPC stream subscriptions exposed as plain subscribe callbacks; WebSocket supervisor (connect, ticket refresh, reconnect, cursor replay); live stores; auth (token holding, login, logout); `detectLocalRunner()` | none (framework-agnostic; the only client package that writes Effect code) |
| `client-core` React bindings | Thin hooks over the live stores and client | React |
| `packages/ui` | The component library (shadcn/ui-based), built in the pinned design language | React |
| `apps/web` | Routes and presentation only | React |

Discipline: **no domain logic in components**. Anything that interprets domain data (ranking strands, deriving provenance tiers, mapping verdicts to labels) lives in `client-core` and is tested there. **The React codebase writes no Effect code**: the backend is written on Effect ([ADR 0031](../adr/0031-the-backend-is-written-on-effect.md)), the web app is not. Its two doors are `packages/contract` and `client-core`; it never imports `effect` directly and never uses generators, layers, streams or atoms. `effect` reaches it transitively through the contract's schemas (the Schema module, roughly 15 KB compressed in Effect 4, inside the bundle budget). Components and hooks use the types inferred from the schemas; schemas are used as values only for form validation through the Standard Schema interface; responses are decoded once in `client-core` and components receive plain typed objects.

Desktop readiness is achieved through this structure, not through a shell. Planning assumption: Electron (any realistic option renders web tech, so `ui` transfers either way). The final call belongs to the post-v1 desktop effort. The desktop app is explicitly NOT a wrapped webview of the web app; it reuses `client-core` and `ui` and stays free to build desktop-specific UI. The onboarding and setup views ship in the web app and are reused unchanged when the desktop app becomes the installer ([./15-packaging-and-operations.md](./15-packaging-and-operations.md)).

## Live model: one WebSocket, subscriptions only

One WebSocket per client. It carries **Live Topic** subscribe/unsubscribe and pushes; nothing else. A Live Topic is a client viewing concern (a session transcript, the event feed, notifications), distinct from the domain term Subscription ([../../CONTEXT.md](../../CONTEXT.md)).

The single multiplexed socket is forced, not chosen: the plain-HTTP LAN default ([./13-security.md](./13-security.md)) means browsers speak HTTP/1.1 with its per-origin connection cap, so parallel SSE streams do not fit.

Two push modes, chosen by data shape:

| Data shape | Examples | Push mode | Reconnect |
|---|---|---|---|
| Append-only streams | session transcripts, the event feed | Payload-carrying deltas | Client sends its last cursor; the controller replays from the store's durable cursors ([./04-state-store.md](./04-state-store.md)) |
| Mutable records | tasks, runs, fleet, workflows, connections, notifications | Invalidation nudge naming the record or collection; the client refetches over HTTP through TanStack Query | Client invalidates every subscribed query on reconnect |

**Watched sessions.** A session the user is actively viewing additionally gets **ephemeral token-delta passthrough**: a live tap beside the durable path. The store keeps coalescing at message/turn boundaries ([./04-state-store.md](./04-state-store.md)); deltas stream only to subscribed watchers and are never persisted per token. On reconnect the client falls back to the coalesced records and resumes the tap from there.

### Wire format

Pinned by [Web app details](https://github.com/rogierpennink/hydra/issues/45) (2026-09-01) as a hand-rolled envelope; superseded 2026-09-02 by [Revisit Effect for the backend (#53)](https://github.com/rogierpennink/hydra/issues/53) ([ADR 0031](../adr/0031-the-backend-is-written-on-effect.md)): the WebSocket is an **Effect RPC** connection and the wire framing is Effect RPC's own. The semantics the envelope pinned survive as the RPC group's method definitions in `packages/contract` (not in `packages/protocol`, which is the runner's):

```
hello       { v: 1, ticket } -> { v: 1, serverVersion }     // first call on the connection; the auth.wsTicket value, never in the URL
subscribe   { topic, cursor? } -> stream                     // one streaming method; the client ends the stream to unsubscribe
  stream items, append-only topics:  delta      { cursor, items: [...] }
  stream items, mutable topics:      invalidate { ids: string[], kind: "created" | "updated" | "deleted" }
ping        { } -> { }                                      // app-level keepalive every 30 s; browsers cannot send WS ping frames
```

The first delta of a subscription carries the replay start as its cursor. Errors are the HTTP error codes of [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 1.5, carried as the method's typed failures. Nothing else is reachable over the socket.

**Topics** are flat strings named like operation entities (singular), in two families. Prior art is the accepted pattern of coarse channels carrying fine-grained payloads (Phoenix Channels, Centrifugo, Ably): the *topic* is the collection, the *message* names the records, and the client decides what to refetch.

| Family | Topics | Message |
|---|---|---|
| Mutable records (invalidation nudges) | `task`, `run`, `session`, `workflow`, `connection`, `notification`, `runner`, `plugin` | `invalidate` naming the changed record ids; the client maps ids to TanStack Query keys and refetches over HTTP. The controller coalesces ids per topic for about 50 ms so a burst is one nudge. |
| Append-only streams (payload deltas) | `event` (the event log), `session:<id>:stream` (the durable coalesced transcript), `session:<id>:tap` (ephemeral token deltas, watched sessions only) | `delta` carrying the items and the new cursor |

There are no per-record topics. A changed task never travels over the socket: the record has one shape, the HTTP one, and permissions are checked once, on the HTTP path; the cost is one LAN round trip per coalesced nudge.

**Cursors** are opaque strings on the wire (today the decimal of the store's integer position, [./04-state-store.md](./04-state-store.md)); the client stores and echoes them and never parses them.

**The ticket** is the value of `auth.wsTicket` ([./13-security.md](./13-security.md) section 4): a 5-minute single-use random string fetched over authenticated HTTP, because a browser cannot set headers on the WebSocket handshake and the 30-day bearer token must never ride in a URL.

## Auth in the client

- Password login over HTTP returns an **opaque bearer token**. The client holds it and sends `Authorization: Bearer <token>` on every HTTP request.
- The WebSocket authenticates with a **short-lived single-purpose ticket** (t3-code pattern, 5-minute tickets) fetched over HTTP with the bearer token. The long-lived token never appears in a URL.
- **No cookies, no CSRF machinery.** The browser is an ordinary API client, and the same flow works unchanged in a desktop shell.
- API keys (long-lived user credentials for the ops CLI and scripts) are minted in the web app under Settings or via `hydra login`; token semantics in [./13-security.md](./13-security.md).
- Session Tokens (agent credentials) never reach the web app.

Ticket #18 pinned a 30-day rolling session cookie; the later ticket #19 and ADR 0017 pin bearer token + WS ticket, no cookies. ADR 0017 governs.

**Storage between page loads** (resolved 2026-09-01, [Web app details](https://github.com/rogierpennink/hydra/issues/45)): the bearer token lives in `localStorage`, keyed by controller origin, removed on logout and on the first 401. Memory-only would demand a login on every page load, unacceptable for a LAN tool; `sessionStorage` dies with the tab; cookies are ruled out by ADR 0017, and a desktop shell has no better option than local storage either. Because agent-authored text is rendered everywhere and any script that runs can read the token, the served bundle carries a strict Content-Security-Policy: no inline scripts, `connect-src 'self'`. The token's lifetime and rolling renewal are [./13-security.md](./13-security.md)'s (30 days rolling, revoked on logout).

## Performance guardrails

Named conventions, lint- or CI-enforced where possible:

1. React Compiler on; compiler-aware `react-hooks` lint rules are CI-blocking.
2. Fine-grained external-store subscriptions (selector-based). Never React Context for changing data.
3. Every unbounded list is virtualized (TanStack Virtual).
4. Token deltas are buffered outside React and flushed with `requestAnimationFrame` at most once per frame; only the visible transcript tail renders live.
5. Route-level code splitting plus a CI bundle budget.
6. TanStack Query for all HTTP reads, WebSocket-driven invalidation, no hand-rolled fetch state.

t3-code validates the family (React Compiler, virtualized transcript, rAF, memoized rows). Its `@effect/atom-react` state and no-Query approach do not transfer: Hydra's backend is on Effect ([ADR 0031](../adr/0031-the-backend-is-written-on-effect.md)) but its web app is not, because the socket carries only live topics and TanStack Query already fits the two push modes above. `@effect/atom-react` is the named revisit if the transport split ever collapses onto the WebSocket.

## V1 screen inventory

The v1 screens are: **Intake, Check-in, Tasks, Sessions (including assistant chat), Runs, Workflows, Fleet, Connections, Notifications, Settings (Plugins, Permission profiles, Secrets, Bounds, System, Profile, Threads, Assistants, Identities).**

**Home is Sessions** (resolved 2026-09-01, [Web app details](https://github.com/rogierpennink/hydra/issues/45)): the default route after login is the Sessions screen, not Intake. Nothing has been triaged on a fresh install, and the first minute is meant to feel like t3-code - create a thread on this machine - with Intake and check-in discovered from there ([Onboarding and first run](#onboarding-and-first-run)). The frame the screens sit in is the [App shell](#app-shell) (resolved 2026-09-01, [Prototype: the app shell and navigation](https://github.com/rogierpennink/hydra/issues/51)).

- Event sources get no screen; they surface through Connections and workflow triggers.
- Plugin configuration forms are generated from the manifest config schema ([./05-plugins.md](./05-plugins.md)). UI pickers (action ids, provider ids, channel ids) read the persisted contribution catalog, never the live plugin.
- Every screen is built in the pinned design language ([Design language](#design-language)).

Constraints other documents hand to specific screens (the owning document has the full rule):

| Screen | Constraint | Owner |
|---|---|---|
| Sessions | Assistant chat in the web app is a Conversation like any other (own session lineage, same assistant, same Memory, no channel involved). | [./12-assistants.md](./12-assistants.md) |
| Sessions | A user-started session is a **Thread** (a Session with no Agent); the copy says "Create new thread". The "create form" is the composer in new-thread mode ([App shell](#app-shell)): it prefills the `thread.*` settings (instance, model with its options, access mode, profile) and the workspace, checkout, branch and runner selectors; changes made there apply to that thread only and are never written back. | [./02-domain-model.md](./02-domain-model.md) |
| Settings > Threads | The defaults for new threads: provider instance, model (options from the Capability Snapshot), access mode (shipped `approval-required`), permission profile (shipped `unrestricted`). Stored as `thread.*` in the settings store. Also the one display preference of the shell: **sidebar rows** `meta` (default) or `plain` ([App shell](#app-shell)), stored as `ui.threadRows` in the user settings store (resolved 2026-09-01, [Prototype: the app shell and navigation](https://github.com/rogierpennink/hydra/issues/51)). | [./02-domain-model.md](./02-domain-model.md), [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) |
| Sessions | Affordances (models, access modes, thinking/effort options) derive from the Capability Snapshot for the provider instance on the placement target, never from a live probe that mutates a conversation. Queued Input is editable and cancelable until delivered. | [./06-providers.md](./06-providers.md) |
| Sessions, Runs | Cost is displayed where a provider reports it and never gated on. | [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) |
| Runs | Manual runs prompt for the workflow's declared inputs. Re-run offers replay-frozen-plan or re-stamp-from-current (default re-stamp). | [./07-workflows.md](./07-workflows.md) |
| Workflows | A tripped Spawn Bound shows the paused trigger with its held events and offers one-click resume, optionally discarding the backlog. | [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) |
| Fleet | A reserved "Add machine" spot shows the join command with a minted single-use token. Queued placements on a full runner are visible. Concurrent sessions in a primary Workspace are surfaced, not locked. Legacy workspace folders from a previous runner life may surface very discreetly for manual recovery. | [./03-controller-and-runners.md](./03-controller-and-runners.md) |
| Tasks | Fixed status axis, any-to-any transitions. Label colours and descriptions are presentation-layer only. Search is structured filters plus full-text. | [./09-tasks.md](./09-tasks.md) |
| Connections | Per-channel-connection toggle for Notification delivery, which asks for the notification container (a channel or the owner's DM). Default Topic chosen at setup. Channel setup ends with the owner's pairing code. | [./08-events-and-connections.md](./08-events-and-connections.md) |
| Settings > Assistants | Channel bindings are edited as `connection + scope -> assistant`, the scope pickers generated from the channel contribution's declared levels in the catalog (Discord guild / channel / thread, Slack channel / thread, or all DMs); the assistant's `reply` mode (turn-end / segments) is a setting here. | [./12-assistants.md](./12-assistants.md) |
| Settings > Identities | Platform identities with role owner / trusted; Add mints a one-time pairing code to DM to the bot; revoke in place. | [./12-assistants.md](./12-assistants.md) |
| Notifications | A Permission Request notification offers "this session only" or "add to profile". | [./13-security.md](./13-security.md) |
| Settings > Assistants | Memory documents (`core` plus topic notes, each topic's gist an editable field) are viewed and edited through the same memory API ops the `hydra memory` CLI uses; caps and the shrink guard are enforced at the write op and the UI shows the resulting error; provenance entries on a document are shown beside it and clearable. Heartbeat: enabled, target, standing prompt, and a schedule form ("every [1 h] between [07:00] and [23:00]") that compiles to the stored cron expression and parses back when the expression fits that shape, otherwise the raw expression is shown. Rotation thresholds and a "start fresh" (manual rotation) on each conversation. Reminders listed per conversation. | [./12-assistants.md](./12-assistants.md) |
| Settings > Bounds | The default Spawn Bound (30 runs per 3600 s, [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 5) is edited here, and one table lists every start trigger across all workflows: workflow · trigger · effective bound (default or override) · runs spawned in the current sliding window · status (active / paused by breaker / paused by you) · held count · Resume (optionally discarding the backlog). Per-trigger overrides are edited in the workflow's source, not here. It is the one fleet-wide place to see which trigger is near its limit (resolved 2026-09-01, [Web app details](https://github.com/rogierpennink/hydra/issues/45)). | [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) |
| Settings > System | The controller's operational settings, which had no home in the inventory before (resolved 2026-09-01, [Web app details](https://github.com/rogierpennink/hydra/issues/45); the screen is called *System*, the settings are the `controller` settings in code): `retention.events` / `retention.security` / `retention.conversations`, `backup.time` / `backup.keep`, the HTTPS toggle and its port, the access-mode fallback policy, and the update nudge. Retention is shown with the same sentence the events surfaces use ([Events surfaces and the retention horizon](#events-surfaces-and-the-retention-horizon)). | [./15-packaging-and-operations.md](./15-packaging-and-operations.md), [./04-state-store.md](./04-state-store.md), [./06-providers.md](./06-providers.md) |
| Settings > Profile | The user's **timezone**, the one spec-wide timezone source (cron triggers, rotation, heartbeat, "since you last checked", display all fall back to it); set at onboarding from the browser. Stored in the user settings store (`settings.read` / `settings.update`), which also holds topic order, mutes and the last-checked markers. | [./12-assistants.md](./12-assistants.md) section 5.2, [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2 |

**Open:** a presentation layer over task status (kanban-style user-defined groupings above the fixed axis) is on the map as "not yet specified"; the Tasks screen ships without it.

## App shell

Pinned by [Prototype: the app shell and navigation](https://github.com/rogierpennink/hydra/issues/51) (2026-09-01, five reaction rounds; the converged asset is in [Prototype assets](#prototype-assets-reference-implementations)). This is the frame every screen sits in; the screens themselves are owned by their own sections.

**A sidebar with two faces** ("Modes"). One sidebar with a segmented switch at its top, **Threads** | **Hydra**:

- *Threads* is the t3-code experience uncut: **Create new thread**, then the threads grouped per project (project identity dot and count on the group header), then **Assistants** (the web-chat assistant and every channel-bound one, a live or idle dot and where it is), then **All sessions →**. Thread rows are the **meta** density: state mark · title · age on the first line, a second faint mono line with checkout or branch · PR · model. Settings > Threads switches rows to **plain** (title and age only); the "rich" card row was rejected as too busy.
- *Hydra* is the orchestration nav in the pinned order: Intake, Check-in, Tasks, Runs, Workflows, then Fleet, Connections, Notifications, Settings. The four entity items carry their glyph, the rest none ([Iconography](#iconography)). Counts sit at the right of Intake (proposals), Check-in (decisions, attention hue) and Notifications (unseen).
- The face follows the screen (Sessions shows Threads, every other screen shows Hydra) and the switch overrides it. The check-in count leaks into the **Hydra** segment, so the orchestration side never hides while the user works in threads: that is what keeps it from feeling like management chrome bolted on.
- Rejected on the record, switchable in the prototype: **A "Nav"** (one orchestration nav always, threads as a list column inside Sessions - management first) and **C "Stack"** (threads and the orchestration group in one sidebar, also in its compact form with Intake / Check-in / Notifications as rows above the threads and the other six screens as a text line at the foot).

**Sidebar foot.** From the bottom up: the **Marks** legend toggle (`?` opens the fly-out, Esc closes; [Iconography](#iconography)), and above it the **pulse**: the fleet's ambient signals as one quiet summary line with a live dot in front and a chevron at the end (`6 runners · 1 at cap · Hera active`), expanding on click to the full block (fleet · assistants · intake lines). Closed by default; the open state is per browser session. The top bar carries no pulse; the check-in page keeps its own pulse rail.

**Top bar.** The screen title with its time context ("Monday 09:14"; "since Sunday 22:10" on Intake). On a thread: `project / title`, a `thread · <short id>` crumb, and `Changes +48 −12 · Commit` or `PR #98` at the right.

**All sessions** is a full page, not a longer sidebar: one headline sentence (`1 running · 1 waiting on you · 2 idle · 2 settled this week`), project filter tabs with Create new thread at their right, lanes **Waiting on you / Running / Idle** (resumes on your next message) **/ Assistants / Settled** with checkout, PR and provider per row. Sessions started by workflows are not threads: they sit behind a fold at the bottom ("show 2 · 1 running · 14 today"), closed by default.

### The thread surface

The Codex / t3-code shape: a centered column (800px), a mono timestamp line, the user's messages as right-aligned bubbles, the agent's prose full width, changed-files cards (`6 changed files +210 −8 · Show files · Open diff`), the composer floating at the bottom. **Worked for 31s ›** dividers collapse a turn's tool calls; click expands them as a quiet mono list (verb · target · result). The live turn reads **Working for 12m ›** with a slow shimmer across the text (static live hue under reduced motion) and its running tool call marked. **Permission requests dock onto the composer**: the decision's ledger card ([The check-in view](#the-check-in-view)) attaches above the input, the same place every time; the transcript does not repeat it.

### The composer is the thread's configuration

**Creating a thread is one step.** Create new thread opens the thread surface in new-thread mode (heading "What should the agent do in *hydra*?", the composer at the bottom); sending the first message starts the thread. There is no create form: every option lives on the composer, prefilled from Settings > Threads and the "local" runner alias, and per-thread changes are never written back.

The composer is the **codexlip** shape: one card holding the text and a row of `+` (attach) · access mode · the model pill (`Claude Code · personal · claude-sonnet-5 · medium`) · voice · a round send; under the card a small **setup bar**: workspace · checkout · branch on the left, runner · profile on the right. Every item is a selector that opens a menu anchored above it (one popover at a time; Esc or a click outside closes it; what was typed survives). Rejected on the record: the round-2 strip-above / row-inside shape, a t3-code lookalike, and the plain Codex card with the setup as tabs above it.

| Selector | Menu | After start |
|---|---|---|
| Workspace | repos grouped per project (identity dot); each says `primary on main · 2 worktrees in use`, or `not cloned on <runner> · clones on first use` when the picked runner has no clone; **No workspace** at the foot, then *Adopt a folder on this machine…* and *Add a repo →*. A fresh install offers only those three. | locked |
| Checkout | **primary checkout** (`main`, the clone itself) or **new worktree**; worktrees already in use are listed dimmed with the thread using them | locked |
| Branch | **new branch** `<repo>/run-…` (from the primary branch, named after the thread id) or an existing one; on the primary checkout the menu says the checkout switches to it | locked |
| Runner | every machine: name · state word in its hue · capacity, and under it `this machine · reserved`, `default`, `queue 2` and the provider logins it holds; a machine without the current login, draining, or unreachable is dimmed with the reason; foot: *Add machine →*. Switching runner re-resolves the Capability Snapshot for that machine ([./06-providers.md](./06-providers.md) §3.1; "probing hetzner-01…" on the model label meanwhile). | locked |
| Profile | unrestricted · worker · assistant, a one-line gist each | locked |
| Access mode | the four modes with their meaning; a mode the instance's provider does not declare native is dimmed with its fallback (`auto` on pi: falls back to auto-accept-edits) | locked |
| Model | grouped per **provider instance**, one login = one group; every group header is a row showing the account and plan (`rogier@… · Max plan`); only the current instance is expanded, the others are one row each (`Claude Code · work · 4 models ›`) and click to switch; instances not logged in on the picked runner are dimmed (`not logged in on hetzner-01`; on a fresh install `found, not logged in · Log in`); **Custom model…** at the foot (the typed-slug escape hatch of [./06-providers.md](./06-providers.md) §3.3, no option controls); an **options block** closes the menu: **reasoning** (the `effort` option, `thinking` on pi) as a segmented row, **context** (200k · 1M) and **fast mode** where the model offers them. The model pill carries the reasoning level. | live |

**Dimmed with the reason, never hidden** is the rule for whatever cannot be picked. Provider logos are off (a prototype toggle keeps monochrome marks on the record; never brand colours outside the rejected t3 clone). The t3-code selector (favorites rail, search, display names, stars) was cloned as the record and not adopted.

**What locks at start.** Workspace, checkout, branch, runner and profile are the session's placement and identity and never change ([./02-domain-model.md](./02-domain-model.md): sessions copy their configuration). **Access mode locks too**: the adapter has no mode-switch method ([./06-providers.md](./06-providers.md) §4, deliberately absent), so the composer shows it read-only after start and a fork or a new thread changes it; on record for post-v1 that Claude (`setPermissionMode`) and pi could switch in-session. **Model and its options stay live**: every provider declares `modelSwitch: in-session`, and the change rides on the next turn's input (`TurnInput.modelSelection`, [./06-providers.md](./06-providers.md) §5, amended 2026-09-01).

**Open:** the voice button is a placeholder for dictation into the composer, kept for the shape; no v1 feature is specced behind it.

## The check-in view

Backward-looking monitoring of delegated work: what is running, what happened to what the user started, what needs them. Settled by four prototype rounds ([Prototype: the check-in view](https://github.com/rogierpennink/hydra/issues/20)); semantics pinned in the "Monitoring semantics" section of [../design-language.md](../design-language.md).

### Principles

1. **Intent-level, not execution-level.** Rows are **strands**: a Task, a standing Workflow, or a one-off Run, named by their domain noun. Runs, Sessions, steps and Turns appear only behind progressive disclosure (click a strand to expand). There is no "ask" vocabulary.
2. **Provenance-first attention.** Ranking is started-by-you > standing workflows > routine schedules; Task priority breaks ties; the darkens-then-warms age label stops routine failures hiding forever. All of this is derivable from the Run record's trigger and the Task's fields; no new domain fields.
3. **Aggregate by default.** Routine workflows collapse to one row each ("6 runs today · all ✓"). Verified against a calm dataset (2 runners) and a busy one (6 runners, 31 outcomes, 9 decisions): the page keeps its shape.
4. **Decisions are questions.** Every needs-you item is phrased as a question; its answers are the quiet buttons; the `?` decision mark (see [Iconography](#iconography)) marks it. **Focus** is the pinned treatment: one uniform-height labeled card at a time with fields FROM (strand, domain noun, priority, provenance), WHY, and AGENT (faint dash when no Session is attached), "1 of N" with next-peek and arrow navigation below the card. The answers are a **ledger** (next paragraph), so the card's height follows its answers and the arrow row moves with it - accepted as the common, expected pattern; the alternative (the arrow row right-aligned on the NEEDS YOU label line, where it never moves) was prototyped and stays in reserve (`?nav=top`). Queue (in-place expansion) and List (condensed rows) were rejected and remain in git history.
5. **Needs-you and the notification center are one record stream on two surfaces.** Decisions and notifications are the same core-owned Notification records ([ADR 0012](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md)); check-in shows the actionable subset, the notification center shows everything. No double bookkeeping.

**Answers as a ledger** (pinned by [Prototype: rendering bound actions](https://github.com/rogierpennink/hydra/issues/50), 2026-09-01). The bound-action rule of [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.4 puts up to three texts on one answer; the card shows all three, nothing behind a hover or a second step. Every answer is one full-width row and **the row is the button**, in a fixed hierarchy:

- **Label** in the left column (~150px, emphasis weight; ink for the `primary` answer, muted otherwise, wrapping when long).
- The core's **describe line** leads the right column at metadata size (12.5px, muted) with the live entity names in ink - the *what the click does* line, never dropped. A null-operation answer's describe line is "Does nothing", italic.
- The producer's **description**, when present, is fine print under it (11.5px, faint). Rows without one (core producers: tool approvals, permission requests, breakers) are label + describe line only.

No prefix glyph on the describe line (a "→" was tried and rejected as ugly). Rows are separated by hairlines; hover reveals the soft background, the pinned quiet affordance. Navigation is never an answer: "Open →" on the AGENT field opens the session; answers are bound actions only. The same hierarchy - describe line over description - applies wherever an answer renders with its texts: the Intake proposal dossier and the notification center. Rejected on the record: *Peek* (quiet button row plus one describe line that follows hover, description in a hover card - hides what a click does until the pointer arrives) and *Commit* (a Confirm / Back step after choosing - two clicks per decision); both remain in the prototype.

### Anatomy

Top to bottom:

1. **One calm headline sentence** ("2 decisions wait · 3 strands in motion · 6 outcomes today").
2. **Needs you** - the Focus card.
3. **In motion** - plain strand rows in three provenance tiers, headed **Started by you** / **Triggered by events** / **On a schedule**, empty tiers hidden. The tiers are the derivation rule of [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 8 made visible: manual run = started by you; event start trigger = triggered by events (a standing workflow reacting, e.g. a PR review); cron start trigger = on a schedule. Both automatic tiers keep the aggregate-one-row-per-workflow rule. The prototype's two labels ("Started by you", "Routine") predate this; standing workflows are neither routine nor started by the user, and either label would lie.
4. **Outcomes digest** - one line, expandable. "Since you last checked" as a feed is dead; outcomes live on their strands.
5. **Pulse rail** - fleet, assistants and intake as quiet text lines. Stat-card rows are banned. Assistants are ambient presence in the rail, never work strands.

A "last check-in" divider marks what the user has already seen: the `lastChecked.checkin` marker, advanced on opening the view by the same rule as Intake's ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 8).

## The Intake view

Forward-looking decision-making over prepared work: signals already triaged, grouped and enriched by agents, presented as Proposals for go/no-go. Settled by four prototype rounds ([Prototype: the Intake view](https://github.com/rogierpennink/hydra/issues/30)); semantics pinned in the "Intake semantics" section of [../design-language.md](../design-language.md). Intake and check-in are **two separate views**, not one spine; merging is a post-dogfooding question.

### Principles

1. **Intake is a morning brief**, framed on "since you last checked" (the timestamp sits in the top bar). One headline sentence leads with what burns ("1 burning · 6 proposals from 212 events · 2 need a call · 3 FYI · 198 handled quietly"). Narrative brief prose was tried and rejected.
2. **Topic tabs** organise the page (for example All / Code / Business / Personal / Ops). A Topic is a label: each Connection files into one default topic chosen at setup; triage labels a Proposal with the connection's topic unless the content says otherwise. Tabs show every topic in use, user-ordered; "Manage topics" sits at the tabs' right edge and opens the Topics sheet.
3. **Urgency is legible through tiers**: Proposals sit under **Now / Today / When you can**. The Now tier carries a pulsing attention-hue dot on its label, on the burning card, and on the topic tab containing it - the one place a coloured dot marks urgency.
4. **Lead card + condensed rows.** The burning Proposal is one lead card (title, made-from marks, one-line gist, the proactive link, actions, "Open the full picture"). Every other Proposal is a condensed row: title · priority bars · system marks · "→ suggested action" · age.
5. **"Needs a call" is verdict-based**, never priority-based: it holds what triage could not decide (an open `triage.unsure` notification, a tripped Spawn Bound). Its label says so ("triage could not decide these"). **Offers** (`triage.offer`: an immediate action with no Task, e.g. "Merge dev bumps") render beside proposals with their own answers.
6. **Made from** is mandatory on every Proposal: one entry per source system with the system's monochrome mark (GitHub, Gmail, Sentry, Tailscale, Hetzner, Dependabot, cron, Hydra itself). The mark shows the *system*; the Connection that carried it is a mono suffix. Marks are 12px monochrome `currentColor` paths, never brand colours.
7. **Detail lives in a drawer** over the rail, never a full page nor a permanent split. Esc closes. Three things open in it:
   - **Proposal dossier**: Next + answers (Accept · Start *X* when a fitting workflow exists · Dismiss - no park in v1) · Why + links (the notification body is the agent's reasoning; there is no separate verdict block) · Made from as signal cards with the source excerpt and "Open in <system>" · History.
   - **Per-connection events view**: every event on that Connection since the last check, each stamped with what triage made of it (→ *task* as proposal or attached / offer / FYI / unsure / known / held / pending triage / no action - [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 3), filterable by stamp. Held events from a tripped breaker are listed here.
   - **Topics sheet**: curate and order topics.
8. Anything that opens says so ("Open →", "Events →").

### Anatomy

Headline · topic tabs · Needs a call · Now / Today / When you can · What came in (one row per Connection: mark, name, summary, event count, "Events →") · FYI · one-line receipt ("212 events → 6 proposals · 1 attached · 2 offers · 3 FYI · 2 unsure · 198 no action") · "last triage" (the most recent completed Triage run's time and summary line). The "since you last checked" timestamp in the top bar is the `lastChecked.intake` marker; opening the view advances it, the visit keeps its `since` in the URL state, and a "since ..." control widens the window without touching the marker ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 8).

### Primitive mapping

No new core concept. A **Proposal** = a Task labelled `proposed` plus its topic label, together with its open `triage.proposal` Notification. Enrichment = the Task description. Grouping and "made from" = Provenance refs. The proactive link = a provenance ref to an existing Task. The receipt and stamps = joins over events, effect rows, Task provenance and Notification subjects ([ADR 0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)); Intake reads Tasks, Notifications and Events, never run outputs. The suggested next step = the Start answer of the decision Notification.

Four model requirements the view depends on, owned elsewhere:

- Events carry a `system` beside their Connection stamp, writable after ingest, plus a `url` (for the mark and "Open in <system>"). [./08-events-and-connections.md](./08-events-and-connections.md)
- Connections are labelable, at minimum with a default Topic. [./08-events-and-connections.md](./08-events-and-connections.md)
- Decision Notification actions bind an operation ("Start Bugfix" = start workflow X with task Y). The actor is the user clicking; the operation was authored by an agent. [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)
- What triage decided is carried by the entities it wrote (the Task, its Notification with the reasoning in its body, enrichments), not by a run field; the dossier renders those. [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)

## Workflow editing

A ringfenced `workflow-editor` feature module exporting one component. Inside it:

- **CodeMirror 6 editing the workflow's YAML source** (steps, edges, triggers, inputs; [./07-workflows.md](./07-workflows.md)) with schema-driven autocomplete and validation derived from the workflow contract in `packages/contract`. Validation surfaces the same errors the API returns (unknown action ids, uncapped cycles, invalid CEL). Autocomplete inserts a block scalar (`|`) for `prompt` and quotes for conditions, the two places YAML bites (`{{` opens a flow mapping in a plain scalar; CEL's `? :` and `: ` need quoting - the same traps GitHub Actions users already know).
- **Read-only DAG preview** rendered with React Flow, auto-laid-out with elk or dagre, updating live as the text changes.

The ringfence exists so a visual drag-and-drop editor can replace the module's internals later without touching the rest of the app.

**Format: YAML 1.2, and the text is the truth** (resolved 2026-09-01, [Web app details](https://github.com/rogierpennink/hydra/issues/45), [ADR 0029](../adr/0029-workflow-definitions-are-stored-as-their-yaml-source.md)). The controller stores the YAML source the user wrote, byte for byte, and parses it into the `Workflow` shape for validation, stamping and the preview; comments, key order and formatting survive every save, and a later git-versioned workflow story round-trips exactly. `workflow.read` returns the source and never a parsed object ([./07-workflows.md](./07-workflows.md) section 1, [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2); the DAG preview parses the text in the client with the same `yaml` package and contract schema `client-core` validates with. JSON was rejected because a multi-line prompt as one escaped string is unreadable and un-diffable; a regenerated-YAML projection was rejected because it strips comments (Home Assistant's UI editor is the cautionary tale); JSON5, TOML, HCL and the newer configuration languages lose on multi-line strings, graph shape or familiarity. Enabling a workflow and pausing a trigger are row state outside the text, so neither reformats the user's file.

## Onboarding and first run

`hydra serve` auto-initializes and prints a one-time setup URL; from there onboarding is wholly a web app + public API flow, and it creates the default assistant ([./12-assistants.md](./12-assistants.md)). The CLI never prompts, so the future desktop app becomes the installer by reusing these views unchanged. Mechanics of first run and the setup URL: [./15-packaging-and-operations.md](./15-packaging-and-operations.md).

Resolved 2026-09-01 ([Web app details](https://github.com/rogierpennink/hydra/issues/45)); the design goal is that onboarding can grow (plugin setup hooks, a richer assistant setup) without touching the gate:

1. **A thin gate.** `/setup?token=...` collects username and password on one screen and calls `setup.complete { username, password, timezone }`: the timezone is sent silently, detected from the browser, because the controller needs one immediately (backup time, cron) and it costs the user nothing. Setup creates the default assistant named `Hydra` and returns a logged-in bearer token. Nothing that needs a Connection, a runner or a provider login sits inside the gate: it completes in thirty seconds on a fresh install.
2. **An ordered step list after the gate**, each step an ordinary authenticated call so a future step is client-side work only. V1 ships two: *confirm your timezone* (`settings.update`) and *name your assistant* (`assistant.update`, prefilled `Hydra`). Progress is `onboarding.completedSteps: string[]` in the user settings store ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2), so a refresh resumes where it left off.
3. **The first-session moment is the rest of onboarding.** There is no "get started" checklist page. The home screen, Sessions, opens empty and *is* the guidance: the local runner has probed which harnesses are installed on this machine (a read-only presence check of `~/.claude`, `~/.codex` and pi's directory; it never reads credentials), so the empty state says "Claude Code and Codex were found on this machine. Log in to use them in Hydra" with one button per detected provider that runs the fleet UI's login action for that instance x the local runner ([./03-controller-and-runners.md](./03-controller-and-runners.md) section 3.3). After one login the same screen says "Claude Code is ready" and offers **Create new thread** (a Thread: a session with no Agent, [./02-domain-model.md](./02-domain-model.md)), which opens the composer in new-thread mode ([App shell](#app-shell)) with the Settings > Threads defaults prefilled and the workspace selector on No workspace, *Adopt a folder on this machine…* and *Add a repo →* its only other entries. GitHub, Gmail and chat Connections are offered as empty states on Intake and Notifications, not as a checklist; nothing is stored, every step's state is derived. Pinned copy ([Prototype: the app shell and navigation](https://github.com/rogierpennink/hydra/issues/51)): Intake opens on "Nothing has come in yet" with Connect rows for GitHub and Gmail and the topic sentence; Notifications on "Decisions and outcomes will land here" with Connect rows for Discord and Slack and the pairing-code sentence; Check-in on "Nothing in motion yet"; Fleet shows this machine with each harness's login state and the Add-machine spot. The provider instances the buttons act on exist from first run ([./06-providers.md](./06-providers.md) section 2: one per shipped provider plugin).

The cost that remains, on the record: the user's existing `claude` / `codex` / `pi` login is invisible to Hydra by design (per-instance isolated provider homes, [./06-providers.md](./06-providers.md) section 9.1), so one paste-a-code per provider per machine is unavoidable in v1 - about twenty seconds each. Reusing that login is on the map as strongly wanted post-v1. The user's skills, subagents and instructions are equally invisible, which is a model gap, not a friction detail: [User knowledge in Hydra sessions](https://github.com/rogierpennink/hydra/issues/52).

## Connection setup

Connection setup is a web app + API flow per Connection type. Two flow shapes exist, paste-a-token and OAuth redirect; for the redirect shape the web app displays the exact redirect URI to register, derived from the origin the user's browser is already using to reach the controller. The Connection's default Topic is chosen at setup. Per-provider flows, including the Google setup steps, are owned by [./08-events-and-connections.md](./08-events-and-connections.md#9-connection-setup-flows); credential policy by [./13-security.md](./13-security.md).

## The "local" runner alias

"local" is a client-resolved placement alias meaning "the runner on the machine the user is operating", distinct from the fleet default runner, and never offered when that machine has no runner. It is a UI convenience only: placement correctness never depends on detection.

Mechanism, single-function territory:

- The runner serves `GET /identity` on a loopback-only port, returning its runner id, with CORS allowing the controller origin (runner side: [./03-controller-and-runners.md](./03-controller-and-runners.md)). The port is the **runner's** (resolved 2026-09-01, [Web app details](https://github.com/rogierpennink/hydra/issues/45)): a runner-local setting `identity.port`, default **4939** (the next number in the controller's 4937/4938 family, not a rule), falling back to a free port when the default is taken. The runner reports it as a probed fact in its hello ([./03-controller-and-runners.md](./03-controller-and-runners.md) section 4); there is no controller config key, because the probe answers "which runner is on the machine *my browser* is on", which only a process on that machine can answer.
- `client-core` exposes one `detectLocalRunner()`: one short-timeout fetch to `127.0.0.1:<port>` for each online runner's reported port (a handful of loopback fetches, all but one failing instantly), returning the id or `null`.
- The UI offers "local" only when the returned id matches an online fleet runner. If the probe cannot run, "local" is not offered and the user picks a runner by name.

Platform facts (2025-26): Chrome's Local Network Access permission gates public→local only, and local→loopback is ungated (tailnet `100.x` counts as local); Firefox 149+ may one-time-prompt, and the probe degrades silently; Safari blocks loopback fetches from HTTPS origins (open WebKit bug since 2017) - the one hard failure case, where the user picks by name.

On record as upgrades if the probe under-delivers: server-side IP correlation (authoritative on a tailnet, heuristic on LAN), and a manual `localStorage` pin via a runner-initiated token URL.

## Events surfaces and the retention horizon

The event log is TTL-pruned (`retention.events`, default 90 days) except for events that an existing Task's provenance or an existing Notification refers to, which live as long as that referrer does ([./04-state-store.md](./04-state-store.md), amended 2026-09-01 by [Web app details](https://github.com/rogierpennink/hydra/issues/45)); a run copies its triggering event and every signal it received into its own records and needs nothing from the log. The rule for every surface that shows events - the Intake per-connection events view, the receipt and headline counts, the Notifications screen - is **never silently truncate**:

1. Every events list states its horizon in its header ("events from the last 90 days"), the same sentence Settings > System shows beside the retention setting.
2. The "since ..." control caps at the horizon and says so.
3. Counts are computed over surviving events and are labelled "since <marker>", so they never claim completeness across the horizon.

A Task's provenance never points at a pruned event while the Task exists, so the dossier's "Made from" excerpts and "Open in <system>" links keep working for the life of the task; there is no degraded rendering to design. Pruning Tasks themselves is on the map as not yet specified.

## Notification center

The Notifications screen is an in-app sink under [ADR 0012](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md): it records everything the core routes, subscribed through a live topic, and executes a Notification's bound actions through ordinary API operations. It is dumb: routing decisions stay in the core. It shows every Notification; the check-in view's needs-you module shows the actionable subset of the same records. There is no per-record read state: a "new" divider at the `lastChecked.notifications` marker (advanced on opening the screen) separates what arrived since the last visit. Resolved decisions show their outcome line from the `Resolution` ("decided in Discord", "handled by *Ada* in #ops", "withdrawn: token refreshed"); the per-producer mute toggles (`notifications.muted` in the settings store) live here. There is no Web Push in v1 (the browser's Service Worker API needs a secure context the plain-HTTP LAN default does not give); push beyond the browser is what channels are for.

## Design language

All screens are built in the pinned language in [../design-language.md](../design-language.md) (ticket [#33](https://github.com/rogierpennink/hydra/issues/33)). In five lines:

- **Register:** calm middle density, Linear-adjacent refinement but less dense; both themes first-class from one token system; decision affordances are quiet text-only ghost buttons, never filled buttons on monitoring surfaces.
- **Surfaces (Midnight):** blue-violet neutrals at oklch hue 265, colour strength 6; grounds light 94.5% / dark 20%; layers `--bg` / `--surface` / `--raised`; depth = hairline border + crisp shallow shadow; dark prominence = raised surface + faint white inner top highlight, never a colour wash.
- **Type:** Onest at emphasis weight 500 (600 reserved for urgent), IBM Plex Mono with tabular numerals for ids, refs, ages, counts; body 14px/1.5.
- **Semantic hues, fixed and colour-only-at-word-and-dot-scale:** amber = waiting on you, clay = failed, petrol = live, sage = done (✓); never fills, chips, stripes or washes.
- **Encodings:** currency = 6px pulsing dot + tinted state word (respect `prefers-reduced-motion`); waiting-time = mono age label darkening faint → muted → ink → attention hue; importance = three gray bars + weight/opacity, never colour; outcome = ✓/✕ glyphs; lineage = text breadcrumbs + square project dots on group headers only.

## Iconography

Pinned by [Prototype: mark & entity-glyph iconography](https://github.com/rogierpennink/hydra/issues/35) (2026-08-30); the full table is in [../design-language.md](../design-language.md) §Marks. One bespoke family on a 12px grid at Lucide's optical weight (~1.15px stroke, `currentColor`), not a third-party icon set. State marks: soft equalizer = agent working (live hue), `?` = decision wanted (attention hue), hollow circle = queued, bare pause bars = paused (attention hue), ✓ / ✕ / – = done / failed / cancelled. Entity glyphs, ink family only: rounded square = task, outline triangle = run, speech bubble = session, three-node fork = workflow. Segmented micro-progress for multi-step runs, priority bars, ◇ = proposed and the attention dot = burning stay as the check-in and Intake prototypes pinned them. The system brand marks (simple-icons paths, monochrome) are unchanged.

**Placement rule: one mark per slot, never two side by side.** A row's leading cell holds its state mark only; entity glyphs appear only where they are the sole mark - the sidebar nav (the four entity items) and the decision card's FROM / AGENT fields. Rows, detail lines and digests name the kind in text instead.

The marks legend lives behind a "Marks" toggle at the foot of the sidebar, a fly-out popover (`?` opens, Esc closes), never permanently on a page.

## Prototype assets (reference implementations)

Throwaway single-file HTML prototypes, not app code. They are the visual reference an implementer builds against.

| Branch | File | Final commit | Live |
|---|---|---|---|
| `prototype/design-language` | `prototype/design-language.html` - the Slate/Midnight playground; defaults are the pinned settings `face=Onest th=Midnight cs=6 ll=94.5 dl=20 w=500`; rounds 1-3 in history (78ab468, b18c9bb, 8331fea) | ec83ff9 | https://claude.ai/code/artifact/8a365dff-abc0-474f-9489-65251a93fa47 |
| `prototype/check-in-view` | `prototype/check-in-view.html` - converged check-in with calm/busy dataset toggle (`d`), theme toggle (`t`); rejected Queue/List treatments and rounds 1-3 in history | 28cf40f | https://claude.ai/code/artifact/a6eeca13-073a-4709-bc9a-d666ae169204 |
| `prototype/intake-view` | `prototype/intake-view.html` - converged Intake; rounds 1-3 at e0f5f7c, 3d6a81f, f4a452a | f1a1e15 | https://claude.ai/code/artifact/2e2b81a8-181c-44df-a7b6-d55b42263ee5 |
| `prototype/iconography` | `prototype/iconography.html` - the marks playground; defaults are the pinned settings (variant D, `sess=bubble`, `legend=side`, `work=soft`, `nav=entities`); rounds 1-2 at ba8da6c, b88feea; `?lab=1` shows every mark at 3x | 4822f19 | https://claude.ai/code/artifact/557a450d-ce45-4336-8d58-3c29301b6b32 |
| `prototype/app-shell` | `prototype/app-shell.html` - the converged shell: B Modes sidebar, `rows=meta`, `input=codexlip`, `effort=nested`, logos off, foot pulse collapsed; every selector on the composer opens its menu; rejected shells A Nav / C Stack (`?variant`, `?stack`), input shapes `hydra` / `t3` (with the t3 selector clone) / `codex`, `?rows=plain|rich`, `?effort=own`, `?logos=1`, `?pulse=top|none` stay switchable; rounds 1-5 at fc420d2, 6a6443b, 331118e, 1a0da0e, 0db4d94 | 96b3c40 | https://claude.ai/code/artifact/d41ae563-3878-49d0-91f7-13539d9cea97 |
| `prototype/bound-actions` | `prototype/bound-actions.html` - the Focus card's answers with all three texts on the check-in page, plus the same decision as a Discord sink message; defaults are the pinned settings (`variant=B` Ledger, `nav=bottom`, `chan=compact`); Peek (A) and Commit (C) rejected but switchable; rounds 1-3 at e7b0247, bc29447, aedf2db | ca15c4a | https://claude.ai/code/artifact/e68afbd7-5a12-4e19-9b1e-e4296b2818e2 |

## Post-v1

- **Desktop app.** High priority later; v1 keeps `client-core` + `ui` framework-agnostic and free of domain logic in components so the desktop app reuses them wholesale.
- **Visual drag-and-drop workflow authoring.** The ringfenced `workflow-editor` module lets a visual editor replace the internals.
- **Bespoke per-workflow-type UIs** (for example a scheduled-tasks view). The screen inventory is fixed without them; a scheduled-task form is sugar over a one-step cron-triggered workflow.
- **Web Push notifications.** Needs a secure context; native desktop notifications arrive with the desktop app.
- **Merging Intake and check-in into one spine.** Post-dogfooding; both views stay separate in v1.
- **Narrative morning-brief prose.** If wanted, it is an assistant or cron workflow posting to a channel, not an Intake feature.
- **Local-runner detection upgrades** (server-side IP correlation, manual `localStorage` pin). Only if the loopback probe under-delivers.
- **UI-contribution extension point** (plugins shipping UI). Ruled post-v1 by [./05-plugins.md](./05-plugins.md); v1 plugin UI is limited to generated config forms.
- **Presentation layer over task status** (kanban-style groupings). Not yet specified; never domain states.

## Sources

Tickets:

- [Web app architecture: observability-first, desktop-shell-ready](https://github.com/rogierpennink/hydra/issues/19)
- [Design language: visual semantics & aesthetic direction](https://github.com/rogierpennink/hydra/issues/33)
- [Prototype: the check-in view](https://github.com/rogierpennink/hydra/issues/20)
- [Prototype: the Intake view](https://github.com/rogierpennink/hydra/issues/30)
- [Prototype: mark & entity-glyph iconography](https://github.com/rogierpennink/hydra/issues/35)
- [Prototype: the app shell and navigation](https://github.com/rogierpennink/hydra/issues/51)
- [Controller packaging & install story](https://github.com/rogierpennink/hydra/issues/24)
- [Research: smoothest Connection-setup path](https://github.com/rogierpennink/hydra/issues/32)
- [Controller promotion & portability](https://github.com/rogierpennink/hydra/issues/10) (the "local" alias handoff)
- [Controller/runner architecture](https://github.com/rogierpennink/hydra/issues/7) (fleet screen constraints)
- [Triage engine & user-set bounds](https://github.com/rogierpennink/hydra/issues/15) (notification sink, breaker resume)
- [Agent-operates-system surface](https://github.com/rogierpennink/hydra/issues/16) (contract package)
- [Security & secrets model](https://github.com/rogierpennink/hydra/issues/18) (user auth, escalation UX)
- [Assistant design](https://github.com/rogierpennink/hydra/issues/17) and [Prototype: assistant memory interface](https://github.com/rogierpennink/hydra/issues/31) (web chat, memory editing)
- [Assemble the v1 spec](https://github.com/rogierpennink/hydra/issues/21) (Intake model requirements)
- [Web app details: workflow text format, onboarding steps, Settings > Bounds, WS envelope](https://github.com/rogierpennink/hydra/issues/45) (YAML source, thin gate and first-session onboarding, Settings > Bounds and > System, check-in tiers, wire format, `localStorage` + CSP, runner-owned identity port, retention horizon, Sessions as home)
- [Revisit Effect for the backend (#53)](https://github.com/rogierpennink/hydra/issues/53) (Effect RPC replaces the envelope, contract in Effect Schema, the web app stays outside Effect)

ADRs:

- [ADR 0017 - The web app is a static pure client of the public API](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)
- [ADR 0013 - Agents operate Hydra through the public API](../adr/0013-agents-operate-hydra-through-the-public-api.md)
- [ADR 0012 - Notifications are core-routed, sinks are dumb](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md)
- [ADR 0009 - All events flow through one persisted pipeline](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)
- [ADR 0004 - Controller state lives in one SQLite database](../adr/0004-controller-state-lives-in-one-sqlite-database.md)
- [ADR 0018 - Hydra ships as one self-contained binary](../adr/0018-hydra-ships-as-one-self-contained-binary.md)
- [ADR 0029 - Workflow definitions are stored as their YAML source](../adr/0029-workflow-definitions-are-stored-as-their-yaml-source.md)
- [ADR 0031 - The backend is written on Effect](../adr/0031-the-backend-is-written-on-effect.md)
