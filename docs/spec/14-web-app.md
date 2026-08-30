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
| `packages/contract` | Shared Zod input/output schemas for every API operation ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)) | none |
| `packages/protocol` | The versioned controller-runner WebSocket message schema ([./03-controller-and-runners.md](./03-controller-and-runners.md)); not imported by the web app | none |
| `packages/client-core` | Typed client over the contract; WebSocket supervisor (connect, ticket refresh, reconnect, cursor replay); live stores; auth (token holding, login, logout); `detectLocalRunner()` | none (framework-agnostic) |
| `client-core` React bindings | Thin hooks over the live stores and client | React |
| `packages/ui` | The component library (shadcn/ui-based), built in the pinned design language | React |
| `apps/web` | Routes and presentation only | React |

Discipline: **no domain logic in components**. Anything that interprets domain data (ranking strands, deriving provenance tiers, mapping verdicts to labels) lives in `client-core` and is tested there.

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

**Open:** the WebSocket wire format (message envelope, topic naming scheme, cursor encoding, hello payload) is not pinned by any ticket. Constraints it must satisfy: versioned, subscribe/unsubscribe/delta/invalidate/hello message kinds, cursor replay for append-only topics, server version in hello.

## Auth in the client

- Password login over HTTP returns an **opaque bearer token**. The client holds it and sends `Authorization: Bearer <token>` on every HTTP request.
- The WebSocket authenticates with a **short-lived single-purpose ticket** (t3-code pattern, 5-minute tickets) fetched over HTTP with the bearer token. The long-lived token never appears in a URL.
- **No cookies, no CSRF machinery.** The browser is an ordinary API client, and the same flow works unchanged in a desktop shell.
- API keys (long-lived user credentials for the ops CLI and scripts) are minted in the web app under Settings or via `hydra login`; token semantics in [./13-security.md](./13-security.md).
- Session Tokens (agent credentials) never reach the web app.

Ticket #18 pinned a 30-day rolling session cookie; the later ticket #19 and ADR 0017 pin bearer token + WS ticket, no cookies. ADR 0017 governs.

**Open:** where the client stores the bearer token between page loads (memory only, `localStorage`, or another mechanism) and the token's lifetime and rolling-renewal rule are not pinned. The 30-day rolling lifetime from ticket #18 is the only stated number and applied to the superseded cookie.

## Performance guardrails

Named conventions, lint- or CI-enforced where possible:

1. React Compiler on; compiler-aware `react-hooks` lint rules are CI-blocking.
2. Fine-grained external-store subscriptions (selector-based). Never React Context for changing data.
3. Every unbounded list is virtualized (TanStack Virtual).
4. Token deltas are buffered outside React and flushed with `requestAnimationFrame` at most once per frame; only the visible transcript tail renders live.
5. Route-level code splitting plus a CI bundle budget.
6. TanStack Query for all HTTP reads, WebSocket-driven invalidation, no hand-rolled fetch state.

t3-code validates the family (React Compiler, virtualized transcript, rAF, memoized rows). Its Effect-stream state and no-Query approach do not transfer because Hydra does not use Effect.

## V1 screen inventory

The v1 screens are: **Intake, Check-in, Tasks, Sessions (including assistant chat), Runs, Workflows, Fleet, Connections, Notifications, Settings (Plugins, Permission profiles, Secrets, Bounds, Assistants).**

