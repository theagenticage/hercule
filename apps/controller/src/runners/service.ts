/**
 * Runners as the API sees them. A runner is almost entirely self-describing:
 * everything but the name, the labels, the session cap and whether the machine
 * is reserved arrives over the runner protocol, and the payload schema refuses
 * the rest.
 *
 * Input is decoded here rather than trusted, because a built-in workflow action
 * calls these methods directly and the bounds are the same rule either way.
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
  conflict,
  DEFAULT_PAGE_LIMIT,
  Id,
  invalidState,
  notFound,
  RUNNER_RETIRE_FIELDS,
  validation,
  RUNNER_EDIT_FIELDS,
  RUNNER_SORT_FIELDS,
  RunnerFilter,
  validationOf,
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
} from "@hydra/contract";
import { currentStamp, requireGrant, SYSTEM_ACTOR } from "../actor";
import { nowIso, pageInput, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { Settings, type SettingError } from "../settings";
import { requireOnline } from "./adapters";
import { JoinTokens } from "./join-tokens";
import { RunnerFactsDeadline, RunnerConnections } from "./connections";
import { runnerRepository, type RunnerEdit } from "./repository";

const QueryInput = Schema.Struct({
  ...RunnerFilter.fields,
  ...pageInput(RUNNER_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const UpdateInput = Schema.Struct({ id: Id, ...RUNNER_EDIT_FIELDS });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const Identified = Schema.Struct({ id: Id });

export type Identified = Schema.Schema.Type<typeof Identified>;

const RetireInput = Schema.Struct({ id: Id, ...RUNNER_RETIRE_FIELDS });

export type RetireInput = Schema.Schema.Type<typeof RetireInput>;

/**
 * The retired row, and the instant it was stamped with: everything else the
 * same retirement writes carries that instant rather than reading the clock
 * again a write later.
 */
export interface Retired extends RunnerDetail {
  readonly at: string;
}

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);
const decodeRetire = Schema.decodeUnknownEffect(RetireInput);

export interface RunnerPage {
  readonly items: ReadonlyArray<Runner>;
  readonly nextCursor?: string;
}

interface Change {
  readonly old: unknown;
  readonly new: unknown;
}

/** What a machine nobody has enlisted is called, wherever one is named. */
export const NO_SUCH_RUNNER = "no such runner";

/** A spent, an expired and an unminted token all read the same: not outstanding. */
const NO_SUCH_JOIN_TOKEN = "no such join token";

const NAME_TAKEN = "another runner already has that name";

/**
 * §5.5: the fleet default is where work with nothing to say about placement
 * lands, which is the one thing a reserved runner never takes.
 */
const RESERVED_IS_THE_DEFAULT =
  "this is the fleet's default runner; choose another default before reserving it";

/**
 * Why a machine takes no session it does not already hold. Read wherever one is
 * named directly - a session being placed, or one being picked up again.
 */
export const DRAINING = "that runner is draining and takes no new sessions";
export const RETIRED = "that runner is retired";

const NOT_ACTIVE = "only an active runner can be drained";

const NOT_DRAINING = "only a draining runner can be taken off the drain";

const ALREADY_RETIRED = "that runner is already retired";

const STILL_RUNNING = "sessions are still running on that runner";

/** Names the reachability first, because that is the word the fleet is showing. */
const UNREACHABLE = "that runner is unreachable, so it cannot confirm its sessions have finished";

/** Alphabetical: a fleet is short, and its name is how a reader picks one out. */
const DEFAULT_DIRECTION: SortDirection = "asc";

type Edit = { -readonly [K in keyof RunnerEdit]: RunnerEdit[K] };

/** What every lifecycle move can answer with. */
export type MoveError =
  | Unauthenticated
  | Forbidden
  | Validation
  | NotFound
  | InvalidState
  | SettingError
  | SqlError
  | Schema.SchemaError;

