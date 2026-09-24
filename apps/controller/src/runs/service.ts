/**
 * The run operations served by the runs domain: `run.query` and `run.read`.
 *
 * Starting a run crosses domains - it reads a workflow, checks Connections,
 * and later calls other domains' services from each step - so it lives in the
 * controller daemon's run engine, not here.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createDecodeValidationError,
  createNotFoundError,
  DEFAULT_PAGE_LIMIT,
  Id,
  RUN_SORT_FIELDS,
  RunFilter,
  type Forbidden,
  type NotFound,
  type Run,
  type RunSummary,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { requireGrant } from "../actor";
import { buildPageInputFields, refuseCursor } from "../db";
import { runRepository } from "./repository";

const QueryInput = Schema.Struct({
  ...RunFilter.fields,
  ...buildPageInputFields(RUN_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);

export interface RunPage {
  readonly items: ReadonlyArray<RunSummary>;
  readonly nextCursor?: string;
}

/** The input of the operations on one run: its id. */
export const Identified = Schema.Struct({ id: Id });

export type Identified = Schema.Schema.Type<typeof Identified>;

const decodeIdentified = Schema.decodeUnknownEffect(Identified);

const make = Effect.gen(function* () {
  const runs = yield* runRepository;

  return {
    /**
     * Returns one page of runs, the newest first unless the caller sorts the
     * other way: the run someone started last is the one they look for.
     */
    query: (
      input: QueryInput,
    ): Effect.Effect<RunPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("run.query");
        const { limit, cursor, sort, ...filter } = yield* Effect.mapError(
          decodeQuery(input),
          createDecodeValidationError,
        );
        const listing = yield* refuseCursor(
          runs.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? "desc",
            ...filter,
          }),
        );
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    /**
     * Returns a run with its frozen plan, its inputs and every step record.
     * Fails with `NotFound` if no run has the id.
     */
    read: (
      input: Identified,
    ): Effect.Effect<Run, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("run.read");
        const { id } = yield* Effect.mapError(decodeIdentified(input), createDecodeValidationError);
        const found = yield* runs.read(id);
        if (Option.isNone(found)) return yield* Effect.fail(createNotFoundError("no such run"));
        return found.value;
      }),
  };
});

export class RunService extends Context.Service<RunService, Effect.Success<typeof make>>()(
  "hercule/controller/runs/RunService",
) {}

export const RunServiceLayer: Layer.Layer<RunService, never, SqlClient.SqlClient> =
  Layer.effect(RunService)(make);
