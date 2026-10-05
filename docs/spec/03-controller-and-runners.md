# Controller and Runners

The controller is the single brain: it holds all domain state, interprets execution plans, schedules steps, and decides where sessions run. Runners are daemons on machines that host sessions and workspaces on the controller's behalf and own only material state (files, provider-native session data, an event outbox). This document specifies the split between the two, the protocol they speak, how a runner joins and leaves the fleet, how work is placed, what a runner executes sessions in and how it provisions and tears down workspaces, and how the controller itself moves to another machine (promotion). Rationale lives in [ADR 0002](../adr/0002-orchestration-stays-on-the-controller.md), [ADR 0003](../adr/0003-sessions-run-as-bare-processes.md) and [ADR 0005](../adr/0005-promotion-is-migration-behind-a-stable-controller-identity.md).

## 1. The controller/runner split

### 1.1 What lives where

| Concern | Owner |
|---|---|
| Domain state: Tasks, Runs, Sessions as records, Workflows, Subscriptions, event log, queued input, queues and scheduling rows, capability snapshots | Controller ([04-state-store](./04-state-store.md)) |
| Run orchestration: interpreting execution plans, scheduling steps, placement decisions | Controller |
| Material state: workspace files, checkouts, bare caches, provider-native session data (transcripts, provider homes), the event outbox, process logs | Runner disk |
| Runner-local paths | Runner; opaque to the controller, keyed by id |

The unit of placement is the Session and the Workspace. Runners never interpret execution plans; plan-shipping to runners is a possible later optimization enabled by protocol capability negotiation (section 2.2), not v1.

Runners are semi-stateful: wiping a runner loses its workspaces and the resumability of its sessions, never history. The controller's normalized session streams remain the observable record ([06-providers](./06-providers.md)).

### 1.2 Disconnect semantics

A runner that loses its controller connection stays autonomous: its running sessions continue, their events buffer in the disk outbox, and everything replays on reconnect. Plan progression waits for the controller: a step cannot complete, and no new step can start, while the controller cannot see the runner.

### 1.3 Ids cross the boundary, paths do not

The controller authors a `SessionSpec` that carries `workspaceId` (or `null` for a workspace-less session), never a path. The runner's session supervisor resolves the id to a directory and hands the adapter a `ProviderRunnerContext` (cwd, session env, provider home, harness binary - the facts the runner resolved for this session on this machine); the adapter never sees workspace ids and the controller never sees paths. Full shapes in [06-providers](./06-providers.md).

## 2. The runner protocol

### 2.1 Transport

