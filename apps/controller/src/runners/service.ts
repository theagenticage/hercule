/**
 * Runners as the API sees them. A runner is almost entirely self-describing:
 * everything but the name, the labels and the session cap arrives over the
 * runner protocol, and the payload schema refuses the rest.
 *
 * Input is decoded here rather than trusted, because a built-in workflow action
 * calls these methods directly and the bounds are the same rule either way.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  DEFAULT_PAGE_LIMIT,
  Id,
  notFound,
  validation,
  RUNNER_EDIT_FIELDS,
  RUNNER_SORT_FIELDS,
  RunnerFilter,
  validationOf,
  type Forbidden,
  type MintedJoinToken,
  type NotFound,
  type Runner,
  type RunnerDetail,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hydra/contract";
import { requireGrant, USER_ACTOR } from "../actor";
import { nowIso, pageInput, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { JoinTokens } from "./join-tokens";
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

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);

export interface RunnerPage {
  readonly items: ReadonlyArray<Runner>;
  readonly nextCursor?: string;
}

interface Change {
  readonly old: unknown;
  readonly new: unknown;
}

const NO_SUCH_RUNNER = "no such runner";

/** Alphabetical: a fleet is short, and its name is how a reader picks one out. */
const DEFAULT_DIRECTION: SortDirection = "asc";

type Edit = { -readonly [K in keyof RunnerEdit]: RunnerEdit[K] };

/** Labels are replaced whole, so their order is part of the value. */
const sameLabels = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((label, index) => label === right[index]);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runners = yield* runnerRepository;
  const joinTokens = yield* JoinTokens;
  const audit = yield* AuditLog;

  const one = (id: string): Effect.Effect<RunnerDetail, NotFound | SqlError> =>
    Effect.flatMap(
      runners.read(id),
      Option.match({
        onNone: () => Effect.fail(notFound(NO_SUCH_RUNNER)),
        onSome: Effect.succeed,
      }),
    );

  return {
    query: (
      input: QueryInput,
    ): Effect.Effect<RunnerPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("runner.query");
        const { limit, cursor, sort, state, label } = yield* Effect.mapError(
          decodeQuery(input),
          validationOf,
        );
        const listing = yield* refuseCursor(
          runners.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? DEFAULT_DIRECTION,
            state,
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
      Unauthenticated | Forbidden | Validation | NotFound | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("runner.update");
        const { id, ...patch } = yield* Effect.mapError(decodeUpdate(input), validationOf);
        if (Object.keys(patch).length === 0) {
          return yield* Effect.fail(validation([{ path: [], message: "name a field to change" }]));
        }
        return yield* withTransaction(
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

            if (Object.keys(changes).length === 0) return before;

            yield* runners.update(id, edit, at);
            yield* audit.append({
              kind: "runner.updated",
              actor: USER_ACTOR,
              record: { topic: "runner", id },
              payload: { runnerId: id, changes },
              at,
            });
            // Read back rather than merged, so the caller gets the written row.
            return yield* one(id);
          }),
        );
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
              actor: USER_ACTOR,
              // The token is a bearer secret; its id is what ties this entry to
              // the machine that spends it.
              payload: { joinTokenId: minted.id, expiresAt: minted.expiresAt },
              at,
            });
            return minted;
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
  SqlClient.SqlClient | JoinTokens | AuditLog
> = Layer.effect(RunnerService)(make);
