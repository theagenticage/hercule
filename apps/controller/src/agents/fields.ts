/**
 * The checks an agent's fields pass before they are written, and the record a
 * stored agent is returned as.
 *
 * The agent operations use them, and so does the assistants domain, because
 * an assistant is an agent with more fields. Keeping them in one place means
 * an agent and an assistant cannot disagree about which account, harness, profile or
 * model selection is acceptable, or about who may choose the profile.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { ModelSelection } from "@hercule/protocol";
import {
  createValidationError,
  type Agent,
  type Forbidden,
  type Validation,
} from "@hercule/contract";
import type { Actor } from "../actor";
import { PermissionProfiles, requireMayAssignAgentProfile, type GrantsError } from "../permissions";
import { PluginHost } from "../plugins";
import { listUnenforcedFields } from "../harnesses";
import { resolveAccountHarness } from "../provider-accounts";
import type { StoredAgent } from "./repository";

const NO_SUCH_PROFILE = "no such permission profile";

/** The message for options sent without a model, and what to send instead. */
const NO_MODEL_FOR_OPTIONS =
  "options belong to one model, so send model too: " +
  "the slug of the agent's current model, or of the model you are switching to";

/**
 * Combines the two API fields, `model` and `options`, into the one selection
 * the record stores. Returns `undefined` when the call sets neither: on an
 * update the stored selection stays as it was, and on a create the agent uses
 * the account's default model. Returns null when `model` is null.
 *
 * Fails with `Validation` if options are sent without a model. A choice
 * belongs to the model that offers it. If the choice were kept and moved to
 * another model, the agent would run with a value that model never declared.
 */
export const buildModelSelection = (
  model: string | null | undefined,
  options: ModelSelection["options"] | undefined,
): Effect.Effect<ModelSelection | null | undefined, Validation> => {
  if (typeof model !== "string" && options !== undefined) {
    return Effect.fail(
      createValidationError([{ path: ["options"], message: NO_MODEL_FOR_OPTIONS }]),
    );
  }
  if (model === undefined) return Effect.succeed(undefined);
  return Effect.succeed(model === null ? null : { model, options: options ?? {} });
};

/**
 * Builds the field checks and the record composer. Each is a function that
 * reads what it needs when it is called, so one build serves every request.
 */
export const buildAgentFieldChecks = Effect.gen(function* () {
  const host = yield* PluginHost;
  const profiles = yield* PermissionProfiles;
  // What `resolveAccountHarness` reads, captured here so the checks below
  // need nothing from their caller.
  const accountServices = yield* Effect.context<SqlClient.SqlClient | PluginHost>();

  return {
    /**
     * Returns a function that builds the API record from a stored agent, with
     * `unenforced` computed from the harness's declaration. The harness
     * catalog is read once from memory, so one function serves a whole page
     * as well as a single agent.
     */
    buildAgentRecordComposer: Effect.map(
      host.harnesses(),
      (definitions) =>
        (stored: StoredAgent): Agent => ({
          ...Struct.omit(stored, ["effectiveHarnessId", "kind"]),
          unenforced: listUnenforcedFields(
            definitions,
            stored.effectiveHarnessId,
            stored.disallowedTools,
          ),
        }),
    ),

    /**
     * Checks that an agent may run in this account and harness before the
     * pair is written. `harnessId` left out or `null` means the account's
     * default harness. Fails with `Validation` if there is no such account,
     * if this build carries no such harness, or if the account cannot run in
     * it. It does not check what the machines that host the harness can do
     * now: an agent is a stored configuration, not a placement.
     */
    validateAgentAccountHarness: (
      providerAccountId: string,
      harnessId: string | null | undefined,
    ): Effect.Effect<void, Validation | SqlError | Schema.SchemaError> =>
      Effect.asVoid(
        Effect.provideContext(resolveAccountHarness(providerAccountId, harnessId), accountServices),
      ),

    /**
     * Checks that an agent may be put on the permission profile with this id,
     * before the id is written. Fails with `Validation` if there is no such
     * profile, and with `Forbidden` when `actor` is a session and the profile
     * holds a grant only the user gives.
     */
    validateAgentProfile: (
      actor: Actor,
      profileId: string,
    ): Effect.Effect<void, Validation | Forbidden | GrantsError | SqlError> =>
      Effect.gen(function* () {
        const profile = yield* profiles.getById(profileId);
        if (Option.isNone(profile)) {
          return yield* Effect.fail(
            createValidationError([{ path: ["permissionProfileId"], message: NO_SUCH_PROFILE }]),
          );
        }
        yield* requireMayAssignAgentProfile(actor, profile.value.grants);
      }),
  };
});