- The runner dials the controller and holds one persistent WebSocket. Runners accept no inbound connections from the controller.
- The controller MUST be reachable by every runner (LAN, tailnet, or public address; the user's choice). Reachability tricks such as pairing codes, tunnels and short-lived WS tickets belong to client-to-controller connections ([14-web-app](./14-web-app.md)), not to this link.
- The runner authenticates with its durable per-runner credential (section 3.2). The runner authenticates the controller's logical identity (section 8.1), not its address.
- The local runner on the controller machine joins over a loopback WebSocket as a supervised child process of the controller (`hercule runner --local`); it is an ordinary fleet member with no special code path ([15-packaging-and-operations](./15-packaging-and-operations.md)).

### 2.2 Framing and hello

- Messages are versioned typed JSON.
- The first exchange on every connection is `hello`. It carries, in both directions: the protocol version, the negotiated capability list (the protocol's extensibility seam: later features such as plan-shipping or OS sandboxing are advertised here and used only when both sides list them), and, from the runner, its probed facts (section 4).
- The hello exchange settles protocol compatibility. A hard refusal happens only on protocol incompatibility; any other version skew between controller and runner is warn-don't-block (section 2.4).

*(Amended 2026-09-05, [#61](https://github.com/theagenticage/hercule/issues/61).)* The catalogue is **two tagged unions in `@hercule/protocol`, in Effect Schema**, and `PROTOCOL_VERSION` is ~~**1**~~ ~~**2**~~ **3** *(amended 2026-10-05, [#431](https://github.com/theagenticage/hercule/issues/431), then [#435](https://github.com/theagenticage/hercule/issues/435))*. Runner to controller: `RunnerHello { protocolVersion, capabilities, binaryVersion, nonce, facts }`, `Pong`, `FactsReport { facts }`, `WatermarkReport { watermark }`, `Goodbye`. Controller to runner: `ControllerHello { protocolVersion, capabilities, identityId, publicKey, nonce, signature }`, `Ping`, `Ack { lastAckedSeq }`.

*(Amended 2026-09-07, [#65](https://github.com/theagenticage/hercule/issues/65).)* Sessions add five frames. Controller to runner: ~~`SessionStart { sessionId, providerId, config, spec }`~~ `SessionStart { requestId, sessionId, input, providerId, config, spec }` *(amended 2026-10-05, [#431](https://github.com/theagenticage/hercule/issues/431))* (the instance's decoded config rides it, the way a probe's does, because the runner holds no Hercule state), `SessionStop { sessionId }`, `SessionInput { sessionId, input }`. Runner to controller: `SessionEvent { seq, event }`, one normalized event from [./06-providers.md](./06-providers.md) section 6, and `SessionsReport { sessions }`, the bindings `listSessions` found. Probes, installs and logins already ride request ids; sessions ride the session id instead, because a session outlives the exchange that started it. A refused hello is a WebSocket close carrying a reason, never a message. The credential rides the socket upgrade as `Authorization: Bearer`, so no hello carries one; the controller's answering signature is over the runner's id and nonce together, so a signature obtained on one connection is worthless on another.

*(Amended 2026-09-08, [#66](https://github.com/theagenticage/hercule/issues/66).)* Sessions add two more frames and one field. Controller to runner: `SessionInterrupt { sessionId }`, which ends the running turn; and `SessionInput` gains `requestId`, which is the Queued Input row's own id ([02-domain-model.md](./02-domain-model.md) Queued Input) rather than a second identifier for the same thing. Runner to controller: `SessionInputResult { requestId, ok, delivery?, message? }`, the answer saying whether that input opened a turn or steered one - the only authority on it ([./06-providers.md](./06-providers.md) section 5). It reuses the request/response the controller already has for probes, installs and logins, and follows the `ok`-plus-optional-message shape those two answers use; it carries no turn id, because nothing on the controller reads one and the turn arrives on `turn.started` anyway. `SessionInterrupt` and `SessionStop` stay fire-and-forget: their outcome is observable in the session's own stream (`turn.completed { state: "interrupted" }`, `session.exited { reason: "stopped" }`), so a second answer channel would carry nothing.

*(Amended 2026-09-12, [#162](https://github.com/theagenticage/hercule/issues/162).)* A resume rides the existing `SessionStart` for the same `sessionId`, with `spec.continue = { nativeSessionId, mode: "resume" }`, the session's current `modelSelection`, ~~and a fresh token~~ a fresh token, and the input that caused the resume *(amended 2026-10-05, [#431](https://github.com/theagenticage/hercule/issues/431))*; no new frame.

*(Amended 2026-10-04, [#75](https://github.com/theagenticage/hercule/issues/75).)* `SessionStart` gains the flag `userMaterial?: true`. The controller sets it only for a Thread placed on its local runner, which it knows from the id its child reported (section 3.4), so nothing new is persisted. The runner then shows the Thread the user's own skills and instructions ([06-providers](./06-providers.md) section 9.1 User Material). The flag carries no path, and the runner follows it without knowing whether it is the local runner, so the local runner keeps no special code path. The controller builds the frame afresh at every start, so a resume or a fork carries it again. A runner that does not know the flag ignores it and runs the Thread plain.

*(Amended 2026-10-05, [#431](https://github.com/theagenticage/hercule/issues/431).)* **`SessionStart` carries the session's first input**, for a fresh start and for a resume. `input` is a `TurnInput`, the same shape `SessionInput` carries, and `requestId` is the id of the Queued Input row it came from: the session's oldest waiting row, which the controller claims in the transaction that dispatches the start ([./06-providers.md](./06-providers.md) section 4.2). No start or resume is sent without one. The runner starts the harness, hands it the input, and answers with `SessionInputResult` under `requestId`, the same answer a `SessionInput` gets. It answers on every path: a start that fails before the harness took the input, a stop that arrives during the start, and a runner shutdown all answer the input refused, and a duplicate start for a session the runner already holds answers its input refused rather than delivering it twice. The controller waits for the answer with no deadline; the wait ends at the answer or when the runner's connection ends. `PROTOCOL_VERSION` goes from 1 to 2 with this change, so a runner on protocol 1 is refused at hello until it is upgraded (section 2.4).

*(Amended 2026-10-05, [#431](https://github.com/theagenticage/hercule/issues/431).)* **The runner keeps each session's frames in order, and nothing else waits for them.** A start now runs until the harness has its input, which can take as long as the harness takes to come up, so it must not hold up the rest of the connection:

- The frames of one session (`SessionStart`, `SessionInput`, `SessionInterrupt`, and the answers to its approval requests and questions) are handled one at a time, in the order they arrived. A `SessionInput` sent right after a `SessionStart` is handed to the harness after the start's input, never refused because the session is not up yet.
- Frames of different sessions are handled at the same time, so one slow start never delays another session.
- `Ping` is answered at once, and so are the frames that are not about a session. A slow start can never make a healthy runner miss the silence threshold (section 7).
- `SessionStop` does not wait behind its session's frames, and no frame waits behind it. It takes effect the moment it arrives, at any point of a start, so a start that has not handed over its input yet answers that input refused ([./06-providers.md](./06-providers.md) section 4.2). A start the stop reaches before it has spawned the harness spawns none, and reports `session.exited` with reason `stopped` itself. A `SessionInput` handled after the stop has arrived, including one still waiting behind earlier frames of the session, is refused without reaching the harness. An input refused this way does not restart the idle wait (section 6.2), because the session is already stopping.
- The controller can send a `SessionStart` for the same session right after a stop: when a sessions report lists a session the controller holds as `exited`, it sends `SessionStop`, and a resume can queue the session again before the old process is gone. A start that finds its session still held by the adapter, with a stop requested, waits until the old harness has exited, for at most 30 seconds, instead of being refused as a duplicate, and the earlier stop does not stop it. If the old harness is still running after that bound, the runner logs a warning and refuses the new start's input as still stopping. The controller puts that input back to waiting, like any refused input ([./06-providers.md](./06-providers.md) section 4.2), and the old harness's exit, when it comes, ends the session.

*(Amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257); [ADR 0035](../adr/0035-an-action-declares-where-it-runs.md).)* **Workspace steps add four frames.** A workspace step is a step of a run whose action runs in the run's workspace on a runner, such as `git.commit` ([./07-workflows.md](./07-workflows.md) section 4.4). Every frame names its step by the **step key** `{ runId, stepId, iteration }`.

- Controller to runner: `WorkspaceStepStart { runId, stepId, iteration, workspaceId, action, input, resourceId?, gitIdentity? }`. It carries everything the runner needs, because the runner holds no Hercule state: the action's id, its `input` as the controller stored it on the step record, the checkout to work in when the workspace has more than one, and who a commit is made as (the workspace's designated Connection, as `SessionStart` carries it; absent when no Connection backs the workspace).
- Controller to runner: `WorkspaceStepSettle { steps }`: the controller no longer owes these steps, because their records have ended. Settling a step means more than stopping it: the runner stops the step if it is still running, deletes its result file, and remembers its key so a start of it that arrives late is ignored. There is no reply. The controller sends it when a run ends with a workspace step running, once it has recorded a step's result, and for every reported step whose record has ended.
- Runner to controller: `WorkspaceStepResult { runId, stepId, iteration, outcome }`, sent once the step has finished. `outcome` is `{ status: "completed", output }` or `{ status: "failed", code, message }`. `code` is one of `action_failed` (the action ran and failed), `timeout` (it ran past its deadline and was stopped), `unsupported_action` (this runner's build does not implement it) and `interrupted` (it was stopped before it finished).
- Runner to controller: `WorkspaceStepsReport { steps }`: the steps the runner is running now, sent on connect like `SessionsReport`. The controller settles each one whose record is no longer `running`.
- A frame lists at most 256 step keys, which only refuses a nonsense frame.

Delivery is idempotent by the step key, not sequenced. The controller sends a `WorkspaceStepStart` again whenever it cannot know whether the runner has the step: on every connect, for every workspace step still `running` in a run pinned to that runner. The runner ignores a repeated start while the step runs, answers it with the stored result once the step has finished, and runs it only when it has no trace of it. So a result lost with a dropped socket is answered again on the next connect. While the run's workspace is still `provisioning`, the controller sends the workspace's provision frame before the start. It rebuilds that frame from the workspace's rows, the checkout's base branch included, so a repeated provision is identical to the first. The runner keeps each step's result in a file outside every checkout, `<runner storage>/step-results/<workspaceId>/<runId>-<stepId>-<iteration>.json`, so a commit never picks it up. The files of a workspace are deleted when the workspace is disposed. A primary workspace is never disposed, so there a step's file is deleted once the controller no longer owes the step: the report's answer shows its record ended, or a `WorkspaceStepSettle` for it arrives.

`PROTOCOL_VERSION` ~~stays 1~~ is 3 *(amended 2026-10-05: [#431](https://github.com/theagenticage/hercule/issues/431) raised it to 2 when a session's first input moved onto `SessionStart`, above, and [#435](https://github.com/theagenticage/hercule/issues/435) to 3 for subagents, below)*. The frames are sent only to a runner that implements them; [#258](https://github.com/theagenticage/hercule/issues/258) makes that a checked rule, with the workspace actions a runner lists at hello (section 2.2's capability list).

*(Amended 2026-09-25, [#258](https://github.com/theagenticage/hercule/issues/258).)* **The capability list holds one capability per workspace action**, spelled `action:<id>`, for example `action:git.commit`. `buildWorkspaceActionCapability` in `@hercule/protocol` is the one place that spelling is written.

- The runner lists one for each workspace action its build implements, derived from its own registry of workspace actions.
- The controller lists one for each workspace action in its catalog (every action with `runsIn: "workspace"`), derived from the catalog.
- Neither list is kept by hand. The controller stores the intersection as the runner's `negotiatedCapabilities`, as before, so a runner on an older build negotiates only the workspace actions it has.
- Run pinning reads the negotiated list (section 5.1). The runner's `unsupported_action` answer stays as the last line of defence.

Versions are still not compared, and section 2.4 is unchanged: the only hard refusal at hello is an incompatible protocol version. A runner that lacks a workspace action stays online and takes every other placement.

*(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* **A device-code login reports its end.** A device-code login (Codex's `codex login --device-auth`, section 3.3) is finished in the user's browser, so nothing comes back through Hercule. The runner reports when the vendor's login ends, and the controller probes the instance again.

- The runner's `LoginUrl` answer gains `expiresInSeconds?`: how long the printed code still works, counted from when the vendor printed it, a whole number of seconds from 1 to 86400 (one day). A frame with any other value does not decode, and the controller closes the socket as it does for any unreadable frame. It is present only with `userCode`. The runner keeps a device login for 15 minutes, the lifetime of Codex's code. The runner sends a duration and not an instant, so the two machines' clocks never meet. The controller turns it into `provider.login`'s `expiresAt` on its own clock ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 4).
- Runner to controller: ~~`LoginEnded { instanceId }`~~ `LoginEnded { requestId }`. *(Amended 2026-10-03, [#313](https://github.com/theagenticage/hercule/issues/313).)* `requestId` is the request id of the `LoginStart` that started the login, so the frame names one login rather than an instance. Two logins on one instance can overlap, for example when a second login is refused or gets no answer while the first is still running, and the controller must tell their ends apart. The controller knows each login's instance, so the frame does not carry it. It is sent when a device-code login's child exits by itself, whether the login worked or not, and when the code's lifetime runs out. It is not sent when the login is replaced by a new one, when the runner stops, or for a paste-a-code login, whose end the controller already sees in the `provider.submitLoginCode` answer.
- On `LoginEnded`, the controller probes the login's instance on that runner. The probe stores the snapshot and announces `provider` / `updated`, which is how a client learns the login finished. The controller reads `LoginEnded` only for a login it started on that runner through `provider.login`, ~~for that instance~~ matched by request id and runner, and not replaced since by a newer login on that runner and instance whose URL came back *(Amended 2026-10-03, [#313](https://github.com/theagenticage/hercule/issues/313).)*, and only once per login; any other `LoginEnded` is logged and ignored, and the connection stays open. At most one such probe runs per runner and instance: a login that ends while the probe runs causes one more probe after it.
- **This amends the capability list above: it also holds `loginEnded`**, the one capability that is not a workspace action. Both sides list it: each derived list gains this one fixed entry. The runner sends `LoginEnded` only when the controller's hello lists it, because an older controller closes the socket on a frame it does not know. A report lost while the socket is down needs no replay: the controller probes every instance when the runner connects.

*(Amended 2026-10-05, [#355](https://github.com/theagenticage/hercule/issues/355); [#351](https://github.com/theagenticage/hercule/issues/351), [#353](https://github.com/theagenticage/hercule/issues/353); [ADR 0038](../adr/0038-a-subagent-is-part-of-its-session-not-a-session.md).)* **Subagents add no frame; three frames gain a field.**

- `SessionEvent` carries events that name a subagent: `subagent.started`, and an optional `subagentId` on the events of [./06-providers.md](./06-providers.md) section 6. The frame itself is unchanged.
- `SessionInterrupt` gains `subagentId?`: stop that subagent and every subagent below it, and leave the rest of the session running ([./06-providers.md](./06-providers.md) section 13.4). Without it, the frame ends the turn of the session's own agent as before.
- `SessionStart`'s `spec.continue` gains ~~`subagents?: { subagentId, itemId? }[]`~~ `subagents?: { subagentId, itemId?, parentSubagentId? }[]` on a resume: the subagents the session already has, so the adapter can match a subagent the harness continues to the record the controller holds ([./06-providers.md](./06-providers.md) section 13.2). *(Amended 2026-10-05, [#436](https://github.com/theagenticage/hercule/issues/436): the adapter's stop cascade needs the tree.)* `parentSubagentId` is the subagent that started it, absent when the session's own agent did, so an interrupt of a continued subagent also stops the continued subagents below it. The field is optional and needs no new `PROTOCOL_VERSION`: a runner that drops it only fails to stop a continued nested subagent with its continued parent, and a runner that gets no parent treats the subagent as one the session's own agent started. Neither acts on the wrong agent, the reason for the bump below.
- **`PROTOCOL_VERSION` goes up by one**, and a runner on the old version is refused at hello with a message that says to upgrade it, the exception to section 2.4 that [#431](https://github.com/theagenticage/hercule/issues/431) also takes. A capability with a fallback would not be safe in either direction:
  - a runner that does not know `subagentId` on `SessionInterrupt` drops it and stops the whole turn of the session's own agent, where the user asked to stop one subagent;
  - a controller that does not know `subagentId` on an event drops it and books a subagent's turn to the session's own agent, so the session's status, its Requests and an assistant's reply follow the wrong agent without any error.
  ~~If [#431](https://github.com/theagenticage/hercule/issues/431) and this change ship in one release, they share one bump.~~ [#431](https://github.com/theagenticage/hercule/issues/431) shipped its bump alone, to 2 *(amended 2026-10-05, [#83](https://github.com/theagenticage/hercule/issues/83))*. *(Amended 2026-10-05, [#435](https://github.com/theagenticage/hercule/issues/435).)* Every push to `main` publishes an `edge` build, so a runner on version 2 can exist. This change takes version 3, and a runner on version 2 is refused at hello like one on version 1.

*(Amended 2026-10-04, [#83](https://github.com/theagenticage/hercule/issues/83).)* **Agent steps ride the session frames and the workspace step frames.** An agent step is a Session, and the engine treats it as a workspace step ([./07-workflows.md](./07-workflows.md) section 4.2).

- **`TurnInput` gains `step?: { runId, stepId, iteration }`**, the step key. The controller sets it on the input that carries a step's prompt, the first one and each later iteration. A turn whose input has no step key is an ordinary turn and gives no step result.
- **The runner decides the step's result when that turn ends**, and sends it as a `WorkspaceStepResult`. It saves the result first, in the same store as a workspace action's. A step whose session has no workspace uses a fixed folder in place of the workspace id. The controller completes the record and settles the step, and the runner deletes the file, as for `git.commit`.
- **`WorkspaceStepStart` is a union of two variants.** The `action` variant is the frame above; its `kind: "action"` may be left out, so an older controller's frame still decodes. The `agent` variant is `{ kind: "agent", runId, stepId, iteration, sessionId, workspaceId | null }`. The prompt rides the session's input, so the agent variant only asks the runner for the step's result. *(Amended 2026-10-05, [#83](https://github.com/theagenticage/hercule/issues/83).)* `sessionId` names the step's session, and the runner handles the request as a frame of that session: after every frame of the session that arrived before it (above), while the `action` variant is still handled at once. So the request never overtakes the input that carries the step's prompt. The controller sends it at once when a step prompt goes unanswered (below), and on connect for each `running` agent step whose prompt is `sent` or `delivered`. The runner answers:
  - with the saved result, when the turn has ended;
  - when the turn ends, when it is still running;
  - with `interrupted`, when it has no trace of the turn, for example after the runner restarted. The step fails with `session-failed`, and the turn is not run again.
- ~~**A step prompt sent again never runs a second turn.** The controller sends a queued input again when it cannot know whether the runner took it, for example after its answer was lost with a dropped socket. When a `TurnInput` arrives whose step key the runner already knows, the runner does not run it: it sends the step's result again if it has one, and answers the input `{ ok: true, delivery: "steered" }`. So the input is marked delivered, and the step completes once.~~ *(Amended 2026-10-05, [#83](https://github.com/theagenticage/hercule/issues/83).)* **A step prompt is never sent again once it may have reached the harness.** A step prompt leaves the controller on a `SessionInput`, or as the first input of the `SessionStart` that starts or resumes the step's session. Once it has left, only the runner's answer about the step settles it: the saved result, the turn's end, or `interrupted`. When no `SessionInputResult` comes back, because a `SessionInput`'s deadline passed, the runner's connection ended or the controller restarted, the controller cannot know whether the runner took the prompt. It marks the prompt `sent` and does not send it again, because a second turn could push or comment a second time. It does not fail the step. Instead it asks the runner for the step's result right away, with the `agent` variant of `WorkspaceStepStart`. When the runner has no connection, nothing is sent, and the controller asks when the runner connects. A controller that restarted marks every step prompt that was on the wire `sent` at boot, and asks the same way. The request waits behind the prompt among the session's frames, so the runner answers it only after it has dealt with the prompt:
  - **The runner took the prompt.** It answers with the step's result when the turn ends. If its answer to the prompt (`ok: true`) arrives late, the prompt is marked `delivered`.
  - **The runner refused the prompt late** (`ok: false`). The prompt stays `sent`, and the controller sends nothing more. The runner ran no turn for the prompt and kept no trace of the step, so it answers the waiting request `interrupted`, and the step fails with `session-failed`. This is an accepted trade: `sent` stays final rather than going back to `queued`, and the failed step is visible and can be rerun.
  - **The prompt never reached the runner**, or the runner restarted since. It has no trace of the turn, answers `interrupted`, and the step fails with `session-failed`.

  The controller may ask twice for one step, once when the prompt goes unanswered and again on connect. That is harmless: the runner answers both the same way, and the controller ignores a result for a step it has already settled.

  A prompt the runner refuses (`ok: false`) while the controller still waits for the answer never reached the harness, so it is queued again and sent again like any refused input. A prompt the controller could not send at all, because the runner had no connection, never left the controller: it stays `queued`, is sent when the runner connects, and the runner is not asked for the step's result. The connect does not ask about a prompt that is still on the wire either: it is `queued` too, and its send asks by itself if no answer comes. The runner keeps no record of the step inputs it has seen. It runs every step input it receives, except the prompt of a step the controller has already settled: when the run ends just as the controller sends a step's prompt, the step's `WorkspaceStepSettle` can reach the runner first. The runner then answers the input `{ ok: false }` and never passes it to the harness, because a turn of a run that has ended could still push or comment. A `SessionStart` that carries such a prompt still starts the session and refuses only the prompt, as it refuses any start's input it cannot deliver; the session then has no turn and unloads after its idle wait, if the run's `SessionStop` has not stopped it first. The controller cancels a refused step prompt whose run has ended, rather than putting it back to wait. The run's end already settled the step, and a prompt left waiting could resume the step's session after an exit that keeps it, such as a runner restart, on a runner that no longer knows the step is settled. Example: `run.cancel` commits while the prompt is on the wire; the runner refuses the prompt and runs no turn, the controller cancels the prompt, and the `SessionStop` it sent for the run's end makes the session exit.
- **`WorkspaceStepResult`'s failure codes gain two**, for agent steps. `schema_failure`: the step has an `outputSchema` and the turn gave no valid structured result. `session_failed`: the turn failed or was interrupted, or the session exited, crashed, timed out or was stopped during the turn; the message names which.
- **Agent steps do not wait for the workspace.** The runner runs a workspace's action steps one at a time, but not its agent steps, because parallel sessions may share one workspace. Only a session start that switches a main workspace's branch waits, and only for the switch: it takes its turn among the workspace's action steps, so the two never meet on git's `index.lock` ([./07-workflows.md](./07-workflows.md) section 4.4).
- **This amends the capability list above: it also holds `agentSteps`**, `AGENT_STEPS_CAPABILITY` in `@hercule/protocol`. A runner lists it when its build can run an agent step. The controller pins a run with an agent step only to a runner whose negotiated capabilities hold it (section 5.1). `PROTOCOL_VERSION` ~~stays 2~~ does not change for agent steps *(amended 2026-10-05, [#435](https://github.com/theagenticage/hercule/issues/435): subagents raised it to 3, above)*: `step` is optional, so every runner on protocol 2 or later still decodes a `TurnInput`. A runner built before agent steps drops the `step` it does not know and would run a step prompt as a plain turn that gives no result. The capability keeps every agent step off such a runner, and the runner stays online for every other placement, as section 2.4 wants.

### 2.3 Sequencing, acks and the outbox

- Every runner-to-controller event carries a monotonic sequence number. The controller acknowledges sequence numbers.
- The runner keeps a disk-backed outbox of unacknowledged events. On reconnect it replays everything after the last acknowledged sequence number. This is the only disconnect buffer; there is no separate replay protocol.
- The runner reconnects with exponential backoff, 1 s doubling to a 30 s cap, retrying forever. The backoff resets to zero on an OS wake or network-change signal, so a laptop lid-open reconnects immediately.
- Seq/ack state is keyed by the controller's logical identity, so it survives the controller changing address (section 8).
- Controller-to-runner traffic on the same socket includes placement commands (start, resume, fork, stop, interrupt a session; provision or tear down a workspace), input delivery (queued input flushed on `turn.completed`, a session's first input carried by its start *(amended 2026-10-05, [#431](https://github.com/theagenticage/hercule/issues/431))*, and steering, both controller-owned domain state riding this channel; *(amended 2026-09-26, [#92](https://github.com/theagenticage/hercule/issues/92))* steering is a guarantee of every session: where the provider cannot steer, the controller sends `SessionInterrupt` and delivers the input as the next turn, and a conversation's session keeps its waiting input through an exit and is resumed for it, [./06-providers.md](./06-providers.md) section 5), approval decisions, probe requests, the reachability probe used during promotion (section 8.2), and the remote upgrade command (section 2.4).

~~**Open:** the ticket material pins the hello exchange, seq/ack and the outbox, but not the full message catalogue (names, payloads, error shapes) of the controller-to-runner and runner-to-controller messages. The implementer defines it as one versioned schema in the shared `protocol` package, in Effect Schema ([ADR 0031](../adr/0031-the-backend-is-written-on-effect.md)).~~ *(Resolved 2026-09-05, [#61](https://github.com/theagenticage/hercule/issues/61): the catalogue is written out in section 2.2 and the shapes it carries in section 4.)*

*(Amended 2026-09-05, [#61](https://github.com/theagenticage/hercule/issues/61).)* Two parts of this section are **deferred to the ticket that ships the first replayable runner event**, with the sessions work: the disk-backed outbox and its replay, and the reconnect reconciliation exchange below. Nothing a runner produces before then survives a disconnect worth replaying - facts and the watermark are latest-wins state (section 4) - so both would ship as mechanism with no consumer. What is frozen now is the wire: `Sequenced { seq }` and `Ack { lastAckedSeq }` are in the schema. *(Amended 2026-09-07, [#65](https://github.com/theagenticage/hercule/issues/65): `SessionEvent` is the first frame to extend `Sequenced`. The monotonic seq and the controller's idempotent insert on it ship with it; the disk-backed outbox and the reconnect reconciliation exchange stay deferred, so an event produced while the socket is down is still lost.)* The rule behind the reconciliation exchange holds from the start: no per-runner command queue is persisted anywhere.

*(Amended 2026-09-05, [#61](https://github.com/theagenticage/hercule/issues/61).)* The **reconnect signal** the backoff resets on comes from one source the reconnect loop subscribes to, so a platform daemon can replace or join it later without touching the loop. v1's source is a heuristic, because no portable wake or network-change API exists: a timer scheduled for one second that fires far later means the machine slept, and a changed `os.networkInterfaces()` address set means the network changed. A connection that held past the 30 s cap also restarts the schedule.

**Command delivery across a disconnect is reconciliation, not a command queue** (resolved 2026-08-31, [#43](https://github.com/theagenticage/hercule/issues/43)). The controller's domain state *is* the intent: a Session in `starting`, a Workspace in `provisioning`, queued input rows. Commands carry an id and are idempotent. On every reconnect - the same exchange as after a runner restart (section 6.2) - the runner reports what it actually has and the controller re-issues whatever its domain state says should exist but does not; a duplicate command for work the runner already has is a no-op. *(Amended 2026-10-05, [#431](https://github.com/theagenticage/hercule/issues/431).)* A duplicate start is still a no-op, and the runner answers the input it carries refused, so that input is never delivered twice. There is no persisted per-runner command queue: a second queue would be a second source of truth for the same intent.

### 2.4 Fleet version skew

- Controller and runner ship as the same binary ([15-packaging-and-operations](./15-packaging-and-operations.md)); skew is expected and surfaced, never hidden.
- Policy is warn-don't-block: a runner on a different binary version stays online and accepts placements; the fleet UI shows the skew. The only hard refusal is protocol incompatibility at hello.
- The controller can upgrade a runner remotely with one WS command that reuses the runner's own self-update path. Upgrade the controller first, then runners, as a UI-nudged convention.
- Provider harness versions differ per runner as well; that skew is a fact in the capability snapshot (section 4.2), not a protocol concern.

*(Amended 2026-10-05, [#431](https://github.com/theagenticage/hercule/issues/431).)* Putting a session's first input on `SessionStart` raised `PROTOCOL_VERSION` from 1 to 2 (section 2.2), so a runner on protocol 1 is refused at hello and stays offline until it is upgraded. This is a deliberate exception to warn-don't-block: the change could have been a capability with a fallback for older runners, but an older runner would decode the new `SessionStart`, drop the input it does not know, and start a session with nothing to do. Nobody runs a fleet yet, and one delivery path is simpler than two. The policy above is unchanged for any other skew.

*(Amended 2026-10-05, [#435](https://github.com/theagenticage/hercule/issues/435).)* Subagents raised `PROTOCOL_VERSION` from 2 to 3 (section 2.2) under the same exception, because a runner or a controller that drops `subagentId` would act on the wrong agent without any error. A runner on protocol 2 is refused at hello and stays offline until it is upgraded.

## 3. Registration and join

### 3.1 The join exchange

1. The user mints a single-use join token in the web app or the ops CLI.
2. On the new machine the user runs one command: `hercule runner join <controller-url> --token <token>`.
3. The exchange upgrades the token to a durable per-runner credential. It is fully programmatic: no interactive prompts, so a future auto-installer can drive it end to end. A one-line installer is acceptable in v1.
4. Join then installs the provider CLIs (section 3.3) and registers the machine's service unit by default (`--no-service` skips it; [15-packaging-and-operations](./15-packaging-and-operations.md)); a `--reserved` flag marks the runner reserved (section 5.5). A provider-CLI install failure never fails the join: the harness simply reports as absent in the runner's facts, with an "Install" retry in the fleet UI.
5. The controller records the new runner (identity, credential, name, probed facts) and the runner appears in the fleet as `online`.

The fleet UI reserves an "Add machine" spot showing the join command with a freshly minted token; fleet auto-discovery and push-install are post-v1.

*(Amended 2026-09-07, [#64](https://github.com/theagenticage/hercule/issues/64).)* Step 4 no longer installs the provider CLIs. Installing a harness is the user's decision per machine and per harness - a user with only a Claude subscription has no use for a Codex binary - so it is an **Install** action on the runner's fleet page and nothing else. Join stays prompt-free and installs nothing; a machine with no harness reports it as absent in its facts, which is what puts the Install button in front of the user.

The join token is single-use and expires after **1 hour**. Outstanding tokens are listable and revocable, and the "Add machine" spot mints a fresh one each time it is opened, so an expired token costs one page refresh.

### 3.2 What the runner sets up on enrollment

- A random storage directory for all its workspaces, caches and other material state, under the runner area of Hercule Home (`~/.hercule/runner/`, [15-packaging-and-operations](./15-packaging-and-operations.md)). A re-enlisted machine therefore never overwrites a previous life's folders. Legacy folders from earlier lives MAY surface very discreetly in the UI for manual recovery; Hercule never adopts them automatically.
- Its durable credential: an opaque random token, stored locally on the runner in `~/.hercule/runner/runner.json` (mode 0600, alongside the controller URL, the controller's logical identity and public key, and the storage-directory name; [15-packaging-and-operations](./15-packaging-and-operations.md)) and stored hashed on the controller ([13-security](./13-security.md)). It is not a secrets-table entry.
- A name. The controller MAY auto-assign a fun name (mythological names are the suggested scheme); the user can rename at any time.

### 3.3 Provider CLIs and login

Hercule installs the provider CLIs (Claude Code, Codex, pi: one command each) on request from the runner's fleet page - not at join, amended 2026-09-07 in section 3.1 - and installs nothing else: everything else on the machine is the owner's responsibility and is probed, not installed (section 6.6).

Provider credentials are never distributed by Hercule. Hercule drives each provider's own headless login on the runner and relays the login URL or device code to the user's browser wherever they are; the vendor CLI stores its own credential on that runner. Copying a credential file onto a runner is a bootstrap shortcut the user may take; from then on that credential belongs to exactly one runner, because refresh-token rotation with reuse detection makes shared credentials log each other out. The per-provider login flows and their fallbacks are specified in [15-packaging-and-operations §12](./15-packaging-and-operations.md); provider-home isolation (one home per provider instance) in [06-providers](./06-providers.md); findings in `research/provider-portability.md` (branch `research/provider-portability`).

**Login is a post-join step driven from the fleet UI** (resolved 2026-08-31, [#43](https://github.com/theagenticage/hercule/issues/43)): login belongs to a provider *instance*, which is controller state the join command knows nothing about, and the auto-joined local runner exists before any user does. The runner's fleet page lists each provider instance x this runner with its auth state and a "Log in" action; clicking runs the vendor's headless login on that runner and relays the login URL or device code to the browser (Claude: paste-a-code; Codex: device code; pi: API key entry as the v1 path, terminal `/login` as the OAuth fallback - flows in [15-packaging-and-operations §12](./15-packaging-and-operations.md)). The same action serves re-login after expiry. The join exchange stays prompt-free.

### 3.4 The local runner

The default install starts an ordinary local runner, auto-joined at first boot, hosted as a supervised child process of the controller. It gets the same random storage directory, credential and states as any other runner ([15-packaging-and-operations](./15-packaging-and-operations.md)).

*(Amended 2026-09-05, [#61](https://github.com/theagenticage/hercule/issues/61).)* **Nothing persists which runner is local**; the child says who it is. Its first line on stdout is one JSON object: `{"runnerId": "<id>"}` when it holds a `runner.json`, `{"join": true}` when it does not. The controller writes a join token to stdin only in the second case and then closes it, holds the reported id in memory for as long as it holds the child, and never reads `runner.json`, which is the runner's. A first line of any other shape fails the boot step. The only persisted consequence of the first join is `defaultRunnerId`, taken by the fleet's first member. *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* After `{"join": true}` and a join that succeeded, the child writes a second line, `{"runnerId": "<id>"}` with the id the join gave it, so the controller knows its local runner from the first boot on rather than from the child's next start. The controller reads that second line only after a join request; every other line goes to its log. `controller.read` returns the id it holds as `localRunnerId`, read from the child on every call and still persisted nowhere: null until the child has said who it is, and null on a controller that starts no local runner.

## 4. Runner capabilities

A Runner Capability is a fact about a runner used for placement. Two kinds:

- **Probed facts**, self-reported by the runner at hello and refreshed on change: OS and architecture, RAM (feeds the session cap default), docker presence, toolchains (section 6.6), provider binaries and their auth state. Probing is credential-file-free: auth state comes from each provider's own side-effect-free probe, never from reading credential files. The controller never probes a runner actively.
- **Labels**, free-form strings the user applies to a runner (`gpu`, `office`, `fast-disk`). Labels are placement filters and nothing more.

### 4.1 Reporting

Probed facts are runner facts, not session events: they arrive in hello and in subsequent fact updates, not in a session's normalized event stream.

*(Amended 2026-09-05, [#61](https://github.com/theagenticage/hercule/issues/61).)* The two reports are **latest-wins state, sent unsequenced and never buffered**: a report older than the newest one is worthless, so one that finds no socket is dropped rather than queued. Their shapes, every size in bytes because the session-cap rule is arithmetic on them:

- `RunnerFacts { os, arch, totalMemoryBytes, docker: boolean, toolchains: [{ name, version, path }], providers: [{ name, present, path? }], identityPort }`. `identityPort` is a probed fact because only the runner knows which port it got (section 5.4).
- `RunnerWatermark { diskFreeBytes, availableMemoryBytes, acceptingPlacements: boolean }`, sent right after every hello and on the 60-second check.

The controller stores each whole, as one JSON document on the runner row, and hands it back on the fleet read. A toolchain whose `--version` cannot be parsed reports the raw string; one that is absent produces no entry and no error.

*(Amended 2026-09-10, [#67](https://github.com/theagenticage/hercule/issues/67).)* `RunnerWatermark` is `{ diskFreeBytes, availableMemoryBytes }`; ~~`acceptingPlacements: boolean`~~ leaves the wire. Whether a machine accepts placements is the controller's decision, made from the reported free bytes against a per-runner watermark it holds (10 GiB unless overridden by `runner.update { diskWatermarkBytes }`), checked at every placement and on every report. The `runner.placementsChanged` audit entry is recorded on the crossing, from a report or from an update.

### 4.2 Capability snapshots

Per provider instance x runner, the controller keeps a `CapabilitySnapshot` (auth state, harness version, model catalog). It is probed runner-side, side-effect-free, stored in the controller DB, and re-probed on interval, on demand, on config change and when the placement target changes. Shape and probe methods in [06-providers](./06-providers.md).

Probed facts refresh at hello, on demand ("Re-probe" on the runner page), and hourly; disk free and RAM ride the 60-second watermark check (section 6.2). (Resolved 2026-08-31, [#43](https://github.com/theagenticage/hercule/issues/43).)

## 5. Placement

### 5.1 Policy

Placement is deliberately dumb and runs in this order:

1. **Capability filter.** Runners lacking a required probed fact or label are excluded (e.g. an agent step requiring `git`, or a label the workflow names).
2. **Explicit choice.** If the request names a runner, use it - including a reserved one (section 5.5).
3. **Default runner.** Otherwise the fleet-level default runner. Never a reserved runner (the default runner cannot be flagged reserved).
4. **Controller's local runner.** If no default is set, the local runner on the controller machine - unless it is flagged reserved.

No load balancing, no migration, no failover.

*(Amended 2026-09-17, [#208](https://github.com/theagenticage/hercule/issues/208).)* Steps 3 and 4 are **not implemented as written**: a request that names no runner is placed on any placeable runner holding a logged-in snapshot for the instance, and neither the fleet default nor the controller's local runner is consulted. The ladder above is what the system is to do; tracked in [#210](https://github.com/theagenticage/hercule/issues/210).

*(Amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257).)* **Run pinning until the ladder is built.** A run is pinned to a runner in the transaction that starts its first workspace step ([./07-workflows.md](./07-workflows.md) section 4.4). Until [#210](https://github.com/theagenticage/hercule/issues/210) replaces it with the ladder above, the rule is:

- The run is pinned to a **placeable** runner: `online`, `active`, and not reserved. A reserved runner is never picked, because a run names no runner (section 5.5).
- For a `primary` policy, a placeable runner that already holds a `ready` main workspace of the policy's resource is preferred, so the run works in the clone the user already has there.
- When no runner is placeable, the step record stays `pending` and the run sleeps. It is not failed: the controller wakes every run that waits for a runner when a runner connects, and when a connected runner may have become placeable (it is undrained, no longer reserved, or given more room). [#258](https://github.com/theagenticage/hercule/issues/258) adds the capability part: a runner must also implement every workspace action in the plan.
- From then on the run is pinned, as section 5.2 says of any work: every later workspace step goes to the same runner. A run whose runner is `offline` or `unreachable` waits for it with no time limit. Cancelling the run, or retiring the runner, are the only ways out; retiring fails the run with `workspace-failed`.

*(Amended 2026-09-25, [#258](https://github.com/theagenticage/hercule/issues/258).)* **The capability filter in run pinning.** A run is pinned only to a runner whose negotiated capabilities (section 2.2) hold every workspace action in the plan, not just the one about to run, because every later workspace step goes to the same runner.

- **At `run.start`**, a plan whose workspace actions no runner that is neither retired nor reserved offers is refused with `validation`, naming the missing actions: "No runner can run git.commit; update a runner to this version." When each action is offered by some runner but no runner offers them all, every workspace action in the plan is named. An offline or draining runner still counts, because it may take the run later. A reserved runner does not count: a run names no runner, so it is never pinned to a reserved one (above), and counting one would let the run wait forever. A plan that only reserved runners offer is refused with the same message.
- A plan that some runner offers, but no placeable one, starts, and its step record stays `pending` until a capable runner is placeable, as above.
- **At pinning time**, if every runner that offered the plan's workspace actions has been retired or reserved since the run started, the run fails with `workspace-failed` at the step about to start, with the same message. Retiring a runner wakes every run waiting for a runner, so such a run fails at once rather than waiting for a runner that will never come.
- A run that is already pinned is not checked again. If its runner comes back on a build without the action, the runner answers the step with `unsupported_action`.

*(Amended 2026-10-04, [#83](https://github.com/theagenticage/hercule/issues/83).)* **Pinning a run with an agent step.** An agent step is a workspace step, so the run is pinned in the transaction that starts its first agent step or workspace action, by the rules above, with two more conditions on the runner:

- it hosts the provider instance of the step's Agent;
- its negotiated capabilities hold `agentSteps` (section 2.2).

A run with an agent step and no workspace policy is still pinned. Its sessions have no workspace, and all of them run on that runner.

### 5.2 Pin once landed

- A Workspace is pinned to the runner it was provisioned on.
- A Session is pinned to the runner it started on: provider session state lives on that disk. Resume and fork happen on the same runner.
- A session that names a workspace is placed on that workspace's runner; the filter and choice steps above apply only to the runner selection that happens before a workspace exists.

### 5.3 Per-runner session cap

- Each runner has `maxConcurrentSessions`. Default: derived from probed RAM at roughly one session per 2 GiB, floor 1. User-overridable per runner.
- A full runner queues its placements. Queued placements are visible in the UI. Work never spills to another runner.
- A runner below its disk-space watermark (section 6.2) also stops accepting placements; they queue the same way.
- Placements pinned to a runner that is `offline` or `unreachable` wait for its return.

*(Amended 2026-09-10, [#67](https://github.com/theagenticage/hercule/issues/67).)* The queue is the Session rows in status `queued`, oldest first; there is no separate placement-queue table. One dispatch function per runner moves them to `starting` when the runner is online, active, above its watermark and has a free slot, and runs after a spawn, a session exit, the runner's `sessionsReport`, a watermark report, a cap or watermark change, and undrain. A spawn or continue pinned to an offline or unreachable runner ~~waits for its return~~ succeeds immediately as `queued`. Retiring a runner ends its queued sessions.

### 5.4 The "local" alias

"Local" is a client-resolved placement alias meaning "the runner on the machine the user is operating". It is distinct from the default runner, is a UI convenience only, and is not offered when that machine has no runner. Resolution: the runner serves `GET /identity` on a loopback-only port it owns and reports as a probed fact (`identity.port`, default 4939; resolved 2026-09-01, [#45](https://github.com/theagenticage/hercule/issues/45)) and the client matches the returned id against online fleet runners; placement correctness never depends on this detection ([14-web-app](./14-web-app.md)).

When the operating machine has a runner, **threads default to "local"**: sessions the user opens from the client with no Agent behind them (Threads, [02-domain-model](./02-domain-model.md)) are placed on that machine's runner unless the user picks another, so working from a laptop feels like working locally. Workflow placements ignore this and use the default runner. Resolving the "local" alias counts as explicit choice for a reserved runner (section 5.5). (Resolved 2026-08-31, [#43](https://github.com/theagenticage/hercule/issues/43).)

### 5.5 Reserved runners

A runner may be flagged **reserved**: it hosts only work explicitly placed on it, and placement fallback never chooses it. Explicit means the request names the runner (a UI pick or a workflow's named runner), the client's "local" alias resolved it, or the placement follows a workspace already living there (pin-once-landed: the workspace's creation was itself an explicit act). The default-runner and local-runner fallback steps skip reserved runners, and the fleet default runner cannot be flagged reserved.

The flag exists for personal machines: a laptop joined as a runner should host "open this repo here", never a 3 a.m. cron routine that happened to fall through placement. Set it at join (`--reserved`; the "Add machine" spot offers a "Personal machine - only runs work you send to it" checkbox) or toggle it on the runner page at any time. The controller's auto-joined local runner is not reserved by default, so a single-machine install keeps hosting scheduled work.

## 6. Execution substrate

### 6.1 Bare processes

Sessions run as provider subprocesses directly on the runner, as the runner's OS user, cwd'd into their workspace. Linux and macOS runners only; no Windows in v1. No containers ([ADR 0003](../adr/0003-sessions-run-as-bare-processes.md)).

Isolation in v1 is provider-native mechanisms (Codex's sandbox, Claude Code's permission modes) plus Hercule's own access modes and approval flows ([06-providers](./06-providers.md), [13-security](./13-security.md)). Native OS sandboxing is post-v1 and returns as a probed capability behind hello negotiation.

Adapters run sessions in isolated provider homes, one per provider instance, so the machine owner's global instructions, skills and packages never leak into Hercule sessions ([06-providers](./06-providers.md)). *(Amended 2026-10-04, [#75](https://github.com/theagenticage/hercule/issues/75).)* A Thread on the controller's local runner is the one exception: it sees the user's own skills and instructions, the User Material of [06-providers](./06-providers.md) section 9.1.

Workspace-less sessions (`workspaceId: null`) get ~~`cwd: null` for Claude Code and pi. Codex alone gets a runner-provisioned scratch directory as its cwd, because `thread/start` needs one~~ ~~and instructions travel as `AGENTS.md` in it~~ *(amended 2026-10-04, [#75](https://github.com/theagenticage/hercule/issues/75), matching [06-providers](./06-providers.md) section 9.1 since [Assistant runtime](https://github.com/theagenticage/hercule/issues/40))* an empty runner-provisioned scratch directory as their cwd, on every harness. A `null` cwd would mean the runner's own cwd, and Claude Code and pi read instruction files from there; Codex needs a cwd anyway, because `thread/start` requires one. *(Amended 2026-09-30: instructions travel as `developerInstructions` on `thread/start`, `thread/resume` and `thread/fork` since [#68](https://github.com/theagenticage/hercule/issues/68), and the scratch directory stays empty; [06-providers](./06-providers.md) section 9.3.)* That directory is not a Workspace: it has no id, no status and no teardown rule beyond the runner deleting it when the session exits. [06-providers](./06-providers.md) uses the same words.

~~**Verify at build time:** confirm whether the Codex app-server protocol offers a better channel for instructions than `AGENTS.md` in a scratch cwd before relying on the scratch directory for workspace-less Codex sessions.~~ *(Answered 2026-09-14, [#73](https://github.com/theagenticage/hercule/issues/73): it does, `developerInstructions`.)*

### 6.2 Session supervision

The runner's session supervisor:

- Resolves `SessionSpec.workspaceId` to a directory and starts the session through the provider adapter with a `ProviderRunnerContext`.
- Injects the session's environment: `HERCULE_API_URL` and `HERCULE_TOKEN` (the session token minted by the controller at session start, dead when the session ends), `HERCULE_SESSION=1`, and the git credential configuration derived from the workspace's designated Connection (mechanics in [13-security](./13-security.md)). It makes the `hercule` binary reachable from the session (PATH prepend or absolute path: Open in [15-packaging-and-operations](./15-packaging-and-operations.md)) and materializes the shipped skill files ([11-public-api-and-agent-surface](./11-public-api-and-agent-surface.md)).
- Enforces two runner-owned timeouts, an inactivity timeout and an absolute timeout, since the harnesses have none built in. On expiry the runner stops the session and reports it as exited with the timeout as the reason (the reported outcome is this spec's consolidation; the tickets pin only the two timeouts).
- Enforces the session cap (section 5.3).
- Watches free disk space against a watermark; below it the runner reports itself as not accepting placements.
- Reconciles after a runner restart: it asks each adapter to list its live sessions and reports the outcome to the controller, so sessions the controller believes are running but the runner no longer has are marked exited.

There are no per-session CPU or memory caps.

Defaults (resolved 2026-08-31, [#43](https://github.com/theagenticage/hercule/issues/43)): **inactivity 30 minutes, absolute 8 hours**. Inactivity means no normalized event from the harness while a turn is running - a stuck-harness detector, not an idle-between-turns rule (idle process unloading is ~~the assistant runtime's, [12-assistants](./12-assistants.md)~~ a third timeout, below *(amended 2026-09-25, [#92](https://github.com/theagenticage/hercule/issues/92))*). Both timeouts are about the work, so they are controller-wide defaults with a per-agent override carried on the session spec, never per runner. The disk watermark is about the machine: **10 GiB free** by default, overridable per runner, checked every 60 seconds and before each placement.

*(Amended 2026-09-10, [#67](https://github.com/theagenticage/hercule/issues/67).)* The timeouts ride the wire as `SessionSpec.timeouts { inactivityMs, absoluteMs }`, filled from controller settings `session.inactivityTimeoutMinutes` and `session.absoluteTimeoutMinutes` (whole minutes; 30 and 480 unset) - the runner holds no default of its own. Reconciliation on a `sessionsReport` is a status move, not a stream event: sessions on that runner in `starting | idle | busy` the report does not list go to `exited`, resumable by their native id. An announced shutdown stops every live session with reason `runner_restart` and waits, bounded, for their exits before the goodbye.

*(Amended 2026-09-25, [#92](https://github.com/theagenticage/hercule/issues/92).)* The spec may carry a third timeout, `timeouts.idleMs`: how long the session may sit with no turn before the runner stops its process with reason `idle_unload`, to be resumed in place by the next input. The runner counts it from the moment the session last became idle, ~~its start or the end of its last turn~~ the end of its last turn, or an input refused while no turn was open *(amended 2026-10-05, [#431](https://github.com/theagenticage/hercule/issues/431))*, and a new turn cancels it. *(Amended 2026-10-05, [#431](https://github.com/theagenticage/hercule/issues/431).)* The runner does not count it from the start: a start's input that was delivered opens a turn, so a session is never unloaded while it waits for its first turn. It is filled from the controller setting `session.idleUnloadMinutes` (whole minutes; 15 when unset) ~~and set only on assistant conversation sessions~~ on assistant conversation sessions ([12-assistants](./12-assistants.md) section 5.1). A Thread gets none yet, because unloading a Thread's process would also end any background process it started, such as a dev server. *(Amended 2026-10-05, [#83](https://github.com/theagenticage/hercule/issues/83).)* An agent step's session gets a fixed `idleMs` of 5 seconds, which reads no setting. Once its step's turn ends, the run may not prompt it again for days, or ever: the next iteration may wait for a signal. Meanwhile an idle session holds a slot of its runner's session cap, so on a runner with one slot the run's next agent step would wait forever for the slot the finished step holds. The next iteration's prompt resumes an unloaded step session in place, and the resume carries that prompt as its first input ([07-workflows](./07-workflows.md) section 4.2). So a resumed step session is never unloaded while its prompt is on the way. The cost is a resume per iteration, and any background process the agent left running ends at the unload, as it would for a Thread.

*(Amended 2026-10-05, [#355](https://github.com/theagenticage/hercule/issues/355); [#351](https://github.com/theagenticage/hercule/issues/351).)* **A session has a turn running while any of its agents does**, its own agent or one of its subagents ([./06-providers.md](./06-providers.md) section 13). A subagent can still run after the session's own agent's turn has ended, for example a background subagent. So:

- the idle timeout counts from the moment the last open turn of any agent ended, and a new turn of any agent cancels it, so a session is never unloaded while a subagent works;
- the inactivity timeout runs while any turn is open, and any normalized event, whichever agent it belongs to, restarts it.

The supervisor keeps the set of open turns by turn id, because one agent's `turn.completed` must not close another agent's turn.

*(Amended 2026-09-22, [#200](https://github.com/theagenticage/hercule/issues/200).)* Reconciliation needs the runner to come back. A runner that never does - a machine wiped or lost, or one that was gone when the controller restarted - reports nothing, so the controller also ends sessions by itself: a session in `starting | idle | busy` whose runner is not `online`, and about which nothing was heard (its `lastActivityAt`) for longer than its own `SessionSpec.timeouts.absoluteMs`, goes to `exited`. A spec stored before the timeouts were on it is bounded by the default, 8 hours. The absolute timeout is the bound because a runner stops every session process at most that long after the process started, so past it the process is gone, or the runner is gone and can never say so. Before the bound, the session can still be running on a runner that is only out of reach (section 7), and the controller leaves it alone. The rule runs when the controller starts and then once a minute. It is a status move like reconciliation: queued inputs are cancelled with the reason, the session's token dies with it ([13-security](./13-security.md) section 5), the audit entry is `session.reconciled` with reason `runner_lost`, and the session stays resumable where its runner returns with the transcript. One case breaks the bound: a machine that was suspended does not count the suspended time, so its process can outlive the bound (a forward jump of the controller's clock has the same effect). The sessions report closes that gap in the other direction: a session the report lists that the controller holds as `exited` is sent `SessionStop`, because it runs on without a token and blocks a resume of the same session.

### 6.3 Workspace kinds

A Workspace is a provisioned working area on one runner containing 0..N checkouts. A Checkout is one working copy of one resource; in v1 only git repos are checkout-able.

| Kind | Checkouts | Lifetime | Use |
|---|---|---|---|
| Primary | exactly 1 | long-lived; at most one per (resource, runner) | the resource's **main workspace**, shared by "just open X" sessions |
| Ephemeral, single | 1 | one job | the normal unit for workflow agent steps |
| Ephemeral, scratch | 0 | one job | sessions that need a working directory but no repo (e.g. mail sessions; mail truth lives on the server, reached through tools) |
| Ephemeral, multi-repo | several | one job | one root directory with one checkout subdirectory per resource |

A session may also run with no workspace at all (`workspaceId: null`; cwd rules in section 6.1).

Concurrent sessions in one primary workspace are allowed; the UI surfaces the overlap, there is no locking. A dirty primary is the next session's starting reality.

**Workspace status** (consolidated from the pinned lifecycle facts in 6.4, 6.5 and 6.7; [02-domain-model](./02-domain-model.md) mirrors it):

| Status | Meaning |
|---|---|
| `provisioning` | checkout(s) being created, setup command running |
| `ready` | usable; the normal state of a primary and of an ephemeral while its job runs |
| `failed` | setup command failed; the files may be on disk; never handed to a session |
| `lost` | its runner was retired, or the runner reported the directory gone |
| `deleted` | torn down by teardown or the TTL reaper; terminal, record kept |

Transitions: `provisioning -> ready | failed`; `ready | failed -> deleted` (teardown after clean completion, ~~dismissal of the failed run~~ `workspace.dispose` on the failed run's kept workspace *(amended 2026-09-25, [#260](https://github.com/theagenticage/hercule/issues/260))*, or reaping); any non-terminal status `-> lost` on runner retirement. Primaries are `ready` for their whole life unless they become `lost`. The status is the material state on the runner and nothing more: whether an ephemeral is kept for inspection is teardown policy read off ~~its run~~ its Workspace Leases (6.7; *amended 2026-09-27, [#263](https://github.com/theagenticage/hercule/issues/263)*), never a workspace state (resolved 2026-09-01, [Domain model residue](https://github.com/theagenticage/hercule/issues/46): `unusable` renamed `failed`, `kept-on-failure` dropped).

Non-repo resources get no workspaces in v1: folder resources need a versioning story for non-git materials (post-v1), and mailboxes never produce workspaces.

*(Amended 2026-09-16, [#72](https://github.com/theagenticage/hercule/issues/72).)* **A failed primary is superseded by the next provision.** "At most one per (resource, runner)" counts only `provisioning` and `ready`. A primary that could not be made holds nothing, so `workspace.provision` and a spawn asking for the main workspace both stand it down - marking it `deleted`, keeping the row and the machine's words as the record of the attempt - and open a fresh one in its place. This is the one way a primary reaches `deleted`; nothing tears one down on request. **Adopt-in-place is not built**: a primary is always a Hercule-managed clone under the runner's storage directory. **The user-facing word for a primary is "main workspace"**; `primary` stays the kind in code, on the wire and in the database.

### 6.4 Checkouts, cache and provisioning

- **Bare cache.** Each runner keeps one bare git cache per resource, under its storage directory. Ephemeral checkouts are git worktrees off that cache, on the branch the run names ~~(default `hercule/run-<runId>`, a template on the workflow's workspace policy; [07-workflows.md](./07-workflows.md) section 4.4)~~. No worktree pooling. *(Amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257).)* The branch has a fixed name. A run's ephemeral checkout is on `hercule/run-<runId>`, and a thread's is on `hercule/thread-<last 8 of the session id>` ([07-workflows.md](./07-workflows.md) section 4.4).
- **Primary.** Always a standalone clone with `origin` pointing at the real remote, cloned once from the cache with hardlink object sharing and then pointed at the remote. ~~*Adopt in place*: an existing local checkout the user points at becomes the primary, untouched, and seeds the runner's bare cache locally.~~ *(Amended 2026-09-16, [#72](https://github.com/theagenticage/hercule/issues/72).)* **Struck: adopt-in-place is not built.** `workspace.provision` takes `{resourceId, runnerId}` and no path; a checkout the user already has on that machine is never read, written or taken over. The consequences are deliberate and are the reason it went: nothing the controller holds could rebuild a frame naming a folder, so a provisioning frame could never be re-sent to a machine that was away; the machine had to read the folder's `origin` to decide whether it was the right repository at all; and "Hercule never writes under a folder you did not give it" is a promise with no exception to explain.
- Primaries, caches and ephemerals all live under the runner's storage directory.
- Git's one-branch-one-worktree guard applies uniformly across a runner's ephemerals; primaries are standalone clones, so the guard never spans the two kinds.
- Git credentials for clone, fetch and push derive from the checkout's Connection and are delivered on demand, never written to runner disk; mechanics in [13-security](./13-security.md) ([ADR 0016](../adr/0016-git-credentials-derive-from-connections.md)).

Branch naming is pinned in [07-workflows.md](./07-workflows.md) section 4.4: ~~default `hercule/run-<runId>`, overridable per workflow,~~ renamable by the agent; "task branch" is a shipped-workflow convention. *(Amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257).)* A run's branch is always `hercule/run-<runId>`; the workspace policy has no branch template. A thread's branch is `hercule/thread-<last 8 of the session id>`, so the two kinds never share a name.

### 6.5 Setup command and `.workspaceinclude`

- A repo resource MAY carry one optional setup command, stored in controller state (never in the repo). The runner runs it in every fresh ephemeral checkout of that resource. A non-zero exit marks the workspace `failed` and the run fails with `workspace-failed`; that the placement which needed it then fails is this spec's consolidation (the ticket pins only the unusable marking).

  *(Amended 2026-10-03, [#310](https://github.com/theagenticage/hercule/issues/310).)* The setup command is repository code, so Hercule gives it no git credential. It runs with the runner's scrubbed environment ([./06-providers.md](./06-providers.md) section 9.3) and without `HERCULE_RUNNER_SOCKET`, so the credential helper git is configured with finds no socket and answers nothing. Before, the socket's path was in its environment, and a setup command that read its workspace id from its directory could ask the runner for the repository's token while the workspace was `provisioning` ([./13-security.md](./13-security.md) section 9.1). A same-OS-user process is still at parity with the runner (13 section 12); this only stops the setup command being handed the way in.
- Fresh worktrees copy untracked files listed by the repository's `.workspaceinclude` file (an existing vendor convention Hercule reads; not Hercule configuration stored in the repo). The copy is configurable.

The copy source is the resource's primary workspace **on the same runner** (paths never cross runners). When that runner has no primary for the resource, nothing is copied and workspace provisioning emits a warning. "Configurable" means a per-resource disable flag only; there is no alternative file name. (Resolved 2026-08-31, [#43](https://github.com/theagenticage/hercule/issues/43).)

### 6.6 Toolchains

Toolchains (node, python, go, docker, ...) are the machine owner's responsibility. The runner probes them and reports them as capabilities; placement filters on them. Hercule installs only provider CLIs (section 3.3). Hercule-managed toolchains and a revived Environment concept are post-v1.

The probed toolchain list is deliberately minimal in v1 (resolved 2026-08-31, [#43](https://github.com/theagenticage/hercule/issues/43)): **`git` and `gh`** only, reported as `{ name, version, path }` (raw `--version` output, parsed to semver where it parses). Anything else the owner installs by hand and, if placement needs it, expresses as a user label (`node`, `gpu`); the fuller answer is the post-v1 Environment concept. Placement filters match toolchain names (optionally a semver range) and labels.

### 6.7 Teardown

| Situation | Ephemeral workspace |
|---|---|
| Clean completion | deleted |
| Failure | kept until the user ~~dismisses the failed run~~ deletes it with `workspace.dispose`, or for 14 days *(amended 2026-09-25, [#260](https://github.com/theagenticage/hercule/issues/260), below)*; re-runs provision fresh workspaces |
| Orphaned (owning run gone, session gone, runner restarted mid-job) | collected by the runner's TTL reaper |

Primary workspaces are never torn down by Hercule and bare caches persist for the runner's life (this spec's consolidation; the ticket's teardown rules cover ephemerals only).

A retired runner's workspaces are marked `lost` in the controller (section 7); the disk itself is not touched.

*(Amended 2026-09-16, [#72](https://github.com/theagenticage/hercule/issues/72).)* The reaper is a **controller sweep the runner executes**: every ten minutes the controller disposes, by the same frame `workspace.dispose` uses, every ephemeral workspace on an online runner that is either orphaned for longer than `workspace.orphanTtlHours` (default **24 hours**) or idle for longer than `workspace.idleTtlDays` (default **30 days**), both controller settings. The runner never decides on its own: it lacks the facts the rule is written in - ~~session status, resumability, last activity~~ the workspace's leases *(amended 2026-09-27, [#263](https://github.com/theagenticage/hercule/issues/263), below)*. A thread's worktree is its work, so a workspace whose threads are still resumable is not orphaned and expires only on the idle TTL, which the user can raise. A workspace on an offline or unreachable runner waits for the next sweep after it returns. ~~The **14-day** window below is a rule about runs - it keeps a failed run's ephemerals until the run is dismissed - and v1 has no runs, so it is unimplemented; the sweep knows only the orphan and idle TTLs.~~ *(Struck 2026-09-25, [#260](https://github.com/theagenticage/hercule/issues/260): the 14-day window is built, below.)*

Reaper TTLs (resolved 2026-08-31, [#43](https://github.com/theagenticage/hercule/issues/43)): orphaned ephemerals are reaped after **24 hours**; the ephemerals of failed runs are kept until the failed run is dismissed or **14 days**, whichever comes first - the run record keeps a "workspace reaped" note so a stale failed run never pretends its files still exist. Both are controller-wide settings.

*(Amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257).)* **Runs now have workspaces, and the sweep leaves an unfinished run's workspace alone.** The sweep never disposes of a workspace whose run is `pending` or `running`, however long the run has waited. *(Amended 2026-09-27, [#263](https://github.com/theagenticage/hercule/issues/263): the unfinished run holds an active lease, and the sweep never touches a workspace with an active lease, below.)* A run can wait for its runner with no time limit (section 5.1), and its workspace holds the work of the steps already done. What happens to a run's workspace once the run ends - deleted on clean completion, kept after a failure, the 14-day window above - is [#260](https://github.com/theagenticage/hercule/issues/260). ~~Until #260 lands, a finished run's ephemeral workspace is orphaned and falls to the 24-hour orphan rule.~~ *(Struck 2026-09-25, [#260](https://github.com/theagenticage/hercule/issues/260): #260 has landed, below.)*

*(Amended 2026-09-25, [#260](https://github.com/theagenticage/hercule/issues/260); the table, the reasons and the window are superseded 2026-09-27 by [#263](https://github.com/theagenticage/hercule/issues/263), below.)* **The sweep tears down a run's ephemeral workspace by how the run ended.** One rule in one place: the same ten-minute sweep, on an online runner only, so an offline runner needs no special case. A `primary` workspace is never deleted by a run.

| The run is | Its ephemeral workspace | The audit `reason` |
|---|---|---|
| `pending` or `running` | never touched, however old | - |
| `completed` | deleted by the next sweep | `run-completed` |
| `cancelled`, the workspace not kept | deleted by the next sweep | `run-cancelled` |
| `failed` | kept for `workspace.failedRunTtlDays` after the run finished (default **14**), then deleted | `run-failed` |
| `cancelled` with `keepWorkspace` | kept like a failed run's | `run-kept` |

- **The 14-day window is built** as the controller setting ~~`workspace.failedRunTtlDays`~~ `workspace.inspectionTtlDays` *(renamed 2026-09-27, [#263](https://github.com/theagenticage/hercule/issues/263))*, counted from the run's `finishedAt`. ~~The orphan and idle TTLs do not apply to a run's workspace: its run's rule decides.~~ *(Struck 2026-09-27, [#263](https://github.com/theagenticage/hercule/issues/263): the latest lease wins, below.)* A thread's workspace keeps the reasons `orphan` and `idle`.
- **Dismissing is `workspace.dispose` on the kept workspace.** There is no dismiss operation for runs. `workspace.dispose` refuses a workspace whose run is `pending` or `running` with `invalid_state`, and the message says to cancel the run first. *(Amended 2026-09-27, [#263](https://github.com/theagenticage/hercule/issues/263): it refuses any workspace with an active lease, and the message names everything to stop: the run to cancel and the sessions to stop.)* Cancelling is where the user chooses whether the workspace stays: `run.cancel { keepWorkspace }` ([07-workflows.md](./07-workflows.md) section 7.2).
- **Deleting after a clean completion can lag by up to ten minutes.** That is the price of one rule in one place.
- **The sweep also takes `failed` ephemeral workspaces**, not only `ready` ones. A run whose setup command failed leaves a `failed` workspace that may hold files, and it is deleted after the window like any failed run's. A thread's `failed` ephemeral falls to the orphan and idle TTLs like a `ready` one.
- **The "workspace reaped" note** is read off the workspace itself: its `deleted` status and `disposedAt`. The run needs no column for it. Until the workspace is deleted, ~~a failed or kept run answers `workspaceKeptUntil`~~ the workspace answers `keptUntil` *(amended 2026-09-27, [#263](https://github.com/theagenticage/hercule/issues/263))* ([11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2), and the run's page shows both ([14-web-app.md](./14-web-app.md)).

*(Amended 2026-09-27, [#263](https://github.com/theagenticage/hercule/issues/263), [ADR 0036](../adr/0036-a-workspace-is-kept-by-leases-its-holders-release.md).)* **A workspace is kept by the leases its holders release.** The sweep reads one kind of fact, the workspace's Workspace Leases, and never the status of a session or a run.

- **Acquire.** A session acquires a lease on the workspace it is placed in, and again when it is resumed; a run acquires one on its workspace when its first workspace step opens it. The lease is active until the holder releases it.
- **Release.** The holder releases its lease with a retention, and the time the workspace is kept until is fixed then: the release time plus the retention's window, read from the settings at that moment. A later settings change moves only later releases.

| Retention | Kept for | Released by |
|---|---|---|
| `none` | nothing: the next sweep may delete it | a run that completed, or was cancelled without `keepWorkspace` |
| `orphan` | `workspace.orphanTtlHours` (default **24 hours**) | a session that exited and cannot be resumed; a session whose conversation is deleted, again |
| `idle` | `workspace.idleTtlDays` (default **30 days**) | a session that exited and can be resumed |
| `inspection` | `workspace.inspectionTtlDays` (default **14 days**) | a run that failed, or was cancelled with `keepWorkspace` |

- **The rule.** The sweep deletes an ephemeral workspace on an online runner once it has no active lease and every lease's kept-until time has passed. The latest lease wins: a thread that joined a failed run's workspace keeps it for its own window, even after the run's window has ended. Every workspace gets its first lease in the transaction that opens it; a workspace with no lease at all would be a fault, and the sweep leaves it alone rather than delete files it cannot account for.
- **Releasing again.** A release also applies to a lease that is already released, and recomputes its kept-until time from the lease's own release time. Deleting an assistant releases each exited session of its conversations again as `orphan`, because nothing can resume those sessions any more.
- **A released lease is kept only where it keeps something.** On a primary, which the sweep never deletes, a lease is deleted when it is released, and acquired afresh when its session is resumed. When a workspace is gone (`deleted` or `lost`), its released leases are deleted with it. Only an active lease matters there: the credential rule reads it, and `Workspace.sessionIds` lists it. So the table does not grow with every session and run that ever ended.
- **The audit `reason`** of `workspace.deleted` is the retention of the lease with the latest kept-until time, with its holder (`run:<id>` or `session:<id>`); `run-completed`, `run-cancelled`, `run-failed` and `run-kept` are retired.
- **`workspace.dispose`** refuses a workspace with an active lease with `invalid_state`, and the message names everything to stop: the run to cancel and the sessions to stop, both when both hold it.
- **Leases carry no actor.** The holder is the actor, and the `workspace.deleted` audit entry records the deletion.

## 7. Runner lifecycle and connectivity

A runner carries two independent axes. **Connectivity** (`online | offline | unreachable`) is written only by Runner Connections, from the socket. **Lifecycle** (`active | draining | retired`) is written only by user operations. They vary independently - a `draining` runner can be `unreachable` at the same time, and the controller reports both rather than collapsing them into one state.

### Connectivity

| Connectivity | Meaning | Placements | Sessions |
|---|---|---|---|
| `online` | connected, hello complete | accepted (subject to cap, watermark and lifecycle) | running |
| `offline` | announced shutdown: outbox flushed, sessions cleanly interrupted and resumable | wait for return | interrupted, resumable |
| `unreachable` | silence: no announcement, connection lost | wait for return | unknown; UI shows "state unknown, last seen X" |

### Lifecycle

| Lifecycle | Meaning | Placements | Sessions |
|---|---|---|---|
| `active` | normal fleet member | accepted (subject to cap, watermark and connectivity) | running |
| `draining` | user-initiated: no new placements, running sessions finish | refused | run to completion |
| `retired` | terminal: credential revoked, workspaces marked lost, session records preserved but unresumable | refused | none |

Transitions (the tickets pin the two axes, drain -> retire, drain -> active (`runner.undrain`), and force-retiring an unreachable runner; the rest of this list is this spec's consolidation):

- `online -> offline` on an announced shutdown; `offline -> online` on reconnect (outbox replays).
- `online -> unreachable` when the socket drops without an announcement and stays down; `unreachable -> online` on reconnect (outbox replays). An `unreachable` runner's sessions may well still be running; the controller reports honestly that it does not know.
- `active -> draining` by user action; `draining -> active` by user action (`runner.undrain`), cancelling a drain in progress.
- `active | draining -> retired` by user action once sessions have finished, or immediately by force. Force-retiring a runner whose connectivity is `unreachable` is allowed with an explicit confirmation.
- `retired` is terminal. Re-enlisting the same machine creates a new runner: new identity, credential, name and labels, a new storage directory, no workspace adoption. The old records stay under the retired runner.

Silence threshold (resolved 2026-08-31, [#43](https://github.com/theagenticage/hercule/issues/43)): WebSocket ping every **15 seconds**; `online -> unreachable` after **60 seconds** without a pong (four missed intervals). Reconnect backoff is section 2.3's (1 s doubling to 30 s, reset on wake or network change).

*(Corrected 2026-09-05, [#61](https://github.com/theagenticage/hercule/issues/61).)* The 15 seconds and the 60 are a **protocol `Ping`/`Pong` pair, not a WebSocket control frame.* A runtime answers a control-frame ping for its process, so a control frame proves the machine is up rather than that the runner is; and the server-owned socket the upgrade yields has no ping to send. The controller sends `Ping`, the runner answers `Pong`, and only a `Pong` advances what the silence window is measured from. The runner answers a `Ping` without waiting for any session's work, so a harness that is slow to start never makes its runner look silent *(amended 2026-10-05, [#431](https://github.com/theagenticage/hercule/issues/431); section 2.2)*.

## 8. Promotion and portability

Promotion moves the controller to another machine by migrating its state; it is never a live handoff, and there is never a moment with two authoritative controllers ([ADR 0005](../adr/0005-promotion-is-migration-behind-a-stable-controller-identity.md)).

### 8.1 Logical controller identity

The controller has a persistent identity: an id plus key material, created at install and carried in the bundle. Runners authenticate that identity at whatever address it appears. Address announcements and the forwarding pointer (8.3) are signed with it, so "controller moved" cannot be spoofed. Because the new machine resumes the same identity, runner seq/ack state and outboxes continue as if the controller had merely reconnected.

### 8.2 The pull ceremony

Old controller A, new machine B.

1. **Mint.** On A (CLI or web app) the user mints a short-lived, single-use promotion token. Minting freezes nothing. Authority originates on the controller, mirroring runner join: nobody on the network can pull state uninvited.
2. **Run.** On B the user runs `hercule promote --from <A-addr> --token <t>`. The command binds B's port so it can answer probes, then contacts A. Install, moving day and promotion are one story: `promote` is auto-initialization with the Data Root arriving by pull ([15-packaging-and-operations](./15-packaging-and-operations.md)).
3. **Probe.** A, over its live runner connections, asks each runner to check that it can reach B's address. The confirm screen shows the fleet with a check per runner. The user states or confirms B's reachable address here (detected default, overridable; plain `IP:PORT` fully supported, nothing assumes Tailscale). *Specified but droppable for v1: shipping without the probe changes nothing structural.*
4. **Confirm.** The commit point, before anything freezes.
5. **Transfer.** A goes read-only and streams the bundle: the SQLite database plus secrets packed at export (re-encrypted under a key derived from the promotion token; B re-wraps them under its own master key, which never leaves a machine: [13-security](./13-security.md)). B starts serving under the same logical identity. During the window event polling and mutations pause; in-flight sessions on runners keep running and buffer to their outboxes.
6. **Switch.** A announces the new address (signed) and seals itself. Runners reconnect to B and replay their outboxes.

Aborting at any point before step 6 restores A untouched. Cold move: no drain phase, no session interruption.

### 8.3 Sealing and fencing

After promotion A is sealed: it refuses to serve and answers anything that dials the old address (runners that missed the announcement, stale browser bookmarks) with a signed forwarding pointer naming B. Un-sealing requires an explicit force flag (disaster recovery only). When A is fully gone, the last-resort escape hatch is a local re-point command run on each runner.

The re-point command (resolved 2026-08-31, [#43](https://github.com/theagenticage/hercule/issues/43)) is **`hercule runner set-controller <url>`**: it keeps the runner's existing credential and verifies at hello that the identity at the new address is the one it enrolled with; on mismatch it refuses with "this is a different controller; use `hercule runner join`". A fresh join token is never needed for a re-point, because a controller that cannot resume the logical identity is by definition a different controller - and that path is re-enlistment, not re-pointing.

### 8.4 Bundle fallback

When A and B cannot see each other: export a bundle file on A, carry it, import on B. Pull is internally export plus import, so both paths produce the same result.

### 8.5 Portability rules

- **The bundle is relocatable.** The controller DB holds no absolute paths and runner-side paths are opaque runner-owned facts keyed by id that promotion never rewrites; the rules are stated once in [04-state-store](./04-state-store.md).
- **Secrets are packable**: the running controller can enumerate and extract them for export. Keychain storage is allowed; write-only machine-bound storage is not ([13-security](./13-security.md)).
- **Future artifact or blob storage lives inside the Data Root** and moves with the bundle; streaming or resumable transfer is the escape hatch if volume ever hurts.

### 8.6 Fleet continuity

- A's local runner is an ordinary fleet member and survives promotion as itself: same identity, name, workspaces; it re-points to B like every other runner. No retire, no re-enlist. "Laptop" stays named "laptop".
- B gets a fresh auto-joined local runner, standard controller behaviour.
- The fleet-level default runner is unchanged by promotion. Promotion changes who the brain is, not where work runs.
- "Local" (section 5.4) resolves on the client device and therefore follows the user, not the controller.

## Post-v1

- Fleet auto-discovery and push-install; v1 keeps the fully programmatic join exchange and the reserved "Add machine" spot.
- Plan-shipping to runners (self-orchestration while disconnected); v1 keeps hello capability negotiation so it lands without a protocol break.
- Native OS sandboxing (macOS Seatbelt, Linux Landlock), containers as a remoter option; both return as a probed runner capability behind hello negotiation.
- Hercule-managed toolchains and an Environment concept (named toolchain plus setup bundles); v1 keeps toolchains as probed facts and the setup command in controller state.
- Folder-resource workspaces; v1 workspaces are git-only.
- Runner-side plugin loading; v1 runner-side provider execution is built-in but plugin-shaped ([05-plugins](./05-plugins.md)).
- Load balancing, session migration and failover between runners; v1 pins work where it lands.
- Windows runners.
- Artifact storage on the controller; when it lands it lives inside the Data Root (8.5).

## Sources

Tickets:

- [Controller/runner architecture: registration, placement, scheduling](https://github.com/theagenticage/hercule/issues/7)
- [Runner execution substrate](https://github.com/theagenticage/hercule/issues/8)
- [Controller promotion & portability](https://github.com/theagenticage/hercule/issues/10)
- [Research: portable provider installs & credentials across runners](https://github.com/theagenticage/hercule/issues/23)
- [Provider adapter interface](https://github.com/theagenticage/hercule/issues/12) (SessionSpec / ProviderRunnerContext boundary, capability snapshots)
- [Agent-operates-system surface](https://github.com/theagenticage/hercule/issues/16) (session token injection)
- [Security & secrets model](https://github.com/theagenticage/hercule/issues/18) (git credential helper, packed secrets)
- [Web app architecture: observability-first, desktop-shell-ready](https://github.com/theagenticage/hercule/issues/19) ("local" alias detection)
- [Controller packaging & install story](https://github.com/theagenticage/hercule/issues/24) (local runner as child process, Hercule Home, fleet skew)
- [Runner substrate details: protocol guarantees, defaults, provider CLI delivery](https://github.com/theagenticage/hercule/issues/43) (reconciliation delivery, thresholds and defaults, reserved runners, join/login split, re-point command)

ADRs:

- [ADR 0002 - Orchestration stays on the controller](../adr/0002-orchestration-stays-on-the-controller.md)
- [ADR 0003 - Sessions run as bare processes on runners](../adr/0003-sessions-run-as-bare-processes.md)
- [ADR 0005 - Promotion is migration behind a stable controller identity](../adr/0005-promotion-is-migration-behind-a-stable-controller-identity.md)
- [ADR 0016 - Git credentials derive from connections](../adr/0016-git-credentials-derive-from-connections.md) (referenced)
- [ADR 0018 - Hercule ships as one self-contained binary](../adr/0018-hercule-ships-as-one-self-contained-binary.md) (referenced)
- [ADR 0035 - An action declares where it runs](../adr/0035-an-action-declares-where-it-runs.md) (workspace steps and their frames, run pinning)

Research: `research/provider-portability.md` (branch `research/provider-portability`).
