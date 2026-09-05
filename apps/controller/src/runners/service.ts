/**
 * Runners as the API sees them: `runner.query`, `read`, `update` and the mint
 * that invites a machine to join.
 *
 * A runner is almost entirely self-describing. Its state, version, negotiated
 * capabilities, probed facts and watermark all arrive over the runner protocol
 * and are written by it; what an operation may change is the name, the labels
 * and the session cap, and the payload schema refuses anything else.
 *
 * Input is decoded against the contract's own schemas rather than trusted. A
 * request has already been decoded by the transport, but a built-in workflow
 * action calls these methods directly, and the bounds are the same rule
 * whichever way the call arrived.
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

/** What listing takes: how much of it, and what narrows it. */
const QueryInput = Schema.Struct({
  ...RunnerFilter.fields,
  ...pageInput(RUNNER_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

/** What identifies one runner: the id, and what an edit does to it. */
const UpdateInput = Schema.Struct({ id: Id, ...RUNNER_EDIT_FIELDS });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const Identified = Schema.Struct({ id: Id });

export type Identified = Schema.Schema.Type<typeof Identified>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);

/** One page of the fleet, in the contract's shape. */
export interface RunnerPage {
  readonly items: ReadonlyArray<Runner>;
  readonly nextCursor?: string;
}

/** What an update reports for a field that changed. */
interface Change {
  readonly old: unknown;
  readonly new: unknown;
}

const NO_SUCH_RUNNER = "no such runner";

/** Alphabetical: a fleet is short, and its name is how a reader picks one out. */
const DEFAULT_DIRECTION: SortDirection = "asc";

/** The repository's edit, writable while the patch is compared to the row. */
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
    /** One page of the fleet. */
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

    /** One runner by id, with everything its hello negotiated. */
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
     * Changes what a person owns on a runner and says what changed.
     *
     * A patch that names no field is refused, and a patch that asks for the
     * values the runner already holds writes nothing at all: either would move
     * `updatedAt` and stamp a `runner.updated` row describing nothing.
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
            // One clock read, inside the transaction: the row and the event
            // that records it carry the same instant.
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
              payload: { runnerId: id, changes },
              at,
            });
            // Read back rather than merge in memory: what the caller gets is
            // then the row that was written, whatever the edit touched.
            return yield* one(id);
          }),
        );
      }),

    /**
     * Mints an invitation for one machine. The token is in the answer and
     * nowhere else; the fleet's "Add machine" spot mints a fresh one every time
     * it is opened, so an expired one costs a page refresh.
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
              // The token itself is a bearer secret; the invitation's id is
              // what ties this entry to the machine that spends it.
              payload: { joinTokenId: minted.id, expiresAt: minted.expiresAt },
              at,
            });
            return minted;
          }),
        );
      }),
  };
});

/** The runner service. */
export class RunnerService extends Context.Service<RunnerService, Effect.Success<typeof make>>()(
  "hydra/controller/runners/RunnerService",
) {}

export const RunnerServiceLayer: Layer.Layer<
  RunnerService,
  never,
  SqlClient.SqlClient | JoinTokens | AuditLog
> = Layer.effect(RunnerService)(make);