/** Labels are replaced whole, so their order is part of the value. */
const sameLabels = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((label, index) => label === right[index]);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runners = yield* runnerRepository;
  const joinTokens = yield* JoinTokens;
  const settings = yield* Settings;
  const audit = yield* AuditLog;

  const connections = yield* RunnerConnections;

  const one = (id: string): Effect.Effect<RunnerDetail, NotFound | SqlError> =>
    Effect.flatMap(
      runners.read(id),
      Option.match({
        onNone: () => Effect.fail(notFound(NO_SUCH_RUNNER)),
        onSome: Effect.succeed,
      }),
    );

  /**
   * The two moves that differ only in which lifecycle they come from, go to,
   * and write down. Each enforces its own grant, so changing what one of them
   * requires changes what is checked.
   */
  const moveLifecycle = (
    input: Identified,
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
      const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
      return yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          const before = yield* one(id);
          if (before.lifecycle !== move.from) {
            return yield* Effect.fail(invalidState(move.refusal));
          }
          yield* runners.setLifecycle(id, move.to, at);
          yield* audit.append({
            kind: move.kind,
            actor: yield* currentStamp,
            record: { topic: "runner", id },
            payload: { runnerId: id },
            at,
          });
          return yield* one(id);
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
          validationOf,
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
      input: Identified,
    ): Effect.Effect<
      RunnerDetail,
      Unauthenticated | Forbidden | Validation | NotFound | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("runner.read");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        return yield* one(id);
      }),

    /**
     * A patch naming no field is refused, and one asking for the values already
     * held writes nothing: either would stamp a row describing nothing.
     */
    update: (
      input: UpdateInput,
    ): Effect.Effect<
      RunnerDetail,
      Unauthenticated | Forbidden | Validation | NotFound | Conflict | SettingError | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("runner.update");
        const { id, ...patch } = yield* Effect.mapError(decodeUpdate(input), validationOf);
        if (Object.keys(patch).length === 0) {
          return yield* Effect.fail(validation([{ path: [], message: "name a field to change" }]));
        }
        const result = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // One clock read, so the row and the event carry the same instant.
            const at = yield* nowIso;
            const before = yield* one(id);

            const changes: Record<string, Change> = {};
            const edit: Edit = {};
            if (patch.name !== undefined && patch.name !== before.name) {
              changes.name = { old: before.name, new: patch.name };
              edit.name = patch.name;
            }
            if (patch.labels !== undefined && !sameLabels(patch.labels, before.labels)) {
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

            // Both reads sit inside the transaction the write is in, so the
            // fleet cannot take the name, or the default, in between.
            if (edit.name !== undefined && (yield* runners.names()).has(edit.name)) {
              return yield* Effect.fail(conflict(NAME_TAKEN));
            }
            if (edit.reserved === true && (yield* settings.defaultRunnerId()) === id) {
              return yield* Effect.fail(conflict(RESERVED_IS_THE_DEFAULT));
            }

            yield* runners.update(id, edit, at);
            yield* audit.append({
              kind: "runner.updated",
              actor: yield* currentStamp,
              record: { topic: "runner", id },
              payload: { runnerId: id, changes },
              at,
            });
            // The override moved the line under a disk this runner already
            // reported: the same crossing `watermarkReport` would have found,
            // recorded the same way.
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
              detail: yield* one(id),
              placements: "maxConcurrentSessions" in changes || "diskWatermarkBytes" in changes,
            };
          }),
        );
        // After the commit, so whoever acts on the room this machine now has
        // reads the cap and the watermark this patch wrote.
        if (result.placements) yield* connections.placementsChanged(id);
        return result.detail;
      }),

    /**
     * Takes a runner out of service without ending it: it finishes what it is
     * running and is given nothing new. Cancelled by `undrain`.
     */
    drain: (input: Identified): Effect.Effect<RunnerDetail, MoveError> =>
      moveLifecycle(input, {
        operation: "runner.drain",
        from: "active",
        to: "draining",
        refusal: NOT_ACTIVE,
        kind: "runner.drained",
      }),

    undrain: (input: Identified): Effect.Effect<RunnerDetail, MoveError> =>
      Effect.gen(function* () {
        const detail = yield* moveLifecycle(input, {
          operation: "runner.undrain",
          from: "draining",
          to: "active",
          refusal: NOT_DRAINING,
          kind: "runner.undrained",
        });
        // A machine off the drain takes work again, which is not a fact the
        // fleet acts on itself.
        yield* connections.placementsChanged(detail.id);
        return detail;
      }),

    /**
     * The runner row's half of retiring a machine: the refusals, the lifecycle,
     * the fleet default and the log entry. The operation a client reaches is the
     * controller daemon's `retireRunner`, which runs this inside the transaction
     * that also ends the machine's sessions and loses its workspaces, and closes
     * the connection once that has committed.
     *
     * The credential stops resolving the moment the row moves. Nothing is
     * deleted: the row and everything that hangs off it stay, and re-enlisting
     * writes a new runner beside this one.
     */
    retire: (input: RetireInput): Effect.Effect<Retired, MoveError | SettingError> =>
      Effect.gen(function* () {
        yield* requireGrant("runner.retire");
        const { id, force } = yield* Effect.mapError(decodeRetire(input), validationOf);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const before = yield* one(id);
            if (before.lifecycle === "retired") {
              return yield* Effect.fail(invalidState(ALREADY_RETIRED));
            }
            if (force !== true) {
              if ((yield* runners.runningSessions(id)) > 0) {
                return yield* Effect.fail(invalidState(STILL_RUNNING));
              }
              if (before.connectivity === "unreachable") {
                return yield* Effect.fail(invalidState(UNREACHABLE));
              }
            }
            yield* runners.setLifecycle(id, "retired", at);
            // A default nobody can place on is worse than no default: the
            // fleet says so rather than promoting a runner nobody chose.
            const wasDefault = (yield* settings.defaultRunnerId()) === id;
            if (wasDefault) yield* settings.setDefaultRunnerId(null, at);
            yield* audit.append({
              kind: "runner.retired",
              actor: yield* currentStamp,
              record: { topic: "runner", id },
              payload: { runnerId: id, forced: force === true, lostDefaultRunner: wasDefault },
              at,
            });
            return { ...(yield* one(id)), at };
          }),
        );
      }),

    /**
     * Asks the machine to probe itself now and hands back the row its answer
     * left. The runner reports on its own hourly and only when something
     * changed, so this is the only way to see a machine that was just given a
     * provider CLI without waiting out the hour.
     */
    refreshFacts: (input: Identified): Effect.Effect<RunnerDetail, MoveError> =>
      Effect.gen(function* () {
        yield* requireGrant("runner.refreshFacts");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        const before = yield* one(id);
        yield* requireOnline(before);
        if (!(yield* connections.refreshedFacts(id))) {
          const waited = Duration.format(yield* RunnerFactsDeadline);
          return yield* Effect.fail(
            invalidState(`that runner did not report its facts within ${waited}`),
          );
        }
        return yield* one(id);
      }),

    /**
     * The token is in the answer and nowhere else. The fleet's "Add machine"
     * mints a fresh one each time it opens, so an expired one costs a refresh.
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
              // The token is a bearer secret; its id is what ties this entry to
              // the machine that spends it.
              payload: { joinTokenId: minted.id, expiresAt: minted.expiresAt },
              at,
            });
            return minted;
          }),
        );
      }),

    /**
     * The tokens the fleet is still expecting a machine to present. Never the
     * token or its hash: this says an invitation is outstanding, and is not a
     * second copy of one.
     */
    queryJoinTokens: (): Effect.Effect<
      ReadonlyArray<JoinTokenRef>,
      Unauthenticated | Forbidden | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("runner.queryJoinTokens");
        return yield* joinTokens.outstanding(yield* nowIso);
      }),

    /** Takes back an invitation that was minted and has not been spent. */
    revokeJoinToken: (
      input: Identified,
    ): Effect.Effect<
      Record<string, never>,
      Unauthenticated | Forbidden | Validation | NotFound | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("runner.revokeJoinToken");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            if (!(yield* joinTokens.revoke(id, at))) {
              return yield* Effect.fail(notFound(NO_SUCH_JOIN_TOKEN));
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
  "hydra/controller/runners/RunnerService",
) {}

export const RunnerServiceLayer: Layer.Layer<
  RunnerService,
  never,
  SqlClient.SqlClient | JoinTokens | Settings | RunnerConnections | AuditLog
> = Layer.effect(RunnerService)(make);
