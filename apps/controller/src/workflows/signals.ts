import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { SqlError } from "effect/unstable/sql/SqlError";

/**
 * What the workflows domain needs to know about a Signal: its kind, because a
 * run's signal input accepts only the id of a Signal of the kinds it lists.
 *
 * The signals domain depends on the workflows domain, because it offers each
 * workflow with a signal input as Hand to an agent. So the workflows domain
 * cannot import it back, and declares what it needs as this port instead,
 * like `WorkflowRuns`. The controller daemon provides it from the signals
 * domain (`WorkflowSignalsLayer`).
 */
export class WorkflowSignals extends Context.Service<
  WorkflowSignals,
  {
    /** Returns the kind of the Signal with this id, or none when no Signal has it. */
    readonly readKind: (signalId: string) => Effect.Effect<Option.Option<string>, SqlError>;
  }
>()("hercule/controller/workflows/WorkflowSignals") {}
