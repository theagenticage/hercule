# 41. Text generation is one model call on a runner

Date: 2026-10-11

## Status

Accepted by [Text generation: one small model call, run on a runner, with Thread titles as the first use (#282)](https://github.com/theagenticage/hercule/issues/282). Amends [ADR 0007](./0007-provider-adapter-is-a-thin-interface-behind-a-normalized-event-stream.md): the provider adapter gains a one-shot method beside the probe and the session methods.

## Context

Every model call in Hercule was a Session: an agent with tools, a workspace and a transcript. Many small jobs need none of that. They need one call: some instructions and an input go in, and a short, validated piece of structured text comes out. A Thread's title is the first such job. Until now it was the first prompt cut short. Known later callers are branch names, run summaries, memory gists, English to CEL or cron, a plugin pulling refs out of a mail, and a pull request's title and body.

Three facts shaped the design:

- **The controller holds no provider login.** Auth is delegated to runners ([spec 13 §8](../spec/13-security.md)), so the controller cannot call a model itself. Every model call has to run on a runner, through a harness that is logged in there.
- **We cannot predict every use.** A service with one method per use, which every provider implements (the shape t3code uses), grows with every caller and gives plugins no way in.
- **Hercule never switches behaviour silently.** t3code falls back to another provider when the chosen one fails. Hercule rules that out.

This decision contradicts two earlier texts, on purpose:

- **Contradicts ADR 0007**, which defines the adapter as a probe plus session methods behind a normalized event stream. A text generation is neither: it has no session and no event stream. The adapter gains a one-shot method for it.
- **Contradicts CONTEXT.md**, which defined a Provider as an adapter wrapping an *interactive* coding harness. A text generation drives the same harness non-interactively, for one answer. The Provider entry is amended, and the terms Text Generation, text generation model and Purpose are added.

## Decision

**A text generation is one model call, made on a runner through the provider adapter's one-shot method, with no tools, no workspace and nothing persisted. Core code calls it through one controller service, and the user chooses which model makes it.**

- **What it is.** Instructions, one input and an output schema go in. A value that matches the schema comes out. There are no tools, no workspace, no transcript and no turn. It has no Session row and takes no session slot. Work that needs tools stays an agent step.
- **The adapter's one-shot method.** `generateText` sits beside the probe and the session methods. It can fail with an error, and otherwise returns `ok` with the value, `invalid-output`, `timeout` or `failed`; the runner turns an error into `failed`. Each call starts its own harness process in a scratch folder the runner makes for it (mode 0700, under `<runner storage>/scratch`) and passes to the adapter as `ctx.cwd`. The runner removes the folder on every path and wipes the whole `scratch` folder when it starts. The runner also owns the 60 second deadline, which answers `timeout`, and runs at most 10 calls at once. It frees a slot only after the harness process has exited, killing it after a bounded grace period. The harness persists no session, and runs at its provider's cheapest reasoning setting. Each provider's way of turning tools and persistence off is written in [spec 06 §14](../spec/06-providers.md).
- **Frames behind a capability.** `TextGenerationRequest` and `TextGenerationReport` travel the runner WebSocket. The controller sends the request only to a runner whose negotiated capabilities hold `textGeneration`, so `PROTOCOL_VERSION` does not change: an older runner simply never receives the frame.
- **Who calls it.** The controller's `TextGeneration` service. Core domains call it now. Plugins get it later through a host capability ([#285](https://github.com/theagenticage/hercule/issues/285)). Agents and sessions never get it: they are already model calls with far more context. It is not a public operation in v1 ([#287](https://github.com/theagenticage/hercule/issues/287)).
- **Purpose.** Every call names what it is for, such as `thread.title`. The service qualifies it with the caller, so the record shows `sessions/thread.title`, and one caller cannot claim another's purpose. The model never sees it. There is no registry: a purpose is only a name.
- **The setting.** One controller setting, `textGeneration.model`, with three values:
  - **Automatic**, the default. It picks the first provider, in a fixed controller order (Codex, then pi, then Claude Code), whose suggested text generation model is in a logged-in instance's model catalog. Each provider names its suggestion in `suggestedTextGenerationModel` on its `ProviderDefinition`: Codex `gpt-6-luna`, pi `glm-5.3-flash`, and Claude a Haiku model. With no match, text generation is off.
  - **A chosen instance and model.** If that instance cannot run the call, the call fails. It never falls back to another provider.
  - **Off.** Every call fails at once as `unavailable`, and nothing is recorded.
- **Where it runs.** On the controller's local runner first, when the instance is logged in there. Otherwise on any other runner that could take the call. A runner could take it when it is placeable, not reserved, negotiated the capability, has the instance logged in and lists the model. Automatic and the chosen model use this same rule.
- **Capacity.** At most 10 text generations run at once per runner. The limit is a constant in `@hercule/protocol` that both sides enforce. It only guards against a burst. It is separate from `maxConcurrentSessions`. The controller queues a call over the limit until a slot is free, and that wait counts against the caller's 60 seconds. The runner refuses an 11th call. A slot stays held until the runner answers, so a caller that gives up does not free it early.
- **How it ends.** The caller waits up to the timeout, 60 seconds, and gets the value or a typed error. The caller decides its own fallback. Nothing is retried, and a call waiting for a slot is held only in memory, so a controller restart that loses a call in flight leaves nothing to clean up. The errors are:
  - `unavailable`: no runner can take the call, or the harness failed;
  - `timeout`: no answer came in time, counting the wait for a free slot, or the runner stopped the harness at its own deadline;
  - `invalid-output`: the model answered with a value that does not match the schema.
- **The record.** Every call, except one refused because the setting is Off, writes an audit entry, `textGeneration.completed` or `textGeneration.failed`, with the `system` actor. These entries are never routed. They hold the qualified purpose, the caller, the instance, model and runner, the duration, the outcome, and usage and cost when the provider reports them. They never hold the prompt or the output.
- **The last failure.** The controller holds the last failure in memory, with the value of the setting it happened under and the instance and model it ran on. The next success clears it, and a failure is not shown once the setting or the model it resolves to has changed. `controller.read` shows it beside the model Automatic resolves to, so Settings can say "Automatic - currently Codex gpt-6-luna" and why the last call failed.
- **Thread titles are the first use.** The cut-short first prompt stays the immediate title and the fallback. At the first submission a `sessions/thread.title` text generation runs in the background, beside the turn. It reads the first message only and returns `{ title, needsRefinement }`. The title replaces the cut-short one once, and `needsRefinement` is stored for a later refinement ([#283](https://github.com/theagenticage/hercule/issues/283)). Workflow and assistant sessions keep their cut-short title.

The behaviour is written in [spec 06 §14](../spec/06-providers.md), the frames in [spec 03 §2.2](../spec/03-controller-and-runners.md), the setting in [spec 11](../spec/11-public-api-and-agent-surface.md), the record in [spec 13 §11](../spec/13-security.md) and the plugin rule in [spec 05](../spec/05-plugins.md).

## Considered options

- **Run the call on the controller.** Rejected. The controller holds no provider login and must not, by auth delegation ([spec 13 §8](../spec/13-security.md)). Giving it one would put a second copy of every credential on the one machine that faces the network.
- **Make it a short Session.** Rejected. A Session brings a row, a session slot, a transcript, tools and a workspace. A title would then take the slot a real thread waits for, and the transcript would fill with sessions nobody opened. Leaving out tools inside a Session would also mean a second mode for every session path.
- **One method per use on a service every provider implements.** Rejected. It grows with every caller, and plugins could never add one.
- **Fall back to another provider when the chosen one fails.** Rejected. It hides which model, and whose subscription, does the work. Automatic is a visible choice the user makes, not a hidden fallback behind a choice.
- **Per-purpose model overrides and a user-editable Automatic order.** Out of scope. Purpose is recorded now so overrides can be added later without changing callers.
- **A warm harness process per runner.** Deferred. One process per call costs about 0.5 to 2 seconds to start, and Claude Code about 1 GiB of memory while it runs. A warm process is an optimization to make only after measuring.

## Consequences

- Any core domain can make a small model call in one line, and the user sees which model does it and why the last call failed.
- Text generation spends the user's subscription in the background. Plugins may do that only behind a switch in the plugin's config, off by default ([spec 05](../spec/05-plugins.md)).
- Each adapter carries a second, non-interactive code path into its harness. Each provider's way of turning off tools and persistence depends on its harness version and is checked at build time ([spec 16 §C](../spec/16-open-items.md)).
- A text generation does not count against `maxConcurrentSessions`, so a busy runner can still briefly run up to 10 harness processes beside its sessions.
- A runner on an older build is never asked, so a fleet with only older runners has text generation unavailable until one is upgraded, and Settings shows that as the last failure.
