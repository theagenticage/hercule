/**
 * The Model Profile operations: reading the profiles with every entry
 * resolved, and replacing a whole profile.
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
  createNotFoundError,
  createValidationError,
  Id,
  ModelProfileUpdateInput,
  type Conflict,
  type Forbidden,
  type ModelProfile,
  type NotFound,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PluginHost } from "../plugins";
import { ModelCatalogs, ProviderAccountService } from "../provider-accounts";
import { runnerRepository } from "../runners";
import { buildProfileBody } from "./build-profile-body";
import { resolveProfile, type ResolutionWorld } from "./resolve-profile";
import { modelProfileRepository, type StoredModelProfile } from "./repository";

const UpdateInput = Schema.Struct({ id: Id, ...ModelProfileUpdateInput.fields });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);

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

  /**
   * Reads everything resolving needs, once: the accounts with their readiness
   * and snapshots, the catalogs, the runners that can run work now, and the
   * plugins' providers and harnesses. It checks no grant: the caller has
   * checked the grant of its own operation, which need not include reading
   * accounts. Callers read it inside the transaction that reads the profiles,
   * so an account deleted meanwhile cannot leave an entry without its account.
   */
  const readResolutionWorld = (): Effect.Effect<ResolutionWorld, ReadError> =>
    Effect.gen(function* () {
      return {
        accounts: yield* providerAccounts.readProviderAccounts(),
        catalogs: yield* catalogs.listCatalogs(),
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
            if (yield* profiles.isNameTaken(request.name, id)) {
              return yield* Effect.fail(
                createValidationError([
                  {
                    path: ["name"],
                    message: `another Model Profile is already named "${request.name}"; choose another name`,
                  },
                ]),
              );
            }
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
  SqlClient.SqlClient | ProviderAccountService | ModelCatalogs | PluginHost | AuditLog
> = Layer.effect(ModelProfileService)(make);
