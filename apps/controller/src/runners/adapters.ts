/**
 * Checks whether a runner can be asked to do anything for a provider. Install
 * and login both fail here, before a frame is sent, because the runner's hello
 * already listed the providers its build has an adapter for.
 */
import * as Effect from "effect/Effect";
import {
  createInvalidStateError,
  createValidationError,
  type InvalidState,
  type Validation,
} from "@hercule/contract";
import type { RunnerDetail } from "@hercule/contract";

const NOT_ONLINE = "that runner is not connected, so it cannot be asked anything";

/** Checks that the runner is connected. Fails with `InvalidState` when it is not. */
export const requireOnline = (runner: RunnerDetail): Effect.Effect<void, InvalidState> =>
  runner.connectivity === "online" ? Effect.void : Effect.fail(createInvalidStateError(NOT_ONLINE));

export const describeNoAdapter = (providerId: string): string =>
  `no adapter for ${providerId} in this runner build`;

/**
 * Checks that the runner is connected and its build has an adapter for this
 * provider. Fails with `InvalidState` when the runner is not connected, and
 * with a `Validation` error on `field` when it has no adapter.
 */
export const requireAdapter = (
  runner: RunnerDetail,
  providerId: string,
  /** The field of the caller's input that the validation error points at. */
  field: string,
): Effect.Effect<void, InvalidState | Validation> =>
  Effect.flatMap(requireOnline(runner), () =>
    (runner.facts?.adapters ?? []).includes(providerId)
      ? Effect.void
      : Effect.fail(
          createValidationError([{ path: [field], message: describeNoAdapter(providerId) }]),
        ),
  );
