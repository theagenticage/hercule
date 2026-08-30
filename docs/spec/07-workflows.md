# Workflows

A Workflow is a stored, editable, declarative source of execution plans: typed inputs, one or more triggers, a graph of steps and edges, and CEL conditions that route between them. A Run freezes a workflow's content into an immutable execution plan at start, resolves its inputs, and executes the graph on the controller in one workspace on one runner; only two step kinds exist (action steps that invoke plugin-contributed actions, agent steps that drive a Session), all routing lives in the graph over declared step outputs, and cycles are bounded by construction. This document is normative for the definition shape, trigger kinds, step kinds, routing, joins, skips and cycles, the expression language at every condition site, the run record and its lifecycle, the agent-to-graph output contract, the built-in action catalogue, and how spawn bounds and the human moment appear from the workflow's side. Event ingestion and matching live in [./08-events-and-connections.md](./08-events-and-connections.md); triage topology, breaker semantics and Notifications in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md); provider mechanics in [./06-providers.md](./06-providers.md).

## 1. Definition

A workflow is data in the controller database, created and edited through the public API and the web app ([./14-web-app.md](./14-web-app.md) owns the editor: schema-validated structured text plus a read-only DAG preview). There is no user-authored code in a workflow and no repo-local definition; expressiveness comes from agent steps and plugin-contributed actions ([ADR 0008](../adr/0008-workflow-graphs-route-on-declared-outputs.md)). Editing a workflow never affects in-flight runs, because every run executes its own frozen copy ([ADR 0001](../adr/0001-runs-freeze-an-execution-plan.md)); there is no workflow versioning.

