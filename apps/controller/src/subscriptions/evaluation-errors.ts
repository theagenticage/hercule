/**
 * Notifies someone that a subscription's condition could not be evaluated.
 *
 * The event router records the failure on the subscription row and calls this
 * service once per error. Who is notified, and how, is not decided yet. When
 * notifications exist, only the body of the Layer below changes, and no call
 * site does.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class EvaluationErrorNotifier extends Context.Service<
  EvaluationErrorNotifier,
  {
    /**
     * Reports that this subscription's condition failed to evaluate, with the
     * evaluator's message.
     */
    readonly notifyEvaluationError: (
      subscriptionId: string,
      message: string,
    ) => Effect.Effect<void>;
  }
>()("hercule/controller/subscriptions/EvaluationErrorNotifier") {}

/**
 * Does nothing with the report until notifications exist. The subscription's
 * health already holds the message, and `subscription.query` returns it, so
 * nothing is lost while this body is empty.
 */
export const EvaluationErrorNotifierLayer: Layer.Layer<EvaluationErrorNotifier> = Layer.succeed(
  EvaluationErrorNotifier,
  { notifyEvaluationError: () => Effect.void },
);
