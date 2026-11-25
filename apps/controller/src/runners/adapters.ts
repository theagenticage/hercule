/**
 * Checks whether a runner can be asked to do anything for a harness. Install
 * and login both fail here, before a frame is sent, because the runner's hello
 * already listed the harnesses its build has an adapter for.
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

/**
 * Returns the sentence that says the runner's build has no adapter for the
 * harness and what to do about it. Installing the harness does not help, so
 * the sentence tells the user to update Hercule on that machine.
 */
export const describeNoAdapter = (runnerName: string, harnessName: string): string =>
  `Hercule on ${runnerName} cannot run ${harnessName}; update Hercule on that machine`;

/**
 * Checks that the runner is connected and its build has an adapter for this
 * harness. Fails with `InvalidState` when the runner is not connected, and
 * with a `Validation` error on `field`, worded by `describeNoAdapter`, when
 * it has no adapter.
 */
export const requireAdapter = (
  runner: RunnerDetail,
  harness: { readonly id: string; readonly displayName: string },
  /** The field of the caller's input that the validation error points at. */
  field: string,
): Effect.Effect<void, InvalidState | Validation> =>
  Effect.flatMap(requireOnline(runner), () =>
    (runner.facts?.adapters ?? []).includes(harness.id)
      ? Effect.void
      : Effect.fail(
          createValidationError([
            { path: [field], message: describeNoAdapter(runner.name, harness.displayName) },
          ]),
        ),
  );
