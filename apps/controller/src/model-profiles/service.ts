/**
 * The Model Profile operations: reading the profiles with every entry
 * resolved, replacing a whole profile, creating a profile and deleting one.
 *
 * A stored entry names only an account, a model and maybe a harness. What a
 * menu needs to draw it (the model's name, its options, whether it can run now)
 * is worked out here on every read, from data read once for all profiles
 * (`resolve-profile.ts`). So no client repeats that logic and none reads per
 * entry.
 *
 * Accounts being deleted and first catalog reads change profiles too. Those
 * changes go through `ModelProfileMembership` (`membership.ts`), not through
 * this service.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createConflictError,
  createDecodeValidationError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  Id,
  MAX_MODEL_PROFILES,
  ModelProfileCreateInput,
  ModelProfileUpdateInput,
  type Conflict,
  type Forbidden,
  type InvalidState,
  type ModelProfile,
  type NotFound,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PluginHost } from "../plugins";
import { ProjectService } from "../projects";
import { ModelCatalogs, ProviderAccountService } from "../provider-accounts";
import { runnerRepository } from "../runners";
import { buildProfileBody } from "./build-profile-body";
import { resolveProfile, type ResolutionWorld } from "./resolve-profile";
import type { StoredProfileBody } from "./profile-body";
import { modelProfileRepository, type StoredModelProfile } from "./repository";

const UpdateInput = Schema.Struct({ id: Id, ...ModelProfileUpdateInput.fields });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeCreate = Schema.decodeUnknownEffect(ModelProfileCreateInput);

/** The body of a profile that holds no account, no entry and no dismissed model. */
const EMPTY_BODY: StoredProfileBody = { accounts: [], defaultEntry: null, dismissedNewModels: [] };

const LAST_PROFILE_REFUSAL =
  "This is your only Model Profile. Create another before you delete this one.";

const TOO_MANY_PROFILES = `There are already ${String(MAX_MODEL_PROFILES)} Model Profiles, the most there can be. Delete one before you create another.`;

const NO_SUCH_PROFILE = "no such model profile";

