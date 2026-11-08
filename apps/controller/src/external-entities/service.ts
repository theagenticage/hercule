/**
 * The External Entity operations: the Inbox and its counts, one entity, take
 * an entity on as a Task, dismiss and restore a card, and the three that let
 * the user add a thing to Work: search the source, list suggestions, and add.
 *
 * The rules this module owns:
 *
 * - A Task for an entity is made by the Task service (`createTaskLinkedToRef`
 *   and `undoCreatedTask`). This module never writes a Task itself.
 * - Reading a thing at its source (`EntityLookups.resolve`) takes seconds and
 *   can fail, so it never runs inside a transaction. `prepareEntityForTask`
 *   reads first, outside any transaction. The final transaction then checks
 *   everything again against the rows, because the world may have moved while
 *   the read waited, and writes the observation and the Task together.
 * - Taking on, undoing, dismissing, restoring, searching and adding are the
 *   user's own acts. A session or a run that holds the grant is refused.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createConflictError,
  createInvalidStateError,
  createNotFoundError,
  MAX_ENTITY_SEARCH_RESULTS,
  MAX_ENTITY_ANCESTORS,
  MAX_ENTITY_SUGGESTIONS,
  MAX_SUGGESTION_CONTEXTS,
  type Conflict,
  type EntityAddToWorkInput,
  type EntityAddToWorkResult,
  type EntityLinkInput,
  type EntityPlace,
  type EntitySearchQuery,
  type EntitySearchReply,
  type EntitySearchResult,
  type EntitySuggestion,
  type EntitySuggestions,
  type EntitySuggestionsQuery,
  type EntityTakeOnResult,
  type EntityUndoTakeOnResult,
  type EntityUnlinkResult,
  type ExternalEntityDetail,
  type Forbidden,
  type Inbox,
  type InboxCounts,
  type InvalidState,
  type NotFound,
  type TaskStage,
  type Unauthenticated,
} from "@hercule/contract";
import {
  PluginError,
  type EntityRecognition,
  type EntityMissing,
  type QualifiedEntityKindDeclaration,
} from "@hercule/plugin-host";
import { currentStamp, requireGrant, requireUserActor } from "../actor";
import { nowIso, withTransaction } from "../db";
import { EntityLookups, PluginHost, type EntityReporter, type LookupObservation } from "../plugins";
import { resourceRepository } from "../resources";
import {
  ONLY_THE_USER_TAKES_ON_WORK,
  TaskService,
  taskRepository,
  type TaskUndoRefusal,
} from "../tasks";
import { announceEntityChanges } from "./announce";
import { buildActiveEntityKind } from "./entity-records";
import { listOfferedKinds, type OfferedKind } from "./offers";
import { isPendingTarget } from "./pending-target";
import { claimRepository } from "./claims";
import { ExternalEntityIngest, ExternalEntityIngestLayer, prepareObservations } from "./ingest";
import {
  externalEntityRepository,
  type EntityReadEnvironment,
  type ObservedEntity,
  type PruneResult,
  type TaskableEntity,
} from "./repository";

/** Builds the reply of `search` from how the search ended. */
const buildSearchReply = (
  source: string,
  linkSources: ReadonlyArray<string>,
  outcome: EntitySearchReply["outcome"],
  results: ReadonlyArray<EntitySearchResult> = [],
  incomplete = false,
): EntitySearchReply => ({ source, outcome, results, incomplete, linkSources });

const ONLY_THE_USER_LINKS =
  "only the user may link two things or take a link back: a person's link is the user's own word, so a session or a workflow step may not; ask the user instead";

const ONLY_THE_USER_SEARCHES =
  "only the user may search a source: the search reads through the user's own accounts, so a session or a workflow step may not; ask the user instead";

/** The stage a Task starts at when the thing's status declares none. */
const DEFAULT_STAGE: TaskStage = "planned";

/** A kind of the catalog, with the plugin that declares it. */
interface CatalogKind {
  readonly pluginId: string;
  readonly declaration: QualifiedEntityKindDeclaration;
}

/** The entity kinds and plugins that are active now. */
interface Catalog {
  readonly activePluginIds: ReadonlyArray<string>;
  /** The active kinds, by qualified word. */
  readonly kinds: ReadonlyMap<string, CatalogKind>;
  /** What the offers need of the plugin of each active kind. */
  readonly offeredKinds: ReadonlyArray<OfferedKind>;
}

/** What `prepareEntityForTask` read: nothing when the rows already held a full, readable record. */
type Preparation =
  | { readonly read: false }
  | {
      readonly read: true;
      readonly connectionId: string;
      readonly entity: ObservedEntity;
    };

