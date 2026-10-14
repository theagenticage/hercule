# 44. A text generation step is a third step kind

Date: 2026-10-14

## Status

Accepted by [Workflow step for a cheap classify/extract text generation: pick a shape (#286)](https://github.com/theagenticage/hercule/issues/286). Extends [ADR 0008](./0008-workflow-graphs-route-on-declared-outputs.md): a text generation step's declared output schema is its whole contract with the graph, as an agent step's is. Amends [ADR 0041](./0041-text-generation-is-one-model-call-on-a-runner.md), which carries a dated note.

## Context

A workflow sometimes needs one cheap classify or extract call: "is this mail something the user must act on?", or "pull the version number out of this release note". An agent step is too heavy for that. It starts a Session with tools and a workspace. Text generation ([ADR 0041](./0041-text-generation-is-one-model-call-on-a-runner.md)) is the right size: one model call on a runner, with no tools, that returns a value matching a schema. Until now only code inside the controller could make one.

The first user is the shipped Screener ([spec 10 §9.8](../spec/10-triage-intake-and-notifications.md)). It runs up to 100 times an hour, once per screened item. Its call must survive a laptop runner going to sleep, a burst of 40 items queued overnight, and a controller restart, without failing every item open.

## Decision

**A workflow step of a third kind, `text-generation`, makes one text generation. It declares `instructions`, `input` and a required `outputSchema`, and its output is the value the model returns.**

```yaml
- id: screen
  kind: text-generation
  instructions: "You decide whether one incoming item becomes a signal. ..."
  input: "{{ inputs.item }}"
  outputSchema:
    type: object
    additionalProperties: false
    required: [decision, reason]
    properties:
      decision: { type: string, enum: ["yes", "no"] }
      reason: { type: string }
```

- **The shape.** `instructions` is the system prompt: trusted text the author wrote. `input` is the one user message, and may hold untrusted text such as a mail. Both are templates. `outputSchema` is required and follows the same strict subset as an agent step's. There is no model field: the step always uses the text generation model setting. Unknown keys, such as `model`, `agent` or `prompt`, are refused at save.
- **Not a workspace step.** It never pins the run to a runner and never opens the workspace. The text generation service picks its own runner, which may differ from the runner the run's agent steps use.
- **A ready check before the call.** The step asks the same resolution the service uses:
  - the setting is Off: the step fails with `text_generation_off`, because the user chose Off and waiting would hide that;
  - no model resolves, or no runner could take the call: the step waits, with no time limit, like a workspace step with no runner;
  - otherwise the record moves to `running` in a transaction of its own, and the call is made after that commit, outside any transaction.
- **Why it waits.** The controller status gains `unavailableReason`, the sentence that says why no text generation can run now, or null. A waiting step shows that sentence. The step record gets no waiting status: the waiting line is worked out from data that already exists.
- **How it ends.** A value is the output. `invalid-output` fails the step with `schema_failure`, `timeout` with `timeout`, and `failed` with `text_generation_failed`. Rendered instructions or input over 64 KiB fail with `input_too_large` before any call.
- **`unavailable` is not a failure.** The call found no runner, or the runner's connection ended before it answered. The record stays `running` and the ready check runs again. If the check passes, the step is called once more at once. A second `unavailable` in a row, or a check that fails, puts the step to sleep until a wake. So a broken setup never becomes a busy loop.
- **What wakes it.** A runner arriving, a change of placements, a stored probe snapshot, and a write of `textGeneration.model`. The providers and settings domains each publish a change stream: a sliding PubSub, published only after the change commits. A fiber of the controller daemon merges them and wakes the runs waiting for text generation. The domains never import runs or the controller daemon.
- **A restart calls it again.** A text generation record found `running` at boot is called again under the same record, not marked `interrupted`. A text generation changes nothing, so calling it again is safe.
- **Cancel** interrupts the call in flight. The runner slot stays held until the runner answers.
- **The record and the audit.** The caller is `run:<runId>` and the purpose is the step id, so the audit entry shows which run and which step made the call. The record stores the output only, never the rendered input: it can be rebuilt from the run's inputs and earlier outputs, which the run already stores.

The service changes with it, for every caller:

- **The deadline starts when the call holds a slot.** The wait for a free slot no longer counts against the 60 seconds. 40 screenings queued overnight then wait for slots when the Mac wakes, instead of all timing out.
- **A new reason, `failed`,** split out of `unavailable`. `unavailable` now means "no runner can take the call now, try again later". `failed` means the runner took the call and gave no answer, or the controller could not send it. A step must wait on the first and fail on the second.
- **The core takes JSON Schema.** `generate` takes the output schema as JSON Schema and checks the value against it. The Effect Schema form that Thread titles use is a thin wrapper around it.

The step is written in [spec 07](../spec/07-workflows.md) §4, §4.4, §6 and §7.2, the service changes in [spec 06 §14](../spec/06-providers.md), the Screener in [spec 10 §9.8](../spec/10-triage-intake-and-notifications.md), and the run page in [spec 14](../spec/14-web-app.md).

## Considered options

- **An action step that calls a built-in action `text.generate`.** Rejected. An action declares one output schema in the catalog, so a per-step schema would have nothing to be checked against ([ADR 0008](./0008-workflow-graphs-route-on-declared-outputs.md)). An action also declares where it runs, on the controller or in the run's workspace ([ADR 0035](./0035-an-action-declares-where-it-runs.md)). A text generation runs on neither: it runs on whichever runner the service picks.
- **An agent step with no tools, or with no `agent`.** Rejected. An agent step is a Session. It is a workspace step, it pins the run, it unloads when idle, and later iterations resume the same Session. None of that fits one model call. A step that switched between "session" and "no session" by whether a field is present would hide a second mode inside one step kind.
- **Answering it together with inline agent steps ([#225](https://github.com/theagenticage/hercule/issues/225)).** Rejected. #225 asks where a Session's permission profile and provider instance come from when there is no Agent. A text generation step has no Session, no tools and no profile, so none of those questions apply. #225 stays open for steps with tools.
- **One `prompt` field instead of `instructions` and `input`.** Rejected. The two fields map one to one onto the service. Untrusted text belongs in the user message and never in the system prompt, and one field cannot keep them apart.
- **A per-step model override.** Out of scope. Nothing needs it today, and it can be added later without breaking stored workflows.
- **Treating the runner's `failed` as `unavailable`, as the service did.** Rejected. A rate limit, a lost login or a crashing harness would then pass the ready check at once, and the step would call again in a loop. A step must tell "try later" from "this failed".

## Consequences

- A workflow can classify or extract with one cheap call, without a Session, a workspace or a pinned runner.
- A Screener run waits through a sleeping laptop, a missing login or a controller restart, and fails only when the setting is Off or the model gave no usable answer.
- Thread titles get their title a little later during a burst, because a call no longer times out while it waits for a slot.
- Known limits:
  - **The local runner first.** The service prefers the controller's local runner, so a burst queues on its 10 slots even when another runner is free. With the slot wait no longer counted, this costs speed, not failures.
  - **Rate limits fail the step.** A provider's rate or usage limit comes back `failed`, so the step fails with `text_generation_failed`, and every Screener run fails the same way until the limit resets. [#625](https://github.com/theagenticage/hercule/issues/625) makes a limit a reason to wait, and blocks the Screener's build.
- Not done here: typed checks of `steps.<id>.output.<field>` against the schema (every CEL variable is `dyn` in v1, for every step kind), showing or storing the prompt, per-purpose overrides, and spreading calls over runners.
- **Future direction: decision models.** A decision model takes an item and typed questions (yes or no, a choice, a score) and returns probabilities with no text. It is cheaper and faster than a text generation, but it writes no reason, cannot extract values, and as far as we found is reachable only over HTTP with an API key, not through a harness login. So it does not replace this step. The direction is a fourth step kind, `decision`, with a decision model setting of its own. This step is already ready for it: the criteria and the item are separate fields, and the declared schema is already the contract with the graph. [#622](https://github.com/theagenticage/hercule/issues/622) follows that up.
