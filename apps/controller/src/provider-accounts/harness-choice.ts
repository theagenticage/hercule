/**
 * Resolves a Provider Account and a harness to the account's row and the
 * harness definition behind it, and checks from a runner's stored snapshot
 * whether the runner is signed in to the account.
 *
 * Opening, forking and steering a session all need both, so they are defined
 * once here rather than in each caller.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { createValidationError, type Validation } from "@hercule/contract";
import { decideProviderAccountHarness, PluginHost, type RegisteredHarness } from "../plugins";
import {
  providerAccountRepository,
  type StoredProviderAccount,
  type StoredSnapshot,
} from "./repository";

/**
 * The error message when no runner can take a session on this account,
 * because none is signed in to it.
 */
export const NO_PLACEMENT =
  "no connected runner is signed in to that provider account; sign in on a machine first";

/** A Provider Account in one harness: the row, the harness definition, and the snapshots of that pair, one per runner. */
interface ResolvedProviderAccountHarness {
  readonly account: StoredProviderAccount;
  /** The qualified id of the harness: the one asked for, or else the account's default. */
  readonly harnessId: string;
  readonly definition: RegisteredHarness;
  readonly snapshots: ReadonlyArray<StoredSnapshot>;
}

/**
 * Checks whether a runner's stored capability snapshot shows it is signed in
 * to the account, which means it can run the account. Reads the stored
 * snapshot and never probes the runner.
 */
export const isSignedIn = (snapshot: StoredSnapshot): boolean => snapshot.auth.status === "ok";

/**
 * Resolves an account id, and a harness id (left out or `null`: the account's
 * default harness), to the account, the harness definition and the stored
 * snapshots of the account in that harness.
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
  Validation | SqlError | Schema.SchemaError,
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
    const account = found.value;
    const choice = decideProviderAccountHarness(
      yield* host.providers(),
      yield* host.harnesses(),
      account,
      harnessId,
    );
    if (choice._tag === "refused") {
      return yield* Effect.fail(
        createValidationError([{ path: [choice.field], message: choice.reason }]),
      );
    }
    const snapshots = yield* accounts.listSnapshots(providerAccountId);
    return {
      account,
      harnessId: choice.harness.id,
      definition: choice.harness,
      snapshots: snapshots.filter((snapshot) => snapshot.harnessId === choice.harness.id),
    };
  });
