/**
 * The Initiative operations of the API: `initiative.query`, `read`, `create`,
 * `update`, `close`, `reopen` and `delete`.
 *
 * An Initiative is the user's own lasting intent, which Tasks belong to. Only
 * the user makes, changes, closes, reopens or deletes one: a grant would let
 * a session do it too, so every mutation also requires the user as actor. A
 * session reads Initiatives, and puts a Task on one through `task.update`.
 *
 * Each mutation announces the Initiative on the `initiative` topic, once the
 * transaction commits. A mutation that changes nothing writes nothing and
 * announces nothing. Rows carry actor stamps (`created_by`, `updated_by`);
 * no audit event is written, because no workflow trigger watches an
 * Initiative.
 *
 * Input is decoded against the contract's schemas rather than trusted, as in
 * the project service: a caller inside the controller can send what the
 * transport would have refused.
 *
 * Delete is soft. In the same transaction, the Tasks on the Initiative lose
 * it (`TaskService.clearInitiative`, which announces each Task).
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createDecodeValidationError,
  createNotFoundError,
  DEFAULT_PAGE_LIMIT,
  INITIATIVE_HUES,
  InitiativeCreateInput,
  InitiativeQuery,
  InitiativeUpdateInput,
  type Forbidden,
  type Id,
  type Initiative,
  type InitiativeHue,
  type NotFound,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant, requireUserActor } from "../actor";
import { announce, nowIso, refuseCursor, withTransaction } from "../db";
import { projectRepository } from "../projects";
import { TaskService } from "../tasks";
import { initiativeRepository, type InitiativeEdit } from "./repository";

const decodeQuery = Schema.decodeUnknownEffect(InitiativeQuery);
const decodeCreate = Schema.decodeUnknownEffect(InitiativeCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(InitiativeUpdateInput);

/** One page of Initiatives, in the contract's shape. */
export interface InitiativePage {
  readonly items: ReadonlyArray<Initiative>;
  readonly nextCursor?: string;
}

/**
 * The refusal a session or a run gets from any Initiative mutation. It says
 * why holding the grant does not help, and what a session may do instead.
 */
const ONLY_THE_USER_MAKES_INITIATIVES =
  "Only the user creates and changes initiatives; a session can add a Task to one that exists.";

const NO_SUCH_INITIATIVE = "no such initiative";
const NO_SUCH_PROJECT = "no such project";

/**
 * Returns the hue that the fewest open Initiatives use. On a tie it returns
 * the first of those in `INITIATIVE_HUES`, so a new Initiative takes the
 * hues in list order until all are used once.
 */
