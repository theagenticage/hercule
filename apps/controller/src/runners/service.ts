/**
 * The runner service: runners as the API sees them. A runner describes itself
 * almost entirely: everything except the name, the labels, the session cap,
 * the disk watermark and whether it is reserved arrives over the runner
 * protocol, and the update schema rejects every other field.
 *
 * Input is decoded here rather than trusted, because a built-in workflow
 * action calls these methods directly, and the same limits apply either way.
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract, and a caller inside
 * the controller passes an id it read from a stored row.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createConflictError,
  DEFAULT_PAGE_LIMIT,
  Id,
  createInvalidStateError,
  createNotFoundError,
  RUNNER_RETIRE_FIELDS,
  createValidationError,
  RUNNER_EDIT_FIELDS,
  RUNNER_SORT_FIELDS,
  RunnerFilter,
  createDecodeValidationError,
  type Conflict,
  type Forbidden,
  type InvalidState,
  type JoinTokenRef,
  type MintedJoinToken,
  type NotFound,
  type Runner,
  type RunnerDetail,
  type RunnerLifecycle,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant, SYSTEM_ACTOR } from "../actor";
import { nowIso, buildPageInputFields, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { Settings, type SettingError } from "../settings";
import { requireOnline } from "./adapters";
import { JoinTokens } from "./join-tokens";
import { RunnerFactsDeadline, RunnerConnections } from "./connections";
import { runnerRepository, type RunnerEdit } from "./repository";

const QueryInput = Schema.Struct({
  ...RunnerFilter.fields,
  ...buildPageInputFields(RUNNER_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const UpdateInput = Schema.Struct({ id: Id, ...RUNNER_EDIT_FIELDS });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const RetireInput = Schema.Struct({ id: Id, ...RUNNER_RETIRE_FIELDS });

export type RetireInput = Schema.Schema.Type<typeof RetireInput>;

/**
 * The retired runner, and the timestamp of the retirement. Everything else the
 * same retirement writes uses that timestamp, rather than reading the clock
 * again.
 */
export interface Retired extends RunnerDetail {
  readonly at: string;
}

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeRetire = Schema.decodeUnknownEffect(RetireInput);

export interface RunnerPage {
  readonly items: ReadonlyArray<Runner>;
  readonly nextCursor?: string;
}

interface Change {
  readonly old: unknown;
  readonly new: unknown;
}

/** The error message for a runner id that matches no runner, wherever it is used. */
export const NO_SUCH_RUNNER = "no such runner";

/** The error message for a join token that was never created, revoked, already spent, or expired. */
const NO_SUCH_JOIN_TOKEN = "no such join token";

const NAME_TAKEN = "another runner already has that name";

/**
 * The fleet's default runner gets work that names no runner, and a reserved
 * runner must never get such work, so the default cannot be reserved (spec 03
 * §5.5).
 */
const RESERVED_IS_THE_DEFAULT =
  "this is the fleet's default runner; choose another default before reserving it";

/**
 * The reasons a runner takes no new sessions. They are used wherever a runner
 * is named directly: when a session is placed on it, or when a session on it
 * is resumed.
 */
export const DRAINING = "that runner is draining and takes no new sessions";
export const RETIRED = "that runner is retired";

const NOT_ACTIVE = "only an active runner can be drained";

const NOT_DRAINING = "only a draining runner can be undrained";

const ALREADY_RETIRED = "that runner is already retired";

const STILL_RUNNING =
  "sessions are still running on that runner; wait for them to finish, " +
  "or retire it with `force` set to true";

/** Starts with "unreachable", because that is the status the fleet page shows. */
const UNREACHABLE =
  "that runner is unreachable, so it cannot confirm its sessions have finished; " +
  "retire it with `force` set to true to skip this check";

/** Alphabetical: a fleet is short, and people find a runner by its name. */
const DEFAULT_DIRECTION: SortDirection = "asc";

type Edit = { -readonly [K in keyof RunnerEdit]: RunnerEdit[K] };

/** The errors every lifecycle change can fail with. */
export type MoveError =
  | Unauthenticated
  | Forbidden
  | Validation
  | NotFound
  | InvalidState
  | SettingError
  | SqlError
  | Schema.SchemaError;

