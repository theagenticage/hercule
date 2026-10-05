# 35. An action declares where it runs

Date: 2026-09-25

## Status

Accepted. Decided by [The run's workspace and workspace actions (#254)](https://github.com/theagenticage/hercule/issues/254) and built first by [Workspace steps: the round trip, proven by `git.commit` (#257)](https://github.com/theagenticage/hercule/issues/257). Reverses two statements of the spec: "action steps run on the controller" ([spec 07](../spec/07-workflows.md) §4.4) and "anything git (clone, push, branch) is not an action" ([spec 05](../spec/05-plugins.md) §4.4). Keeps [ADR 0002](./0002-orchestration-stays-on-the-controller.md) (orchestration stays on the controller) and [ADR 0006](./0006-plugins-request-capabilities-and-register-contributions-in-code.md) (plugins run only on the controller).

**Amended 2026-10-04 ([#83](https://github.com/theagenticage/hercule/issues/83)):** agent steps are built as workspace steps, as the consequence below expected. The transaction that starts a run's first workspace step, an agent step or a workspace action, pins the run and opens its workspace. A run with an agent step is pinned even when it has no workspace policy, because its sessions run on that runner. An agent step's result reaches the controller as a workspace action's does, as a `WorkspaceStepResult` keyed by the step key. Unlike a workspace action, an agent step does not wait for the other steps in its workspace ([spec 07](../spec/07-workflows.md) §4.2 and §4.4).

## Context

A run takes place in one workspace on one runner ([spec 07](../spec/07-workflows.md) §4.4). Until now only an agent step could touch that workspace, because every action step ran on the controller. So this workflow could not be written:

```
implement (agent) → commit → push → open PR
```

The only way was to ask an agent to "commit and push". That is slow, costs tokens, and is not reliable: the agent may forget, commit the wrong files, or describe a push it never made.

The controller cannot run git itself. The workspace's files live on the runner's disk, and paths never cross between the two ([spec 03](../spec/03-controller-and-runners.md) §1.3). So some action steps must run on a runner, and something has to decide which ones.

## Decision

**Every workflow action declares where it runs: `runsIn: "controller" | "workspace"`.** This is a fixed property of the action, stored in its catalog entry beside its id and schemas. A step never chooses where it runs.

```ts
{ id: "task.create", runsIn: "controller", input: TaskCreateInput,                    output: Task }
{ id: "git.commit",  runsIn: "workspace",  input: { message, paths?, resourceId? },   output: { sha, branch, committed } }
```

- **A controller action** runs on the controller. It gets the run's context and, later, `ctx.api` and Connections ([spec 05](../spec/05-plugins.md) §4.4). Every plugin action is a controller action, and so are the built-in actions that are operations, such as `task.create`.
- **A workspace action** runs on the run's runner, in the run's workspace. It gets the workspace's folder and, for a push, the git credential helper ([spec 13](../spec/13-security.md) §9.1). A step that calls one is a **workspace step**.
- **Each action keeps its own typed input and output.** There is no generic envelope, so edges route on real fields, such as `steps.commit.output.committed` ([ADR 0008](./0008-workflow-graphs-route-on-declared-outputs.md)).
- **Workspace actions are built into the runner in v1**, written plugin-shaped, in a folder of their own beside the provider adapters. Providers already work this way ([spec 05](../spec/05-plugins.md) §3, "Where plugins run"). The controller keeps each workspace action's catalog entry (id, schemas, `runsIn`), which save-time validation and the action pickers read. The runner holds the code. Plugins cannot contribute workspace actions in v1.
- **Orchestration stays on the controller** ([ADR 0002](./0002-orchestration-stays-on-the-controller.md)). The controller decides when a workspace step starts, sends it to the run's runner, and records how it ended. The runner runs one action and reports its outcome. It never reads the plan.
- **A workspace action runs commands as argument lists, never as shell strings.** A template fills an argument and nothing else. A workflow fired by an external event must not be able to run commands on the user's machine. Example: a GitHub issue titled `fix; rm -rf ~` becomes a commit message through `{{ inputs.title }}`. The runner passes that text to `git commit` as one argument, and no shell ever reads it, so the `rm` never runs.

The v1 roster is `git.commit` ([#257](https://github.com/theagenticage/hercule/issues/257)) and `git.push` ([#259](https://github.com/theagenticage/hercule/issues/259)).

## Considered options

- **A generic `exec` action**, such as `{ command, args } → { stdout, exitCode }`. Rejected. Its output is text, so an edge would route on parsed stdout rather than on a declared field ([ADR 0008](./0008-workflow-graphs-route-on-declared-outputs.md)). And it puts a command on the machine from a template, so a workflow triggered by an outsider's issue or email is one careless template away from running what the outsider wrote. It can come later as one more action, with its own contract and its own security story, and it follows the argument-list rule above.
- **The step chooses where it runs**, for example `runsIn` on the step. Rejected. Where an action can run is a fact about its code, not about the step that calls it. `task.create` has no meaning on a runner, which holds no Hercule state, and `git.commit` cannot run on the controller, which has no workspace. A step-level choice would only add a way to be wrong.
- **Plugins on runners**, so a plugin can contribute a workspace action. Rejected for v1. Plugins load only on the controller ([ADR 0006](./0006-plugins-request-capabilities-and-register-contributions-in-code.md)). A plugin host on every runner means shipping plugin code, versions and configuration to every machine, and a second place where plugin trust must be enforced. Nothing in v1 needs it: the two git actions are the whole roster. Built-in runner code written plugin-shaped keeps that door open, as it does for providers.

## Consequences

- Save-time validation reads `runsIn`. A workflow with a workspace action and no `workspace` policy is refused, because the action would have nowhere to run. A git action without `resourceId`, in a workflow whose policy has more than one checkout, is refused, because the checkout it works in would be ambiguous.
- The run's workspace is provisioned, and the run pinned to a runner, when its first workspace step starts, whether that is an action or (with [#83](https://github.com/theagenticage/hercule/issues/83)) an agent step. It used to be the first agent step.
- A run now waits on runners. A workspace step's outcome arrives as a frame, possibly after either side restarts. The run's execution sleeps while its only unfinished work is on a runner, and the result wakes it. Every delivery is idempotent by the step key `(runId, stepId, iteration)`, so the controller can send a step again whenever it cannot know whether the runner has it ([spec 07](../spec/07-workflows.md) §7.2).
- **Version skew.** The controller's catalog and the runner's code ship in the same binary, but a fleet may run different builds on different machines ([spec 03](../spec/03-controller-and-runners.md) §2.4). So a runner may not implement a workspace action the controller's catalog lists. At hello, a runner lists the workspace actions it implements, in the capability list [ADR 0002](./0002-orchestration-stays-on-the-controller.md) set up for this kind of growth. Placement picks only runners that implement every workspace action in the plan, and a plan that no runner can serve is refused with a message that names the missing actions ([#258](https://github.com/theagenticage/hercule/issues/258)). Until then, a runner answers an action it lacks with `unsupported_action`. Either way, the controller decodes a runner's output against its own output schema, and a mismatch fails the step.
- A new workspace action ships as a runner release, not as a plugin install. A third party cannot add one in v1.
- The author of a commit made by `git.commit` is the workspace's designated Connection, as for a session, until per-checkout identity is built ([spec 13](../spec/13-security.md) §9.2).
