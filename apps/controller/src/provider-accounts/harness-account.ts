/**
 * Builds the `HarnessAccount` every frame that runs a harness carries: a
 * probe, a sign-in, a session's start, resume or fork, and a text generation
 * call. There is one builder so no frame can disagree with another about an
 * account's home, model argument or credential.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createInvalidStateError,
  createNotFoundError,
  type InvalidState,
  type NotFound,
} from "@hercule/contract";
import type { HarnessAccount } from "@hercule/protocol";
import { checkHarnessSupport, PluginHost } from "../plugins";
import { readProviderAccountCredential, Secrets } from "../secrets";
import { resolveHarnessHome } from "./harness-home";
import { providerAccountRepository } from "./repository";

/**
 * Returns what the runner needs to run one harness for one account. It
 * fails, and sends nothing, when the pair cannot run:
 *
 * - `NotFound` when there is no such account;
 * - `InvalidState` when this build carries no such harness, when the account's
 *   provider does not allow the harness for the account's kind, or when the
 *   harness does not list the provider and kind in its `runs`. The message
 *   says which and why;
 * - `InvalidState` when the stored key does not decrypt. The user fixes it by
 *   entering the key again, so it is reported as a state and not as a fault.
 *
 * The folder comes from `resolveHarnessHome`. The model argument comes from
 * the harness's `runs` entry for the account's provider. When that entry
 * names a credential variable for the account's kind, the frame carries it,
 * with the decrypted key if one is stored. Without a key it carries the
 * variable alone, so the runner removes it from the harness's environment
 * instead of letting a key of the runner's own stand in. The plaintext lives
 * only while the frame is built and then on the wire.
 */
export const prepareHarnessAccount = (
  providerAccountId: string,
  harnessId: string,
): Effect.Effect<
  HarnessAccount,
  NotFound | InvalidState | SqlError,
  SqlClient.SqlClient | PluginHost | Secrets
> =>
  Effect.gen(function* () {
    const accounts = yield* providerAccountRepository;
    const host = yield* PluginHost;
    const secrets = yield* Secrets;
    const found = yield* accounts.one(providerAccountId);
    if (Option.isNone(found)) {
      return yield* Effect.fail(createNotFoundError("no such provider account"));
    }
    const account = found.value;
    const definition = (yield* host.harnesses()).find((candidate) => candidate.id === harnessId);
    if (definition === undefined) {
      return yield* Effect.fail(
        createInvalidStateError(`this build carries no ${harnessId} harness`),
      );
    }
    const support = checkHarnessSupport(yield* host.providers(), definition, account);
    if (support._tag === "refused") {
      return yield* Effect.fail(createInvalidStateError(support.reason));
    }
    const harnessHome = resolveHarnessHome(account, harnessId);
    if (support.credentialVariable === undefined) {
      return { providerAccountId, harnessHome, modelArgument: support.modelArgument };
    }
    const key = yield* readProviderAccountCredential(secrets, providerAccountId).pipe(
      Effect.catchTag("SecretDecryptError", () =>
        Effect.fail(
          createInvalidStateError(
            "the key stored for that provider account could not be decrypted; enter it again " +
              `with \`hercule provider-account update ${providerAccountId} --credentials-stdin\``,
          ),
        ),
      ),
    );
    return {
      providerAccountId,
      harnessHome,
      modelArgument: support.modelArgument,
      credential: {
        variable: support.credentialVariable,
        ...(Option.isSome(key) ? { value: key.value } : {}),
      },
    };
  });