/** Whether a Task was made for an entity, and which. */
interface TaskForEntity {
  readonly entityId: string;
  readonly taskId: string;
  readonly created: boolean;
  readonly stage: TaskStage;
  readonly followed: boolean;
}

/**
 * Returns the stage a Task starts at for a thing: the `stage` that the kind's
 * status table declared for the thing's status when it was observed, else
 * `planned`. So Todo is Planned and In progress is Building. The stage is
 * stored with the status, so the kind need not be in the catalog.
 */
export const chooseStageForEntity = (entity: Pick<TaskableEntity, "stage">): TaskStage =>
  entity.stage ?? DEFAULT_STAGE;

/** Checks that the text is one web address and nothing else. */
const isSingleUrl = (text: string): boolean => /^https?:\/\/\S+$/i.test(text);

/** Builds the sentence for a thing that could not be read at its source. */
const describeMissing = (ref: string, missing: EntityMissing): string => {
  switch (missing) {
    case "inaccessible":
      return `${ref} cannot be taken on: the source refused every connected account that was asked. Connect an account that can open it, then try again.`;
    case "unknown":
      return `${ref} cannot be taken on: no connected account could read it. It may not exist, or no account may open it.`;
    case "not-found":
      return `${ref} cannot be taken on: the source says nothing is there. It may have been deleted.`;
  }
};