- Event sources get no screen; they surface through Connections and workflow triggers.
- Plugin configuration forms are generated from the manifest config schema ([./05-plugins.md](./05-plugins.md)). UI pickers (action ids, provider ids, channel ids) read the persisted contribution catalog, never the live plugin.
- Every screen is built in the pinned design language ([Design language](#design-language)).

Constraints other documents hand to specific screens (the owning document has the full rule):

| Screen | Constraint | Owner |
|---|---|---|
| Sessions | Assistant chat in the web app is a Conversation like any other (own session lineage, same assistant, same Memory, no channel involved). | [./12-assistants.md](./12-assistants.md) |
| Sessions | Affordances (models, access modes, thinking/effort options) derive from the Capability Snapshot for the provider instance on the placement target, never from a live probe that mutates a conversation. Queued Input is editable and cancelable until delivered. | [./06-providers.md](./06-providers.md) |
| Sessions, Runs | Cost is displayed where a provider reports it and never gated on. | [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) |
| Runs | Manual runs prompt for the workflow's declared inputs. Re-run offers replay-frozen-plan or re-stamp-from-current (default re-stamp). | [./07-workflows.md](./07-workflows.md) |
| Workflows | A tripped Spawn Bound shows the paused trigger with its held events and offers one-click resume, optionally discarding the backlog. | [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) |
| Fleet | A reserved "Add machine" spot shows the join command with a minted single-use token. Queued placements on a full runner are visible. Concurrent sessions in a primary Workspace are surfaced, not locked. Legacy workspace folders from a previous runner life may surface very discreetly for manual recovery. | [./03-controller-and-runners.md](./03-controller-and-runners.md) |
| Tasks | Fixed status axis, any-to-any transitions. Label colours and descriptions are presentation-layer only. Search is structured filters plus full-text. | [./09-tasks.md](./09-tasks.md) |
| Connections | Per-channel-connection toggle for Notification delivery. Default Topic chosen at setup. | [./08-events-and-connections.md](./08-events-and-connections.md) |
| Notifications | A Permission Request notification offers "this session only" or "add to profile". | [./13-security.md](./13-security.md) |
| Settings > Assistants | Memory documents (`core` plus topic notes) are viewed and edited through the same memory API ops the `hydra memory` CLI uses; caps are enforced at the write op and the UI shows the resulting error. | [./12-assistants.md](./12-assistants.md) |

**Open:** the screen inventory names "Bounds" under Settings while Spawn Bounds are per-trigger settings inside a workflow. What the Settings > Bounds screen shows beyond a fleet-wide overview of triggers and their bounds is not pinned.

**Open:** a presentation layer over task status (kanban-style user-defined groupings above the fixed axis) is on the map as "not yet specified"; the Tasks screen ships without it.

## The check-in view

Backward-looking monitoring of delegated work: what is running, what happened to what the user started, what needs them. Settled by four prototype rounds ([Prototype: the check-in view](https://github.com/rogierpennink/hydra/issues/20)); semantics pinned in the "Monitoring semantics" section of [../design-language.md](../design-language.md).

### Principles

1. **Intent-level, not execution-level.** Rows are **strands**: a Task, a standing Workflow, or a one-off Run, named by their domain noun. Runs, Sessions, steps and Turns appear only behind progressive disclosure (click a strand to expand). There is no "ask" vocabulary.
2. **Provenance-first attention.** Ranking is started-by-you > standing workflows > routine schedules; Task priority breaks ties; the darkens-then-warms age label stops routine failures hiding forever. All of this is derivable from the Run record's trigger and the Task's fields; no new domain fields.
3. **Aggregate by default.** Routine workflows collapse to one row each ("6 runs today · all ✓"). Verified against a calm dataset (2 runners) and a busy one (6 runners, 31 outcomes, 9 decisions): the page keeps its shape.
4. **Decisions are questions.** Every needs-you item is phrased as a question; its answers are the quiet buttons; the `?` decision mark (see [Iconography](#iconography)) marks it. **Focus** is the pinned treatment: one uniform-height labeled card at a time with fields FROM (strand, domain noun, priority, provenance), WHY, and AGENT (faint dash when no Session is attached), "1 of N" with next-peek and arrow navigation. Because the card height is fixed, the controls never move while cycling. Queue (in-place expansion) and List (condensed rows) were rejected and remain in git history.
5. **Needs-you and the notification center are one record stream on two surfaces.** Decisions and notifications are the same core-owned Notification records ([ADR 0012](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md)); check-in shows the actionable subset, the notification center shows everything. No double bookkeeping.

**Open:** the bound-action rule of [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.4 puts up to three texts on one answer: the label, the producer's description of what the choice means, and the core's describe line of what the click does. Doing that inside a Focus card while keeping it calm and low-load is unsolved; the check-in and Intake prototypes predate the rule. Candidate: label as the button, describe line as fine print, description behind hover or expand. To be prototyped.

### Anatomy

Top to bottom:

1. **One calm headline sentence** ("2 decisions wait · 3 strands in motion · 6 outcomes today").
2. **Needs you** - the Focus card.
3. **In motion** - plain strand rows in provenance tiers; the prototype labels them "Started by you" and "Routine".
4. **Outcomes digest** - one line, expandable. "Since you last checked" as a feed is dead; outcomes live on their strands.
5. **Pulse rail** - fleet, assistants and intake as quiet text lines. Stat-card rows are banned. Assistants are ambient presence in the rail, never work strands.

A "last check-in" divider marks what the user has already seen.

**Open:** the ranking has three provenance levels (you > standing > routine) but the prototype shows two tier labels ("Started by you", "Routine"). Which tier standing workflows render under is not pinned.

## The Intake view

Forward-looking decision-making over prepared work: signals already triaged, grouped and enriched by agents, presented as Proposals for go/no-go. Settled by four prototype rounds ([Prototype: the Intake view](https://github.com/rogierpennink/hydra/issues/30)); semantics pinned in the "Intake semantics" section of [../design-language.md](../design-language.md). Intake and check-in are **two separate views**, not one spine; merging is a post-dogfooding question.

### Principles

1. **Intake is a morning brief**, framed on "since you last checked" (the timestamp sits in the top bar). One headline sentence leads with what burns ("1 burning · 6 proposals from 212 events · 2 need a call · 3 FYI · 198 handled quietly"). Narrative brief prose was tried and rejected.
2. **Topic tabs** organise the page (for example All / Code / Business / Personal / Ops). A Topic is a label: each Connection files into one default topic chosen at setup; triage labels a Proposal with the connection's topic unless the content says otherwise. Tabs show every topic in use, user-ordered; "Manage topics" sits at the tabs' right edge and opens the Topics sheet.
3. **Urgency is legible through tiers**: Proposals sit under **Now / Today / When you can**. The Now tier carries a pulsing attention-hue dot on its label, on the burning card, and on the topic tab containing it - the one place a coloured dot marks urgency.
4. **Lead card + condensed rows.** The burning Proposal is one lead card (title, made-from marks, one-line gist, the proactive link, actions, "Open the full picture"). Every other Proposal is a condensed row: title · priority bars · system marks · "→ suggested action" · age.
5. **"Needs a call" is verdict-based**, never priority-based: it holds what triage could not decide (an `unsure` verdict, a tripped Spawn Bound). Its label says so ("triage could not decide these").
6. **Made from** is mandatory on every Proposal: one entry per source system with the system's monochrome mark (GitHub, Gmail, Sentry, Tailscale, Hetzner, Dependabot, cron, Hydra itself). The mark shows the *system*; the Connection that carried it is a mono suffix. Marks are 12px monochrome `currentColor` paths, never brand colours.
7. **Detail lives in a drawer** over the rail, never a full page nor a permanent split. Esc closes. Three things open in it:
   - **Proposal dossier**: Next + actions · Why + links · Made from as signal cards with the source excerpt and "Open in <system>" · the **triage verdict block** (the agent's structured output: verdict, priority, confidence, grouping, related tasks, suggested step - the trust surface) · History.
   - **Per-connection events view**: every event on that Connection since the last check, each stamped with what triage made of it (→ proposal / unsure / FYI / ignored / filed / held), filterable by verdict. Held events from a tripped breaker are listed here.
   - **Topics sheet**: curate and order topics.
8. Anything that opens says so ("Open →", "Events →").

### Anatomy

Headline · topic tabs · Needs a call · Now / Today / When you can · What came in (one row per Connection: mark, name, summary, event count, "Events →") · FYI · one-line receipt ("212 events → 6 proposals · 2 routed · 1 attached · 3 FYI · 198 ignored").

### Primitive mapping

No new core concept. A **Proposal** = a Task labelled `proposed` plus its topic label, together with its pending go/no-go Notification. Enrichment = the Task description. Grouping and "made from" = Provenance refs. The proactive link = a provenance ref to an existing Task. The receipt = triage Run records. The events view = the event log filtered by Connection, joined to the effect rows each event produced ([ADR 0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)). The suggested next step = the first bound action of the decision Notification.

Four model requirements the view depends on, owned elsewhere:

- Events carry a `system` beside their Connection stamp, writable after ingest, plus a `url` (for the mark and "Open in <system>"). [./08-events-and-connections.md](./08-events-and-connections.md)
- Connections are labelable, at minimum with a default Topic. [./08-events-and-connections.md](./08-events-and-connections.md)
- Decision Notification actions bind an operation ("Start Bugfix" = start workflow X with task Y). The actor is the user clicking; the operation was authored by an agent. [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)
- The triage agent's structured verdict is stored on the Run and surfaced in the dossier. [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)

## Workflow editing

A ringfenced `workflow-editor` feature module exporting one component. Inside it:

- **CodeMirror 6 structured text** of the workflow definition (steps, edges, triggers, inputs; [./07-workflows.md](./07-workflows.md)) with schema-driven autocomplete and validation derived from the workflow contract in `packages/contract`. Validation surfaces the same errors the API returns (unknown action ids, uncapped cycles, invalid CEL).
- **Read-only DAG preview** rendered with React Flow, auto-laid-out with elk or dagre, updating live as the text changes.

The ringfence exists so a visual drag-and-drop editor can replace the module's internals later without touching the rest of the app.

**Open:** the concrete text format the editor edits (JSON, YAML, or another serialization of the declarative workflow definition) is not pinned by any ticket.

## Onboarding and first run

`hydra serve` auto-initializes and prints a one-time setup URL; from there onboarding is wholly a web app + public API flow, and it creates the default assistant ([./12-assistants.md](./12-assistants.md)). The CLI never prompts, so the future desktop app becomes the installer by reusing these views unchanged. Mechanics of first run and the setup URL: [./15-packaging-and-operations.md](./15-packaging-and-operations.md).

**Open:** the content of the onboarding flow (which steps the setup URL walks the user through, beyond establishing the user's password and creating the default assistant) is not pinned by any ticket.

## Connection setup

Connection setup is a web app + API flow per Connection type. Two flow shapes exist, paste-a-token and OAuth redirect; for the redirect shape the web app displays the exact redirect URI to register, derived from the origin the user's browser is already using to reach the controller. The Connection's default Topic is chosen at setup. Per-provider flows, including the Google setup steps, are owned by [./08-events-and-connections.md](./08-events-and-connections.md#9-connection-setup-flows); credential policy by [./13-security.md](./13-security.md).

## The "local" runner alias

"local" is a client-resolved placement alias meaning "the runner on the machine the user is operating", distinct from the fleet default runner, and never offered when that machine has no runner. It is a UI convenience only: placement correctness never depends on detection.

Mechanism, single-function territory:

- The runner serves `GET /identity` on a fixed loopback-only port, returning its runner id, with CORS allowing the controller origin (runner side: [./03-controller-and-runners.md](./03-controller-and-runners.md)).
- `client-core` exposes one `detectLocalRunner()`: one fetch with a short timeout, returning the id or `null`.
- The UI offers "local" only when the returned id matches an online fleet runner. If the probe cannot run, "local" is not offered and the user picks a runner by name.

Platform facts (2025-26): Chrome's Local Network Access permission gates public→local only, and local→loopback is ungated (tailnet `100.x` counts as local); Firefox 149+ may one-time-prompt, and the probe degrades silently; Safari blocks loopback fetches from HTTPS origins (open WebKit bug since 2017) - the one hard failure case, where the user picks by name.

On record as upgrades if the probe under-delivers: server-side IP correlation (authoritative on a tailnet, heuristic on LAN), and a manual `localStorage` pin via a runner-initiated token URL.

**Open:** the fixed loopback port number for `GET /identity` is not pinned.

## Notification center

The Notifications screen is an in-app sink under [ADR 0012](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md): it records everything the core routes, subscribed through a live topic, and executes a Notification's bound actions through ordinary API operations. It is dumb: routing decisions stay in the core. It shows every Notification; the check-in view's needs-you module shows the actionable subset of the same records. There is no Web Push in v1 (the browser's Service Worker API needs a secure context the plain-HTTP LAN default does not give); push beyond the browser is what channels are for.

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
- [Controller packaging & install story](https://github.com/rogierpennink/hydra/issues/24)
- [Research: smoothest Connection-setup path](https://github.com/rogierpennink/hydra/issues/32)
- [Controller promotion & portability](https://github.com/rogierpennink/hydra/issues/10) (the "local" alias handoff)
- [Controller/runner architecture](https://github.com/rogierpennink/hydra/issues/7) (fleet screen constraints)
- [Triage engine & user-set bounds](https://github.com/rogierpennink/hydra/issues/15) (notification sink, breaker resume)
- [Agent-operates-system surface](https://github.com/rogierpennink/hydra/issues/16) (contract package)
- [Security & secrets model](https://github.com/rogierpennink/hydra/issues/18) (user auth, escalation UX)
- [Assistant design](https://github.com/rogierpennink/hydra/issues/17) and [Prototype: assistant memory interface](https://github.com/rogierpennink/hydra/issues/31) (web chat, memory editing)
- [Assemble the v1 spec](https://github.com/rogierpennink/hydra/issues/21) (Intake model requirements)

ADRs:

- [ADR 0017 - The web app is a static pure client of the public API](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)
- [ADR 0013 - Agents operate Hydra through the public API](../adr/0013-agents-operate-hydra-through-the-public-api.md)
- [ADR 0012 - Notifications are core-routed, sinks are dumb](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md)
- [ADR 0009 - All events flow through one persisted pipeline](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)
- [ADR 0004 - Controller state lives in one SQLite database](../adr/0004-controller-state-lives-in-one-sqlite-database.md)
- [ADR 0018 - Hydra ships as one self-contained binary](../adr/0018-hydra-ships-as-one-self-contained-binary.md)
