/**
 * Checks that a Provider Account can run in a harness and returns the harness
 * definition, and checks from a runner's stored snapshot whether the runner is
 * signed in to the account.
 *
 * Opening and forking a session and saving an Agent all need the first, so it
 * is defined once here rather than in each caller.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { createValidationError, type Validation } from "@hercule/contract";
import { decideProviderAccountHarness, PluginHost, type RegisteredHarness } from "../plugins";
import { providerAccountRepository, type StoredSnapshot } from "./repository";

/**
 * The error message when no runner can take a session on this account,
 * because none is signed in to it.
 */
export const NO_PLACEMENT =
  "no connected runner is signed in to that provider account; sign in on a machine first";

/** The harness a Provider Account runs in. */
interface ResolvedProviderAccountHarness {
  /** The qualified id of the harness: the one asked for, or else the account's default. */
  readonly harnessId: string;
  readonly definition: RegisteredHarness;
}

/**
 * Checks whether a runner's stored capability snapshot shows it is signed in
 * to the account, which means it can run the account. Reads the stored
 * snapshot and never probes the runner.
 */
export const isSignedIn = (snapshot: StoredSnapshot): boolean => snapshot.auth.status === "ok";

/**
 * Resolves an account id, and a harness id (left out or `null`: the account's
 * default harness), to the harness's id and definition. It reads no
 * snapshots: a caller that places a session lists them with
 * `providerAccountRepository.listHarnessSnapshots`.
 *
 * Fails with a `Validation` error when:
 *
 * - there is no such account (path `providerAccountId`);
 * - the account cannot run in the harness, because this build carries no such
 *   harness, the account's provider does not allow it, or the harness does
 *   not support it. `decideProviderAccountHarness` gives the message and the path:
 *   `harnessId` when the caller named the harness, else `providerAccountId`,
 *   since the account's own default is then the problem.
 */
export const resolveProviderAccountHarness = (
  providerAccountId: string,
  harnessId?: string | null,
): Effect.Effect<
  ResolvedProviderAccountHarness,
  Validation | SqlError,
  SqlClient.SqlClient | PluginHost
> =>
  Effect.gen(function* () {
    const accounts = yield* providerAccountRepository;
    const host = yield* PluginHost;
    const found = yield* accounts.one(providerAccountId);
    if (Option.isNone(found)) {
      return yield* Effect.fail(
        createValidationError([
          { path: ["providerAccountId"], message: "no such provider account" },
        ]),
      );
    }
    const choice = decideProviderAccountHarness(
      yield* host.providers(),
      yield* host.harnesses(),
      found.value,
      harnessId,
    );
    if (choice._tag === "refused") {
      return yield* Effect.fail(
        createValidationError([{ path: [choice.field], message: choice.reason }]),
      );
    }
    return { harnessId: choice.harness.id, definition: choice.harness };
  });