/** Checks whether two label lists are equal. Labels are replaced as a whole, so order matters. */
const haveSameLabels = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((label, index) => label === right[index]);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runners = yield* runnerRepository;
  const joinTokens = yield* JoinTokens;
  const settings = yield* Settings;
  const audit = yield* AuditLog;

  const connections = yield* RunnerConnections;

  const readRunnerOrFail = (id: string): Effect.Effect<RunnerDetail, NotFound | SqlError> =>
    Effect.flatMap(
      runners.read(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_RUNNER)),
        onSome: Effect.succeed,
      }),
    );

  /**
   * Changes a runner's lifecycle for `drain` and `undrain`, which differ only
   * in the lifecycle they start from, the one they move to, and the audit
   * entry. Each passes its own operation, so each checks its own grant.
   */
  const moveLifecycle = (
    id: Id,
    move: {
      readonly operation: "runner.drain" | "runner.undrain";
      readonly from: RunnerLifecycle;
      readonly to: RunnerLifecycle;
      readonly refusal: string;
      readonly kind: "runner.drained" | "runner.undrained";
    },
  ): Effect.Effect<RunnerDetail, MoveError> =>
    Effect.gen(function* () {
      yield* requireGrant(move.operation);
      return yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          const before = yield* readRunnerOrFail(id);
          if (before.lifecycle !== move.from) {
            return yield* Effect.fail(createInvalidStateError(move.refusal));
          }
          yield* runners.setLifecycle(id, move.to, at);
          yield* audit.append({
            kind: move.kind,
            actor: yield* currentStamp,
            record: { topic: "runner", id },
            payload: { runnerId: id },
            at,
          });
          return yield* readRunnerOrFail(id);
        }),
      );
    });

  return {
    query: (
      input: QueryInput,
    ): Effect.Effect<RunnerPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("runner.query");
        const { limit, cursor, sort, connectivity, lifecycle, label } = yield* Effect.mapError(
          decodeQuery(input),
          createDecodeValidationError,
        );
        const listing = yield* refuseCursor(
          runners.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? DEFAULT_DIRECTION,
            connectivity,
            lifecycle,
            label,
          }),
        );
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    read: (
      id: Id,
    ): Effect.Effect<RunnerDetail, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("runner.read");
        return yield* readRunnerOrFail(id);
      }),

    /**
     * Updates a runner's editable fields and returns the updated runner. A
     * patch with no fields is rejected, and a patch whose values match the
     * current ones writes nothing, because either would record an audit entry
     * describing no change.
     */
    update: (
      input: UpdateInput,
    ): Effect.Effect<
      RunnerDetail,
      Unauthenticated | Forbidden | Validation | NotFound | Conflict | SettingError | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("runner.update");
        const { id, ...patch } = yield* Effect.mapError(
          decodeUpdate(input),
          createDecodeValidationError,
        );
        if (Object.keys(patch).length === 0) {
          return yield* Effect.fail(
            createValidationError([{ path: [], message: "name a field to change" }]),
          );
        }
        const result = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // One clock read, so the row and the audit entry share one timestamp.
            const at = yield* nowIso;
            const before = yield* readRunnerOrFail(id);

            const changes: Record<string, Change> = {};
            const edit: Edit = {};
            if (patch.name !== undefined && patch.name !== before.name) {
              changes.name = { old: before.name, new: patch.name };
              edit.name = patch.name;
            }
            if (patch.labels !== undefined && !haveSameLabels(patch.labels, before.labels)) {
              changes.labels = { old: before.labels, new: patch.labels };
              edit.labels = patch.labels;
            }
            const cap = patch.maxConcurrentSessions;
            if (cap !== undefined && cap !== before.maxConcurrentSessions) {
              changes.maxConcurrentSessions = { old: before.maxConcurrentSessions, new: cap };
              edit.maxConcurrentSessions = cap;
            }
            const watermark = patch.diskWatermarkBytes;
            if (watermark !== undefined && watermark !== before.diskWatermarkBytes) {
              changes.diskWatermarkBytes = { old: before.diskWatermarkBytes, new: watermark };
              edit.diskWatermarkBytes = watermark;
            }
            if (patch.reserved !== undefined && patch.reserved !== before.reserved) {
              changes.reserved = { old: before.reserved, new: patch.reserved };
              edit.reserved = patch.reserved;
            }

            if (Object.keys(changes).length === 0) return { detail: before, placements: false };

            // Both reads are inside the write's transaction, so no other write
            // can take the name, or change the default, in between.
            if (edit.name !== undefined && (yield* runners.names()).has(edit.name)) {
              return yield* Effect.fail(createConflictError(NAME_TAKEN));
            }
            if (edit.reserved === true && (yield* settings.defaultRunnerId()) === id) {
              return yield* Effect.fail(createConflictError(RESERVED_IS_THE_DEFAULT));
            }

            yield* runners.update(id, edit, at);
            yield* audit.append({
              kind: "runner.updated",
              actor: yield* currentStamp,
              record: { topic: "runner", id },
              payload: { runnerId: id, changes },
              at,
            });
            // The new override may move the watermark past the free disk this
            // runner already reported. That is the same change a
            // `watermarkReport` would detect, and it is recorded the same way.
            if (before.watermark !== null && edit.diskWatermarkBytes !== undefined) {
              const wasAccepting = before.watermark.diskFreeBytes >= before.diskWatermarkBytes;
              const accepting = before.watermark.diskFreeBytes >= edit.diskWatermarkBytes;
              if (wasAccepting !== accepting) {
                yield* audit.append({
                  kind: "runner.placementsChanged",
                  actor: SYSTEM_ACTOR,
                  record: { topic: "runner", id },
                  payload: { runnerId: id, acceptingPlacements: accepting },
                  at,
                });
              }
            }
            return {
              // Read back rather than merged, so the caller gets the written row.
              detail: yield* readRunnerOrFail(id),
              placements: "maxConcurrentSessions" in changes || "diskWatermarkBytes" in changes,
            };
          }),
        );
        // After the commit, so whoever acts on this runner's new room reads
        // the cap and the watermark this patch wrote.
        if (result.placements) yield* connections.placementsChanged(id);
        return result.detail;
      }),

    /**
     * Takes a runner out of service without stopping it: it finishes the
     * sessions it is running and gets no new ones. `undrain` reverses it.
     */
    drain: (id: Id): Effect.Effect<RunnerDetail, MoveError> =>
      moveLifecycle(id, {
        operation: "runner.drain",
        from: "active",
        to: "draining",
        refusal: NOT_ACTIVE,
        kind: "runner.drained",
      }),

    undrain: (id: Id): Effect.Effect<RunnerDetail, MoveError> =>
      Effect.gen(function* () {
        const detail = yield* moveLifecycle(id, {
          operation: "runner.undrain",
          from: "draining",
          to: "active",
          refusal: NOT_DRAINING,
          kind: "runner.undrained",
        });
        // An undrained runner can take work again. This domain does not act on
        // that itself, so it publishes the change.
        yield* connections.placementsChanged(detail.id);
        return detail;
      }),

    /**
     * Does the runner row's part of retiring a runner: the checks, the
     * lifecycle change, the fleet default and the audit entry. Fails with
     * `InvalidState` when the runner is already retired, or, without `force`,
     * when it still runs sessions or is unreachable.
     *
     * Clients reach the controller daemon's `retireRunner`, which runs this in
     * the same transaction that ends the runner's sessions and marks its
     * workspaces lost, and closes the connection after the commit.
     *
     * The credential stops working as soon as the lifecycle changes. Nothing
     * is deleted: the row and everything linked to it stay, and joining again
     * creates a new runner next to this one.
     */
    retire: (input: RetireInput): Effect.Effect<Retired, MoveError | SettingError> =>
      Effect.gen(function* () {
        yield* requireGrant("runner.retire");
        const { id, force } = yield* Effect.mapError(
          decodeRetire(input),
          createDecodeValidationError,
        );
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const before = yield* readRunnerOrFail(id);
            if (before.lifecycle === "retired") {
              return yield* Effect.fail(createInvalidStateError(ALREADY_RETIRED));
            }
            if (force !== true) {
              if ((yield* runners.runningSessions(id)) > 0) {
                return yield* Effect.fail(createInvalidStateError(STILL_RUNNING));
              }
              if (before.connectivity === "unreachable") {
                return yield* Effect.fail(createInvalidStateError(UNREACHABLE));
              }
            }
            yield* runners.setLifecycle(id, "retired", at);
            // A default that cannot take work is worse than no default. The
            // default is cleared, and the audit entry records that, rather
            // than promoting a runner nobody chose.
            const wasDefault = (yield* settings.defaultRunnerId()) === id;
            if (wasDefault) yield* settings.setDefaultRunnerId(null, at);
            yield* audit.append({
              kind: "runner.retired",
              actor: yield* currentStamp,
              record: { topic: "runner", id },
              payload: { runnerId: id, forced: force === true, lostDefaultRunner: wasDefault },
              at,
            });
            return { ...(yield* readRunnerOrFail(id)), at };
          }),
        );
      }),

    /**
     * Asks the runner to report its facts now, and returns the updated runner.
     * Fails with `InvalidState` when the runner is not connected or does not
     * report in time. The runner reports by itself only hourly, and only when
     * something changed, so this is the only way to see a newly installed
     * provider CLI without waiting up to an hour.
     */
    refreshFacts: (id: Id): Effect.Effect<RunnerDetail, MoveError> =>
      Effect.gen(function* () {
        yield* requireGrant("runner.refreshFacts");
        const before = yield* readRunnerOrFail(id);
        yield* requireOnline(before);
        if (!(yield* connections.refreshedFacts(id))) {
          const waited = Duration.format(yield* RunnerFactsDeadline);
          return yield* Effect.fail(
            createInvalidStateError(`that runner did not report its facts within ${waited}`),
          );
        }
        return yield* readRunnerOrFail(id);
      }),

    /**
     * Creates a join token and returns it. The token appears only in this
     * response. The fleet page's "Add machine" dialog creates a new one each
     * time it opens, so an expired token only costs a refresh.
     */
    createJoinToken: (): Effect.Effect<MintedJoinToken, Unauthenticated | Forbidden | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("runner.createJoinToken");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const minted = yield* joinTokens.create(at);
            yield* audit.append({
              kind: "runner.joinToken.minted",
              actor: yield* currentStamp,
              // The token is a bearer secret, so only its id is recorded. The id
              // links this entry to the runner that later spends the token.
              payload: { joinTokenId: minted.id, expiresAt: minted.expiresAt },
              at,
            });
            return minted;
          }),
        );
      }),

    /**
     * Returns the join tokens that can still be spent. It never returns the
     * token or its hash: the list shows which tokens are open, and must not be
     * a second copy of them.
     */
    queryJoinTokens: (): Effect.Effect<
      ReadonlyArray<JoinTokenRef>,
      Unauthenticated | Forbidden | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("runner.queryJoinTokens");
        return yield* joinTokens.outstanding(yield* nowIso);
      }),

    /** Revokes a join token that has not been spent. Fails with `NotFound` when there is no such open token. */
    revokeJoinToken: (
      id: Id,
    ): Effect.Effect<Record<string, never>, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("runner.revokeJoinToken");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            if (!(yield* joinTokens.revoke(id, at))) {
              return yield* Effect.fail(createNotFoundError(NO_SUCH_JOIN_TOKEN));
            }
            yield* audit.append({
              kind: "runner.joinToken.revoked",
              actor: yield* currentStamp,
              payload: { joinTokenId: id },
              at,
            });
            return {};
          }),
        );
      }),
  };
});

export class RunnerService extends Context.Service<RunnerService, Effect.Success<typeof make>>()(
  "hercule/controller/runners/RunnerService",
) {}

export const RunnerServiceLayer: Layer.Layer<
  RunnerService,
  never,
  SqlClient.SqlClient | JoinTokens | Settings | RunnerConnections | AuditLog
> = Layer.effect(RunnerService)(make);