type ReadError = Unauthenticated | Forbidden | SqlError | Schema.SchemaError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const profiles = yield* modelProfileRepository;
  const catalogs = yield* ModelCatalogs;
  const providerAccounts = yield* ProviderAccountService;
  const runners = yield* runnerRepository;
  const host = yield* PluginHost;
  const audit = yield* AuditLog;
  const projects = yield* ProjectService;

  /** Fails with `Validation` on `name` when another profile has the name. */
  const requireFreeName = (
    name: string,
    exceptId: string | undefined,
  ): Effect.Effect<void, Validation | SqlError> =>
    Effect.flatMap(profiles.isNameTaken(name, exceptId), (taken) =>
      taken
        ? Effect.fail(
            createValidationError([
              {
                path: ["name"],
                message: `another Model Profile is already named "${name}"; choose another name`,
              },
            ]),
          )
        : Effect.void,
    );

  /**
   * Reads everything resolving needs, once: the accounts with their readiness
   * and snapshots, the catalogs with the models that arrived in them, the
   * runners that can run work now, and the plugins' providers and harnesses.
   * It checks no grant: the caller has checked the grant of its own
   * operation, which need not include reading accounts. Callers read it
   * inside the transaction that reads the profiles, so an account deleted
   * meanwhile cannot leave an entry without its account.
   */
  const readResolutionWorld = (): Effect.Effect<ResolutionWorld, ReadError> =>
    Effect.gen(function* () {
      const { catalogs: stored, arrivedModels } = yield* catalogs.listCatalogsWithArrivedModels();
      return {
        accounts: yield* providerAccounts.readProviderAccounts(),
        catalogs: stored,
        arrivedModels,
        connectedRunners: yield* runners.listOnline(),
        providers: yield* host.providers(),
        harnesses: yield* host.harnesses(),
      };
    });

  const readStoredOrFail = (
    id: string,
  ): Effect.Effect<StoredModelProfile, NotFound | SqlError | Schema.SchemaError> =>
    Effect.flatMap(profiles.one(id), (found) =>
      Option.match(found, {
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_PROFILE)),
        onSome: Effect.succeed,
      }),
    );

  return {
    /**
     * Returns every profile, in the order they were created, with every entry
     * resolved. The profiles and what resolves them are read in one
     * transaction, so they agree with each other.
     */
    query: (): Effect.Effect<ReadonlyArray<ModelProfile>, ReadError> =>
      Effect.gen(function* () {
        yield* requireGrant("modelProfile.query");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const stored = yield* profiles.list();
            const world = yield* readResolutionWorld();
            return stored.map((profile) => resolveProfile(profile, world));
          }),
        );
      }),

    /**
     * Returns one profile with every entry resolved, or fails with `NotFound`.
     * Read in one transaction, as `query` does.
     */
    read: (id: Id): Effect.Effect<ModelProfile, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("modelProfile.read");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const stored = yield* readStoredOrFail(id);
            return resolveProfile(stored, yield* readResolutionWorld());
          }),
        );
      }),

    /**
     * Creates a profile and returns it resolved, at revision 1. It starts
     * empty, or as a copy of the profile `copyFromId` names. A copy takes the
     * source's stored body as it is: its sections (including any still waiting
     * for a first catalog read), entries, harness choices, default entry and
     * dismissed models. The copy shares nothing with the source afterwards.
     *
     * - `Validation` when another profile has the name.
     * - `NotFound` when `copyFromId` names no profile.
     * - `InvalidState` when there are already `MAX_MODEL_PROFILES` profiles.
     */
    create: (
      input: ModelProfileCreateInput,
    ): Effect.Effect<ModelProfile, ReadError | Validation | NotFound | InvalidState> =>
      Effect.gen(function* () {
        yield* requireGrant("modelProfile.create");
        const request = yield* Effect.mapError(decodeCreate(input), createDecodeValidationError);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            if ((yield* profiles.count()) >= MAX_MODEL_PROFILES) {
              return yield* Effect.fail(createInvalidStateError(TOO_MANY_PROFILES));
            }
            yield* requireFreeName(request.name, undefined);
            const body =
              request.copyFromId === undefined
                ? EMPTY_BODY
                : (yield* readStoredOrFail(request.copyFromId)).body;
            const id = yield* profiles.insert({ name: request.name, body, at });
            yield* audit.append({
              kind: "modelProfile.created",
              actor: yield* currentStamp,
              payload: {
                modelProfileId: id,
                name: request.name,
                ...(request.copyFromId === undefined ? {} : { copyFromId: request.copyFromId }),
              },
              record: { topic: "provider", id },
              at,
            });
            return resolveProfile(yield* readStoredOrFail(id), yield* readResolutionWorld());
          }),
        );
      }),

    /**
     * Deletes a profile and returns an empty object. Every project that names
     * it is left with no profile, and each of those changes is recorded as a
     * `project.updated` event, in the same transaction.
     *
     * - `NotFound` when there is no such profile.
     * - `InvalidState` for the last profile, because the composer needs one.
     */
    delete: (id: Id): Effect.Effect<Record<string, never>, ReadError | NotFound | InvalidState> =>
      Effect.gen(function* () {
        yield* requireGrant("modelProfile.delete");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const doomed = yield* readStoredOrFail(id);
            if ((yield* profiles.count()) <= 1) {
              return yield* Effect.fail(createInvalidStateError(LAST_PROFILE_REFUSAL));
            }
            yield* projects.clearModelProfile(id, at);
            yield* profiles.delete(id);
            yield* audit.append({
              kind: "modelProfile.deleted",
              actor: yield* currentStamp,
              payload: { modelProfileId: id, name: doomed.name },
              record: { topic: "provider", id },
              at,
            });
            return {};
          }),
        );
      }),

    /**
     * Replaces the whole profile and returns it resolved. The stored profile
     * becomes exactly what is sent, and its revision goes up by one. Needs
     * `infra.write` only: the accounts it reads are read without the
     * `providerAccount.query` grant.
     *
     * - `Conflict` when the profile's revision is not `expectedRevision`.
     *   Only a stale revision is a conflict. Nothing is merged: the caller
     *   reads the profile again and makes its one change on that.
     * - `Validation` when the payload breaks a rule of `buildProfileBody`:
     *   a name another profile has, an unknown account, an account twice, a
     *   duplicate entry, a harness the account cannot run in, a model that
     *   the harness is known not to list, or a default entry that is not an
     *   entry.
     * - A section sent without `entries` gets its Default Selection, now or
     *   when its account's first catalog read lands (`buildProfileBody`).
     *
     * The revision check, the validation, the write and the read of the result
     * share one transaction, so a catalog read or an account deleted meanwhile
     * cannot slip between them.
     */
    update: (
      input: UpdateInput,
    ): Effect.Effect<ModelProfile, ReadError | Validation | NotFound | Conflict> =>
      Effect.gen(function* () {
        yield* requireGrant("modelProfile.update");
        const { id, ...request } = yield* Effect.mapError(
          decodeUpdate(input),
          createDecodeValidationError,
        );
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const current = yield* readStoredOrFail(id);
            if (current.revision !== request.expectedRevision) {
              return yield* Effect.fail(
                createConflictError(
                  `The profile changed since you read it (now revision ${String(current.revision)}). Read it again and make your change on that.`,
                ),
              );
            }
            yield* requireFreeName(request.name, id);
            const world = yield* readResolutionWorld();
            const built = buildProfileBody(request, current.body, world);
            if (built._tag === "refused") {
              return yield* Effect.fail(createValidationError(built.issues));
            }
            yield* profiles.save(id, { name: request.name, body: built.body, at });
            yield* audit.append({
              kind: "modelProfile.updated",
              actor: yield* currentStamp,
              payload: { modelProfileId: id, revision: current.revision + 1, name: request.name },
              record: { topic: "provider", id },
              at,
            });
            // The write changes no account, catalog or runner, so `world` is
            // still what the stored profile resolves against.
            return resolveProfile(yield* readStoredOrFail(id), world);
          }),
        );
      }),
  };
});

export class ModelProfileService extends Context.Service<
  ModelProfileService,
  Effect.Success<typeof make>
>()("hercule/controller/model-profiles/ModelProfileService") {}

export const ModelProfileServiceLayer: Layer.Layer<
  ModelProfileService,
  never,
  | SqlClient.SqlClient
  | ProviderAccountService
  | ModelCatalogs
  | PluginHost
  | AuditLog
  | ProjectService
> = Layer.effect(ModelProfileService)(make);