/** Builds the sentence for an undo that left the Task in place. */
const describeUndoRefusal = (reason: TaskUndoRefusal): string => {
  switch (reason) {
    case "task-gone":
      return "The Task is already gone, so there is nothing to undo.";
    case "task-merged":
      return "The Task was merged into another Task, which now holds its work, so it stays.";
    case "has-thread":
      return "A Thread has joined the Task, so it stays.";
    case "has-run":
      return "A run works on the Task, so it stays.";
    case "has-other-link":
      return "The Task links another thing too, so it stays.";
    case "edited":
      return "The Task was edited after it was made, so it stays.";
    case "finished":
      return "The Task is already done or dropped, so it stays.";
    case "not-linked":
      return "That Task was not made for this thing, so it stays.";
  }
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const entities = yield* externalEntityRepository;
  const taskRows = yield* taskRepository;
  const tasks = yield* TaskService;
  const resources = yield* resourceRepository;
  const lookups = yield* EntityLookups;
  const ingest = yield* ExternalEntityIngest;
  const host = yield* PluginHost;
  const claims = yield* claimRepository;

  /** Reads the entity kinds and plugins that are active now. */
  const readCatalog: Effect.Effect<Catalog> = Effect.map(
    host.listActiveEventSources(),
    (sources) => {
      const kinds = new Map<string, CatalogKind>();
      for (const source of sources) {
        for (const declaration of source.entityKinds) {
          kinds.set(declaration.word, { pluginId: source.pluginId, declaration });
        }
      }
      return {
        activePluginIds: [...new Set(sources.map((source) => source.pluginId))],
        kinds,
        offeredKinds: listOfferedKinds(sources),
      };
    },
  );

  /** Reads what the repository needs to tell whether a plugin and a kind are active, and the time. */
  const readEnvironment: Effect.Effect<EntityReadEnvironment> = Effect.gen(function* () {
    const catalog = yield* readCatalog;
    return {
      now: yield* nowIso,
      activePluginIds: catalog.activePluginIds,
      activeKinds: new Set(catalog.kinds.keys()),
      activeEntityKinds: [...catalog.kinds.values()].map(({ declaration }) =>
        buildActiveEntityKind(declaration),
      ),
      offeredKinds: catalog.offeredKinds,
    };
  });

  /** Returns the reporter that `prepareObservations` checks an observation against. */
  const buildReporter = (
    catalog: Catalog,
    pluginId: string,
    connectionId: string,
  ): EntityReporter => ({
    connectionId,
    pluginId,
    kinds: [...catalog.kinds.values()]
      .filter((entry) => entry.pluginId === pluginId)
      .map((entry) => entry.declaration),
  });

  /**
   * Checks a thing that a lookup read and returns it ready to store, or fails
   * with `InvalidState`. It must be exactly the requested ref, a full record
   * of a work kind, and well formed (see `prepareObservations`).
   */
  const checkReadThing = (
    catalog: Catalog,
    pluginId: string,
    ref: string,
    found: LookupObservation,
  ): Effect.Effect<ObservedEntity, InvalidState> =>
    Effect.gen(function* () {
      const { observation } = found;
      if (observation.ref !== ref) {
        return yield* Effect.fail(
          createInvalidStateError(
            `${ref} cannot be taken on: the source answered with ${observation.ref}, which is another thing.`,
          ),
        );
      }
      if (observation.partial === true) {
        return yield* Effect.fail(
          createInvalidStateError(
            `${ref} cannot be taken on: the source returned only its title, and a Task needs the whole record. Try again.`,
          ),
        );
      }
      const [prepared] = yield* Effect.mapError(
        prepareObservations(buildReporter(catalog, pluginId, found.connectionId), [observation]),
        (error: PluginError) =>
          createInvalidStateError(`${ref} cannot be taken on: ${error.message}`),
      );
      if (
        prepared === undefined ||
        catalog.kinds.get(prepared.kind)?.declaration.pace === "context"
      ) {
        return yield* Effect.fail(
          createInvalidStateError(`${ref} cannot be taken on: it is a place, not work.`),
        );
      }
      return prepared;
    });

  /**
   * Prepares an entity for a Task, outside any transaction, and returns
   * whether the rows already hold a record that needs no read or a thing was
   * read at its source.
   *
   * - A kind with no card (a place) fails `InvalidState`.
   * - A full record with `access: ok` and an active kind needs no read.
   * - Anything else (no record, a partial record, lost access) is read with
   *   `EntityLookups.resolve`. If the read fails, so does this call, and no
   *   Task exists. A partial answer never satisfies it.
   *
   * Fails with `InvalidState` when the ref belongs to no active kind, or the
   * read does not give one full record of exactly this ref.
   */
  const prepareEntityForTask = (ref: string): Effect.Effect<Preparation, InvalidState | SqlError> =>
    Effect.gen(function* () {
      const catalog = yield* readCatalog;
      const known = Option.getOrUndefined(yield* entities.readTaskableEntity({ ref }));
      const owner =
        known !== undefined && known.kind !== ""
          ? catalog.kinds.get(known.kind)
          : [...catalog.kinds.values()].find((entry) =>
              ref.startsWith(entry.declaration.refPrefix),
            );
      if (owner === undefined) {
        return yield* Effect.fail(
          createInvalidStateError(
            `${ref} cannot be taken on now: no active plugin reads this kind of thing. Enable the plugin that reports it, then try again.`,
          ),
        );
      }
      if (owner.declaration.pace === "context") {
        return yield* Effect.fail(
          createInvalidStateError(
            `${ref} is ${owner.declaration.noun.toLowerCase()}, a place that groups work. A place cannot be taken on: take on one of the things in it.`,
          ),
        );
      }
      if (known !== undefined && known.isWorkRecord && known.access === "ok") {
        return { read: false };
      }
      const recognition: EntityRecognition = {
        recognized: "ref",
        form: "identifier",
        ref,
        kind: owner.declaration.word,
      };
      const decided = yield* lookups.resolve(owner.pluginId, recognition);
      if ("found" in decided) {
        const entity = yield* checkReadThing(catalog, owner.pluginId, ref, decided.found);
        return { read: true, connectionId: decided.found.connectionId, entity };
      }
      if ("missing" in decided) {
        return yield* Effect.fail(createInvalidStateError(describeMissing(ref, decided.missing)));
      }
      if ("ambiguous" in decided) {
        return yield* Effect.fail(
          createInvalidStateError(
            `${ref} cannot be taken on: the source names more than one thing for it.`,
          ),
        );
      }
      if ("incomplete" in decided) {
        return yield* Effect.fail(
          createInvalidStateError(
            `${ref} cannot be taken on yet: a connected account could not be asked, so it is not sure the thing can be read. Try again.`,
          ),
        );
      }
      return yield* Effect.fail(
        createInvalidStateError(
          `${ref} cannot be taken on now: no connected account of ${owner.pluginId} can be asked right now. Connect one, then try again.`,
        ),
      );
    });

  /**
   * Returns the Project for the Task of an entity: the only Project that is
   * not deleted and that the Resource whose canonical remote is the repository
   * the work lands in is filed under. With no repository, no such Resource, or
   * a Resource in no live Project or in several, there is none. A GitHub
   * repository or a Linear project is never a Project.
   */
  const findProjectOfRemote = (
    remote: string | undefined,
  ): Effect.Effect<string | undefined, SqlError> =>
    Effect.gen(function* () {
      if (remote === undefined) return undefined;
      const projects = yield* resources.listLiveProjectsOfRemote(remote);
      return projects.length === 1 ? projects[0] : undefined;
    });

  /**
   * Returns the active Task of an entity, or makes one, in one transaction.
   *
   * 1. When a thing was read, checks that its Connection can still read, and
   *    stores the observation (which creates the entity when it is new).
   * 2. Checks the rows again: the exact ref, a full record, `access: ok` and
   *    an active kind. Otherwise fails with `Conflict`, so the caller repeats.
   * 3. Returns the active Task when one appeared meanwhile.
   * 4. Makes the Task and its link, in the Project the user picked or the one
   *    the repository points at. With `followIfUnconcerned`, the link records
   *    that Hercule follows the thing when no Connection reports a concern.
   *
   * The observation is stored through the repository's `refresh`, which never
   * changes a concern, so a later poll never empties what a Task follows.
   */
  const makeTaskForEntity = (input: {
    readonly ref: string;
    readonly preparation: Preparation;
    readonly projectId: string | undefined;
    readonly followIfUnconcerned: boolean;
  }): Effect.Effect<TaskForEntity, Unauthenticated | Forbidden | NotFound | Conflict | SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const catalog = yield* readCatalog;
        const { preparation, ref } = input;
        if (preparation.read) {
          const stored = yield* ingest.storeRead({
            connectionId: preparation.connectionId,
            observed: preparation.entity,
            activePluginIds: catalog.activePluginIds,
          });
          if (!stored) {
            return yield* Effect.fail(
              createConflictError(
                `${ref} was read through an account that can no longer read it. Try again.`,
              ),
            );
          }
        }
        const record = Option.getOrUndefined(yield* entities.readTaskableEntity({ ref }));
        const declaration =
          record === undefined ? undefined : catalog.kinds.get(record.kind)?.declaration;
        if (
          record === undefined ||
          declaration === undefined ||
          declaration.pace === "context" ||
          !record.isWorkRecord ||
          record.access !== "ok"
        ) {
          return yield* Effect.fail(
            createConflictError(
              `${ref} changed while the Task was being made, and can no longer be taken on. Try again.`,
            ),
          );
        }
        const active = Option.getOrUndefined(yield* taskRows.findActiveTaskForRef(ref));
        if (active !== undefined) {
          return {
            entityId: record.id,
            taskId: active.id,
            created: false,
            stage: active.stage,
            followed: false,
          };
        }
        const stage = chooseStageForEntity(record);
        const followed = input.followIfUnconcerned && !record.hasConcern;
        const projectId = input.projectId ?? (yield* findProjectOfRemote(record.targetRemote));
        const task = yield* tasks.createTaskLinkedToRef({
          ref,
          title: record.title,
          stage,
          ...(projectId === undefined ? {} : { projectId }),
          following: followed,
        });
        yield* announceEntityChanges({ entityIds: [record.id], affectedTaskIds: [] });
        return { entityId: record.id, taskId: task.id, created: true, stage, followed };
      }),
    );

  /** Reads the entity of an id, or fails with `NotFound`. */
  const readTaskableEntityOrFail = (
    id: string,
  ): Effect.Effect<TaskableEntity, NotFound | SqlError> =>
    Effect.flatMap(entities.readTaskableEntity({ id }), (found) =>
      Option.isSome(found)
        ? Effect.succeed(found.value)
        : Effect.fail(createNotFoundError("no such external entity")),
    );

  /** Sets a card aside or brings it back, as the user. Announces only when the card changed. */
  const moveCard = (
    id: string,
    write: (now: string, actor: string) => ReturnType<typeof entities.dismiss>,
  ): Effect.Effect<Record<string, never>, Unauthenticated | Forbidden | NotFound | SqlError> =>
    Effect.gen(function* () {
      yield* requireUserActor("task.update", ONLY_THE_USER_TAKES_ON_WORK);
      const actor = yield* currentStamp;
      const now = yield* nowIso;
      yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const moved = yield* write(now, actor);
          if (Option.isNone(moved)) {
            return yield* Effect.fail(createNotFoundError("no such external entity"));
          }
          if (moved.value.changed) {
            const active = yield* taskRows.findActiveTaskForRef(moved.value.ref);
            yield* announceEntityChanges({
              entityIds: [id],
              affectedTaskIds: Option.isSome(active) ? [active.value.id] : [],
            });
          }
        }),
      );
      return {};
    });

  /** Builds the results of a search from what the lookups read, and drops what cannot be added or shown. */
  const buildSearchResults = (
    catalog: Catalog,
    pluginId: string,
    read: ReadonlyArray<LookupObservation>,
  ): Effect.Effect<
    { readonly results: ReadonlyArray<EntitySearchResult>; readonly dropped: boolean },
    SqlError
  > =>
    Effect.gen(function* () {
      const shown: Array<{ readonly entity: ObservedEntity; readonly remote: string | undefined }> =
        [];
      let dropped = false;
      for (const found of read) {
        const prepared = yield* Effect.option(
          prepareObservations(buildReporter(catalog, pluginId, found.connectionId), [
            found.observation,
          ]),
        );
        const entity = Option.getOrUndefined(prepared)?.[0];
        if (entity === undefined) {
          dropped = true;
          continue;
        }
        // A place cannot be added, so it is not offered.
        if (catalog.kinds.get(entity.kind)?.declaration.pace === "context") continue;
        shown.push({ entity, remote: entity.observation.repository?.target.remote });
      }
      const standings = yield* entities.readStandings(
        shown.map(({ entity }) => entity.observation.ref),
      );
      const results = shown.map(({ entity, remote }): EntitySearchResult => {
        const { observation, slots } = entity;
        const standing = standings.get(observation.ref);
        return {
          ref: observation.ref,
          kind: entity.kind,
          noun: slots.noun,
          ...(slots.pace === "context" ? {} : { identifier: slots.identifier }),
          title: observation.title,
          ...(observation.url === undefined ? {} : { url: observation.url }),
          ...(slots.status === undefined ? {} : { status: slots.status }),
          ...(remote === undefined ? {} : { location: remote }),
          standing: standing?.standing ?? "new",
          ...(standing?.taskId === undefined ? {} : { taskId: standing.taskId }),
        };
      });
      return { results, dropped };
    });

  /** Reads the thing a recognition names, and answers the search with it. */
  const searchRecognition = (
    catalog: Catalog,
    pluginId: string,
    recognition: EntityRecognition,
    linkSources: ReadonlyArray<string>,
  ): Effect.Effect<EntitySearchReply, SqlError> =>
    Effect.gen(function* () {
      const reply = (
        outcome: EntitySearchReply["outcome"],
        results: ReadonlyArray<EntitySearchResult> = [],
        incomplete = false,
      ) => buildSearchReply(pluginId, linkSources, outcome, results, incomplete);
      const decided = yield* lookups.resolve(pluginId, recognition);
      if ("found" in decided) {
        const { results, dropped } = yield* buildSearchResults(catalog, pluginId, [decided.found]);
        if (results.length > 0) return reply("results", results);
        return dropped ? reply("incomplete", [], true) : reply("no-match");
      }
      if ("missing" in decided) {
        // A link that no account can open still names a ref: the result has no title, because none was read.
        const declaration =
          recognition.recognized === "ref"
            ? catalog.kinds.get(recognition.kind)?.declaration
            : undefined;
        if (
          recognition.recognized === "ref" &&
          declaration !== undefined &&
          decided.missing !== "not-found"
        ) {
          const standing = (yield* entities.readStandings([recognition.ref])).get(recognition.ref);
          return reply(decided.missing, [
            {
              ref: recognition.ref,
              kind: declaration.word,
              noun: declaration.noun,
              standing: standing?.standing ?? "new",
              ...(standing?.taskId === undefined ? {} : { taskId: standing.taskId }),
            },
          ]);
        }
        return reply(decided.missing);
      }
      if ("ambiguous" in decided) return reply("ambiguous");
      if ("incomplete" in decided) return reply("incomplete", [], true);
      return reply("source-unavailable");
    });

  return {
    /**
     * Returns the Inbox: the cards, the places above them, the edges between
     * the places and the counts. Needs the grants `task.read` and `signal.query`, because cards show signal text,
     * and `workflow.query` and `connection.query`, because the offers name workflows and accounts.
     */
    queryInbox: (): Effect.Effect<Inbox, Unauthenticated | Forbidden | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.read");
        yield* requireGrant("signal.query");
        yield* requireGrant("workflow.query");
        yield* requireGrant("connection.query");
        return yield* entities.queryInbox(yield* readEnvironment);
      }),

    /** Returns the counts of the Inbox, from the same definition as `queryInbox`. Needs the grants `task.read` and `signal.query`. */
    countInbox: (): Effect.Effect<InboxCounts, Unauthenticated | Forbidden | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.read");
        yield* requireGrant("signal.query");
        return yield* entities.countInbox((yield* readEnvironment).now);
      }),

    /**
     * Returns one entity with the records above it and what it links to.
     * Fails with `NotFound` for an unknown id, a partial record or a place:
     * only a full record of a work kind has a detail. Needs the grants
     * `task.read` and `signal.query`, because the detail shows signal text,
     * and `workflow.query` and `connection.query`, because the offers name
     * workflows and accounts.
     */
    read: (
      id: string,
    ): Effect.Effect<ExternalEntityDetail, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.read");
        yield* requireGrant("signal.query");
        yield* requireGrant("workflow.query");
        yield* requireGrant("connection.query");
        const found = yield* entities.readEntity(id, yield* readEnvironment);
        return yield* Option.match(found, {
          onNone: () => Effect.fail(createNotFoundError("no such external entity")),
          onSome: Effect.succeed,
        });
      }),

    /**
     * Returns the active Task of the entity, or makes one, and says which.
     * It is idempotent: a second click, or a second account, gets the same
     * Task. A new Task has the entity's title, the stage its status declares
     * (else `planned`), priority `normal`, and the Project that the entity's
     * repository points at when there is exactly one. Nothing is written at
     * the source.
     *
     * Fails with `NotFound` for an unknown id, `InvalidState` for a place or
     * a thing that could not be read, and `Conflict` when the entity changed
     * while the Task was being made and the call should be repeated. User
     * only.
     */
    takeOn: (
      id: string,
    ): Effect.Effect<
      EntityTakeOnResult,
      Unauthenticated | Forbidden | NotFound | InvalidState | Conflict | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireUserActor("task.update", ONLY_THE_USER_TAKES_ON_WORK);
        const record = yield* readTaskableEntityOrFail(id);
        const active = yield* taskRows.findActiveTaskForRef(record.ref);
        if (Option.isSome(active)) return { taskId: active.value.id, created: false };
        const preparation = yield* prepareEntityForTask(record.ref);
        const made = yield* makeTaskForEntity({
          ref: record.ref,
          preparation,
          projectId: undefined,
          followIfUnconcerned: false,
        });
        return { taskId: made.taskId, created: made.created };
      }),

    /**
     * Takes back the Task that `takeOn` or `addToWork` made, when nothing was
     * added to it since (see `TaskService.undoCreatedTask`). Otherwise
     * changes nothing and says why in a sentence. The Task must be linked to
     * this entity's ref, so a stale id can never delete another thing's Task.
     * Fails with `NotFound` for an unknown entity. User only.
     */
    undoTakeOn: (
      id: string,
      taskId: string,
    ): Effect.Effect<EntityUndoTakeOnResult, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireUserActor("task.update", ONLY_THE_USER_TAKES_ON_WORK);
        const record = yield* readTaskableEntityOrFail(id);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const outcome = yield* tasks.undoCreatedTask(taskId, record.ref);
            if (!outcome.undone) {
              return { undone: false, reason: describeUndoRefusal(outcome.reason) };
            }
            yield* announceEntityChanges({ entityIds: [id], affectedTaskIds: [] });
            return { undone: true };
          }),
        );
      }),

    /**
     * Takes the card off the Inbox until `restore`, stamped with the user.
     * Fails with `NotFound` for an unknown id. Dismissing a dismissed card
     * changes nothing. User only.
     */
    dismiss: (
      id: string,
    ): Effect.Effect<Record<string, never>, Unauthenticated | Forbidden | NotFound | SqlError> =>
      moveCard(id, (now, actor) => entities.dismiss(id, actor, now)),

    /** Brings a dismissed card back. Fails with `NotFound` for an unknown id. User only. */
    restore: (
      id: string,
    ): Effect.Effect<Record<string, never>, Unauthenticated | Forbidden | NotFound | SqlError> =>
      moveCard(id, (now, actor) => entities.restore(id, actor, now)),

    /**
     * Searches a source live, for the Add to Work sheet. Needs the grants
     * `task.read` and `connection.query`, and only the user may call it.
     * Nothing is stored.
     *
     * 1. Text that is one web address is recognized by every active plugin.
     *    The plugin that recognizes it becomes the source, so the tab
     *    changes by itself. A web address no plugin recognizes answers
     *    `unknown-link`.
     * 2. Anything else stays on the chosen source: one word that the source
     *    recognizes as an identifier is read, and other text is searched.
     * 3. Each result is marked `new`, `known` or `on-work` from one batched
     *    read.
     *
     * `scopeRef` narrows a search by words. An identifier is read in the
     * scope the plugin finds in it, so `scopeRef` does not apply to it.
     */
    search: (
      query: EntitySearchQuery,
    ): Effect.Effect<EntitySearchReply, Unauthenticated | Forbidden | SqlError> =>
      Effect.gen(function* () {
        yield* requireUserActor("task.read", ONLY_THE_USER_SEARCHES);
        yield* requireGrant("connection.query");
        const catalog = yield* readCatalog;
        const linkSources = yield* lookups.listLinkSources();
        const text = query.text.trim();
        const emptyReply = (source: string, outcome: EntitySearchReply["outcome"]) =>
          buildSearchReply(source, linkSources, outcome);
        if (text === "") return emptyReply(query.source, "no-match");

        if (isSingleUrl(text)) {
          const links = (yield* lookups.recognize(text)).filter(
            ({ recognition }) => recognition.form === "url",
          );
          const chosen = links.find(({ pluginId }) => pluginId === query.source) ?? links[0];
          if (chosen === undefined) return emptyReply(query.source, "unknown-link");
          return yield* searchRecognition(
            catalog,
            chosen.pluginId,
            chosen.recognition,
            linkSources,
          );
        }

        const identifiers = /\s/.test(text)
          ? []
          : (yield* lookups.recognize(text)).filter(
              ({ pluginId, recognition }) =>
                pluginId === query.source && recognition.form === "identifier",
            );
        if (identifiers.length === 1) {
          return yield* searchRecognition(
            catalog,
            query.source,
            identifiers[0]!.recognition,
            linkSources,
          );
        }

        const searched = yield* lookups.search(query.source, {
          text,
          limit: MAX_ENTITY_SEARCH_RESULTS,
          ...(query.scopeRef === undefined ? {} : { scopeRef: query.scopeRef }),
        });
        if (searched.outcome === "source-unavailable") {
          return emptyReply(query.source, "source-unavailable");
        }
        const { results, dropped } = yield* buildSearchResults(
          catalog,
          query.source,
          searched.observations,
        );
        const incomplete = searched.incomplete || dropped;
        return buildSearchReply(
          query.source,
          linkSources,
          results.length > 0 ? "results" : incomplete ? "incomplete" : "no-match",
          results.slice(0, MAX_ENTITY_SEARCH_RESULTS),
          incomplete,
        );
      }),

    /**
     * Returns the things that concern the user and have no active Task,
     * oldest first, for the sheet's list before the user types. With
     * `contextRef`, only the things under that context (reached by `part of`,
     * any number of levels) are listed. Each thing is listed once; `alsoIn`
     * names the other contexts that hold it, which are all its contexts
     * except the chosen one and the ones above it. Places are never listed,
     * and choosing a context never creates a Task. Fails with `NotFound` for
     * a context with no record.
     */
    listSuggestions: (
      query: EntitySuggestionsQuery,
    ): Effect.Effect<EntitySuggestions, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.read");
        const { contextRef } = query;
        const environment = yield* readEnvironment;
        const found = yield* entities.listSuggestions({
          contextRef,
          limit: MAX_ENTITY_SUGGESTIONS + 1,
          now: environment.now,
        });
        const truncated = found.length > MAX_ENTITY_SUGGESTIONS;
        const rows = truncated ? found.slice(0, MAX_ENTITY_SUGGESTIONS) : found;
        // The context is read with the rows: it is a place, and what lies
        // above it is not named as another context of a row.
        const context = yield* entities.readContext({
          starts:
            contextRef === undefined
              ? rows.map((row) => row.ref)
              : [contextRef, ...rows.map((row) => row.ref)],
          alsoPlaces: contextRef === undefined ? [] : [contextRef],
          maxAncestors: MAX_ENTITY_ANCESTORS,
          // Room for every ancestor of every row and of the context, so nothing is cut.
          maxPlaces: (MAX_ENTITY_SUGGESTIONS + 1) * MAX_ENTITY_ANCESTORS + 1,
          environment,
        });
        const records = new Map(context.places.map((place) => [place.ref, place] as const));
        const aboveContext = new Set<string>();
        if (contextRef !== undefined) {
          if (!records.has(contextRef)) {
            return yield* Effect.fail(createNotFoundError("no such context"));
          }
          for (const ancestor of context.ancestors.get(contextRef) ?? []) {
            aboveContext.add(ancestor);
          }
          aboveContext.add(contextRef);
        }
        const named = new Map<string, EntityPlace>();
        const suggestions = rows.map((row): EntitySuggestion => {
          const alsoIn = (context.ancestors.get(row.ref) ?? [])
            .filter((ancestor) => {
              // Only a kind that can group things is a context to name.
              return records.get(ancestor)?.caption !== undefined && !aboveContext.has(ancestor);
            })
            .slice(0, MAX_SUGGESTION_CONTEXTS);
          for (const ref of alsoIn) named.set(ref, records.get(ref)!);
          return {
            ref: row.ref,
            kind: row.kind,
            noun: row.noun,
            identifier: row.identifier,
            title: row.title,
            url: row.url,
            ...(row.status === undefined ? {} : { status: row.status }),
            alsoIn,
          };
        });
        return {
          suggestions,
          places: [...named.values()].sort((a, b) => a.ref.localeCompare(b.ref)),
          truncated,
        };
      }),

    /**
     * Adds one thing to Work, as a Task. With an active Task already, returns
     * it first, before any read, even when Hercule holds no record of the
     * thing (the reply then has no `id`). Otherwise reads the thing at its source when Hercule does not hold
     * a full, readable record of it, stores that record (which creates the
     * entity when it is new), and makes the Task as `takeOn` does, in
     * `projectId` when given. When no Connection reports a concern for the
     * thing, the link records that Hercule follows it.
     *
     * Fails like `takeOn`, and with `NotFound` for an unknown Project. User
     * only.
     */
    addToWork: (
      input: EntityAddToWorkInput,
    ): Effect.Effect<
      EntityAddToWorkResult,
      Unauthenticated | Forbidden | NotFound | InvalidState | Conflict | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireUserActor("task.update", ONLY_THE_USER_TAKES_ON_WORK);
        // An existing Task wins before any read: a Task can link a ref Hercule
        // holds no record of (an agent's `--ref`, or older work), and the user
        // must get it back even when the source cannot be reached.
        const active = yield* taskRows.findActiveTaskForRef(input.ref);
        if (Option.isSome(active)) {
          const known = Option.getOrUndefined(
            yield* entities.readTaskableEntity({ ref: input.ref }),
          );
          return {
            ...(known === undefined ? {} : { id: known.id }),
            taskId: active.value.id,
            created: false,
            stage: active.value.stage,
            followed: false,
          };
        }
        const preparation = yield* prepareEntityForTask(input.ref);
        const made = yield* makeTaskForEntity({
          ref: input.ref,
          preparation,
          projectId: input.projectId,
          followIfUnconcerned: true,
        });
        return {
          id: made.entityId,
          taskId: made.taskId,
          created: made.created,
          stage: made.stage,
          followed: made.followed,
        };
      }),

    /**
     * Links two things as the user's own claim (a `person` claim, stamped with
     * the user). The target may be a ref nobody has read: the next refresh
     * reads it. The source is never told. Linking a pair the user already
     * linked, in either direction, changes nothing.
     *
     * Fails with `NotFound` when Hercule holds no record of `fromRef`, and
     * with `InvalidState` when the two refs are the same or one is not a ref.
     * User only.
     */
    link: (
      input: EntityLinkInput,
    ): Effect.Effect<
      Record<string, never>,
      Unauthenticated | Forbidden | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireUserActor("task.update", ONLY_THE_USER_LINKS);
        const { fromRef, toRef } = input;
        if (fromRef === toRef) {
          return yield* Effect.fail(
            createInvalidStateError(
              `${fromRef} cannot be linked to itself. Link it to another thing.`,
            ),
          );
        }
        const notARef = [fromRef, toRef].find(isPendingTarget);
        if (notARef !== undefined) {
          return yield* Effect.fail(
            createInvalidStateError(
              `${notARef} is not a ref: "unresolved:" is reserved for the core's own use. Use the ref of the thing.`,
            ),
          );
        }
        const actor = yield* currentStamp;
        const now = yield* nowIso;
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const changes = yield* claims.changePersonLink({
              change: "link",
              fromRef,
              toRef,
              actor,
              now,
            });
            if (!changes.fromRefKnown) {
              return yield* Effect.fail(
                createNotFoundError(
                  `Hercule holds no record of ${fromRef}, so it cannot be linked from.`,
                ),
              );
            }
            yield* entities.applyClaimChanges(changes, now);
          }),
        );
        return {};
      }),

    /**
     * Removes the user's own claim between two things, in either direction,
     * and returns what is left. `removed` is false when the user made no link
     * between them. A claim a source made, and a hint found in text, stay and
     * are reported in `remaining`. User only.
     */
    unlink: (
      input: EntityLinkInput,
    ): Effect.Effect<EntityUnlinkResult, Unauthenticated | Forbidden | SqlError> =>
      Effect.gen(function* () {
        yield* requireUserActor("task.update", ONLY_THE_USER_LINKS);
        const now = yield* nowIso;
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const changes = yield* claims.changePersonLink({
              change: "unlink",
              fromRef: input.fromRef,
              toRef: input.toRef,
            });
            yield* entities.applyClaimChanges(changes, now);
            return {
              removed: changes.changedRefs.length > 0,
              ...(changes.remaining === undefined ? {} : { remaining: changes.remaining }),
            };
          }),
        );
      }),

    /**
     * Deletes the records nothing needs, and returns how many it deleted. The
     * daily job calls it. It is the controller's own sweep and no one's
     * request, so it checks no grant.
     */
    prune: (): Effect.Effect<PruneResult, SqlError> =>
      Effect.flatMap(nowIso, (now) => withTransaction(sql, entities.pruneEntities(now))),
  };
});

/** The External Entity operations. */
export class ExternalEntityService extends Context.Service<
  ExternalEntityService,
  Effect.Success<typeof make>
>()("hercule/controller/external-entities/ExternalEntityService") {}

export const ExternalEntityServiceLayer: Layer.Layer<
  ExternalEntityService,
  never,
  SqlClient.SqlClient | TaskService | EntityLookups | PluginHost
> = Layer.effect(ExternalEntityService)(make).pipe(Layer.provide(ExternalEntityIngestLayer));
