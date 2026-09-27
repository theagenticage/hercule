/**
 * The checks an agent's fields pass before they are written, and the record a
 * stored agent is returned as.
 *
 * The agent operations use them, and so does the assistants domain, because
 * an assistant is an agent with more fields. Keeping them in one place means
 * an agent and an assistant cannot disagree about which instance, profile or
 * model selection is acceptable.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ModelSelection } from "@hercule/protocol";
import { createValidationError, type Agent, type Validation } from "@hercule/contract";
import { PermissionProfiles, type GrantsError } from "../permissions";
import { PluginHost } from "../plugins";
import { providerRepository, listUnenforcedFields } from "../providers";
import type { StoredAgent } from "./repository";

const NO_SUCH_PROFILE = "no such permission profile";

const NO_SUCH_INSTANCE = "no such provider instance";

/** The message for options sent without a model, and what to send instead. */
const NO_MODEL_FOR_OPTIONS =
  "options belong to one model, so send model too: " +
  "the slug of the agent's current model, or of the model you are switching to";

/**
 * Combines the two API fields, `model` and `options`, into the one selection
 * the record stores. Returns `undefined` when the call sets neither: on an
 * update the stored selection stays as it was, and on a create the agent uses
 * the instance's default model. Returns null when `model` is null.
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
  const instances = yield* providerRepository;
  const host = yield* PluginHost;
  const profiles = yield* PermissionProfiles;

  return {
    /**
     * Returns a function that builds the API record from a stored agent, with
     * `unenforced` computed from the provider's declaration. The provider
     * catalog is read once from memory, so one function serves a whole page
     * as well as a single agent.
     */
    buildAgentRecordComposer: Effect.map(
      host.providers(),
      (definitions) =>
        (stored: StoredAgent): Agent => ({
          ...Struct.omit(stored, ["providerId", "kind"]),
          unenforced: listUnenforcedFields(definitions, stored.providerId, stored.disallowedTools),
        }),
    ),

    /**
     * Returns the provider id of the instance an agent names. Fails with
     * `Validation` if the instance does not exist, or if this build does not
     * include its provider. It does not check what the machines that host the
     * provider can do now: an agent is a stored configuration, not a
     * placement.
     */
    readProviderIdOrFail: (
      instanceId: string,
    ): Effect.Effect<string, Validation | SqlError | Schema.SchemaError> =>
      Effect.gen(function* () {
        const instance = yield* instances.one(instanceId);
        if (Option.isNone(instance)) {
          return yield* Effect.fail(
            createValidationError([{ path: ["instanceId"], message: NO_SUCH_INSTANCE }]),
          );
        }
        const providerId = instance.value.providerId;
        const definitions = yield* host.providers();
        if (!definitions.some((definition) => definition.id === providerId)) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["instanceId"],
                message:
                  `this build carries no ${providerId} provider; ` +
                  "name an instance of a provider this build carries",
              },
            ]),
          );
        }
        return providerId;
      }),

    /**
     * Checks that a `permissionProfileId` matches a profile before it is
     * written. Fails with `Validation` if it does not.
     */
    validateProfileExists: (
      profileId: string,
    ): Effect.Effect<void, Validation | GrantsError | SqlError> =>
      Effect.gen(function* () {
        const profile = yield* profiles.getById(profileId);
        if (Option.isNone(profile)) {
          return yield* Effect.fail(
            createValidationError([{ path: ["permissionProfileId"], message: NO_SUCH_PROFILE }]),
          );
        }
      }),
  };
});
