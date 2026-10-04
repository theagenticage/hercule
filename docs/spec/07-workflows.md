# Workflows

A Workflow is a stored, editable, declarative source of execution plans: typed inputs, one or more triggers, a graph of steps and edges, and CEL conditions that route between them. A Run freezes a workflow's content into an immutable execution plan at start, resolves its inputs, and executes the graph on the controller in one workspace on one runner; only two step kinds exist (action steps that invoke plugin-contributed actions, agent steps that drive a Session), all routing lives in the graph over declared step outputs, and cycles are bounded by construction. This document is normative for the definition shape, trigger kinds, step kinds, routing, joins, skips and cycles, the expression language at every condition site, the run record and its lifecycle, the agent-to-graph output contract, the built-in action catalogue, and how spawn bounds and the human moment appear from the workflow's side. Event ingestion and matching live in [./08-events-and-connections.md](./08-events-and-connections.md); triage topology, breaker semantics and Notifications in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md); provider mechanics in [./06-providers.md](./06-providers.md).

## 1. Definition

A workflow is data in the controller database, created and edited through the public API and the web app ([./14-web-app.md](./14-web-app.md) owns the editor: schema-validated structured text plus a read-only DAG preview). There is no user-authored code in a workflow and no repo-local definition; expressiveness comes from agent steps and plugin-contributed actions ([ADR 0008](../adr/0008-workflow-graphs-route-on-declared-outputs.md)). Editing a workflow never affects in-flight runs, because every run executes its own frozen copy ([ADR 0001](../adr/0001-runs-freeze-an-execution-plan.md)); there is no workflow versioning. *(Amended 2026-10-05, [#89](https://github.com/theagenticage/hercule/issues/89).)* Nor does disabling a plugin, or a plugin failing to start: a run that has already started still executes that plugin's actions ([./05-plugins.md](./05-plugins.md) section 8). A new run or a save that names those actions is still refused (below). A step whose action no loaded plugin registered fails with `not_found`.

**The stored form of a workflow is its YAML source** (resolved 2026-09-01, [Web app details](https://github.com/theagenticage/hercule/issues/45), [ADR 0029](../adr/0029-workflow-definitions-are-stored-as-their-yaml-source.md)): the text the user wrote, kept byte for byte, so comments, key order and formatting survive every save and a git-versioned future round-trips exactly. The `Workflow` shape below is what the controller *parses* the source into - a derived column recomputed on every write and never written on its own - for validation, the editor's preview and stamping; a run's frozen plan holds the parsed form only. The public API accepts either the source or a definition object and always stores source: an object is rendered to canonical YAML by one deterministic rule (contract key order, a block scalar for any string containing a newline, double quotes for anything else that needs quoting, two-space indent) so two controllers render identically. `workflow.read` returns the source, never a parsed object ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2). Three fields of the shape are **row state outside the text** - `id`, `enabled` and the timestamps - and so is each start trigger's `status`, keyed by `(workflowId, triggerId)`: a breaker trip or an enable toggle must never rewrite the user's file.

Names pinned by the tickets are used verbatim (`maxTraversals`, `freshSession`, `iteration-limit`, cron `schedule`/`timezone`, action ids). Other field names below are this document's consolidation and are normative for the implementation; the concepts behind them are the tickets'. The execution semantics (joins, skips, signal nodes, terminal steps, errors, run and step states, one workspace per run) were pinned by [Workflow execution semantics](https://github.com/theagenticage/hercule/issues/36).

```ts
interface Workflow {
  id: string
  name: string                         // one line of plain text, at most 128 characters
  description?: string
  enabled: boolean                     // row state, not in the source; false = no trigger of this workflow matches (pausing a workflow covers quiet hours)
  inputs?: InputDeclaration[]
  triggers?: Trigger[]                 // >= 0 start triggers, >= 0 signal triggers
  steps: Step[]
  edges?: Edge[]
  workspace?: WorkspacePolicy          // the one workspace every agent step of a run works in (section 4.4); absent = no checkout
  createdAt: string
  updatedAt: string
}

interface InputDeclaration {           // exactly one of `schema` and `connection`
  name: string                         // a CEL identifier (below); referenced as inputs.<name>
  schema?: JsonSchema                  // draft-07; scalar, object or array
  connection?: { type: string }        // the qualified Connection type, "github/github"; the value is a Connection id of that type (section 3)
  required: boolean
  default?: unknown
}
```

*(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* The block above is now the shape as shipped. It changed in four places, each to the spelling the contract already had for the concept or to what exists today:

- `inputs`, `triggers` and `edges` may be left out, and so may `workspace`: a workflow with no `workspace` runs each agent step with no checkout, which is what `{ kind: "none" }` was (section 4.4).
- `runner?` is gone for now. No placement by runner capability and no explicit runner exist yet; the field joins additively with ~~the run engine ([#79](https://github.com/theagenticage/hercule/issues/79), [#80](https://github.com/theagenticage/hercule/issues/80))~~ agent steps in runs ([#83](https://github.com/theagenticage/hercule/issues/83)) *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79): a run of action steps needs no runner, so the run engine did not add it)*.
- An input is one object with exactly one of `schema` and `connection`, so a mistake in either is named at its own field and not at the whole input.
- `connection.type` is the qualified Connection type, `github/github`, as everywhere else ([./05-plugins.md](./05-plugins.md) section 1).

In the contract the parsed shape is `WorkflowDefinition`: the block above less `id`, `enabled` and the timestamps, which are row state. `workflow.read` answers those beside `source`, and ~~`workflow.submit`~~ `run.start` *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))* (section 9) takes a `WorkflowDefinition`. Every object in it refuses a key it does not declare, because a misspelt key would otherwise be dropped and the stored workflow would do something other than what its text says. A workflow is created with `enabled: false`; only `workflow.update { enabled: true }` turns it on. `updatedAt` is when the text last changed: turning a workflow on or off, or saving the same text again, does not move it, so a list sorted by it keeps its order when a workflow is switched; the audit log records each toggle. The canonical render has one exception to the rule above: a string that a block scalar cannot hold exactly (whitespace and line breaks only, or a control character) is double-quoted. No line is folded, and the keys an author chooses (`params`, schemas, a trigger's mappings) keep the order they were sent in.

*(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* **Ids and names are what an expression can read.** An expression reads a step or a signal trigger as `steps.<id>`, an input as `inputs.<name>` and a signal output as `steps.<id>.output.<name>`. CEL reads `steps.open-pr.output` as `steps.open - pr.output`, which passes the check at save and fails when a run evaluates it. So every step id and trigger id matches `^[a-z][a-z0-9_]*$`, and the refusal suggests the snake_case spelling (`open_pr`). Every input name and signal output name matches `^[A-Za-z_][A-Za-z0-9_]*$`; case is free there, because such a name is a field name (`prUrl`). A word that CEL cannot read as a field name is refused too: `in`, `true`, `false` and `null`, and `constructor` and `__proto__`, which the evaluator cannot read back as fields. Steps and triggers share one set of ids, because both are read as `steps.<id>`; a repeated id is refused at the later one. The examples in this document were written with hyphens and are corrected to snake_case.

A workflow can be as small as one trigger plus one step. Steps reference inputs and earlier step outputs by expression (section 5) inside conditions, action parameters and agent prompts.

`enabled: false` stops the workflow's triggers and nothing else: a disabled workflow may still be run manually (direct run creation is explicit intent, and the usual way to test a fix before re-enabling).

### Validation at save

The controller validates a definition when it is saved and again when a run is stamped from it (section 7.1). Validation fails loudly with the offending element named. Checks:

- Graph: every edge references existing steps or signal nodes; no edge leads *into* a signal node (section 2.4); every cycle contains at least one edge with `maxTraversals` (section 4.3); no step inside a cycle carries `join: "all"` (section 4.3). Two edges with the same `from` and `to`, and `join: "all"` on an entry step, are refused too (section 4.3) *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80))*.
- Expressions: every CEL expression at every site parses and type-checks in the environment declared for that site (section 5).
- Actions: every action step names a contribution present in the persisted contribution catalogue whose plugin is enabled; parameters validate against the contribution's declared input schema. Disabling a plugin makes every workflow referencing its contributions fail validation ([./05-plugins.md](./05-plugins.md)).
- Agents: every agent step names an existing Agent; a declared output schema is valid JSON Schema draft-07 and lints clean against the common strict subset of all three providers, regardless of which provider the step's agent runs on (the OpenAI strict subset is the binding constraint: `additionalProperties: false`, all properties required; the full per-harness limits are in [./06-providers.md](./06-providers.md)). Linting at validation time beats a turn failure at run time and keeps a workflow portable across agents.
- Triggers: a start trigger names its Connection selection explicitly (section 2.1); a cron trigger carries `schedule`; every input mapped by a trigger exists; every required input without a default is mapped by every start trigger.
- Inputs: a `connection` input's `default`, when present, names an existing Connection of that type.

One **warning**, not an error: a graph with signal nodes and no `terminal` step (section 4.3) can only end by cancellation. The editor shows it; the save succeeds, because "keep fixing checks until I cancel" is a legitimate workflow.

*(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* The checks as built add these to the list above. Each problem is an issue `{ path, message }` whose path points into the definition (`["steps", "1", "action"]`); a YAML syntax problem has an empty path and names its line and column. A refusal names every problem it finds, up to 100, and one more issue that counts the rest. The checks that read CEL or the controller's data (expressions, actions, agents, Connections, the graph) run only once the text parses into the shape, so a text with a syntax or shape problem is refused for that first. `workflow.validate` runs the same checks and answers `{ errors, warnings }` ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2).

- Text: YAML anchors, aliases, tags and directives are refused at their place. Each one makes a value other than what the text visibly says, and an alias makes one place in the text stand for several places in the definition, so a path could not lead the editor back to one place. `<<` is an ordinary key, so there are no merge keys. A key that repeats an earlier key of its mapping (`1` and `"1"` are one key) is refused, and so is a key that is a mapping or a list. Refusing these now and allowing them later breaks no stored file; the other order would.
- Ids and names: the rule above.
- Expressions: a filter, a step condition and an edge condition must give a bool. One whose type is known and is not `bool` is refused; one whose type is known only at run time is accepted.
- Templates: the `prompt` and every string inside `params` that holds `{{`, at any depth, are templates (section 5). Each of their expressions is checked in the scope of a run, and an unclosed `{{` is refused.
- Actions: an action step names a built-in action, or an action of a plugin that is enabled and started; the refusal lists the actions that can be named. The params rule: every param the action requires is present, and a key its input does not declare is refused, at any depth. A literal value is decoded against its field's schema, together with any rule the input carries as a whole (a `task.update` names a field to change). A template is accepted for a field of any type, because its value is known only when the run renders it, except where the field takes no value at all.
- Triggers: an event kind is a core kind or a kind of a plugin that is enabled and started (section 2.1). A plugin's kind names a Connection or `any`, and a named Connection exists and has the kind's Connection type; a core kind names none. A `Schedule` has a five-field `schedule`, with no field for seconds, that parses and comes due at least once; its `timezone` is a known IANA zone. *(Amended 2026-09-29, [#276](https://github.com/theagenticage/hercule/issues/276): the rules that kept `schedule` and `timezone` off other kinds, and a signal trigger off `cron.tick`, are gone, because the shape of `on` rules those out.)*
- Inputs: a Connection input's `connection.type` is a Connection type of a plugin that is enabled and started.
- Graph: an edge from or into a start trigger is refused, because a start trigger starts runs and does not continue one. The entry-step rules of section 4.3 apply.

The warning has the path `["steps"]`. A save answers it beside the stored workflow, and `workflow.validate` answers it in `warnings`.

*(Amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257).)* Two checks read where an action runs (`runsIn`, section 8). They run at `workflow.create`, `workflow.update` and `workflow.validate`, and on a definition sent with `run.start`:

- A step that calls a workspace action, in a workflow with no `workspace` policy, is refused at that step: the action would have no workspace to run in.
- A git action in a workflow whose policy has no checkout (`ephemeral` with `checkouts: []`) is refused at that step: it would have nothing to work in.
- A git action without `resourceId`, in a workflow whose policy has more than one checkout, is refused at that step: the checkout it works in would be ambiguous.

These are decided by the definition alone, because a policy's checkouts are written out and never rendered from a template. A `resourceId` that is not in the run's workspace is not checked at save, because the param can be a template. The step fails when it runs, with the code `validation` (section 7.2).

*(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* A plugin action may declare a Connection type of its own plugin. A step names the Connection in `params.connection`, as a literal id or a template; that param is validated at save, a disabled literal is refused at start (section 7.1), and the param never reaches the action's input. The checks at save:

- The param is required, and must be a string.
- A literal must be the id of an existing Connection of the action's type. Whether it is disabled is not checked at save.
- A template that is exactly `{{ inputs.<name> }}` must name a Connection input of the action's type. ~~Any other template is accepted, because its value is known only when the run renders it.~~
- *(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* Any other template is refused, so the Connection a step acts through is known before a run starts: the param is a literal Connection id, or exactly one Connection input of the action's type.
- *(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* Saving a workflow with such a step, with `workflow.create` or with an `update` that sends a new definition, needs the `connection.use` grant beside `workflow.write`, whether the param is a literal or an input. Without it the save is refused with `forbidden` after the definition validates. An `update` that changes only `enabled` is not checked, and neither is `workflow.validate`, which stores nothing ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2).

### Invalid after the fact

A stored workflow can stop validating without being edited: its plugin is disabled, its agent or a Connection named in a default is deleted. The controller re-validates every workflow that references the mutated thing at the moment of the mutation. A workflow that fails is marked **invalid**: a health warning on the workflow, one Notification, and its start triggers no longer match while it is invalid (matched events show as ignored in the events view, [./08-events-and-connections.md](./08-events-and-connections.md)). A manual run of an invalid workflow is rejected with the validation error. The mark clears on the next successful validation (the plugin is re-enabled, or the workflow is saved with a fix). Runs are never spawned only to fail at stamp: one notification, not a failed-run flood.

*(Amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82).)* The invalid mark is not built yet, and neither is the events view that shows matched events as ignored. Until they are, a start trigger of a workflow that no longer validates still matches, and each match writes a run that fails at once with `validation-error` (section 7.1).

## 2. Triggers

A workflow owns its triggers; there is no standalone routing entity. Triggers are rows in their own table, queryable independently of the workflow (a scheduled-tasks view is a query over cron triggers). A workflow may carry several start triggers and several signal triggers.

```ts
type Trigger = StartTrigger | SignalTrigger

interface EventSelector {               // the events a trigger accepts
  kind: string                         // event kind: "github.issue.opened", "task.updated"; the part before the first dot is a namespace, not always the Event Source
  connectionId?: string | "any"        // required for plugin-emitted kinds: a Connection id or a deliberate "any"; absent for core-emitted kinds
  filter?: CelExpression               // over `event`; bool
}

interface Schedule {                    // when a cron trigger fires; no filter, the cron expression already sets when
  schedule: string                     // five-field cron expression
  timezone?: string                    // IANA zone; the user's timezone setting when omitted
}

interface StartTrigger {
  id: string                           // unique inside its workflow; section 1 for the form
  kind: "start"
  on: EventSelector | Schedule         // a Schedule makes it a cron trigger
  inputs?: Record<string, CelExpression> // input name -> expression over `event`
  spawnBound?: { maxRuns: number; windowSeconds: number }   // default ~30 per hour
  status: "active" | "paused"          // row state keyed by (workflowId, triggerId), not in the source; paused by the user or by a tripped breaker; enable/disable lives on the Workflow
}

interface SignalTrigger {
  id: string                           // referenced as steps.<id> once it has fired (section 2.4)
  kind: "signal"
  on: EventSelector                    // events only: a signal trigger never fires on a schedule
  correlation: {
    event: CelExpression               // over `event`; value-producing
    run: CelExpression                 // over `inputs`, `steps`; value-producing
  }
  outputs?: Record<string, CelExpression>   // output name -> expression over `event`; absent = the whole envelope minus raw
}
```

A trigger's `on` has one of two shapes:

```yaml
# Accepts events
on:
  kind: github.issue.labeled
  connectionId: any
  filter: event.payload.label == "ready-for-agent"

# Fires on a schedule
on:
  schedule: "0 9 * * 1-5"
  timezone: Europe/Amsterdam   # optional; the user's timezone setting when absent
```

`EventSelector` is defined here because workflows own triggers; the matcher in [./08-events-and-connections.md](./08-events-and-connections.md) evaluates it (kind matches, Connection selection admits `event.connectionId`, filter true). The persisted kind catalogue that `kind` is validated against is registered by plugins and core emitters ([./08-events-and-connections.md](./08-events-and-connections.md)).

*(Amended 2026-09-29, [#276](https://github.com/theagenticage/hercule/issues/276).)* **`on` replaces `source`.** A trigger's matching fields used to sit under `source:`, and a cron trigger's `schedule` and `timezone` sat beside it at the trigger level, with `source.kind: cron.tick`. `source` was the wrong name: an Event Source is where an event comes from, and the field held a description of the events the trigger accepts. The split shape also let the event kind and the schedule disagree, so four save checks refused the bad combinations. Now:

- `on:` is an `EventSelector` or a `Schedule`. A start trigger takes either; a signal trigger takes only an `EventSelector`. A `Schedule` has no `filter`.
- The schema rules out a schedule beside an event kind, so the four checks are gone: a `schedule` or a `timezone` on a trigger that is not on `cron.tick`, a trigger on `cron.tick` with no `schedule`, and a signal trigger on `cron.tick`. The schedule's own checks stay (section 1).
- `cron.tick` is no longer a kind a trigger can name. An `EventSelector` with `kind: cron.tick` is refused as an unknown kind, with a hint to write `on: schedule:` instead.
- Nothing changes underneath. The Scheduler still appends a `cron.tick` event through the one pipeline ([ADR 0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)), a run keeps it as its triggering event, and an input mapping still reads `event.payload.scheduledFor` and `event.payload.previousFiredAt`. A tick still reaches only the trigger its payload names (section 2.1), and a cron trigger's row still stores the event kind `cron.tick`, but both are internal details an author never writes.
- `trigger.query` follows the same split. Its items carry `on` in place of the flat `eventKind`, `connectionId`, `filter`, `schedule` and `timezone`. Its filter gains `on: "event" | "schedule"`, so `on: "schedule"` lists the cron triggers; `eventKind` matches only triggers that accept events ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2).
- There is no compatibility path. A workflow written with `source:`, or with `schedule` or `timezone` at the trigger level, is refused with an error that says to write them under `on:`.

*(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* **A trigger is identified by `(workflowId, triggerId)`**, where `triggerId` is the `id` written in the source. No other id is minted, and a trigger id is unique only inside its workflow, as a job id is inside a GitHub Actions file. A later operation that names one trigger takes both. Each save reconciles the trigger rows in the transaction that stores the workflow:

- a trigger whose id stays keeps its row, its `status` and its `createdAt`; its other fields (its `on`: event kind, Connection selection and filter, or schedule and timezone) are computed again from the source;
- a removed id loses its row;
- a new id gets a row, `active` for a start trigger. A signal trigger's row has no status.

A trigger whose id stays but whose `kind` changes, start to signal or back, is a new trigger: new `createdAt`, and `active` again if it is a start trigger. A start and a signal trigger are different things, and a signal trigger has no status to keep. A start trigger may leave out `inputs` (it maps nothing) and `spawnBound` (the default bound applies, section 2.5).

*(Amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82).)* A save also clears the `health` of every start trigger whose definition it changes, because the error it recorded was about the definition being replaced (section 2.1). A trigger the save leaves as it was keeps its error, which is still true of it. A cron trigger whose schedule or timezone changes, or that changes between a `Schedule` and an `EventSelector`, loses its next fire time, and the Scheduler computes it again (section 2.2). Its `status` stays, so a paused trigger stays paused.

### 2.1 Start triggers

A start trigger fires on events or on a schedule (section 2.2). One that fires on events has a static condition, its `EventSelector`: the event kind, the Connection selection and the optional CEL `filter`. When a persisted event matches an enabled workflow's active start trigger, the matcher inserts a pending-run effect row for it in the same transaction that advances its cursor ([ADR 0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md); mechanics in [./08-events-and-connections.md](./08-events-and-connections.md)). One event may start any number of runs across workflows and signal any number of live subscriptions; delivery is non-exclusive.

Connection selection is explicit: a named Connection or a deliberate `"any"`. Silent all-connections matching does not exist. Triggers on core-emitted events (cron, manual, platform) have no Connection; `connectionId` is absent for them.

A filter or mapping expression that throws evaluates as no-match and records a visible health warning on the trigger; it never stops the pipeline.

*(Amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82).)* **Start triggers as built.** The event router ([./08-events-and-connections.md](./08-events-and-connections.md) section 4) has a routing table for triggers, with one route per active start trigger of an enabled workflow.

- **Admitting an event.** A route admits an event when its kind is the trigger's event kind (`on.kind`, or `cron.tick` for a cron trigger) and its Connection is the one the trigger names. A trigger that names `"any"`, or no Connection, admits every Connection. A `cron.tick` is admitted only when the Scheduler emitted it (source `cron`), and only by the trigger its payload names. The `filter` then decides.
- **The trigger effect.** On a match, the router evaluates the trigger's `inputs` over `event` and writes a **trigger effect**: a row `pending`, holding the mapped inputs, unique on `(workflowId, triggerId, eventId)`. A mapping that fails is a no-match, like a failing filter.
- **Starting the run.** A separate delivery reads the `pending` effects in arrival order. For each one, in one transaction, it starts the run (section 7.1) and marks the effect `spawned` with the run's id. An effect whose event has been pruned from the log, or whose trigger was paused or its workflow disabled since the match, is marked `discarded`, and the reason is logged. A start that fails because the database was busy or could not be opened leaves its effect `pending`, and the next pass tries it again. Any other failure, such as a constraint the database refuses or a bug in the controller, would fail the same way on every try, so its effect is marked `discarded` too, and the failure is recorded on the trigger's `health`. A run that starts clears an error its trigger's last start recorded. One effect that fails to start holds up no other. The router only writes rows, so a run that is slow or fails to start never holds up the routing of the next event.
- **Paused triggers and disabled workflows** have no route. An event that arrives while a trigger is paused, or while its workflow is disabled, is not evaluated against it and starts no run later.
- **Health.** The warning is the trigger's `health`, `ok` or `error` with a message and a time. It records the last failure of a filter or mapping, of a cron schedule (section 2.2) or of a run's start, and which of the three failed, since only the same one clears it; [./08-events-and-connections.md](./08-events-and-connections.md) section 4 has the rules. Only start triggers have one.

Event kinds a start trigger can name in v1: GitHub and Gmail events from their plugins, ~~`cron.tick`~~ *(a schedule is written as a `Schedule` since 2026-09-29, [#276](https://github.com/theagenticage/hercule/issues/276))*, manual synthetic events, and the platform events `run.completed`, `run.failed`, `task.created`, `task.updated` ([./08-events-and-connections.md](./08-events-and-connections.md) owns the envelope and catalogue).

*(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* The kinds a trigger can listen for are one catalogue. `eventKind.query` returns it and validation reads it: the **core kinds** ~~`cron.tick`,~~ `run.completed`, `run.failed`, `run.cancelled`, `task.created` and `task.updated`, and the kinds of every plugin that is enabled and started. A manual synthetic event has no kind of its own; it carries whatever kind its caller gives it. ~~A signal trigger cannot name `cron.tick`: the Scheduler starts runs with its ticks and never signals a live run with one, so such a trigger could never fire.~~ *(Amended 2026-09-29, [#276](https://github.com/theagenticage/hercule/issues/276): `cron.tick` is not in the catalogue, so no trigger can name it. A cron trigger writes `on: { schedule, timezone? }` instead. `cron.tick` stays a core kind in two senses: no plugin can declare a kind with its name, and its events appear in the event log.)* The catalogue's rules are in [./08-events-and-connections.md](./08-events-and-connections.md) section 2.

### 2.2 Cron

Cron is a core emitter, not a plugin. The schedule is trigger configuration: a **cron trigger** is a start trigger whose `on` is a `Schedule`, `{ schedule, timezone? }` (timezone per trigger; when omitted, the **user's timezone setting**, the one spec-wide timezone source pinned in [./12-assistants.md](./12-assistants.md) section 5.2 - there is no separate controller timezone). The core **Scheduler** emits `cron.tick { workflowId, triggerId, scheduledFor, previousFiredAt }` (`previousFiredAt` = when this trigger last actually fired, `null` on the first tick; the shipped Triage workflow maps it to its `since` input) through the pipeline and the matcher routes it by trigger id, so no filter is needed. Ticks missed while the controller was down are skipped with a visible note. The same Scheduler also fires assistant Scheduled Wakes (heartbeat, reminders), which never enter the pipeline ([./12-assistants.md](./12-assistants.md) section 8, [ADR 0024](../adr/0024-assistants-are-woken-by-the-scheduler-not-by-workflows.md)). A "scheduled task" form in the UI is sugar over creating a workflow with one cron trigger and one step, or adding a cron trigger to an existing workflow.

*(Amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82).)* **Cron as built.** The Scheduler looks at the cron triggers every second. Each cron trigger row keeps its next fire time, the timezone that time was computed in, and when it last fired. The timezone is the trigger's `timezone`, else the user's timezone setting, else UTC while the user has set none. Each trigger is handled in its own transaction:

- A trigger with no next fire time yet, or whose timezone changed since it was computed (for example because the user changed the timezone setting), gets its next fire time computed, and does not fire.
- A trigger that is paused, or whose workflow is disabled, does not fire. Its next fire time moves on without a note, because nothing was missed.
- A trigger whose next fire time has come fires for the **latest** scheduled time that has come, if that time came due at most 60 seconds ago: one `cron.tick` is appended to the event log, with `occurredAt` equal to `scheduledFor` and the dedup key `<workflowId>/<triggerId>/<scheduledFor>`. The trigger's last fire time becomes `scheduledFor`. Scheduled times before the latest one, if any, were missed.
- When even the latest scheduled time is more than 60 seconds late, nothing fires, because the controller was not running at that time.
- The trigger records the stretch of scheduled times it missed, `{ from, until }`, as its visible note. Only the latest stretch is kept. There are no catch-up runs. For example, a trigger due at 09:00 every day on a controller that was down from Monday 08:00 to Wednesday 09:00:30 fires once, for Wednesday 09:00, and notes Monday to Tuesday as missed.
- A trigger whose timezone is not a known one gets no next fire time and never fires. Saving a workflow and writing the timezone setting both refuse an unknown timezone, so this happens only when a newer timezone database drops a known one. The error is recorded on the trigger's `health`, once, and cleared when a later pass computes the next fire time in a known timezone.
- The trigger is read again in the transaction that fires it, so a save, pause or delete between the Scheduler's listing and the firing is never overridden.
- Daylight saving time moves the local clock, and the Scheduler follows it. When the clocks go back, a local time that occurs twice fires once, at its first occurrence, and the repeated hour's second pass fires nothing: a schedule every 30 minutes in Europe/Amsterdam fires at 02:30 summer time and next at 03:00 winter time. When the clocks go forward, a local time that does not exist fires at the same minute an hour later: a schedule for 02:30 fires at 03:30 that day.

`trigger.query` returns the next fire time, the last fire time and the missed stretch, and every change is announced on the live topic `workflow`.

### 2.3 Manual

Manual is two things. Direct run creation (API or web app) starts a run of a workflow with no triggering event; it prompts for the workflow's declared inputs. The synthetic-event API injects an event into the pipeline, where it matches triggers like any other event (for testing triggers, and for agents poking subscriptions).

### 2.4 Signal triggers

A signal trigger resumes a live run mid-graph. Its static part is the same `EventSelector` as a start trigger; its dynamic part is the correlation pair: the event-side expression and the run-side expression must produce equal values. When a run starts, the controller instantiates one Subscription per signal trigger in the plan. Correlation evaluates lazily at match time against the run's current state (`inputs` and the outputs of steps completed so far); a run-side reference that does not resolve yet is a no-match, and no resolvability analysis is done. The subscription lives until the run reaches a terminal state and has no timeout: a run waiting forever is visible and cancelable, so workflows are designed to end at the right moment (correlate on PR merged, not PR opened).

**A signal trigger is a source node in the graph.** It has outgoing edges and never incoming ones (validation rejects an edge into it). It is live from run start; each time its subscription matches, it fires: a step record is written for it (status `completed`, section 7.2, holding its output) and every outgoing edge whose condition holds fires, exactly as when a step completes. It may fire any number of times per run; `maxTraversals` on its outgoing edges bounds what that can do, the same cap that bounds cycles. Ordering comes from correlation, not from edges: a signal that correlates on `steps.open_pr.output.prNumber` cannot match before `open_pr` has completed, which is why the node needs no incoming edge to "wait after" a step. The pattern:

```
implement (entry: true) -> open_pr
[checks_failed]  correlation.run: steps.open_pr.output.prNumber  -> implement    maxTraversals: 3
[pr_merged]      correlation.run: steps.open_pr.output.prNumber  -> task_done    (terminal step)
```

*(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* `implement` carries `entry: true`. Every step of the pattern has an incoming edge, so without the flag a run of it would start no step (section 4.3).

`checks_failed` firing into `implement` is an ordinary re-entry of `implement` (section 4.3): the next turn of its session, with the prompt re-rendered from `steps.checks_failed.output`. That is how a run "revives" a finished step on new information, visibly and bounded. Steps never hold subscriptions of their own; only sessions do, and a session's subscriptions are the agent's own doing through the `hercule` CLI, not the plan's ([./08-events-and-connections.md](./08-events-and-connections.md) section 7.2).

**Output.** `outputs` maps event fields onto `steps.<signalId>.output` with expressions over `event`, the same mechanism as a start trigger's input mapping. When `outputs` is absent, the output is the whole event envelope as expressions see it (`kind`, `source`, `connectionId`, `system`, `refs`, `url`, `occurredAt`, `payload.*`; never `raw`). The default is the loose shape because an agent step is the usual consumer and copes with it; a human pre-mapping every field is the exception. Section 3's "the raw event never enters the plan" therefore reads: not unless the author asks, and `raw` (the provider's untouched body) never.

**Limitation, on the record:** an event that arrives before its correlation key exists in run state is a no-match and is gone; the matcher never replays past events against later run state. In practice the key (a PR number) appears in the same step that creates the thing the event is about, so the window is negligible. An agent that creates an artifact mid-session and wants its events before the step ends uses a session-held subscription.

### 2.5 Spawn bounds

Every start trigger carries a spawn bound: the number of runs it may spawn per window, default about 30 per hour, configurable per trigger. Signal triggers do not spawn runs and carry none. Exceeding the bound trips a breaker: the trigger's `status` becomes `paused`, events that matched but did not spawn are held visibly against the trigger, a Notification is raised, and the user resumes with one click, optionally discarding the backlog. Nothing is dropped silently, and a tripped breaker is the intended review moment. Breaker semantics, the held-event view and the Notification are specified in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) ([ADR 0011](../adr/0011-triage-is-a-workflow-pattern-inside-core-enforced-bounds.md)). Spawn bounds are the only core-enforced bound in v1: there are no run caps, spend gates or quiet hours (pausing a workflow or trigger covers quiet hours).

*(Amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82).)* Spawn bounds are not built yet ([#87](https://github.com/theagenticage/hercule/issues/87)). A start trigger starts a run for every event it matches, and a `spawnBound` in the source is accepted and not enforced. Only the user pauses a trigger, with `trigger.pause`, and `trigger.resume` takes no `discardHeld` ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2). Nothing is held: the events a paused trigger would have matched start no run, before or after it is resumed.

## 3. Inputs

A workflow declares typed inputs. A start trigger maps event fields onto them with CEL expressions over `event`; the raw event is visible to the trigger's filter and mapping and nowhere else. It never enters the plan: steps see `inputs.*`, not `event`. (The run record separately copies the triggering event for audit; that copy is not readable by expressions.) Manual runs prompt the user for declared inputs; ~~`workflow.run`~~ `run.start` *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))* action steps and ad-hoc plan runs pass them explicitly. Defaults fill unmapped optional inputs; a required input left unresolved fails stamping.

Connections flow through inputs: an outbound action names the Connection it acts as, and that id may be mapped from the triggering event's `event.connectionId` into an input, then referenced by the action's parameters (`inputs.connection`).

A Connection input is **first-class**: the declaration says ~~`connection: { type: "github" }`~~ `connection: { type: "github/github" }` *(amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78): the qualified Connection type, as everywhere else)* instead of a JSON schema, the value is a Connection id, and stamping validates that the Connection exists, is of that type and is not disabled, so a dead Connection fails at start rather than at step four. The manual-run form renders a Connection picker for it. A trigger with no event Connection (cron, manual) fills it from the declaration's `default` or a literal in its mapping (`'conn_abc'`). An action step may also name a Connection id literally in its `params` when the workflow only ever acts through one. *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* The param is `connection` (section 1). A literal names the Connection the step always acts through, and a template such as `{{ inputs.account }}` names the one the run was given.

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* **The inputs are checked when a run starts**, by ~~`workflow.run`, `workflow.submit` and the `workflow.run` action~~ `run.start`, as an operation and as an action *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))* (section 8). The controller checks the given values against the declarations:

- A value for an input the workflow does not declare is refused.
- A required input with no value and no default is refused.
- An optional input with no value and no default is left out of `inputs`, so `has(inputs.x)` is false.
- The value of a `schema` input, given or taken from its default, is checked against its JSON Schema (draft-07). A schema the checker cannot use is reported as a problem of the workflow, not of the value, because the author has to correct the schema.
- A `connection` input must name an existing Connection of that type that is not disabled. A Connection whose status is `needs-reauth` or `error` is not refused; the action that uses it reports that problem.

Each problem is one issue at the path `inputs.<name>`, and no run is created. So "a required input left unresolved fails stamping" above means that the start is refused. Known gap: a save does not yet check a `schema` itself, or its `default` against it. A `default` that does not match its schema is therefore accepted at save, and every start that relies on it is refused.

## 4. Steps and the graph

```ts
type Step = ActionStep | AgentStep

interface StepBase {
  id: string                           // referenced as steps.<id>
  name?: string
  condition?: CelExpression            // skip condition over `inputs`, `steps`; bool
  join?: "any" | "all"                 // default "any"; section 4.3
  entry?: boolean                      // default false; the run starts here, as at a step with no incoming edge; section 4.3
  terminal?: boolean                   // default false; completing this step completes the run; section 4.3
}

interface ActionStep extends StepBase {
  kind: "action"
  action: string                       // contribution id, e.g. "task.create", "github/pr.create"
  params?: Record<string, Literal | Template>  // validated against the contribution's input schema; a string holding {{ }}, at any depth, is a template (section 5)
}

interface AgentStep extends StepBase {
  kind: "agent"
  agent: string                        // Agent id; supplies the provider instance and the permission profile
  prompt: Template                     // first turn input; interpolates `inputs`, `steps`
  model?: string                       // a model slug; overrides the Agent's model
  options?: Record<string, string | boolean>  // that model's options; well-known option ids per ./06
  accessMode?: AccessMode              // overrides the Agent's accessMode (default full-access); resolved before session start
  freshSession?: boolean               // default false: iterations resume the same session
  outputSchema?: JsonSchema            // draft-07; declares steps.<id>.output
}

type WorkspacePolicy =                 // declared once per workflow (section 1), absent = workspace-less sessions; section 4.4
  | { kind: "primary"; resourceId: string; branch?: string }                           // the resource's shared main checkout on the target runner
  | { kind: "ephemeral"; checkouts: { resourceId: string; baseBranch?: string }[] }    // one fresh worktree per checkout; [] = scratch, several = multi-repo

interface Edge {
  from: string                         // step id or signal trigger id
  to: string                           // step id (never a signal trigger id)
  condition?: CelExpression            // over `inputs`, `steps`; bool; absent = always
  maxTraversals?: number               // >= 1; times this edge may fire per run
}
```

*(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* The block above is now the shape as shipped, spelled as the contract already spelled each concept. Steps gain `entry` (section 4.3). An action step may leave out `params`, and its values are literals or templates, not bare expressions. An agent step's model override is flat, `model` plus `options`, as `agent.create` and `session.spawn` take it; it was `model: { model, options }`. `WorkspacePolicy` is `session.spawn`'s workspace less `existing` ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2, workspace): `resource` became `resourceId`, `resources` became `checkouts` (at most 32), and `{ kind: "none" }` became leaving `workspace` out. The ephemeral `branch` template is not in the shape yet (section 4.4).

### 4.1 Action steps

An action step invokes a plugin-contributed workflow action by contribution id (a tool call is just this). The contribution declares an input schema and an output schema; `params` are literals or expressions and are validated at save time. Built-in actions (section 8) have the same shape and are invoked the same way. The action's return value becomes `steps.<id>.output`. An action that fails fails the run; failure is not redirection, and actions never steer the graph ([ADR 0008](../adr/0008-workflow-graphs-route-on-declared-outputs.md)).

Actor and permission context: a built-in action executing inside a run is stamped `run:<runId>` and is **ungated**: the workflow was authored by the user and its action steps run with the user's parity. Agent steps are sessions and act as `session:<id>` under their own profile ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 3.1). That is why the `worker` profile withholds ~~`workflow.run` and `workflow.submit`~~ `run.start` *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))* (a session cannot fan out) while a ~~`workflow.run`~~ `run.start` *action step* needs no grant (the user wrote it into the recipe). Plugin-contributed actions stand on the same footing: `execute()` receives `ctx.api`, a public-API client stamped `run:<runId>` with the `stepId` carried in the audit entry, and every mutation made through it is summarised on the step record ([ADR 0026](../adr/0026-workflow-actions-may-call-the-public-api-as-the-run.md); interface in [./05-plugins.md](./05-plugins.md) section 4.4). Actions still never redirect: routing reads declared outputs only.

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* The built-in actions execute as described: each mutation one makes is stamped `run:<runId>`, and it passes every grant check, whoever started the run. The step's id is not yet written to the audit entry; the step record shows what the step returned. `ctx.api` does not exist yet, so a plugin action cannot call the public API and nothing is summarised on the step record ([./05-plugins.md](./05-plugins.md) section 4.4).

### 4.2 Agent steps

An agent step starts a Session for the named Agent and waits until its turn completes. The controller authors the SessionSpec (the agent's provider instance, the step's `model` selection, `accessMode`, the run's `workspaceId` (section 4.4), system prompt from the agent, the step's `outputSchema`), places it on the run's runner (section 4.4; a full runner queues the placement and the step waits), and sends the rendered `prompt` as the first turn. The session carries a copy of the agent's permission profile id (shipped default for workflow agent steps: `worker`, [./13-security.md](./13-security.md)) and reaches Hercule through the `hercule` CLI with its session token. The session is linked to the run and step from the session side; the run's step record holds the session id.

Defaults come from the Agent (resolved 2026-09-01, [Domain model residue](https://github.com/theagenticage/hercule/issues/46)): the step's `model` and `accessMode` are optional overrides of the Agent's `model` and `accessMode` (default `full-access`); absent both, the instance's default model applies. Every resolved value is copied into the Session at spawn; the session never reads through its agent afterwards ([./02-domain-model.md](./02-domain-model.md) rule 9).

`accessMode` names one of the four fixed modes. If the provider does not support it natively, the controller substitutes the hardcoded fallback before session start, strictly downward in permissiveness; if no equal-or-less-permissive mode exists the step fails with a clear error ([./06-providers.md](./06-providers.md), [./13-security.md](./13-security.md); [ADR 0007](../adr/0007-provider-adapter-is-a-thin-interface-behind-a-normalized-event-stream.md) as amended).

Runner-owned inactivity and absolute timeouts apply to the session; a session that times out or exits abnormally fails the step. *(Amended 2026-09-12, [#162](https://github.com/theagenticage/hercule/issues/162).)* A timeout while the step's turn runs fails the step; an inactivity exit between iterations does not, and the next iteration's prompt resumes the session in place ([./06-providers.md](./06-providers.md) section 4.1).

Iterations: when an edge brings the graph back to an agent step (a cycle, or a signal node firing into it), the step by default sends the newly rendered prompt as the next turn of the same session, so review feedback or a failed-checks signal arrives as a follow-up in context. `freshSession: true` opts out for context-poisoning cases and starts a new session each iteration. Each iteration produces its own step record (section 7.2). A step's `outputSchema` travels on the `SessionSpec` once, and the adapter applies it to every turn of that session ([./06-providers.md](./06-providers.md) section 7), so each iteration yields a fresh structured result.

### 4.3 Routing and cycles

Control flow lives entirely in the graph. ~~Steps with no incoming edges start when the run starts.~~ *(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* The run starts every **entry step**: a step with `entry: true`, or a step with no incoming edge. In a loop the old rule started nothing: in section 2.4's pattern every step has an incoming edge. A step that only a signal trigger leads into is not an entry step, because it waits for its signal. Validation refuses two things, and each message suggests `entry: true`. A workflow with steps and no entry step is refused at the first step, in definition order, that another step leads into, or at the first step when no step leads into another. A step that no path reaches from an entry step or a signal trigger is refused at that step. The graph preview draws an edge from each start trigger to each entry step ([./14-web-app.md](./14-web-app.md) §Workflow editing).

When a step completes (or a signal node fires), every outgoing edge whose condition is absent or evaluates true fires; several firing edges run their targets in parallel ~~*(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79): not built yet. The run engine executes a run's ready steps one at a time, in the order their step records were created. Every step it can run today is an action step that writes to the one database, so running them side by side would not finish sooner)*~~ *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80): built. The run engine executes every ready step record at once, so a `wait` on one branch does not hold up another)*. A branch the agent "chooses" is two outgoing edges with mutually exclusive conditions over an enum field of the step's output; the prompt tells the agent the choice exists, the schema carries it, the edges route it. Conditions route on `inputs.*` and `steps.<id>.output.*` only; there is no other run state visible to the graph.

*(Amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80).)* `steps.<id>` holds the step's latest finished iteration: its output when that iteration completed, and nothing when it was skipped (section 5). A condition that reads a step on another branch depends on timing: the step is present only if its branch has already finished. An author who needs the outputs of both branches joins them with `join: all`.

**Joins.** A step with several incoming edges runs according to its `join`:

- `any` (default): every firing incoming edge runs the step once more, as a new iteration. For an agent step that is the next turn of its session, so a `summarize` step fed by `review_a` and `review_b` sees both reviews arrive in context, like a main thread receiving messages from subagents. Its outgoing edges fire per iteration, so anything after it runs once per firing.
- `all`: the step runs once, ~~when every incoming edge has *resolved*: fired, or dead. An edge is dead when its source is dead or skipped, or its source completed and the edge's condition was false. A step with incoming edges is dead when all of them are dead; a dead step gets no record.~~ when every incoming edge is settled and at least one of them fired, as the settled rule below says *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80))*. `all` is the fan-in barrier ("run two reviewers, then combine once"). Validation forbids `all` on a step inside a cycle, because the loop-back edge cannot resolve on the first visit.

*(Amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80).)* **The settled rule.** "Fired or dead" could not tell whether a source upstream of a loop would fire again, so `all` waits until its sources can no longer run. In the rules below, a record is *active* when it is `pending` or `running`.

- An incoming edge is **settled** when its source can no longer run: the source has no active record, and no step with an active record has a path of edges to it. Conditions and `maxTraversals` are ignored when looking for a path.
- When every incoming edge is settled and at least one fired, the step gets one `pending` record, iteration 1.
- When every incoming edge is settled and none fired, the step is **dead**: it gets no record, and the steps that only it leads to can never run either. Nothing marks them; they are simply never reached.
- A skipped source is not a reason for an edge to be dead: a skipped step passes through (below), so its outgoing edges are evaluated as if it had completed.

Example: `review_a` finishes in 1 second and `review_b` takes 1 minute. `summarize` (`join: all`) waits the minute and then runs once, with both outputs. If a condition had cut `review_b` off, `review_b` is settled at once, and `summarize` runs after `review_a` alone. With a loop upstream of the join, the join runs once, after the loop has exited.

Validation also refuses `join: all` on an entry step: an entry step starts when the run starts, so it cannot wait for its incoming edges first.

**Skips.** A step whose `condition` evaluates false is skipped: a record with status `skipped`, no output, and its outgoing edges are evaluated as if it had completed (pass-through). Skipping is never a runtime act; it is a condition the author wrote, so the steps after it are written to expect it: `steps.<id>` is absent for a skipped step (section 5), and a downstream condition that reads it guards with `has()`:

```
review -> merge      condition: !has(steps.review) || steps.review.output.verdict == "approve"
review -> implement  condition: has(steps.review) && steps.review.output.verdict == "reject"
```

A forgotten guard is an expression error (below), never a silent false. Pruning the branch instead is expressed by putting the condition on the edges, which is why pass-through is the meaning of a step condition.

*(Amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80).)* A step's condition is evaluated when its record would start, not when the record is created. A false condition moves the record `pending → skipped`: no output, no error, no `startedAt`, and `finishedAt` set. Its outgoing edges are then evaluated as for a completed step. A step skipped in its latest iteration is absent from `steps`, even if an earlier iteration completed, so nothing routes on an old output.

**Cycles** use ordinary edges. Any edge may carry `maxTraversals >= 1`, the number of times it may fire in one run; validation requires every cycle to contain at least one capped edge, so every graph is bounded by construction. When a capped edge's condition holds but its cap is exhausted, the run fails with reason `iteration-limit`. When the condition is false the edge simply does not fire and the cap is irrelevant. The per-step `iteration` counter increments each time the step runs in the run.

*(Amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80).)* A run counts how often it has followed each edge, and `run.read` returns the counts as `edgeTraversals` (section 7.2). A capped edge whose condition holds after it has fired `maxTraversals` times fails the run with `iteration-limit`, `failedStepId` set to the edge's source and `failedEdge` to the edge's index in `edges` and what went wrong there. A step's next record takes the step's highest iteration so far plus one, so the iterations of a step are 1, 2, 3 and so on. Validation refuses two edges with the same `from` and `to`: counts are kept per edge, and two such edges would be one route counted twice. Two conditions on one route are written as one, joined with `||`.

**Busy step.** An edge firing into a step that is currently running (a second review arriving while the summarizer is mid-turn, a second `checks_failed` signal while the fixer is still fixing) queues one iteration, recorded as `pending`; queued iterations run in order after the current one completes. Nothing is coalesced and nothing steers the running turn in v1: batching belongs at the source (subscribe to GitHub's per-suite and per-review kinds, not per-check and per-comment ones; [./08-events-and-connections.md](./08-events-and-connections.md)). Coalescing queued firings into one iteration, and steering a running session, are Post-v1.

*(Amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80).)* A step never has two `running` records. An edge that fires into a step whose record is `running` adds a `pending` record with the next iteration. A step's queued records start one at a time, in iteration order, each after the one before it has ended. Records of different steps run side by side.

**Terminal steps.** A step with `terminal: true` completes the run when it completes: running branches are cancelled (their records `cancelled`), pending iterations dropped, live subscriptions ended, undelivered signal deliveries dropped. Otherwise a run completes when nothing is running or pending and no subscription is live. A graph with signal nodes therefore needs a terminal step to end on its own (a live `checks_failed` node would otherwise keep the run alive after `task_done`); without one it ends only by cancellation, which the editor warns about (section 1).

*(Amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80).)* **Terminal steps as built.** The transaction that completes a terminal step also ends the run:

- The run is `completed`, and its `output` is the terminal step's output (section 7.2).
- Every `running` record is `cancelled`, and its work stops: a `wait` ends at once, and a plugin action sees its `signal` abort ([./05-plugins.md](./05-plugins.md) section 4.4).
- Every `pending` record is `cancelled`.
- The terminal step's outgoing edges are not evaluated: they are not counted and create no records.

A terminal step that is skipped does not end the run: its outgoing edges are evaluated as for any skipped step. A run with no terminal step completes when nothing is running or pending, and has no `output`. There are no subscriptions or signal deliveries to end yet ([#83](https://github.com/theagenticage/hercule/issues/83)).

**Failure.** A step failing fails the run; parallel branches still running are cancelled *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80): in the transaction that fails the run, and their work stops as at a terminal step)*. There are no automatic retries. A CEL expression that throws at any in-run site (a step condition, an edge condition, a template in a prompt or a parameter) fails the run with reason `expression-error` and the site named in `failedStepId`. A condition fails the same way when it gives something other than true or false *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80))*. At an edge, `failedStepId` is the edge's source, whose record stays `completed`, and `failedEdge` holds the edge's index and the evaluation error. At a step condition, the step's record is `failed` with the code `expression_error`, `failedStepId` is the step, and there is no `failedEdge`. Either way every active record is `cancelled`, including records created for earlier edges in the same transaction. In-run errors are loud where trigger sites are quiet ([./08-events-and-connections.md](./08-events-and-connections.md): no-match plus health warning) because the pipeline must never stall on one workflow's bad expression, whereas a run is an isolated unit and a silently-false edge would route work wrongly.

### 4.4 One run, one workspace, one runner

A run takes place in one workspace on one runner. The workflow declares the `WorkspacePolicy` once (section 1) and it is frozen into the plan; every agent step of the run works in it, and the run's `runner` placement inputs (`requires` feeds the capability filter, `runnerId` is the explicit choice, [./03-controller-and-runners.md](./03-controller-and-runners.md)) place the whole run. The first placement pins the runner; later agent steps go to the same runner, because the workspace is runner-pinned. ~~Action steps run on the controller and need neither.~~ An action step runs where its action says: on the controller, or in the run's workspace on the run's runner *(amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257), below)*. This moves the workspace and the placement inputs off the agent step, where the Workflow model ticket had put them: nobody could name a run that needs two workspaces (multi-repo is one workspace with several resources), and an implementer and a reviewer on one branch is the normal case, impossible with per-step workspaces. Named workspaces per run are the additive extension if a use case appears (Post-v1).

Policy: `none` runs sessions workspace-less (assistant-style, API-only work); `primary` uses the resource's long-lived main checkout on the runner, sharing it with whatever else runs there (a dirty primary is the next run's starting reality); `ephemeral` provisions fresh worktrees for the listed resources off the runner's per-resource cache, with each resource's setup command run first. ~~Provisioning happens when the first agent step starts.~~ Provisioning happens when the first workspace step starts *(amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257), below)*. Ephemeral workspaces are deleted on clean completion of the run and kept on failure until the user ~~dismisses the failed run~~ deletes the kept workspace with `workspace.dispose`, or for ~~`workspace.failedRunTtlDays`~~ `workspace.inspectionTtlDays` *(amended 2026-09-25, [#260](https://github.com/theagenticage/hercule/issues/260), and 2026-09-27, [#263](https://github.com/theagenticage/hercule/issues/263), below)*; a re-run provisions fresh ones. Parallel agent steps share the one workspace, allowed and the author's risk, as with a primary. Substrate details in [./03-controller-and-runners.md](./03-controller-and-runners.md).

Branch: ~~`branch` is a template over `inputs` (and `steps`, though nothing has run yet); the default is `hercule/run-<runId>`, always unique.~~ the branch is always `hercule/run-<runId>`, unique by construction; the `branch` template is deferred until a workflow needs it *(amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257), below)*. It is the *initial* name only: the runner tracks the worktree by path, so an agent is free to rename the branch to something meaningful and PR creation uses whatever branch is current. Shipped task-driven workflows template `task/{{ inputs.taskId }}`; "task branch" is a convention of those workflows, not a core rule.

*(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* The policy is spelled as `session.spawn` spells a workspace, so one concept has one spelling: `{ kind: "primary", resourceId, branch? }`, with `branch` meaning what it means on `session.spawn`, or `{ kind: "ephemeral", checkouts: [{ resourceId, baseBranch? }] }`. `none` is leaving `workspace` out. Two things above are not in the shape yet, because nothing exists to act on them: the ephemeral `branch` template (no run-branch naming exists) and the run's `runner` placement inputs (no placement by runner capability exists). Both join additively with ~~the run engine ([#79](https://github.com/theagenticage/hercule/issues/79), [#80](https://github.com/theagenticage/hercule/issues/80))~~ agent steps in runs ([#83](https://github.com/theagenticage/hercule/issues/83)) *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79): the run engine runs action steps only, which need neither a workspace nor a runner; a run freezes the `workspace` policy and does not use it)*.

*(Amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257); [ADR 0035](../adr/0035-an-action-declares-where-it-runs.md).)* **Where a step runs, and the run's workspace as built.**

- **Every action says where it runs**, `runsIn` (section 8). A `controller` action runs on the controller and needs no workspace and no runner. A `workspace` action runs in the run's workspace on the run's runner. A step that calls a workspace action is a **workspace step**. An agent step becomes a workspace step too when [#83](https://github.com/theagenticage/hercule/issues/83) builds it. A run now uses its frozen `workspace` policy, for its workspace steps.
- **The workspace is provisioned, and the run pinned to a runner, in the transaction that starts the run's first workspace step.** A run with no workspace step gets neither. The run keeps both for its whole life: every later workspace step goes to the same runner and works in the same workspace. How the runner is picked, until the placement ladder is built, is in [./03-controller-and-runners.md](./03-controller-and-runners.md) section 5.
- **The workspace is opened as a session opens one.** A `primary` policy uses the resource's main workspace on the pinned runner, and an `ephemeral` policy provisions a fresh one. A failed setup command fails the run with `workspace-failed` (section 7.2).
- **An ephemeral checkout's branch is always `hercule/run-<runId>`.** Example: the run `0199a3f2-…` works on the branch `hercule/run-0199a3f2-…`. The `branch` template above is deferred until a workflow needs it, and then joins the shape additively. A thread's branch is `hercule/thread-<last 8 characters of its session id>` ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2), so the prefix tells a run's branch from a thread's.
- **A `primary` policy's `branch`** is switched to before each workspace step, the way a session start switches it. The branch name is given to git after `--`, so a name that starts with `-` is never read as an option.
- **One workspace step at a time per workspace.** The runner runs one workspace's steps one after another, so two `git.commit` steps on parallel branches never collide on git's `index.lock`: the second waits for the first.

*(Amended 2026-09-25, [#260](https://github.com/theagenticage/hercule/issues/260).)* **What happens to the run's ephemeral workspace once the run ends.** The controller's workspace sweep decides, every ten minutes, as it does for every workspace ([./03-controller-and-runners.md](./03-controller-and-runners.md) section 6.7). A `primary` workspace is never deleted by a run.

- **Completed:** deleted. **Failed:** kept for ~~`workspace.failedRunTtlDays`~~ `workspace.inspectionTtlDays` (default 14) after the run finished, then deleted.
- **Cancelled:** `run.cancel` takes `keepWorkspace` (default `false`), and the choice applies to the run and to every descendant run cancelled with it. Not kept, the workspace is deleted; kept, it is kept like a failed run's. Example: `hercule run cancel <id> --keep-workspace true`.
- **"Dismissing the failed run" is `workspace.dispose` on its kept workspace.** There is no dismiss operation for runs. `workspace.dispose` refuses while the workspace's run is unfinished, and says to cancel the run first.
- ~~**A failed or kept run answers `workspaceKeptUntil`**, the day its workspace is deleted, so a client can say "Workspace kept for inspection until 9 Oct".~~ **The workspace answers `keptUntil`** *(amended 2026-09-27, [#263](https://github.com/theagenticage/hercule/issues/263))*, the day it may be deleted, so a client can say "Workspace kept until 9 Oct". Once the workspace is gone, the workspace's own `deleted` status and `disposedAt` say when.

*(Amended 2026-09-27, [#263](https://github.com/theagenticage/hercule/issues/263); [ADR 0036](../adr/0036-a-workspace-is-kept-by-leases-its-holders-release.md).)* **The run holds a Workspace Lease and releases it as it ends.** The run acquires a lease on its workspace when its first workspace step opens it, and releases it in the transaction that records how the run ended, with a retention picked from that ending: `none` when it completed or was cancelled without `keepWorkspace`, `inspection` when it failed or was cancelled with `keepWorkspace`. The kept-until time is fixed at that moment, from the settings then; it is no longer computed when the run is read. A thread that joins the run's workspace holds a lease of its own, and the workspace is kept until the later of the two runs out ([./03-controller-and-runners.md](./03-controller-and-runners.md) section 6.7).

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

`inputs` is the run's resolved inputs by name. `steps` is a map of step id (or signal trigger id) to `{ output }`, holding the output of every step that has completed and every signal node that has fired in this run; when a step ran more than once, `steps.<id>.output` is the latest iteration's output. A skipped, dead or not-yet-run step has no entry, so `has(steps.<id>)` is the test for "did it run" (section 4.3). `steps.<id>` is the step's latest finished iteration, so a step whose latest iteration was skipped has no entry either, even if an earlier iteration completed *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80))*. `event` is the event envelope as defined in [./08-events-and-connections.md](./08-events-and-connections.md): `event.kind`, `event.source`, `event.connectionId`, `event.system`, `event.refs`, `event.url`, `event.occurredAt`, `event.payload.*`; `event.raw` is not readable by expressions. `has()` covers presence tests on loosely shaped payloads (`has(event.changes.status) && event.changes.status.new == "done"`).

Evaluator: `@marcbachmann/cel-js` (pure JS, zero dependencies) behind a small Hercule-owned wrapper exposing parse, check and evaluate and nothing else; `@bufbuild/cel` is the named fallback implementation, swappable without touching stored workflows because definitions store CEL source only. Wrapper rules:

- Context variables (`inputs`, `steps`, `event`) are declared `dyn` in v1 so plain JSON numbers work without BigInt friction; typed schemas can come later.
- Every stored expression is checked with the environment's `check()` at save time; parse or type errors reject the save. *(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* Each site is checked in an environment that declares only that site's variables (the table above), so `steps.x` in a trigger filter is refused at save and not at each evaluation. A site whose result is bool refuses an expression whose type is known and is not `bool`.
- Parse-time structural limits (`maxAstNodes`, `maxDepth`, list and map size, call arity) are set to modest values; conditions are small.
- No async or side-effecting custom functions; the function whitelist is pure.
- Evaluation of one expression is wall-clock guarded as a belt-and-braces measure, since neither implementation meters runtime cost.

*(Amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80).)* **Conditions at run time.** A run evaluates a step or edge condition in the same scope that the save-time check and templates use, so a condition that saves also runs. The save-time check refuses a condition whose type is known and is not `bool`, but a `dyn` value's type is only known at run time: a condition that gives a string, a number, a list, a map or null there fails the run with `expression-error`, and so does a condition that throws. It is never read as false (section 4.3).

Interpolation: action parameter values and agent prompts are templates whose embedded expressions are ordinary CEL over `inputs` and `steps`, delimited `{{ expr }}`: `Fix the failing checks on {{ inputs.prUrl }}. CI said: {{ steps.checks_failed.output.payload.summary }}`. A non-string value renders as JSON. A literal `{{` is written `{{ '{{' }}`. `{{ }}` was chosen over `${ }` because prompts routinely quote code, where `${...}` is common. Only the step `prompt` and ~~string `params`~~ the strings in `params` are templates; an Agent's system prompt is a standalone entity with no run to reference and is not interpolated. A template that throws is an `expression-error` (section 4.3).

*(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* A string inside `params` that holds `{{` is a template at any depth: the value of a param, an item of a list, or a field of a mapping. Section 8 puts `inputs.eventId` into `provenance`, which is a list of mappings, so a template only at the top would not be enough. The run renders nested strings the same way ([#79](https://github.com/theagenticage/hercule/issues/79)). An expression ends at the first `}}` after its `{{`, as a Mustache tag does, so the reader of a template needs to know nothing of CEL; an expression that must hold `}}` writes it another way, such as `'}' + '}'`.

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* **How a run renders the templates in `params`.** "A non-string value renders as JSON" above holds only inside text. The rules as built:

- A param string that is exactly one `{{ expr }}`, with no other text around it, not even a space, renders to the expression's value with its own JSON type. So `"{{ inputs.count }}"` renders to the number 3 and can fill a field that takes a number. Without this rule a template could never fill a number or a list, although a save accepts a template in a field of any type (section 1).
- Any other string that holds `{{ }}` renders to a string. Each expression is replaced by its value: a string as it is, any other value as JSON.
- Rendering walks the params at any depth, as a save checks them.
- CEL returns an integer (an int literal, what `size()` returns) as a big integer. A safe integer becomes a JSON number. A value with no JSON form fails the template: an integer too large to be exact as a JSON number, bytes, a duration or a timestamp. The message suggests converting it with `string()`.

The rendered params are then decoded against the action's input schema. A decode failure fails the step with the code `validation`, and the run with `step-failed`: the expression evaluated, and the value it gave is wrong for the field. A template that throws fails the run with `expression-error`, with the step in `failedStepId`, and its step record fails with the code `expression_error`.

~~A number read from `inputs` or from a step's output is a CEL double, because the context is plain JSON and `dyn` (above). An int literal is an int, and CEL does not mix the two: `inputs.count + 1` fails with "no such overload: dyn<double> + int". An author writes `inputs.count + 1.0`.~~

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* **An author never thinks about number types.** A number read from `inputs`, a step's output or `event` is a CEL double, because the context is plain JSON and `dyn` (above); an int literal and what `size()` returns are ints. Standard CEL keeps the two apart, so `inputs.count + 1` fails there. Hercule extends CEL on purpose, with these rules. One function builds the environment for both the save-time check and evaluation, so a save accepts exactly what a run can evaluate:

- `+ - * / %` between an int and a double, in either order, give a double: `inputs.count + 1` is 4, `inputs.count / 2` is 1.5. `%` also works between two doubles, so `inputs.count % 2 == 0` works.
- `==` and `!=` between an int and a double compare the values: `3 == 3.0` and `size(x) == inputs.count` hold. Ordering (`<`, `>=` and the rest) already compared across the two.
- `+` between a string and a number, in either order, joins them as text: `"count: " + inputs.count` is `"count: 3"`. A whole double is written without `.0`, as JavaScript writes it.
- A list or map literal may mix value types: `[1, inputs.price]`.
- A list read from the context can be indexed by a number read from the context: `inputs.labels[inputs.index]`.
- A whole double becomes a JSON integer when rendered: `{{ inputs.price * 2 }}` with a price of 2.5 renders 5.

Limits of the evaluator, which the wrapper cannot change through its public API:

- `/` between two ints still drops the remainder: `7 / 2` and `size(x) / 2` are 3. Write one side as a decimal (`size(x) / 2.0`) for the decimal result. A number read from the context is already a double, so `inputs.count / 2` is not affected.
- The two branches of `? :` must have the same type: write `cond ? 1.0 : 2.5`, not `cond ? 1 : 2.5`.
- A list literal is indexed by an int only: `["a", "b"][1]`, not `["a", "b"][1.0]`.
- A decimal divided by zero gives infinity, and `x % 0.0` gives NaN. Neither has a JSON form, so a template that renders one fails.
- A whole number above 2^53 mixed with a decimal loses precision, because the whole number becomes a decimal first, as CEL's own `double()` does.

An optional input with no value stays absent from `inputs`, as section 3 says, so `has(inputs.x)` is the test for it. Reading it without `has()` fails with "no such key".

**Verify at build time:** the exact values of the parse-time limits, and a Hercule-side corpus of representative expressions run in CI against the wrapper (optionally including selected official conformance cases from `@bufbuild/cel-spec`) to pin the subset Hercule relies on.

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

A Run is one execution of an execution plan. Orchestration happens only on the controller: it interprets the plan, schedules steps, places sessions and workspaces on runners, and advances the graph on session and action completion; runners never interpret plans ([ADR 0002](../adr/0002-orchestration-stays-on-the-controller.md)). Runs are rows in the controller database, reloaded on boot; a run whose session is on a disconnected runner waits for the runner to return. *(Amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257): so does a run whose workspace step is on a disconnected runner, with no time limit, section 7.2.)*

### 7.1 Starting a run

A run is created by: a start-trigger match (the matcher's pending-run effect row), direct manual creation, a ~~`workflow.run`~~ `run.start` action step in another run, an API call by an actor holding the ~~`workflow.run`~~ `run.start` grant (assistants do by default), or an unstored definition ~~submitted through `workflow.submit`~~ sent with `run.start` *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))* (section 9). At start the controller:

1. Freezes the plan: copies the workflow's inputs declaration, steps, edges, triggers, workspace policy ~~and placement inputs~~ *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79): the definition has no placement inputs until `runner` joins it, section 1)* into the run as an immutable execution plan ([ADR 0001](../adr/0001-runs-freeze-an-execution-plan.md)). Start triggers in the plan are inert record; signal triggers are live.
2. Re-validates the plan (section 1); a plan that no longer validates fails the run at start with reason `validation-error` *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79): only for a start that nobody waits on, such as a trigger effect; a start by request is refused instead, below)*.
3. Resolves inputs from the trigger's mappings, the manual form, or the caller's explicit values, applying defaults; a `connection` input is checked against the Connection table here.
4. Copies the triggering event, if any, onto the run so event-log pruning never breaks audit.
5. Instantiates a Subscription for every signal trigger in the plan.
6. Starts every ~~step with no incoming edge~~ entry step (section 4.3; *amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78)*, because in a loop every step has an incoming edge). The workspace is provisioned, and the runner pinned, when the first ~~agent step~~ workspace step *(amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257))* starts (section 4.4).

Concurrent runs of one workflow are unlimited in v1; the per-runner session cap queues sessions at placement and the spawn bound limits trigger-driven creation.

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* **Starting a run by request, as built.** ~~`workflow.run` and `workflow.submit` check~~ `run.start` checks everything before they create anything, while the request is handled. The request is refused with `validation` (400, every problem as an issue at its path) and no run is created when:

- the definition no longer validates (section 1);
- the definition has an element that runs cannot execute yet (the list below);
- the inputs are not valid (section 3).

*(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* Two more checks apply to a step whose action acts through a Connection:

- A literal `connection` param that names a disabled Connection is refused with `validation` at the param's path, as a disabled Connection input is. This holds for a stored workflow and a sent one alike. A start from a trigger effect runs the same check, and its run fails with `validation-error` (below).
- A sent workflow (`source` or `definition`) with such a step is refused with `forbidden` when the caller lacks the `connection.use` grant, whether the param is an id or a template ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2). ~~A stored workflow needs no grant, because the user wrote its steps.~~
- *(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* A start of a stored workflow is refused with `forbidden` when the caller lacks `connection.use` and gives a value for an input that such a step's `connection` param reads, even a value equal to the default. A start that leaves those inputs to their defaults needs no grant, because whoever saved the workflow chose them.
- *(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* A replay (section 7.4) of a run whose workflow was sent with `run.start`, and has such a step, is refused with `forbidden` when the caller lacks `connection.use`, because the replay chooses the sender's Connection again. A re-stamp, and a replay of a stored workflow, are not checked: they run with the original run's inputs and Connections chosen when the workflow was saved.

A run that failed at start would be one more failed run to read, for a problem the caller can be told about at once. `validation-error` as a run's failure reason stays for starts that nobody waits on: a trigger effect ([#82](https://github.com/theagenticage/hercule/issues/82)) *(amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82): built, below)*.

Runs execute part of this document so far. Each element they cannot execute yet is one issue, at its place, in plain words ("Runs cannot evaluate edge conditions yet."):

- an agent step, and a signal trigger ([#83](https://github.com/theagenticage/hercule/issues/83));
- ~~a step or edge `condition`, `join`, `terminal`, `maxTraversals`, a step that more than one edge leads into, and `entry: true` on a step that an edge also leads into. Such a step would run once as an entry step and again when the edge fires, and a step that runs twice needs the rules for loops ([#80](https://github.com/theagenticage/hercule/issues/80));~~
- ~~a plugin action that declares a Connection. The first plugin action that needs a Connection decides how a step names it (section 3, [./05-plugins.md](./05-plugins.md) section 4.4).~~ *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* Runs execute these now (section 1).

*(Amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80).)* Runs execute every routing element of section 4.3, `terminal` included, so the struck bullet lists nothing any more.

Accepted: action steps, ~~edges with no condition~~ step and edge conditions, `join`, `maxTraversals`, a step that several edges lead into, `entry: true` on a step that an edge also leads into, `terminal` *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80))*, fan-out (one step leading to several), several entry steps, start triggers (frozen and inert) and a `workspace` policy (frozen and unused, because no step needs a workspace yet).

*(Amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257).)* Action steps that call a workspace action, such as `git.commit`, are accepted too, and a run uses its `workspace` policy for them (section 4.4). Agent steps are still refused ([#83](https://github.com/theagenticage/hercule/issues/83)), ~~and so are plugin actions that declare a Connection~~ *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)*.

How the numbered steps above apply to a start by request:

- The frozen plan is the parsed definition, including `name` and `description`, so a run can still be named and drawn after its workflow is renamed, edited or deleted. It is the contract's `WorkflowDefinition`; no separate execution-plan type exists (section 9).
- Step 3 applies defaults: a required input with a default takes it.
- ~~Steps 4 and 5 do nothing yet: no run has a triggering event before [#82](https://github.com/theagenticage/hercule/issues/82), and a plan with a signal trigger is refused.~~ Step 4 does nothing, because a start by request has no triggering event, and step 5 does nothing yet, because a plan with a signal trigger is refused *(amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82))*.
- A disabled workflow can still be run by hand (section 1).
- The request writes the run and a `pending` step record for each entry step, in one transaction, and answers `{ runId }` at once. It never waits for a step. The run engine then executes the run apart from the request. ~~It executes ready steps one at a time, in the order their step records were created (section 4.3).~~ It executes every ready step at once, and at most one record of each step at a time (section 4.3) *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80))*.

*(Amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82).)* **Starting a run from a trigger effect, as built.** The delivery of a trigger effect (section 2.1) starts the run with the same checks as `run.start`, with the inputs the trigger mapped from the event, except two. No grant is checked.

- The nesting limit is not checked, because the run is 1 deep.
- Whether a runner can run the plan is not checked. A run that no runner can run starts, and its first workspace step fails with `workspace-failed`, as for a run whose runner was retired after it started. Which runners are connected says nothing about the workflow, so this is not a validation failure, and its notification is not held back.


- The delivery first checks that the trigger is still active and its workflow still enabled. A trigger paused, or a workflow disabled, after the match and before the delivery starts no run: the effect is marked `discarded`, and the delivery logs why. This keeps the promise that a paused trigger starts no run.
- Nobody waits on this start to refuse it. So when a check fails, the run is still written, and it ends at once `failed` with the reason `validation-error` and a `failureMessage` that says what did not validate. It has no `startedAt` and no step records. It raises the usual `core.run-failed` notification, with the trigger among its subjects, so the user learns that the trigger's runs are failing. A trigger whose runs fail validation fails the same way on every event it matches, so this notification is not raised when one about a run of the same trigger was raised in the hour before. Each such run is still listed as failed.
- Otherwise the numbered steps apply as for a start by request. Step 3 applies defaults to the mapped inputs. Step 4 copies the event onto the run as `triggerEvent`, without `raw` (section 7.2).
- The run's `origin` is `{ kind: "trigger", triggerId, eventId }`, and the actor of its writes is `system`.

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
    | { kind: "api"; actor: Actor }    // run.start over the API (amended 2026-09-24, #79)
  triggerEvent?: Event                 // copy of the triggering event
  originalRunId?: string               // the run this run re-runs (amended 2026-09-27, #81: named originalRunId, not the provisional rerunOf)
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
  | "workspace-failed"                 // the run's workspace never provisioned: the setup command failed (section 4.4; ./03 section 6.3); or its runner was retired (amended 2026-09-25, #257)

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

Run status: `pending` (created, not yet started, e.g. queued behind validation or placement), `running`, and the terminal states `completed`, `failed`, `cancelled`. There is no waiting status: a run blocked on a signal is `running` with nothing running or pending and a live subscription, and the UI derives "waiting on `pr_merged`" from that. A run with one branch waiting and another working is `running` either way, which is why a run-level `waiting` would lie. `failed` is terminal: recovery is fixing the workflow, prompt or filter and re-running (section 7.4); resuming a failed run from a step is partial re-run, Post-v1. The user may cancel a run at any time; cancellation ends its subscriptions, cancels its running step records and stops their sessions.

Step records are one per (node, iteration) and their status is monotonic: `pending` (a queued iteration behind a busy step, section 4.3) `-> running -> completed | failed | cancelled`~~; `skipped` is set at creation and final~~, or `pending -> skipped`, which is final: a step's condition is evaluated when its record would start, not when the record is created (section 4.3) *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80))*. A re-entered step never goes back from `completed`; its next iteration is a new record. A signal node gets a `completed` record per firing, holding its output, and none while merely live; a dead step gets none.

The record supports audit replay (walk the exact path a run took into its session transcripts) and re-execution; deterministic replay is a non-goal.

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* **The run record as built.** `run.read` returns this shape:

```ts
interface Run {
  id: string
  workflowId: string | null            // null for a workflow sent with run.start; kept after the workflow is deleted
  plan: WorkflowDefinition             // the parsed definition as it was at start, name and description included
  inputs: Record<string, unknown>      // resolved; an optional input with no value and no default is absent
  origin:
    | { kind: "manual"; actor: Actor }
    | { kind: "api"; actor: Actor }
    | { kind: "action"; parentRunId: string; stepId: string }
  runnerId?: string                    // the runner the run is pinned to, set when its first workspace step starts (amended 2026-09-25, #257)
  workspaceId?: string                 // the run's workspace, set at the same time (amended 2026-09-25, #257)
  status: "pending" | "running" | "completed" | "failed" | "cancelled"
  failureReason?: "expression-error" | "step-failed" | "iteration-limit" | "controller-error" | "workspace-failed"  // (amended 2026-09-25, #80, #257)
  failedStepId?: string
  failedEdge?: { index: number; message: string }  // the edge a run failed at, by index in plan.edges, and what went wrong there (amended 2026-09-25, #80)
  steps: StepRecord[]                  // in the order they were created
  edgeTraversals: number[]             // how often the run followed each edge, one count per plan.edges index (amended 2026-09-25, #80)
  createdAt: string
  startedAt?: string
  finishedAt?: string
  output?: unknown                     // on a completed run: the output of the terminal step that ended it; absent without one (amended 2026-09-25, #80)
  originalRunId?: string               // the run this run re-runs, when run.rerun started it (amended 2026-09-27, #81)
}

interface StepRecord {
  stepId: string
  iteration: number                    // 1, 2, 3...: the step's highest iteration so far plus one (amended 2026-09-25, #80)
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped"  // (amended 2026-09-25, #80)
  startedAt?: string
  finishedAt?: string
  input?: unknown                      // the params the action was called with, rendered and decoded; absent until the step starts (amended 2026-09-25, #257)
  output?: unknown                     // what the action returned
  error?: { code: string; message: string }
}
```

- **Fields that join later**, each with the ticket that sets it: ~~`workspaceId`, `runnerId` and~~ a step record's `sessionId` with agent steps *(amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257): `workspaceId` and `runnerId` joined with workspace steps, below)* ([#83](https://github.com/theagenticage/hercule/issues/83)); ~~`triggerEvent` and the `trigger` origin with trigger effects ([#82](https://github.com/theagenticage/hercule/issues/82));~~ *(amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82): both joined with trigger effects, below)*; ~~`rerunOf` with re-run ([#81](https://github.com/theagenticage/hercule/issues/81));~~ *(amended 2026-09-27, [#81](https://github.com/theagenticage/hercule/issues/81): the field joined with re-run as `originalRunId`, section 7.4)* ~~the run's final output, which is its terminal step's output, with terminal steps ([#80](https://github.com/theagenticage/hercule/issues/80));~~ `taskId` ([./02-domain-model.md](./02-domain-model.md)) with the ticket that links a run to a Task.
- **`origin`.** `manual` when the user starts a run by hand, from the web app or the CLI; `api` when a session calls ~~`workflow.run`; always `api` for `workflow.submit`, whoever calls it (section 9)~~ `run.start`, for a stored workflow or a sent one alike *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))*; `action` for a run that a ~~`workflow.run`~~ `run.start` step started (section 8). `actor` is the starter's actor stamp. The user who sends a workflow with `run.start` starts it by hand as much as one who names a stored workflow, so the origin follows who started the run, not which kind of workflow it runs.
- **A step record's `error` is `{ code, message }`**, not a string, so a client can tell the kinds of failure apart. `code` is one of:
  - an error code of the API, when the action's operation failed with one, such as `not_found` or `validation`. `validation` is also the code when the rendered params do not match the action's input (section 5);
  - `expression_error`, when a template in the step's params could not be rendered, or the step's condition could not be decided *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80))*;
  - `unexpected`, for a failure that is not one of the API's errors, such as a database error or a bug in the controller;
  - `interrupted`, for a plugin action cut off by a restart (below);
  - *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* `connection_unavailable`, when the Connection a plugin action acts through is disabled, or its credentials cannot be read. A step whose `connection` param renders to anything other than ~~a non-empty string~~ a Connection id *(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)*, or names a Connection of another type, fails with `validation`, and one that names a Connection that does not exist fails with `not_found`;
  - the `code` of a plugin's `ActionError` ([./05-plugins.md](./05-plugins.md) section 4.4).
- **Built so far:** the failure reasons `expression-error`, `step-failed` and `controller-error` *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))*. The others join with the tickets that can cause them. ~~The step status `skipped` joins with step conditions ([#80](https://github.com/theagenticage/hercule/issues/80)).~~ `iteration-limit` and the step status `skipped` are built *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80))*, and so is `workspace-failed` *(amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257))*, and so is `validation-error`, for a run a trigger starts *(amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82), below)*.
- **`pending`** means created and not started yet, for a run and for a step record alike. A run is `pending` from the request that creates it until the run engine takes it up; it is never held back by validation, which happens before it exists, and nothing places it yet. *(Amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82).)* A run a trigger starts whose checks fail (section 7.1) moves from `pending` straight to `failed` with `validation-error`, in the transaction that writes it, so no reader ever sees it `pending` and it is never `running`. A step record is `pending` from when the step before it completes until the engine calls its action, not only as a queued iteration behind a busy step.
- **A step record moves to `running` in a transaction of its own, before its action is called.** What happens next depends on the action:
  - A built-in action's effect, the end of its step record, and ~~a `pending` record for each step an edge leads to~~ what routing decides after it (below) *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80))* commit in one transaction. A crash therefore never leaves the effect committed with the record unfinished. A built-in step record found `running` when the controller starts means that transaction never committed and the action took no effect, so the engine executes it again.
  - A plugin action is called after its `running` record has committed, outside any transaction, because it reaches outside the database. Its step record found `running` when the controller starts may or may not have taken effect. Runs never retry an action (section 7.5), so the step fails with the code `interrupted` and the run fails with `step-failed`.
- **A step that fails** fails the run with `step-failed` and `failedStepId`; every step record that has not ended is `cancelled`, and no later step starts. A run that the controller cannot carry out for a reason of its own, such as a bug, fails ~~at its current step~~ *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80))* with the code `unexpected`, rather than staying `running` until the next restart.

  *(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* Such a run fails with the reason `controller-error`, not `step-failed`: `step-failed` means the step's action failed, and the author can do something about that, while `controller-error` means the controller failed, and the author cannot. A database error while a built-in action writes counts as the controller's, not the step's, even though it happens inside the action. `failedStepId` and `startedAt` are set when the run was at a step~~, and absent when it failed before its first step~~ *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80): `failedStepId` is set when the error happened at one step record, and absent otherwise, such as an error before the run's first step or in ~~the engine's scheduler that starts step records~~ the part of the run's execution that starts step records (amended 2026-09-25, [#253](https://github.com/theagenticage/hercule/issues/253)))*. The step record's code is `unexpected`, and the controller's log has the details.
- **Cancel** (`run.cancel`) works on a `pending` or `running` run: the run becomes `cancelled` with `finishedAt`, every `pending` and every `running` step record becomes `cancelled` (the pending ones too, not only the running ones), and no later step starts. A plugin action still running sees its `signal` abort ([./05-plugins.md](./05-plugins.md) section 4.4). A run that has already ended is refused with `invalid_state`, naming its status. There are no subscriptions or sessions to end yet.

  *(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* Cancelling a run also cancels every unfinished run that its `run.start` steps started, and the runs those started, however deep, in the same transaction. A child run that has already ended stays as it is. A child of a finished child is still reached: a child can outlive the run that started it. So cancelling the first run of a chain that a workflow started on itself stops the whole chain. Only cancel reaches child runs: a parent that fails or completes leaves its children running, because a `run.start` step does not wait for its child (section 8).
- *(Amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80).)* **Routing as built.**
  - A step record's status moves forward only: `pending → running → completed | failed | cancelled`, or `pending → skipped`, which is final. A record is created `pending`, and its step's condition is evaluated when the record would start (section 4.3). A skipped record has `finishedAt` and no `startedAt`, `output` or `error`.
  - `edgeTraversals` always has one count per edge of `plan.edges`, in the same order, zeros included. A count goes up in the transaction that follows the edge, and survives a restart.
  - `failedEdge` is set when the run failed at an edge: `iteration-limit`, or an `expression-error` in an edge's condition. `failedStepId` is then the edge's source. `failedEdge.index` is the edge's index in `plan.edges`, and `failedEdge.message` says what went wrong at the edge: the condition's evaluation error, or the `maxTraversals` it reached. A run that failed at a step has no `failedEdge`; the step record's `error` holds the message.
  - A step whose condition cannot be evaluated fails without running, so its failed record's `startedAt` equals its `finishedAt`.
  - A completed run's `output` is the output of the terminal step that ended it. A terminal action that returns nothing has the output `null`, so the run's `output` is `null` too. A run that completed without a terminal step has no `output`.
  - The run engine executes every ready step record at once. A step failing, a terminal step completing and a cancel each cancel every `running` record, and the engine stops the work behind it.
  - A run that the controller cannot carry out for a reason of its own fails at the step where the error happened, with `controller-error`, and the records running on other branches are `cancelled`. When the error is not at any step, the run fails with `controller-error` and no `failedStepId`.
  - When the controller starts and finds several plugin action records `running` in one run, the first of them, in the order the records were created, fails with the code `interrupted` and fails the run with `step-failed`. The others are `cancelled` with the run.
  - Every decision about what runs next is made in one of two transactions. The one that starts a record evaluates the step's condition and writes `running`, or `skipped` together with what follows from it. The one that ends a record writes its end together with the edges it follows, their counts, the new records, and the run's end when the run completes or fails. Every way a run ends goes through one function.
- *(Amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257).)* **Workspace steps as built.** A workspace step (section 4.4) runs on a runner, so its outcome arrives later, as a frame ([./03-controller-and-runners.md](./03-controller-and-runners.md) section 2.2).
  - **New fields.** `runnerId` and `workspaceId` are set in the transaction that starts the run's first workspace step, and kept after the run ends, as history. A step record's `input` holds the params an action step's action was called with: rendered from their templates and decoded against the action's input schema. It is set for every action step when the step starts, and absent for an agent step. A workspace step sent to its runner again must carry exactly the input it was first sent with, not a new rendering of its templates, and the run page shows it.
  - **The run sleeps and wakes.** A workspace step's record moves to `running` in its start transaction, and the step is handed to its runner after that transaction commits. The run's execution does not wait for it. When nothing is left that the run's execution can do on the controller, it returns, and the run is asleep: still `running`, with its only unfinished work on a runner. The runner's result ends the step record and decides what runs next, in one transaction, and then wakes the run's execution. A result that arrives while the run's execution is still busy makes it read the run's rows once more before it stops, so a result is never missed as the run falls asleep.
  - **A result is checked before it counts.** A completed step's output is decoded against the action's output schema, because the runner's build may not match the controller's catalog. An output that does not match fails the step with the code `unexpected`. A result for a record that has already ended (a duplicate, a cancelled step, or a step of an ended run) is ignored. So is a result from a runner the run is not pinned to, which is logged as a warning.
  - **Every delivery is idempotent by the step key `(runId, stepId, iteration)`.** Each time a runner connects, the controller sends it the workspace's provision again if the workspace is still `provisioning`, and then every workspace step still `running` in a run pinned to that runner, with its stored `input`. The runner ignores a repeated start while the step runs, answers it from the step's stored result once the step has finished, and runs it only when it has no trace of it, for example after the runner itself crashed. On connect the runner also reports the steps it has in flight, and the controller settles each one whose record is no longer `running`: it tells the runner it no longer owes the step, and the runner stops it if it is still running, deletes its result file, and ignores a later start of it. So a step cancelled while its runner was away is stopped when the runner returns, and never started again.
  - **A run waits for its runner with no time limit.** A workspace step on a runner that is `offline` or `unreachable` stays `running`, and the run waits. The run page shows "Waiting for runner X to reconnect (offline since 14:02)". The run ends only when the runner returns, or when the user cancels the run or retires the runner. A run stuck on a machine that is gone for good is the user's decision, not a timer's.
  - **No runner to pin yet.** When the first workspace step would start and no placeable runner is online ([./03-controller-and-runners.md](./03-controller-and-runners.md) section 5), the step record stays `pending` and the run sleeps. It is woken when a runner connects.
  - **A controller restart does not cut off a workspace step.** A workspace step record found `running` when the controller starts stays `running`: the run resumes asleep, and its runner's reconnect sends the step again. A plugin action found `running` still fails with `interrupted`, because only a workspace step can be delivered again safely.
  - **Cancel.** The cancel transaction ends the records as before. After it commits, the controller settles every workspace step it cancelled with the runner, which stops the step. A settle that cannot be delivered is caught by the runner's report when it returns.
  - **`workspace-failed`.** The run fails with `workspace-failed` when its workspace cannot be set up (a failed setup command), or when the user retires the runner it is pinned to (the message is "runner X was retired"). `failedStepId` is set when a workspace step was running, and that step's record is `failed`. A failed setup always has one: the first workspace step, whose start began the provisioning. A runner retired between two workspace steps has none, and `failedStepId` is absent.
  - **Error codes of a workspace step.** Beside the codes above, a runner reports `action_failed` (the action ran and failed; for a git action, the message holds the tail of git's error output), `timeout` (the action ran past its 10-minute deadline and was stopped), `unsupported_action` (the runner's build does not implement the action) and `interrupted` (the step was stopped before it finished). `validation` is the code for a step whose `resourceId` is not a checkout of the run's workspace. A workspace step that fails with one of these codes fails the run with `step-failed`, as any action does.
- *(Amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82).)* **Runs started by a trigger, as built.**
  - **`origin`** has a fourth kind, `{ kind: "trigger"; triggerId: string; eventId: number }`: the trigger's id in the workflow's source, and the event's position in the event log.
  - **`triggerEvent`** is the copy of the event that started the run, taken when the run was written: the event as the log held it then, without `raw`. Only a run a trigger started has one.
  - **`failureReason`** can be `validation-error`, with **`failureMessage`**, a sentence that says what did not validate (section 7.1). Only such a run has a `failureMessage`.
- Every committed change to a run or a step record publishes the run's id on the live topic `run` ([./14-web-app.md](./14-web-app.md)).

### 7.3 Platform events

At a terminal state the controller emits `run.completed`, `run.failed` or `run.cancelled` into the pipeline; other workflows may trigger on them (this is how a "learning" workflow over run outcomes, or a failure-notification workflow, is built). Cancellation is not a failure: a "notify me on failures" workflow must not fire when the user cancels on purpose, so cancel has its own kind. The payload shapes are owned outright by [./08-events-and-connections.md](./08-events-and-connections.md).

~~*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* Not emitted yet: a run reaches its terminal state and emits nothing into the pipeline until [#81](https://github.com/theagenticage/hercule/issues/81). Until then a client learns that a run ended from `run.read` and from the live topic `run` (section 7.2).~~

*(Amended 2026-09-27, [#81](https://github.com/theagenticage/hercule/issues/81).)* **Emitted as built.** Every run that ends emits exactly one of the three events.

- The event is written in the transaction that ends the run, by the one function every way a run ends goes through (section 7.2). So the run's status and its event commit together or not at all. A run ends only once, so it emits only once.
- A session's subscription to the run receives the event now ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2). ~~Triggers receive it when triggers start runs ([#82](https://github.com/theagenticage/hercule/issues/82)).~~ Start triggers receive it too, like any event *(amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82))*.
- The payloads, and what they leave out for now, are in [./08-events-and-connections.md](./08-events-and-connections.md) section 5.5.

### 7.4 Re-run

Re-run is whole-run only; there is no "re-run failed steps only". Two modes:

- **Re-stamp** (default): create a new run from the current workflow definition with the same resolved inputs. Picks up edits made since.
- **Replay**: create a new run from the original run's frozen plan with the same inputs. Reproduces exactly what ran before.

Both create a new Run that references the original. Re-runs provision fresh ephemeral workspaces; the failed run's kept workspace stays until ~~dismissed~~ disposed of or its window ends *(amended 2026-09-25, [#260](https://github.com/theagenticage/hercule/issues/260), section 4.4)*. Submitted runs (section 9) can only replay (there is no stored workflow to re-stamp from). Both are the `run.rerun` operation ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)).

*(Amended 2026-09-27, [#81](https://github.com/theagenticage/hercule/issues/81).)* **Re-run as built.** `run.rerun` takes the run's id and an optional `mode`, and answers `{ runId }` at once, as `run.start` does.

- **Only a run that has ended.** A `completed`, `failed` or `cancelled` run can be re-run. A `pending` or `running` run is refused with `invalid_state`.
- **Re-stamp** is the default. The new run's plan is the workflow as it is stored now, and its inputs are the original run's resolved inputs.
- **Replay** starts the original run's frozen plan with the original run's resolved inputs.
- **Checked like any start by request** (section 7.1). When the new run cannot start, the request is refused with `validation`, and no run is created. For example, a re-stamp whose stored workflow no longer accepts the old inputs, because an input was removed, is refused this way, and the message points to replay.
- **No stored workflow, no re-stamp.** A run of a workflow sent with `run.start`, or of a workflow deleted since, has no stored workflow to re-stamp from. A re-stamp of it is refused with `invalid_state`, and the message tells the caller to replay. This holds when `mode` is left out, too. The controller never falls back to replay by itself, because the caller would get the old plan without knowing it.
- **The new run** names the original in `originalRunId` (section 7.2). The mode is not stored. The new run's `origin` follows who called `run.rerun`, exactly as for `run.start` (section 7.2), and the nesting limit of `run.start` applies to it (section 8). It gets a fresh workspace, like any run.
- **No triggering event.** A re-run is started by its caller, not by an event, so it has no triggering event (section 7.1 step 4) and does not copy the original's. The original keeps its own copy, and `originalRunId` leads to it. ~~No run has a triggering event before [#82](https://github.com/theagenticage/hercule/issues/82).~~ *(amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82): a run a trigger starts has one, section 7.2)*
- **Lineage.** `run.query` with `originalRunId` lists the re-runs of a run.

### 7.5 Cleanup and supervision

There is no cleanup machinery beyond the substrate's: the run's ephemeral workspace is deleted on success, kept on failure until the failed run is dismissed, and collected by the runner's TTL reaper if orphaned *(amended 2026-09-25, [#260](https://github.com/theagenticage/hercule/issues/260): the workspace sweep applies the rules of section 4.4, and dismissing is `workspace.dispose`)*. No automatic retries and no per-workflow concurrency controls (pinned); no run-level timeouts either (this spec's consolidation from "no timeouts" on subscriptions and runner-owned session timeouts). A run's sessions are visible and steerable like any session; steering a running agent step is the ordinary way to correct it mid-flight.

## 8. Built-in actions

Five built-in actions ship in the core (~~three~~ four of them now *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))*; see the amendments below the table), registered into the workflow-action extension point like any plugin contribution but owned by the core. Each is a thin call into the same service layer the public API exposes ([ADR 0013](../adr/0013-agents-operate-hercule-through-the-public-api.md)) and carries the **same id as the operation** it calls ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 1.3); its input and output are that operation's contract schemas, so nothing is reachable through an action that is not reachable over HTTP. The tickets called the notification action `notify`; its id is `notification.create`. This table is the single owner of the catalogue; Task semantics are in [./09-tasks.md](./09-tasks.md), the Notification record and triage-specific usage in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md).

| Action | Input (contract op) | Output | Notes |
|---|---|---|---|
| ~~`workflow.run`~~ `run.start` *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))* | `{ workflowId, inputs }` | `{ runId }` | Fire-and-forget: starts a run of another workflow and returns immediately; does not wait or route on the child's output (that is the post-v1 sub-workflow step). The scheduled-tasks one-step shortcut uses it. |
| `notification.create` | Notification producer input: `{ kind, title, body?, actions?, subject? }` (record and bound-action shape per [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)) | `{ notificationId }` | Creates one core-owned Notification with producer = the run and step; delivery is decided by the core router, never by the step. |
| `task.create` | Task create input: `{ title, description, priority?, labels?, projectId?, provenance? }` | the created Task | Provenance may carry the triggering event id (`inputs.eventId`), the run id and external refs. |
| `task.update` | `{ taskId, ...changes }` | the updated Task | One call, one `task.updated` event with per-field diffs. Appending provenance is an update. |
| `wait` *(added 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))* | `{ seconds }`, a whole number from 1 to 86400 (one day); no contract op | `{}` | Pauses the run. The one built-in action that is not an operation, below. |
| `task.query` | `TaskFilter`: `{ refs?, labels?, status?, projectId?, text? }` (any-of within a field, and across fields; [./11](./11-public-api-and-agent-surface.md) section 2) | `{ items: Task[] }` | The same operation agents use. Structured fields match by exact identity: a provenance ref is matched by canonical external ref (`github:issue:owner/repo#42`), never by content; `text` is SQLite FTS over title and description and is normally absent in graphs. The guard-before-agent pattern: `task.query` on the event's refs, an edge on `size(steps.guard.output.items) > 0` to `task.update`, otherwise the agent step. |
| `git.commit` *(added 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257))* | `{ message, paths?, resourceId? }`; no contract op | `{ sha, branch, committed }` | Commits in the run's workspace. The first workspace action, below. |
| `git.push` *(added 2026-09-25, [#259](https://github.com/theagenticage/hercule/issues/259))* | `{ branch?, resourceId? }`; no contract op | `{ branch, sha }` | Pushes a branch of the run's workspace to the checkout's own remote. A workspace action, below. |

*(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* Three are registered now: `task.create`, `task.update` and `task.query`. `workflow.run` joins with [#79](https://github.com/theagenticage/hercule/issues/79) and `notification.create` with [#84](https://github.com/theagenticage/hercule/issues/84), each in the ticket that adds its operation, because an action is its operation and cannot exist before it. Two inputs differ from the operation's, by necessity. `task.update` takes `taskId` in its params, because a request carries it in the path, and it is refused when it names no field to change, by the operation's own rule. `task.query` takes `TaskFilter` without the paging fields and answers the first page, `{ items, nextCursor? }`: a step reads the answer to decide where the run goes next, and the first page answers that. ~~Nothing executes an action until runs exist ([#79](https://github.com/theagenticage/hercule/issues/79)).~~ *(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79): runs now execute these actions, below.)*

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* Runs execute the built-in actions, and ~~four are registered now: `workflow.run` joins `task.create`, `task.update` and `task.query`.~~ five are registered now: `task.create`, `task.update`, `task.query`, `run.start` and `wait` *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))*. `notification.create` still joins with [#84](https://github.com/theagenticage/hercule/issues/84), and until then a save refuses a step that names it as an unknown action.

- **~~`workflow.run`~~ `run.start`** takes `{ workflowId, inputs? }` in its params and outputs `{ runId }`. As with `task.update`, the id that a request carries in its path is a param. It starts the child run and completes at once, without waiting for the child. The child's origin is `{ kind: "action", parentRunId, stepId }`. The child is checked exactly as a start by request is (section 7.1). A child that cannot start, because its workflow no longer validates, has an element runs cannot execute yet, or is given inputs that are not valid, fails the parent step with the code `validation` and creates no child run. A workflow that does not exist fails it with `not_found`.
- **Actor.** Inside a run, a built-in action acts as `run:<runId>` and passes every grant check (section 4.1). So a ~~`workflow.run`~~ `run.start` step needs no grant, whoever started its run.
- **The run on a Task's provenance.** ~~"Provenance may carry ... the run id" in the table is met by the entry's `actor`: every provenance entry a step writes is stamped `run:<runId>`.~~ Expressions read only `inputs` and `steps`, and no variable for the run's id is added to them.

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* **One operation starts a run, and the built-in actions are five.**

- **`run.start` replaces `workflow.run` and `workflow.submit`**, as an operation and as an action. The two operations did one thing, start a run, for two kinds of workflow: a stored one and one sent with the request. One operation with one grant is simpler for a caller and for a profile. The rule above, that an action carries the id of the operation it calls, then gives the action the same id. The operation takes exactly one of `workflowId`, `source` and `definition`, beside `inputs` (section 9). The action takes only `{ workflowId, inputs? }`: a step that ran a workflow written into its own params would be a sub-workflow, which is post-v1. The grant is `run.start`; a profile that held `workflow.run` or `workflow.submit` holds `run.start` instead ([./13-security.md](./13-security.md)).
- **`wait`** pauses the run for `seconds`, a whole number from 1 to 86400, and outputs `{}`. A save refuses any other value, at `params.seconds`. It is the one built-in action that is not an operation, because waiting changes nothing and no caller of the API needs it. It holds no transaction while it waits. A controller that restarts during a wait waits only for the time the step had left, counted from the step record's `startedAt`, and not at all if that time has passed. Cancelling the run ends the wait at once, and no later step starts.
- **How deep runs may nest.** A run started by hand, by a program or by a trigger is 1 deep. A run that a `run.start` step starts is one deeper than the step's run. A `run.start` step whose child would be deeper than the controller setting `run.nestingLimit` (default 5) fails with the code `cap_exceeded` and starts no run, and the parent fails with `step-failed`. Without the limit, a workflow that starts itself, directly or through another workflow, would start runs without end, and with two such steps their number would double each time. The message names the depth and the limit and says how to change either. The setting is changed through the API or the CLI: `hercule settings update --controller '{"run.nestingLimit": 8}'`. Cancelling a run also cancels the runs it started (section 7.2).
- **The run on a Task's provenance.** A task that a run's `task.create` step creates gets one provenance entry `{ runId }` after the entries the step's params give, unless one of those already names the run. Provenance records what created the task, and that was the run. Stamping the entries `run:<runId>` recorded who wrote them, not where the task came from. `task.update` adds nothing: provenance records where a task came from, and a run that edits a task did not create it. The entry is the core's own, so it does not count toward the limit on how many entries one request may add ([./09-tasks.md](./09-tasks.md)).

*(Amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257); [ADR 0035](../adr/0035-an-action-declares-where-it-runs.md).)* **Every action says where it runs, and `git.commit` is the first action that runs in a workspace.**

- **`runsIn: "controller" | "workspace"`** is a fixed property of every action in the catalog, never a choice the step makes. `controller`: the controller calls the action. Every plugin action runs there, and so does every built-in action above. `workspace`: the run's runner runs the action in the run's workspace (section 4.4). Only built-in actions run in a workspace: their code is built into the runner, and the controller's catalog holds their id, their schemas and `runsIn`, which validation and the action pickers read. Plugins cannot contribute one in v1 ([./05-plugins.md](./05-plugins.md) section 4.4).
- **A workspace action has no operation.** Like `wait`, it changes nothing in the controller's database, so no caller of the API needs it as an operation.
- **A workspace action runs commands as argument lists, never as shell strings** ([./13-security.md](./13-security.md) section 9.6). A template in its params fills one argument and nothing else.
- **`git.commit`** commits the changes in one checkout of the run's workspace. It takes `{ message, paths?, resourceId? }` and outputs `{ sha, branch, committed }`:
  - `message` is the commit message, and may not be empty.
  - `paths` limits the commit to those paths. Without `paths`, every change in the checkout is staged (`git add -A`) and committed. The paths are given to git after `--`, so a path that starts with `-` is never read as an option.
  - `resourceId` picks the checkout when the workspace has more than one, and may be left out when it has one (section 1 refuses it left out with more than one). A `resourceId` that is not a checkout of the workspace fails the step with the code `validation`; a workspace with no checkout at all is refused at save (section 1).
  - `sha` is the commit made, `branch` the checkout's branch.
  - **Nothing to commit is not a failure.** The step succeeds with `committed: false`, and `sha` is the checkout's current HEAD. A workflow that wants a failure there routes on it: an edge with the condition `!steps.commit.output.committed` to a step that reports it.
  - The commit's author is the workspace's designated Connection, as for a session ([./13-security.md](./13-security.md) section 9.2). With no Connection behind the workspace, git's own identity on the machine is left as it is.
  - It fails with `action_failed` when git fails, with the tail of git's error output as the message, and with `timeout` after 10 minutes.

*(Amended 2026-09-25, [#259](https://github.com/theagenticage/hercule/issues/259).)* **`git.push`** is the second workspace action. It pushes a branch of one checkout of the run's workspace. It takes `{ branch?, resourceId? }` and outputs `{ branch, sha }`:

- `branch` is the branch to push, and defaults to the checkout's current branch. It is checked with `git check-ref-format --branch`. A name that is not a valid branch name, or that git would expand into another one (such as `@{-1}`), fails the step with `action_failed` before anything is pushed. It reaches git after `--`, so it is never read as an option.
- `resourceId` picks the checkout exactly as for `git.commit`.
- The branch is pushed to the branch of the same name on the checkout's own remote, and set as its upstream. There is no `remote` param: the controller hands out credentials only for the checkout's own remote ([./13-security.md](./13-security.md) section 9.1), so a push anywhere else could not authenticate.
- **It never forces.** A push the remote refuses, such as a non-fast-forward because the remote branch has commits the checkout lacks, fails the step with `action_failed` and the tail of git's error output as the message.
- `branch` is the branch pushed, `sha` the commit it points at. After `git.commit`, `steps.push.output.sha` equals `steps.commit.output.sha`.
- It authenticates with the checkout's Connection, through the runner's credential helper, which asks as the runner and names the workspace while the step runs ([./13-security.md](./13-security.md) section 9.1).
- It fails with `timeout` after 10 minutes, as every workspace action does. Sending the same step to the runner again is safe: a remote that already has the commit accepts the same push and changes nothing.

GitHub and Gmail actions (for example creating a PR, commenting, fetching a mail body on demand, merging) are plugin contributions of the `github` and `gmail` plugins, invoked as ordinary action steps naming the Connection they act as (`connection.use` grant, [./13-security.md](./13-security.md)). ~~Their exact roster is Open in [./05-plugins.md](./05-plugins.md).~~ *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* Their roster is in [./05-plugins.md](./05-plugins.md) section 4.4, and the GitHub actions are built. ~~`connection.use` is checked only when a run of a sent workflow starts (section 7.1).~~ *(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* `connection.use` is checked when a workflow with such a step is saved (section 1), and when a run is started or replayed in a way that chooses the Connection (section 7.1). Mid-session mailbox access from an agent step is covered in v1 by gmail action steps around it and the session spec's MCP passthrough.

## 9. Ad-hoc workflows

An agent (or the user) may start a run from a workflow definition that is not stored: ~~`workflow.submit { definition, inputs }`~~ `run.start { source | definition, inputs? }` *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))* ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)), where `definition` is the `Workflow` shape of section 1 minus `id` and timestamps. The controller validates it exactly as a stored workflow (section 1), freezes it into a run with `workflowId: null` ~~and `origin.kind: "api"`~~ *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79): the origin follows who started the run, below)*, and executes it; ~~`workflow.run`~~ `run.start { workflowId }` loads a stored definition and takes the same path. The definition lives only on that run; it is never stored as a workflow and nothing else references it. This is how "something weird once" is expressed without user code, and how an agent that needs a route no shipped workflow has gets one ([ADR 0001](../adr/0001-runs-freeze-an-execution-plan.md), [ADR 0008](../adr/0008-workflow-graphs-route-on-declared-outputs.md)). The outside world only ever writes workflows; "execution plan" names the frozen copy on a run and appears in no contract. Graduating a submitted definition into a stored workflow ("save as workflow") is post-v1.

Grant: ~~`workflow.submit`, its own verb~~ `run.start`, the one grant for starting any run *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))*, held by the shipped `assistant` profile and withheld from `worker` ([./13-security.md](./13-security.md)).

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* ~~`workflow.submit` takes `{ source | definition, inputs? }`: exactly one of `source` (the YAML text) and `definition` (the `WorkflowDefinition` object of section 1), as `workflow.create` does, and the values the run starts with. It is checked and refused exactly as `workflow.run` is (section 7.1), and it answers `{ runId }` at once. The workflow is never stored: the run has `workflowId: null`, its origin is `api` whoever calls it, and its `plan` is the only copy of the definition. A submitted source is parsed into the plan; the text itself is not kept.~~

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* **`run.start`** takes exactly one of `workflowId` (a stored workflow), `source` (the YAML text) and `definition` (the `WorkflowDefinition` object of section 1), beside `inputs?`, the values the run starts with. A request that names no workflow, or more than one, is refused with `validation`, as one issue at the whole request. A stored workflow is loaded and a sent one parsed, and from there both take the same path: checked and refused as section 7.1 says, answered with `{ runId }` at once. A sent workflow is never stored: the run has `workflowId: null`, and its `plan` is the only copy of the definition; a sent source is parsed into the plan and the text itself is not kept. The run's origin follows who started it, not the kind of workflow: `manual` for the user, `api` for a session, `action` for a run's step (section 7.2).

## 10. The human moment

There is no human-gate step in v1. What covers a workflow needing a person:

- **Failure notifications plus re-run.** A failed run is a core Notification and a `run.failed` platform event; the user reads the run record, fixes the workflow, prompt or filter, and re-runs.
- **An explicit verdict.** A triage-style agent step declares an `unsure` (or similar) value in its output enum; an edge routes it to a `notify` step and the run ends. The person acts out of band: tells an assistant to proceed, or clicks a bound action on the Notification that starts the next workflow with the task attached. No run waits for a human.
- **Steering.** A running agent step is an ordinary Session; the user can steer it, answer its approval requests (access modes) and its Permission Requests ([./13-security.md](./13-security.md)), none of which block the graph.

Whether a gate step earns a return is a post-dogfooding question: it needs a known shape for the question a workflow can pose upfront.

## Post-v1

- Human-gate step; returns post-dogfooding once the question shape is known. Kept possible: steps are a closed tagged union that can grow a third kind.
- Sub-workflow steps that wait and route on the child's output; v1 has fire-and-forget ~~`workflow.run`~~ `run.start` *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))* only.
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

- Workflow model: recipes, triggers, human gates - https://github.com/theagenticage/hercule/issues/13
- Workflow execution semantics: joins, signals, errors, run states - https://github.com/theagenticage/hercule/issues/36
- Research: TypeScript-native expression language for workflow conditions - https://github.com/theagenticage/hercule/issues/27
- Research: structured output across provider harnesses - https://github.com/theagenticage/hercule/issues/28
- Triage engine & user-set bounds - https://github.com/theagenticage/hercule/issues/15
- Event & trigger ingress design - https://github.com/theagenticage/hercule/issues/14
- Domain model & ubiquitous language - https://github.com/theagenticage/hercule/issues/6
- Controller/runner architecture: registration, placement, scheduling - https://github.com/theagenticage/hercule/issues/7
- Runner execution substrate - https://github.com/theagenticage/hercule/issues/8
- Plugin architecture: API shape, loading, dogfooding - https://github.com/theagenticage/hercule/issues/11
- Provider adapter interface - https://github.com/theagenticage/hercule/issues/12
- Agent-operates-system surface - https://github.com/theagenticage/hercule/issues/16
- Security & secrets model - https://github.com/theagenticage/hercule/issues/18
- Assemble the v1 spec (Intake constraint: stored triage verdict) - https://github.com/theagenticage/hercule/issues/21
- Task model: shape, status axis, lifecycle, provenance - https://github.com/theagenticage/hercule/issues/29
- Prototype: the Intake view - https://github.com/theagenticage/hercule/issues/30

ADRs: [0001](../adr/0001-runs-freeze-an-execution-plan.md), [0002](../adr/0002-orchestration-stays-on-the-controller.md), [0008](../adr/0008-workflow-graphs-route-on-declared-outputs.md), [0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md), [0011](../adr/0011-triage-is-a-workflow-pattern-inside-core-enforced-bounds.md), [0013](../adr/0013-agents-operate-hercule-through-the-public-api.md), [0019](../adr/0019-the-task-model-is-thin-workflows-own-task-semantics.md), [0035](../adr/0035-an-action-declares-where-it-runs.md).

Research: `research/expression-language.md` (branch `research/expression-language`), `research/structured-output.md` (branch `research/structured-output`).