const chooseLeastUsedHue = (usesByHue: ReadonlyMap<number, number>): InitiativeHue => {
  let chosen: InitiativeHue = INITIATIVE_HUES[0];
  let fewest = Number.POSITIVE_INFINITY;
  for (const hue of INITIATIVE_HUES) {
    const uses = usesByHue.get(hue) ?? 0;
    if (uses < fewest) {
      chosen = hue;
      fewest = uses;
    }
  }
  return chosen;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const initiatives = yield* initiativeRepository;
  const projects = yield* projectRepository;
  const tasks = yield* TaskService;

  const readLiveOrFail = (id: string): Effect.Effect<Initiative, NotFound | SqlError> =>
    Effect.flatMap(
      initiatives.live(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_INITIATIVE)),
        onSome: Effect.succeed,
      }),
    );

  /** Fails with `NotFound` when no project that is not deleted has this id. */
  const requireProject = (projectId: string): Effect.Effect<void, NotFound | SqlError> =>
    Effect.flatMap(
      projects.live(projectId),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_PROJECT)),
        onSome: () => Effect.void,
      }),
    );

  const announceChange = (id: string, kind: "created" | "updated" | "deleted") =>
    announce({ _tag: "record", topic: "initiative", id, kind });

  /**
   * Opens or closes an Initiative and returns it. Setting the state it
   * already has writes and announces nothing.
   */
  const setClosed = (
    operation: "initiative.close" | "initiative.reopen",
    id: Id,
  ): Effect.Effect<Initiative, Unauthenticated | Forbidden | NotFound | SqlError> =>
    Effect.gen(function* () {
      yield* requireUserActor(operation, ONLY_THE_USER_MAKES_INITIATIVES);
      const closing = operation === "initiative.close";
      return yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const before = yield* readLiveOrFail(id);
          if ((before.closedAt !== undefined) === closing) return before;
          const at = yield* nowIso;
          yield* initiatives.setClosedAt(id, closing ? at : null, at, yield* currentStamp);
          yield* announceChange(id, "updated");
          return yield* readLiveOrFail(id);
        }),
      );
    });

  return {
    /**
     * Returns one page of the open Initiatives, or of the closed ones when
     * `closed` is true, in creation order.
     */
    query: (
      input: InitiativeQuery,
    ): Effect.Effect<InitiativePage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("initiative.query");
        const { limit, cursor, closed, projectId } = yield* Effect.mapError(
          decodeQuery(input),
          createDecodeValidationError,
        );
        const listing = yield* refuseCursor(
          initiatives.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            closed: closed ?? false,
            projectId,
          }),
        );
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    /** Returns one Initiative by id, open or closed. Fails with `NotFound` if there is none or it is deleted. */
    read: (id: Id): Effect.Effect<Initiative, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("initiative.read");
        return yield* readLiveOrFail(id);
      }),

    /**
     * Creates an open Initiative and returns it. With no `hue`, it takes the
     * one that the fewest open Initiatives use. Fails with `NotFound` when
     * `projectId` names no project.
     */
    create: (
      input: InitiativeCreateInput,
    ): Effect.Effect<Initiative, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireUserActor("initiative.create", ONLY_THE_USER_MAKES_INITIATIVES);
        const decoded = yield* Effect.mapError(decodeCreate(input), createDecodeValidationError);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            if (decoded.projectId !== undefined) yield* requireProject(decoded.projectId);
            const hue = decoded.hue ?? chooseLeastUsedHue(yield* initiatives.countOpenByHue());
            const initiative = yield* initiatives.insert({
              name: decoded.name,
              intent: decoded.intent ?? "",
              target: decoded.target,
              targetDate: decoded.targetDate,
              hue,
              projectId: decoded.projectId,
              at,
              by: yield* currentStamp,
            });
            yield* announceChange(initiative.id, "created");
            return initiative;
          }),
        );
      }),

    /**
     * Updates an Initiative and returns it as it is after the update. A field
     * set to `null` is cleared (`target`, `targetDate`, `projectId`). An
     * update that only repeats the current values writes and announces
     * nothing. Fails with `NotFound` when the Initiative or the project in
     * `projectId` does not exist.
     */
    update: (
      id: Id,
      input: InitiativeUpdateInput,
    ): Effect.Effect<Initiative, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireUserActor("initiative.update", ONLY_THE_USER_MAKES_INITIATIVES);
        const patch = yield* Effect.mapError(decodeUpdate(input), createDecodeValidationError);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const before = yield* readLiveOrFail(id);
            if (patch.projectId !== undefined && patch.projectId !== null) {
              yield* requireProject(patch.projectId);
            }

            // An absent optional field and `null` both mean "none", so the
            // comparison treats them alike.
            const edit: {
              -readonly [Field in keyof InitiativeEdit]: InitiativeEdit[Field];
            } = {};
            if (patch.name !== undefined && patch.name !== before.name) edit.name = patch.name;
            if (patch.intent !== undefined && patch.intent !== before.intent) {
              edit.intent = patch.intent;
            }
            if (patch.target !== undefined && patch.target !== (before.target ?? null)) {
              edit.target = patch.target;
            }
            if (
              patch.targetDate !== undefined &&
              patch.targetDate !== (before.targetDate ?? null)
            ) {
              edit.targetDate = patch.targetDate;
            }
            if (patch.projectId !== undefined && patch.projectId !== (before.projectId ?? null)) {
              edit.projectId = patch.projectId;
            }
            if (patch.hue !== undefined && patch.hue !== before.hue) edit.hue = patch.hue;

            if (Object.keys(edit).length === 0) return before;

            yield* initiatives.update(id, edit, at, yield* currentStamp);
            yield* announceChange(id, "updated");
            // Read the row back rather than merge in memory, so the caller
            // gets exactly the row that was written.
            return yield* readLiveOrFail(id);
          }),
        );
      }),

    /**
     * Closes an Initiative and returns it. Its Tasks stay on it. Closing a
     * closed Initiative changes nothing.
     */
    close: (id: Id) => setClosed("initiative.close", id),

    /** Reopens an Initiative and returns it. Reopening an open one changes nothing. */
    reopen: (id: Id) => setClosed("initiative.reopen", id),

    /**
     * Deletes an Initiative (a soft delete) and returns an empty object. In
     * the same transaction each of its Tasks loses it, with one `task`
     * announcement each. Fails with `NotFound` if the Initiative does not
     * exist or is already deleted.
     */
    delete: (
      id: Id,
    ): Effect.Effect<Record<string, never>, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireUserActor("initiative.delete", ONLY_THE_USER_MAKES_INITIATIVES);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            yield* readLiveOrFail(id);
            yield* initiatives.softDelete(id, at, yield* currentStamp);
            yield* tasks.clearInitiative(id);
            yield* announceChange(id, "deleted");
            return {};
          }),
        );
      }),
  };
});

/** The Initiative service. */
export class InitiativeService extends Context.Service<
  InitiativeService,
  Effect.Success<typeof make>
>()("hercule/controller/initiatives/InitiativeService") {}

export const InitiativeServiceLayer: Layer.Layer<
  InitiativeService,
  never,
  SqlClient.SqlClient | TaskService
> = Layer.effect(InitiativeService)(make);
