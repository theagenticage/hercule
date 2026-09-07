/**
 * Whether a machine can be asked to do something for a provider at all.
 *
 * Two operations ask it - installing a harness and logging one in - and both
 * refuse before a frame goes out, because the runner already said in its hello
 * which providers its build carries an adapter for. Being told is better than
 * finding out by asking and failing.
 */
import * as Effect from "effect/Effect";
import { invalidState, validation, type InvalidState, type Validation } from "@hydra/contract";
import type { RunnerDetail } from "@hydra/contract";

export const NOT_ONLINE = "that runner is not connected, so it cannot be asked anything";

export const noAdapterFor = (providerId: string): string =>
  `no adapter for ${providerId} in this runner build`;

export const requireAdapter = (
  runner: RunnerDetail,
  providerId: string,
  /** Which field of the caller's input is the one at fault. */
  field: string,
): Effect.Effect<void, InvalidState | Validation> => {
  if (runner.connectivity !== "online") return Effect.fail(invalidState(NOT_ONLINE));
  if ((runner.facts?.adapters ?? []).includes(providerId)) return Effect.void;
  return Effect.fail(validation([{ path: [field], message: noAdapterFor(providerId) }]));
};
