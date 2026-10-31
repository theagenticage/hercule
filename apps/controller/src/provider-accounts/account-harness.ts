/**
 * Resolves a Provider Account and a harness to the account's row and the
 * harness definition behind it, and checks from a runner's stored snapshot
 * whether the runner can run the pair.
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
import { checkHarnessSupport, PluginHost, type RegisteredHarness } from "../plugins";
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
export interface ResolvedAccountHarness {
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
export const isLoggedIn = (snapshot: StoredSnapshot): boolean => snapshot.auth.status === "ok";

/**
 * Resolves an account id, and a harness id (left out or `null`: the account's
 * default harness), to the account, the harness definition and the stored
 * snapshots of the account in that harness.
 *
 * Fails with a `Validation` error when:
 *
 * - there is no such account (path `providerAccountId`);
 * - this build carries no such harness (path `harnessId` when the caller named
 *   it, else `providerAccountId`, since the account's own default is the
 *   problem);
 * - the account cannot run in the harness (path `harnessId`), because its
 *   provider does not allow it or the harness does not support it. The
 *   message says which.
 */
export const resolveAccountHarness = (
  providerAccountId: string,
  harnessId?: string | null,
): Effect.Effect<
  ResolvedAccountHarness,
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
    const resolvedHarnessId = harnessId ?? account.defaultHarnessId;
    const definition = (yield* host.harnesses()).find(
      (candidate) => candidate.id === resolvedHarnessId,
    );
    if (definition === undefined) {
      return yield* Effect.fail(
        createValidationError([
          {
            path: [
              harnessId === undefined || harnessId === null ? "providerAccountId" : "harnessId",
            ],
            message: `this build carries no ${resolvedHarnessId} harness`,
          },
        ]),
      );
    }
    const support = checkHarnessSupport(yield* host.providers(), definition, account);
    if (support._tag === "refused") {
      return yield* Effect.fail(
        createValidationError([{ path: ["harnessId"], message: support.reason }]),
      );
    }
    const snapshots = yield* accounts.listSnapshots(providerAccountId);
    return {
      account,
      harnessId: resolvedHarnessId,
      definition,
      snapshots: snapshots.filter((snapshot) => snapshot.harnessId === resolvedHarnessId),
    };
  });
