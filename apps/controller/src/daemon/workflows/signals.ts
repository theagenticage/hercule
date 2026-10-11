import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { signalRepository } from "../../signals";
import { WorkflowSignals } from "../../workflows";

/**
 * Provides the workflows domain's `WorkflowSignals` from the signals
 * domain's rows. It lives in the controller daemon because the signals domain
 * depends on the workflows domain, so neither domain can connect the two
 * without a cycle.
 */
export const WorkflowSignalsLayer: Layer.Layer<WorkflowSignals, never, SqlClient.SqlClient> =
  Layer.effect(WorkflowSignals)(
    Effect.map(signalRepository, (signals) => ({
      readKind: (signalId: string) =>
        Effect.map(
          signals.readKindAndTitle(signalId),
          Option.map((signal) => signal.kind),
        ),
    })),
  );
