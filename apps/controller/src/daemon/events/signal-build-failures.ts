/**
 * The controller daemon's implementation of the notifications domain's
 * `SignalBuildFailures` port. The count is read from the signals, which the
 * notifications domain cannot import without making the domain graph a
 * cycle.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { SignalBuildFailures } from "../../notifications";
import { signalRepository } from "../../signals";

export const SignalBuildFailuresLayer: Layer.Layer<
  SignalBuildFailures,
  never,
  SqlClient.SqlClient
> = Layer.effect(SignalBuildFailures)(
  Effect.map(signalRepository, (signals) => ({
    countSince: (kind: string, sinceEventId: number) =>
      signals.countBuildFailuresSince(kind, sinceEventId),
  })),
);
