/**
 * Whether a machine can be asked to do something for a provider at all. Install
 * and login both refuse before a frame goes out: the runner's hello already
 * said which providers its build carries an adapter for.
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

export const requireOnline = (runner: RunnerDetail): Effect.Effect<void, InvalidState> =>
  runner.connectivity === "online" ? Effect.void : Effect.fail(createInvalidStateError(NOT_ONLINE));

export const noAdapterFor = (providerId: string): string =>
  `no adapter for ${providerId} in this runner build`;

/** Online, and carrying an adapter for this provider. */
export const requireAdapter = (
  runner: RunnerDetail,
  providerId: string,
  /** Which field of the caller's input is the one at fault. */
  field: string,
): Effect.Effect<void, InvalidState | Validation> =>
  Effect.flatMap(requireOnline(runner), () =>
    (runner.facts?.adapters ?? []).includes(providerId)
      ? Effect.void
      : Effect.fail(createValidationError([{ path: [field], message: noAdapterFor(providerId) }])),
  );
