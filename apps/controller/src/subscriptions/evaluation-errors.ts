/**
 * Telling somebody that a subscription's condition could not be evaluated.
 *
 * The event router records the failure on the subscription row and calls this
 * once per error. Who is told, and how, is not decided yet: a later
 * notification ticket replaces the body of the Layer below, and no call site
 * changes.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class EvaluationErrorNotifier extends Context.Service<
  EvaluationErrorNotifier,
  {
    /** Reports that this subscription's condition failed, with what the evaluator said. */
    readonly notifyEvaluationError: (
      subscriptionId: string,
      message: string,
    ) => Effect.Effect<void>;
  }
>()("hercule/controller/subscriptions/EvaluationErrorNotifier") {}

/**
 * What a controller does with the report until notifications exist: nothing.
 * The subscription's health already carries the message, and a listing shows
 * it, so nothing is lost while this body is empty.
 */
export const EvaluationErrorNotifierLayer: Layer.Layer<EvaluationErrorNotifier> = Layer.succeed(
  EvaluationErrorNotifier,
  { notifyEvaluationError: () => Effect.void },
);