Names pinned by the tickets are used verbatim (`maxTraversals`, `freshSession`, `iteration-limit`, cron `schedule`/`timezone`, action ids). Other field names below are this document's consolidation and are normative for the implementation; the concepts behind them are the tickets'. The execution semantics (joins, skips, signal nodes, terminal steps, errors, run and step states, one workspace per run) were pinned by [Workflow execution semantics](https://github.com/rogierpennink/hydra/issues/36).

```ts
interface Workflow {
  id: string
  name: string
  description?: string
  enabled: boolean                     // false = no trigger of this workflow matches (pausing a workflow covers quiet hours)
  inputs: InputDeclaration[]
  triggers: Trigger[]                  // >= 0 start triggers, >= 0 signal triggers
  steps: Step[]
  edges: Edge[]
  workspace: WorkspacePolicy           // the one workspace every agent step of a run works in (section 4.4)
  runner?: { requires?: string[]; runnerId?: string }   // placement inputs for the run: required runner capabilities, explicit runner
  createdAt: string
  updatedAt: string
}

type InputDeclaration =
  | { name: string; schema: JsonSchema; required: boolean; default?: unknown }   // draft-07; scalar, object or array; referenced as inputs.<name>
  | { name: string; connection: { type: string }; required: boolean; default?: string }   // a Connection id of the named plugin type (section 3)
```

A workflow can be as small as one trigger plus one step. Steps reference inputs and earlier step outputs by expression (section 5) inside conditions, action parameters and agent prompts.

`enabled: false` stops the workflow's triggers and nothing else: a disabled workflow may still be run manually (direct run creation is explicit intent, and the usual way to test a fix before re-enabling).

### Validation at save

The controller validates a definition when it is saved and again when a run is stamped from it (section 7.1). Validation fails loudly with the offending element named. Checks:

- Graph: every edge references existing steps or signal nodes; no edge leads *into* a signal node (section 2.4); every cycle contains at least one edge with `maxTraversals` (section 4.3); no step inside a cycle carries `join: "all"` (section 4.3).
- Expressions: every CEL expression at every site parses and type-checks in the environment declared for that site (section 5).
- Actions: every action step names a contribution present in the persisted contribution catalogue whose plugin is enabled; parameters validate against the contribution's declared input schema. Disabling a plugin makes every workflow referencing its contributions fail validation ([./05-plugins.md](./05-plugins.md)).
- Agents: every agent step names an existing Agent; a declared output schema is valid JSON Schema draft-07 and lints clean against the common strict subset of all three providers, regardless of which provider the step's agent runs on (the OpenAI strict subset is the binding constraint: `additionalProperties: false`, all properties required; the full per-harness limits are in [./06-providers.md](./06-providers.md)). Linting at validation time beats a turn failure at run time and keeps a workflow portable across agents.
- Triggers: a start trigger names its Connection selection explicitly (section 2.1); a cron trigger carries `schedule`; every input mapped by a trigger exists; every required input without a default is mapped by every start trigger.
- Inputs: a `connection` input's `default`, when present, names an existing Connection of that type.

One **warning**, not an error: a graph with signal nodes and no `terminal` step (section 4.3) can only end by cancellation. The editor shows it; the save succeeds, because "keep fixing checks until I cancel" is a legitimate workflow.

### Invalid after the fact

A stored workflow can stop validating without being edited: its plugin is disabled, its agent or a Connection named in a default is deleted. The controller re-validates every workflow that references the mutated thing at the moment of the mutation. A workflow that fails is marked **invalid**: a health warning on the workflow, one Notification, and its start triggers no longer match while it is invalid (matched events show as ignored in the events view, [./08-events-and-connections.md](./08-events-and-connections.md)). A manual run of an invalid workflow is rejected with the validation error. The mark clears on the next successful validation (the plugin is re-enabled, or the workflow is saved with a fix). Runs are never spawned only to fail at stamp: one notification, not a failed-run flood.

## 2. Triggers

A workflow owns its triggers; there is no standalone routing entity. Triggers are rows in their own table, queryable independently of the workflow (a scheduled-tasks view is a query over cron triggers). A workflow may carry several start triggers and several signal triggers.

```ts
type Trigger = StartTrigger | SignalTrigger

interface EventSelector {               // the static condition of a trigger
  kind: string                         // event kind, namespaced by source: "github.issue.opened", "task.updated", "cron.tick"
  connectionId?: string | "any"        // required for plugin-emitted kinds: a Connection id or a deliberate "any"; absent for core-emitted kinds
  filter?: CelExpression               // over `event`; bool
}

interface StartTrigger {
  id: string
  kind: "start"
  source: EventSelector
  inputs: Record<string, CelExpression> // input name -> expression over `event`
  spawnBound: { maxRuns: number; windowSeconds: number }   // default ~30 per hour
  status: "active" | "paused"          // paused by the user or by a tripped breaker; enable/disable lives on the Workflow
  schedule?: string                    // cron triggers only (source.kind == "cron.tick"): cron expression
  timezone?: string                    // cron triggers only; the user's timezone setting when omitted
}

interface SignalTrigger {
  id: string                           // referenced as steps.<id> once it has fired (section 2.4)
  kind: "signal"
  source: EventSelector                // the condition shape
  correlation: {
    event: CelExpression               // over `event`; value-producing
    run: CelExpression                 // over `inputs`, `steps`; value-producing
  }
  outputs?: Record<string, CelExpression>   // output name -> expression over `event`; absent = the whole envelope minus raw
}
```

`EventSelector` is defined here because workflows own triggers; the matcher in [./08-events-and-connections.md](./08-events-and-connections.md) evaluates it (kind matches, Connection selection admits `event.connectionId`, filter true). The persisted kind catalogue that `kind` is validated against is registered by plugins and core emitters ([./08-events-and-connections.md](./08-events-and-connections.md)).

### 2.1 Start triggers

A start trigger has a static condition, its `EventSelector`: the event kind, the Connection selection and the optional CEL `filter`. When a persisted event matches an enabled workflow's active start trigger, the matcher inserts a pending-run effect row for it in the same transaction that advances its cursor ([ADR 0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md); mechanics in [./08-events-and-connections.md](./08-events-and-connections.md)). One event may start any number of runs across workflows and signal any number of live subscriptions; delivery is non-exclusive.

Connection selection is explicit: a named Connection or a deliberate `"any"`. Silent all-connections matching does not exist. Triggers on core-emitted events (cron, manual, platform) have no Connection; `connectionId` is absent for them.

A filter or mapping expression that throws evaluates as no-match and records a visible health warning on the trigger; it never stops the pipeline.

Event kinds a start trigger can name in v1: GitHub and Gmail events from their plugins, `cron.tick`, manual synthetic events, and the platform events `run.completed`, `run.failed`, `task.created`, `task.updated` ([./08-events-and-connections.md](./08-events-and-connections.md) owns the envelope and catalogue).

### 2.2 Cron

Cron is a core emitter, not a plugin. The schedule is trigger configuration: a start trigger whose `source.kind` is `cron.tick` carries `schedule` and optional `timezone` (per trigger; when omitted, the **user's timezone setting**, the one spec-wide timezone source pinned in [./12-assistants.md](./12-assistants.md) section 5.2 - there is no separate controller timezone). The core **Scheduler** emits `cron.tick { workflowId, triggerId, scheduledFor }` through the pipeline and the matcher routes it by trigger id, so no filter is needed. Ticks missed while the controller was down are skipped with a visible note. The same Scheduler also fires assistant Scheduled Wakes (heartbeat, reminders), which never enter the pipeline ([./12-assistants.md](./12-assistants.md) section 8, [ADR 0024](../adr/0024-assistants-are-woken-by-the-scheduler-not-by-workflows.md)). A "scheduled task" form in the UI is sugar over creating a workflow with one cron trigger and one step, or adding a cron trigger to an existing workflow.

### 2.3 Manual

Manual is two things. Direct run creation (API or web app) starts a run of a workflow with no triggering event; it prompts for the workflow's declared inputs. The synthetic-event API injects an event into the pipeline, where it matches triggers like any other event (for testing triggers, and for agents poking subscriptions).

### 2.4 Signal triggers

A signal trigger resumes a live run mid-graph. Its static part is the same `EventSelector` as a start trigger; its dynamic part is the correlation pair: the event-side expression and the run-side expression must produce equal values. When a run starts, the controller instantiates one Subscription per signal trigger in the plan. Correlation evaluates lazily at match time against the run's current state (`inputs` and the outputs of steps completed so far); a run-side reference that does not resolve yet is a no-match, and no resolvability analysis is done. The subscription lives until the run reaches a terminal state and has no timeout: a run waiting forever is visible and cancelable, so workflows are designed to end at the right moment (correlate on PR merged, not PR opened).

**A signal trigger is a source node in the graph.** It has outgoing edges and never incoming ones (validation rejects an edge into it). It is live from run start; each time its subscription matches, it fires: a step record is written for it (status `completed`, section 7.2, holding its output) and every outgoing edge whose condition holds fires, exactly as when a step completes. It may fire any number of times per run; `maxTraversals` on its outgoing edges bounds what that can do, the same cap that bounds cycles. Ordering comes from correlation, not from edges: a signal that correlates on `steps.open-pr.output.prNumber` cannot match before `open-pr` has completed, which is why the node needs no incoming edge to "wait after" a step. The pattern:

```
implement -> open-pr
[checks-failed]  correlation.run: steps.open-pr.output.prNumber  -> implement    maxTraversals: 3
[pr-merged]      correlation.run: steps.open-pr.output.prNumber  -> task-done    (terminal step)
```

`checks-failed` firing into `implement` is an ordinary re-entry of `implement` (section 4.3): the next turn of its session, with the prompt re-rendered from `steps.checks-failed.output`. That is how a run "revives" a finished step on new information, visibly and bounded. Steps never hold subscriptions of their own; only sessions do, and a session's subscriptions are the agent's own doing through the `hydra` CLI, not the plan's ([./08-events-and-connections.md](./08-events-and-connections.md) section 7.2).

**Output.** `outputs` maps event fields onto `steps.<signalId>.output` with expressions over `event`, the same mechanism as a start trigger's input mapping. When `outputs` is absent, the output is the whole event envelope as expressions see it (`kind`, `source`, `connectionId`, `system`, `refs`, `url`, `occurredAt`, `payload.*`; never `raw`). The default is the loose shape because an agent step is the usual consumer and copes with it; a human pre-mapping every field is the exception. Section 3's "the raw event never enters the plan" therefore reads: not unless the author asks, and `raw` (the provider's untouched body) never.

**Limitation, on the record:** an event that arrives before its correlation key exists in run state is a no-match and is gone; the matcher never replays past events against later run state. In practice the key (a PR number) appears in the same step that creates the thing the event is about, so the window is negligible. An agent that creates an artifact mid-session and wants its events before the step ends uses a session-held subscription.

### 2.5 Spawn bounds

Every start trigger carries a spawn bound: the number of runs it may spawn per window, default about 30 per hour, configurable per trigger. Signal triggers do not spawn runs and carry none. Exceeding the bound trips a breaker: the trigger's `status` becomes `paused`, events that matched but did not spawn are held visibly against the trigger, a Notification is raised, and the user resumes with one click, optionally discarding the backlog. Nothing is dropped silently, and a tripped breaker is the intended review moment. Breaker semantics, the held-event view and the Notification are specified in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) ([ADR 0011](../adr/0011-triage-is-a-workflow-pattern-inside-core-enforced-bounds.md)). Spawn bounds are the only core-enforced bound in v1: there are no run caps, spend gates or quiet hours (pausing a workflow or trigger covers quiet hours).

## 3. Inputs

A workflow declares typed inputs. A start trigger maps event fields onto them with CEL expressions over `event`; the raw event is visible to the trigger's filter and mapping and nowhere else. It never enters the plan: steps see `inputs.*`, not `event`. (The run record separately copies the triggering event for audit; that copy is not readable by expressions.) Manual runs prompt the user for declared inputs; `workflow.run` action steps and ad-hoc plan runs pass them explicitly. Defaults fill unmapped optional inputs; a required input left unresolved fails stamping.

Connections flow through inputs: an outbound action names the Connection it acts as, and that id may be mapped from the triggering event's `event.connectionId` into an input, then referenced by the action's parameters (`inputs.connection`).

A Connection input is **first-class**: the declaration says `connection: { type: "github" }` instead of a JSON schema, the value is a Connection id, and stamping validates that the Connection exists, is of that type and is not disabled, so a dead Connection fails at start rather than at step four. The manual-run form renders a Connection picker for it. A trigger with no event Connection (cron, manual) fills it from the declaration's `default` or a literal in its mapping (`'conn_abc'`). An action step may also name a Connection id literally in its `params` when the workflow only ever acts through one.

## 4. Steps and the graph

```ts
type Step = ActionStep | AgentStep

interface StepBase {
  id: string                           // referenced as steps.<id>
  name?: string
  condition?: CelExpression            // skip condition over `inputs`, `steps`; bool
  join?: "any" | "all"                 // default "any"; section 4.3
  terminal?: boolean                   // default false; completing this step completes the run; section 4.3
}

interface ActionStep extends StepBase {
  kind: "action"
  action: string                       // contribution id, e.g. "task.create", "github.create-pr"
  params: Record<string, Literal | CelExpression>  // validated against the contribution's input schema
}

interface AgentStep extends StepBase {
  kind: "agent"
  agent: string                        // Agent id; supplies the provider instance and the permission profile
  model?: { model: string; options?: Record<string, string | boolean> }  // model selection for this step; well-known option ids per ./06
  prompt: Template                     // first turn input; interpolates `inputs`, `steps`
  accessMode: AccessMode               // approval-required | auto-accept-edits | auto | full-access
  freshSession?: boolean               // default false: iterations resume the same session
  outputSchema?: JsonSchema            // draft-07; declares steps.<id>.output
}

type WorkspacePolicy =                 // declared once per workflow (section 1); section 4.4
  | { kind: "none" }                                                    // workspace-less sessions
  | { kind: "primary"; resource: string }                               // the resource's shared main checkout on the target runner
  | { kind: "ephemeral"; resources: string[]; branch?: Template }       // fresh worktrees; [] = scratch, several = multi-repo

interface Edge {
  from: string                         // step id or signal trigger id
  to: string                           // step id (never a signal trigger id)
  condition?: CelExpression            // over `inputs`, `steps`; bool; absent = always
  maxTraversals?: number               // >= 1; times this edge may fire per run
}
```

### 4.1 Action steps

An action step invokes a plugin-contributed workflow action by contribution id (a tool call is just this). The contribution declares an input schema and an output schema; `params` are literals or expressions and are validated at save time. Built-in actions (section 8) have the same shape and are invoked the same way. The action's return value becomes `steps.<id>.output`. An action that fails fails the run; failure is not redirection, and actions never steer the graph ([ADR 0008](../adr/0008-workflow-graphs-route-on-declared-outputs.md)).

Actor and permission context: a built-in action executing inside a run is stamped `run:<runId>` and is **ungated**: the workflow was authored by the user and its action steps run with the user's parity. Agent steps are sessions and act as `session:<id>` under their own profile ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 3.1). That is why the `worker` profile withholds `workflow.run` and `workflow.submit` (a session cannot fan out) while a `workflow.run` *action step* needs no grant (the user wrote it into the recipe). Plugin-contributed actions stand on the same footing: `execute()` receives `ctx.api`, a public-API client stamped `run:<runId>` with the `stepId` carried in the audit entry, and every mutation made through it is summarised on the step record ([ADR 0026](../adr/0026-workflow-actions-may-call-the-public-api-as-the-run.md); interface in [./05-plugins.md](./05-plugins.md) section 4.4). Actions still never redirect: routing reads declared outputs only.

### 4.2 Agent steps

An agent step starts a Session for the named Agent and waits until its turn completes. The controller authors the SessionSpec (the agent's provider instance, the step's `model` selection, `accessMode`, the run's `workspaceId` (section 4.4), system prompt from the agent, the step's `outputSchema`), places it on the run's runner (section 4.4; a full runner queues the placement and the step waits), and sends the rendered `prompt` as the first turn. The session carries the agent's permission profile (shipped default for workflow agent steps: `worker`, [./13-security.md](./13-security.md)) and reaches Hydra through the `hydra` CLI with its session token. The session is linked to the run and step from the session side; the run's step record holds the session id.

Which of these values the Agent may carry as defaults (model selection, access mode) is Open in [./02-domain-model.md](./02-domain-model.md); this document places `accessMode` and `model` on the step as the spec's consolidation (ticket #12 pins `SessionSpec.accessMode` without saying where it is chosen).

`accessMode` names one of the four fixed modes. If the provider does not support it natively, the controller substitutes the hardcoded fallback before session start, strictly downward in permissiveness; if no equal-or-less-permissive mode exists the step fails with a clear error ([./06-providers.md](./06-providers.md), [./13-security.md](./13-security.md); [ADR 0007](../adr/0007-provider-adapter-is-a-thin-interface-behind-a-normalized-event-stream.md) as amended).

Runner-owned inactivity and absolute timeouts apply to the session; a session that times out or exits abnormally fails the step.

Iterations: when an edge brings the graph back to an agent step (a cycle, or a signal node firing into it), the step by default sends the newly rendered prompt as the next turn of the same session, so review feedback or a failed-checks signal arrives as a follow-up in context. `freshSession: true` opts out for context-poisoning cases and starts a new session each iteration. Each iteration produces its own step record (section 7.2). A step's `outputSchema` travels on the `SessionSpec` once, and the adapter applies it to every turn of that session ([./06-providers.md](./06-providers.md) section 7), so each iteration yields a fresh structured result.

### 4.3 Routing and cycles

Control flow lives entirely in the graph. Steps with no incoming edges start when the run starts. When a step completes (or a signal node fires), every outgoing edge whose condition is absent or evaluates true fires; several firing edges run their targets in parallel. A branch the agent "chooses" is two outgoing edges with mutually exclusive conditions over an enum field of the step's output; the prompt tells the agent the choice exists, the schema carries it, the edges route it. Conditions route on `inputs.*` and `steps.<id>.output.*` only; there is no other run state visible to the graph.

**Joins.** A step with several incoming edges runs according to its `join`:

- `any` (default): every firing incoming edge runs the step once more, as a new iteration. For an agent step that is the next turn of its session, so a `summarize` step fed by `review-a` and `review-b` sees both reviews arrive in context, like a main thread receiving messages from subagents. Its outgoing edges fire per iteration, so anything after it runs once per firing.
- `all`: the step runs once, when every incoming edge has *resolved*: fired, or dead. An edge is dead when its source is dead or skipped, or its source completed and the edge's condition was false. A step with incoming edges is dead when all of them are dead; a dead step gets no record. `all` is the fan-in barrier ("run two reviewers, then combine once"). Validation forbids `all` on a step inside a cycle, because the loop-back edge cannot resolve on the first visit.

**Skips.** A step whose `condition` evaluates false is skipped: a record with status `skipped`, no output, and its outgoing edges are evaluated as if it had completed (pass-through). Skipping is never a runtime act; it is a condition the author wrote, so the steps after it are written to expect it: `steps.<id>` is absent for a skipped step (section 5), and a downstream condition that reads it guards with `has()`:

```
review -> merge      condition: !has(steps.review) || steps.review.output.verdict == "approve"
review -> implement  condition: has(steps.review) && steps.review.output.verdict == "reject"
```

A forgotten guard is an expression error (below), never a silent false. Pruning the branch instead is expressed by putting the condition on the edges, which is why pass-through is the meaning of a step condition.

**Cycles** use ordinary edges. Any edge may carry `maxTraversals >= 1`, the number of times it may fire in one run; validation requires every cycle to contain at least one capped edge, so every graph is bounded by construction. When a capped edge's condition holds but its cap is exhausted, the run fails with reason `iteration-limit`. When the condition is false the edge simply does not fire and the cap is irrelevant. The per-step `iteration` counter increments each time the step runs in the run.

**Busy step.** An edge firing into a step that is currently running (a second review arriving while the summarizer is mid-turn, a second `checks-failed` signal while the fixer is still fixing) queues one iteration, recorded as `pending`; queued iterations run in order after the current one completes. Nothing is coalesced and nothing steers the running turn in v1: batching belongs at the source (subscribe to GitHub's per-suite and per-review kinds, not per-check and per-comment ones; [./08-events-and-connections.md](./08-events-and-connections.md)). Coalescing queued firings into one iteration, and steering a running session, are Post-v1.

**Terminal steps.** A step with `terminal: true` completes the run when it completes: running branches are cancelled (their records `cancelled`), pending iterations dropped, live subscriptions ended, undelivered signal deliveries dropped. Otherwise a run completes when nothing is running or pending and no subscription is live. A graph with signal nodes therefore needs a terminal step to end on its own (a live `checks-failed` node would otherwise keep the run alive after `task-done`); without one it ends only by cancellation, which the editor warns about (section 1).

**Failure.** A step failing fails the run; parallel branches still running are cancelled. There are no automatic retries. A CEL expression that throws at any in-run site (a step condition, an edge condition, a template in a prompt or a parameter) fails the run with reason `expression-error` and the site named in `failedStepId`. In-run errors are loud where trigger sites are quiet ([./08-events-and-connections.md](./08-events-and-connections.md): no-match plus health warning) because the pipeline must never stall on one workflow's bad expression, whereas a run is an isolated unit and a silently-false edge would route work wrongly.

### 4.4 One run, one workspace, one runner

A run takes place in one workspace on one runner. The workflow declares the `WorkspacePolicy` once (section 1) and it is frozen into the plan; every agent step of the run works in it, and the run's `runner` placement inputs (`requires` feeds the capability filter, `runnerId` is the explicit choice, [./03-controller-and-runners.md](./03-controller-and-runners.md)) place the whole run. The first placement pins the runner; later agent steps go to the same runner, because the workspace is runner-pinned. Action steps run on the controller and need neither. This moves the workspace and the placement inputs off the agent step, where the Workflow model ticket had put them: nobody could name a run that needs two workspaces (multi-repo is one workspace with several resources), and an implementer and a reviewer on one branch is the normal case, impossible with per-step workspaces. Named workspaces per run are the additive extension if a use case appears (Post-v1).

Policy: `none` runs sessions workspace-less (assistant-style, API-only work); `primary` uses the resource's long-lived main checkout on the runner, sharing it with whatever else runs there (a dirty primary is the next run's starting reality); `ephemeral` provisions fresh worktrees for the listed resources off the runner's per-resource cache, with each resource's setup command run first. Provisioning happens when the first agent step starts. Ephemeral workspaces are deleted on clean completion of the run and kept on failure until the user dismisses the failed run; a re-run provisions fresh ones. Parallel agent steps share the one workspace, allowed and the author's risk, as with a primary. Substrate details in [./03-controller-and-runners.md](./03-controller-and-runners.md).

Branch: `branch` is a template over `inputs` (and `steps`, though nothing has run yet); the default is `hydra/run-<runId>`, always unique. It is the *initial* name only: the runner tracks the worktree by path, so an agent is free to rename the branch to something meaningful and PR creation uses whatever branch is current. Shipped task-driven workflows template `task/{{ inputs.taskId }}`; "task branch" is a convention of those workflows, not a core rule.

## 5. Expressions: CEL

One language, CEL, is used at every condition site. Termination is a property of the language (no user functions, no recursion, comprehensions bounded by input size), evaluation is sandboxed to the supplied context, and the syntax is the one Kubernetes and Google Cloud users and LLMs already know. Rationale and alternatives: `research/expression-language.md` (branch `research/expression-language`).

| Site | Variables | Result |
|---|---|---|
| Start-trigger `filter` | `event` | bool |
| Start-trigger input mapping | `event` | value matching the input's schema |
| Signal-trigger `filter` | `event` | bool |
| Signal-trigger `correlation.event` | `event` | value (string or number) |
| Signal-trigger `correlation.run` | `inputs`, `steps` | value (string or number) |
| Step `condition` (skip) | `inputs`, `steps` | bool |
| Edge `condition` | `inputs`, `steps` | bool |
| Action `params`, agent `prompt` interpolation | `inputs`, `steps` | value |

`inputs` is the run's resolved inputs by name. `steps` is a map of step id (or signal trigger id) to `{ output }`, holding the output of every step that has completed and every signal node that has fired in this run; when a step ran more than once, `steps.<id>.output` is the latest iteration's output. A skipped, dead or not-yet-run step has no entry, so `has(steps.<id>)` is the test for "did it run" (section 4.3). `event` is the event envelope as defined in [./08-events-and-connections.md](./08-events-and-connections.md): `event.kind`, `event.source`, `event.connectionId`, `event.system`, `event.refs`, `event.url`, `event.occurredAt`, `event.payload.*`; `event.raw` is not readable by expressions. `has()` covers presence tests on loosely shaped payloads (`has(event.changes.status) && event.changes.status.new == "done"`).

Evaluator: `@marcbachmann/cel-js` (pure JS, zero dependencies) behind a small Hydra-owned wrapper exposing parse, check and evaluate and nothing else; `@bufbuild/cel` is the named fallback implementation, swappable without touching stored workflows because definitions store CEL source only. Wrapper rules:

- Context variables (`inputs`, `steps`, `event`) are declared `dyn` in v1 so plain JSON numbers work without BigInt friction; typed schemas can come later.
- Every stored expression is checked with the environment's `check()` at save time; parse or type errors reject the save.
- Parse-time structural limits (`maxAstNodes`, `maxDepth`, list and map size, call arity) are set to modest values; conditions are small.
- No async or side-effecting custom functions; the function whitelist is pure.
- Evaluation of one expression is wall-clock guarded as a belt-and-braces measure, since neither implementation meters runtime cost.

Interpolation: action parameter values and agent prompts are templates whose embedded expressions are ordinary CEL over `inputs` and `steps`, delimited `{{ expr }}`: `Fix the failing checks on {{ inputs.prUrl }}. CI said: {{ steps.checks-failed.output.payload.summary }}`. A non-string value renders as JSON. A literal `{{` is written `{{ '{{' }}`. `{{ }}` was chosen over `${ }` because prompts routinely quote code, where `${...}` is common. Only the step `prompt` and string `params` are templates; an Agent's system prompt is a standalone entity with no run to reference and is not interpolated. A template that throws is an `expression-error` (section 4.3).

**Verify at build time:** the exact values of the parse-time limits, and a Hydra-side corpus of representative expressions run in CI against the wrapper (optionally including selected official conformance cases from `@bufbuild/cel-spec`) to pin the subset Hydra relies on.

## 6. The agent-to-graph contract

An agent step's declared `outputSchema` is the whole contract between the agent and the graph: prompts persuade, schemas route. An agent cannot invent a route the graph lacks; work needing a novel route uses an ad-hoc plan (section 9).

With a schema, the runner drives the provider to produce a schema-conforming final result through that provider's native mechanism (Claude Agent SDK `outputFormat`, Codex `outputSchema` on `turn/start`, pi a `submit_result` custom tool with a bounded adapter-owned re-prompt when the agent ends without calling it). `structuredOutput` is a declared provider capability; per-harness mechanics, schema limits and pinned versions are in [./06-providers.md](./06-providers.md), findings in `research/structured-output.md` (branch `research/structured-output`). The runner re-validates the value against the declared schema before reporting it, whatever the harness claims.

Outcomes, one taxonomy across providers:

| Outcome | Meaning | Effect on the run |
|---|---|---|
| `ok` | a schema-valid value was produced | `steps.<id>.output` = the value; routing proceeds |
| `schema-failure` | the harness exhausted its validation retries, or the session ended without a structured result | the step fails; the run fails with reason `schema-failure` |
| `run-failure` | the session failed for an ordinary reason (crash, timeout, interrupted, provider error) | the step fails; the run fails with the session's failure reason |

Without a schema, `steps.<id>.output` is `{ text, exitStatus }`: the final assistant message text and the turn's terminal state (`completed | failed | interrupted`); a turn ending other than `completed` is a `run-failure`.

`schema-failure` is run-failing in v1, not routable: "failure is not redirection" (ticket #13) holds for agent steps as for actions. Routing on it would need an explicit failure output shape the edges can condition on; that is Post-v1, reopened on dogfooding evidence.

The structured output of every agent step is stored on the run's step record (section 7.2). This is what makes a triage agent's verdict (verdict, priority, confidence, grouping, related tasks, suggested step) visible in Intake's proposal detail; the Intake view reads it from the run, never from a separate store ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)).

## 7. Runs

A Run is one execution of an execution plan. Orchestration happens only on the controller: it interprets the plan, schedules steps, places sessions and workspaces on runners, and advances the graph on session and action completion; runners never interpret plans ([ADR 0002](../adr/0002-orchestration-stays-on-the-controller.md)). Runs are rows in the controller database, reloaded on boot; a run whose session is on a disconnected runner waits for the runner to return.

### 7.1 Starting a run

A run is created by: a start-trigger match (the matcher's pending-run effect row), direct manual creation, a `workflow.run` action step in another run, an API call by an actor holding the `workflow.run` grant (assistants do by default), or an unstored definition submitted through `workflow.submit` (section 9). At start the controller:

1. Freezes the plan: copies the workflow's inputs declaration, steps, edges, triggers, workspace policy and placement inputs into the run as an immutable execution plan ([ADR 0001](../adr/0001-runs-freeze-an-execution-plan.md)). Start triggers in the plan are inert record; signal triggers are live.
2. Re-validates the plan (section 1); a plan that no longer validates fails the run at start with reason `validation-error`.
3. Resolves inputs from the trigger's mappings, the manual form, or the caller's explicit values, applying defaults; a `connection` input is checked against the Connection table here.
4. Copies the triggering event, if any, onto the run so event-log pruning never breaks audit.
5. Instantiates a Subscription for every signal trigger in the plan.
6. Starts every step with no incoming edge. The workspace is provisioned, and the runner pinned, when the first agent step starts (section 4.4).

Concurrent runs of one workflow are unlimited in v1; the per-runner session cap queues sessions at placement and the spawn bound limits trigger-driven creation.

### 7.2 The run record

```ts
interface Run {
  id: string
  workflowId: string | null            // null for submitted (unstored) workflows, section 9
  plan: ExecutionPlan                  // frozen: inputs declaration, steps, edges, triggers, workspace policy, placement inputs
  inputs: Record<string, unknown>      // resolved
  workspaceId?: string                 // the run's one workspace, once provisioned (section 4.4)
  runnerId?: string                    // the run's runner, once pinned
  origin:
    | { kind: "trigger"; triggerId: string; eventId: string }
    | { kind: "manual"; actor: Actor }
    | { kind: "action"; parentRunId: string; stepId: string }
    | { kind: "api"; actor: Actor }    // workflow.run or workflow.submit over the API
  triggerEvent?: Event                 // copy of the triggering event
  rerunOf?: string                     // run id this run was re-run from (field name provisional)
  status: "pending" | "running" | "completed" | "failed" | "cancelled"
  failureReason?: FailureReason
  failedStepId?: string                // the step, or for expression-error the step or edge site
  steps: StepRecord[]                  // one per (node, iteration); signal nodes included
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

type FailureReason =                   // closed set, grows additively
  | "validation-error"                 // the plan no longer validated at stamp (section 7.1)
  | "expression-error"                 // a CEL site threw mid-run (section 4.3)
  | "iteration-limit"                  // a capped edge's cap was exhausted (section 4.3)
  | "schema-failure"                   // an agent step produced no schema-valid result (section 6)
  | "step-failed"                      // an action threw; the message is in the step record's error
  | "session-failed"                   // an agent step's session ended abnormally; the session's reason is in error

interface StepRecord {
  stepId: string                       // step id or signal trigger id
  iteration: number                    // 1-based, per node, per run
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled"
  startedAt?: string
  finishedAt?: string
  output?: unknown                     // the declared output; agent structured output lives here; a signal node's mapped event
  sessionId?: string                   // agent steps
  error?: string
}
```

Run status: `pending` (created, not yet started, e.g. queued behind validation or placement), `running`, and the terminal states `completed`, `failed`, `cancelled`. There is no waiting status: a run blocked on a signal is `running` with nothing running or pending and a live subscription, and the UI derives "waiting on `pr-merged`" from that. A run with one branch waiting and another working is `running` either way, which is why a run-level `waiting` would lie. `failed` is terminal: recovery is fixing the workflow, prompt or filter and re-running (section 7.4); resuming a failed run from a step is partial re-run, Post-v1. The user may cancel a run at any time; cancellation ends its subscriptions, cancels its running step records and stops their sessions.

Step records are one per (node, iteration) and their status is monotonic: `pending` (a queued iteration behind a busy step, section 4.3) `-> running -> completed | failed | cancelled`; `skipped` is set at creation and final. A re-entered step never goes back from `completed`; its next iteration is a new record. A signal node gets a `completed` record per firing, holding its output, and none while merely live; a dead step gets none.

The record supports audit replay (walk the exact path a run took into its session transcripts) and re-execution; deterministic replay is a non-goal.

### 7.3 Platform events

At a terminal state the controller emits `run.completed`, `run.failed` or `run.cancelled` into the pipeline; other workflows may trigger on them (this is how a "learning" workflow over run outcomes, or a failure-notification workflow, is built). Cancellation is not a failure: a "notify me on failures" workflow must not fire when the user cancels on purpose, so cancel has its own kind. The payload shapes are owned outright by [./08-events-and-connections.md](./08-events-and-connections.md).

### 7.4 Re-run

Re-run is whole-run only; there is no "re-run failed steps only". Two modes:

- **Re-stamp** (default): create a new run from the current workflow definition with the same resolved inputs. Picks up edits made since.
- **Replay**: create a new run from the original run's frozen plan with the same inputs. Reproduces exactly what ran before.

Both create a new Run that references the original. Re-runs provision fresh ephemeral workspaces; the failed run's kept workspace stays until dismissed. Submitted runs (section 9) can only replay (there is no stored workflow to re-stamp from). Both are the `run.rerun` operation ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)).

### 7.5 Cleanup and supervision

There is no cleanup machinery beyond the substrate's: the run's ephemeral workspace is deleted on success, kept on failure until the failed run is dismissed, and collected by the runner's TTL reaper if orphaned. No automatic retries and no per-workflow concurrency controls (pinned); no run-level timeouts either (this spec's consolidation from "no timeouts" on subscriptions and runner-owned session timeouts). A run's sessions are visible and steerable like any session; steering a running agent step is the ordinary way to correct it mid-flight.

## 8. Built-in actions

Five built-in actions ship in the core, registered into the workflow-action extension point like any plugin contribution but owned by the core. Each is a thin call into the same service layer the public API exposes ([ADR 0013](../adr/0013-agents-operate-hydra-through-the-public-api.md)) and carries the **same id as the operation** it calls ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 1.3); its input and output are that operation's contract schemas, so nothing is reachable through an action that is not reachable over HTTP. The tickets called the notification action `notify`; its id is `notification.create`. This table is the single owner of the catalogue; Task semantics are in [./09-tasks.md](./09-tasks.md), the Notification record and triage-specific usage in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md).

| Action | Input (contract op) | Output | Notes |
|---|---|---|---|
| `workflow.run` | `{ workflowId, inputs }` | `{ runId }` | Fire-and-forget: starts a run of another workflow and returns immediately; does not wait or route on the child's output (that is the post-v1 sub-workflow step). The scheduled-tasks one-step shortcut uses it. |
| `notification.create` | Notification producer input: `{ kind, title, body?, actions?, subject? }` (record and bound-action shape per [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)) | `{ notificationId }` | Creates one core-owned Notification with producer = the run and step; delivery is decided by the core router, never by the step. |
| `task.create` | Task create input: `{ title, description, priority?, labels?, projectId?, provenance? }` | the created Task | Provenance may carry the triggering event id (`inputs.eventId`), the run id and external refs. |
| `task.update` | `{ taskId, ...changes }` | the updated Task | One call, one `task.updated` event with per-field diffs. Appending provenance is an update. |
| `task.query` | `TaskFilter`: `{ refs?, labels?, status?, projectId?, text? }` (any-of within a field, and across fields; [./11](./11-public-api-and-agent-surface.md) section 2) | `{ items: Task[] }` | The same operation agents use. Structured fields match by exact identity: a provenance ref is matched by canonical external ref (`github:issue:owner/repo#42`), never by content; `text` is SQLite FTS over title and description and is normally absent in graphs. The guard-before-agent pattern: `task.query` on the event's refs, an edge on `size(steps.guard.output.items) > 0` to `task.update`, otherwise the agent step. |

GitHub and Gmail actions (for example creating a PR, commenting, fetching a mail body on demand, merging) are plugin contributions of the `github` and `gmail` plugins, invoked as ordinary action steps naming the Connection they act as (`connection.use` grant, [./13-security.md](./13-security.md)). Their exact roster is Open in [./05-plugins.md](./05-plugins.md). Mid-session mailbox access from an agent step is covered in v1 by gmail action steps around it and the session spec's MCP passthrough.

## 9. Ad-hoc workflows

An agent (or the user) may start a run from a workflow definition that is not stored: `workflow.submit { definition, inputs }` ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)), where `definition` is the `Workflow` shape of section 1 minus `id` and timestamps. The controller validates it exactly as a stored workflow (section 1), freezes it into a run with `workflowId: null` and `origin.kind: "api"`, and executes it; `workflow.run` loads a stored definition and takes the same path. The definition lives only on that run; it is never stored as a workflow and nothing else references it. This is how "something weird once" is expressed without user code, and how an agent that needs a route no shipped workflow has gets one ([ADR 0001](../adr/0001-runs-freeze-an-execution-plan.md), [ADR 0008](../adr/0008-workflow-graphs-route-on-declared-outputs.md)). The outside world only ever writes workflows; "execution plan" names the frozen copy on a run and appears in no contract. Graduating a submitted definition into a stored workflow ("save as workflow") is post-v1.

Grant: `workflow.submit`, its own verb, held by the shipped `assistant` profile and withheld from `worker` ([./13-security.md](./13-security.md)).

## 10. The human moment

There is no human-gate step in v1. What covers a workflow needing a person:

- **Failure notifications plus re-run.** A failed run is a core Notification and a `run.failed` platform event; the user reads the run record, fixes the workflow, prompt or filter, and re-runs.
- **An explicit verdict.** A triage-style agent step declares an `unsure` (or similar) value in its output enum; an edge routes it to a `notify` step and the run ends. The person acts out of band: tells an assistant to proceed, or clicks a bound action on the Notification that starts the next workflow with the task attached. No run waits for a human.
- **Steering.** A running agent step is an ordinary Session; the user can steer it, answer its approval requests (access modes) and its Permission Requests ([./13-security.md](./13-security.md)), none of which block the graph.

Whether a gate step earns a return is a post-dogfooding question: it needs a known shape for the question a workflow can pose upfront.

## Post-v1

- Human-gate step; returns post-dogfooding once the question shape is known. Kept possible: steps are a closed tagged union that can grow a third kind.
- Sub-workflow steps that wait and route on the child's output; v1 has fire-and-forget `workflow.run` only.
- Graduation ("save as workflow") of a submitted workflow; kept possible because a submitted definition already has the stored-workflow shape.
- Per-workflow concurrency controls; automatic retries; partial re-run ("failed steps only").
- Execution-plan snapshot dedup by content hash, only if per-run plan copies ever hurt.
- Typed CEL environments (schema-typed `inputs`/`steps` instead of `dyn`) for stronger save-time checks.
- Routing on `schema-failure` as an output rather than a run failure, if dogfooding shows the need (section 6).
- Coalescing queued firings into one iteration, and steering a running agent step with a signal instead of queueing it (section 4.3). On the record as likely needed: a PR-check-monitoring workflow that processes one check result per turn is slow and expensive. The research ticket on how Claude Code routines feed CI events into a running session informs the design.
- Named workspaces per run (`workspaces: Record<name, WorkspacePolicy>`, steps naming one), if a run that needs two workspaces ever appears (section 4.4).
- Holding events that arrive before their correlation key exists (section 2.4), by replaying the log against later run state.
- Including `event.raw` in a signal node's default output (section 2.4).

## Sources

Tickets:

- Workflow model: recipes, triggers, human gates - https://github.com/rogierpennink/hydra/issues/13
- Workflow execution semantics: joins, signals, errors, run states - https://github.com/rogierpennink/hydra/issues/36
- Research: TypeScript-native expression language for workflow conditions - https://github.com/rogierpennink/hydra/issues/27
- Research: structured output across provider harnesses - https://github.com/rogierpennink/hydra/issues/28
- Triage engine & user-set bounds - https://github.com/rogierpennink/hydra/issues/15
- Event & trigger ingress design - https://github.com/rogierpennink/hydra/issues/14
- Domain model & ubiquitous language - https://github.com/rogierpennink/hydra/issues/6
- Controller/runner architecture: registration, placement, scheduling - https://github.com/rogierpennink/hydra/issues/7
- Runner execution substrate - https://github.com/rogierpennink/hydra/issues/8
- Plugin architecture: API shape, loading, dogfooding - https://github.com/rogierpennink/hydra/issues/11
- Provider adapter interface - https://github.com/rogierpennink/hydra/issues/12
- Agent-operates-system surface - https://github.com/rogierpennink/hydra/issues/16
- Security & secrets model - https://github.com/rogierpennink/hydra/issues/18
- Assemble the v1 spec (Intake constraint: stored triage verdict) - https://github.com/rogierpennink/hydra/issues/21
- Task model: shape, status axis, lifecycle, provenance - https://github.com/rogierpennink/hydra/issues/29
- Prototype: the Intake view - https://github.com/rogierpennink/hydra/issues/30

ADRs: [0001](../adr/0001-runs-freeze-an-execution-plan.md), [0002](../adr/0002-orchestration-stays-on-the-controller.md), [0008](../adr/0008-workflow-graphs-route-on-declared-outputs.md), [0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md), [0011](../adr/0011-triage-is-a-workflow-pattern-inside-core-enforced-bounds.md), [0013](../adr/0013-agents-operate-hydra-through-the-public-api.md), [0019](../adr/0019-the-task-model-is-thin-workflows-own-task-semantics.md).

Research: `research/expression-language.md` (branch `research/expression-language`), `research/structured-output.md` (branch `research/structured-output`).
