/**
 * The External Entity operations: the Inbox and its counts, one entity, take
 * an entity on as a Task, dismiss and restore a card, and the three that let
 * the user add a thing to Work: search the source, list suggestions, and add.
 *
 * The rules this module owns:
 *
 * - A Task for an entity is made by the Task service (`createTaskLinkedToRefs`
 *   and `undoCreatedTask`). This module never writes a Task itself.
 * - Reading a thing at its source (`EntityLookups.resolve`) takes seconds and
 *   can fail, so it never runs inside a transaction. `prepareEntityForTask`
 *   reads first, outside any transaction. The final transaction then checks
 *   everything again against the rows, because the world may have moved while
 *   the read waited, and writes the observation and the Task together.
 * - Taking on, undoing, dismissing, restoring, searching and adding are the
 *   user's own acts. A session or a run that holds the grant is refused.
 */
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createConflictError,
  createInvalidStateError,
  createNotFoundError,
  EntityBlocks,
  formatIssue,
  listDecodeIssues,
  truncateMessage,
  KnownBlock,
  MAX_ENTITY_BLOCKS,
  MAX_ENTITY_SEARCH_RESULTS,
  MAX_ENTITY_ANCESTORS,
  MAX_ENTITY_SUGGESTIONS,
  MAX_SUGGESTION_CONTEXTS,
  type Conflict,
  type EntityAddToWorkInput,
  type EntityAddToWorkResult,
  type EntityLinkInput,
  type EntityLinkResult,
  type EntityPlace,
  type EntitySearchQuery,
  type EntitySearchReply,
  type EntitySearchResult,
  type EntitySuggestion,
  type EntitySuggestions,
  type EntitySuggestionsQuery,
  type EntityTakeOnResult,
  type EntityTakeOnTogetherInput,
  type EntityTakeOnTogetherResult,
  type EntityUndoTakeOnTogetherInput,
  type EntityUndoTakeOnResult,
  type EntityUnlinkResult,
  type ExternalEntityDetail,
  type Forbidden,
  type InboxCounts,
  type InboxGroupDetail,
  type InboxOutline,
  type InboxMove,
  type InboxQuery,
  type InboxReply,
  type InboxValueQuery,
  type InboxValues,
  type InvalidState,
  type NotFound,
  type Task,
  type TaskStage,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import {
  PluginError,
  type EntityRecognition,
  type EntityMissing,
  type QualifiedEntityKindDeclaration,
} from "@hercule/plugin-host";
import { currentStamp, requireGrant, requireUserActor } from "../actor";
import { nowIso, withTransaction } from "../db";
import {
  EntityLookups,
  listAskingKinds,
  PluginHost,
  type EntityReporter,
  type LookupObservation,
  type RegisteredSavedQuery,
  type RegisteredSignalKind,
} from "../plugins";
import { resourceRepository } from "../resources";
import { Settings } from "../settings";
import {
  ONLY_THE_USER_TAKES_ON_WORK,
  TaskService,
  taskRepository,
  type TaskUndoRefusal,
} from "../tasks";
import { announceEntityChanges } from "./announce";
import { buildActiveEntityKind } from "./entity-records";
import { listEntityKindSources, type EntityKindSource } from "./workflow-offers";
import { isPendingTarget } from "./pending-target";
import { findProjectOfRemote } from "./project-of-remote";
import { claimRepository } from "./claims";
import { ExternalEntityIngest, ExternalEntityIngestLayer, prepareObservations } from "./ingest";
import { externalEntityInbox, type InboxEnvironment, type InboxRailSettings } from "./inbox-query";
import {
  externalEntityRepository,
  type EntityReadEnvironment,
  type ObservedEntity,
  type PruneResult,
  type TaskableEntity,
} from "./repository";

/**
 * Decodes the drafts a plugin read as blocks of a type the contract knows, so
 * a misspelled type is a plugin error and not a block the app cannot draw.
 * `EntityBlocks` itself accepts any type, because a newer controller may send
 * blocks an older app does not know.
 */
const decodeKnownEntityBlocks = Schema.decodeUnknownEffect(
  Schema.Struct({ blocks: Schema.Array(KnownBlock).check(Schema.isMaxLength(MAX_ENTITY_BLOCKS)) }),
);

/** How many things `takeOnTogether` prepares at once: preparing one may read it at its source. */
const MAX_CONCURRENT_PREPARATIONS = 8;

/** The message of the error `readBlocks` fails with. It names no plugin and no credential. */
const SOURCE_UNREADABLE_MESSAGE =
  "The source could not be read right now. Try again later, or open the thing at its source.";

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
  readonly kindSources: ReadonlyArray<EntityKindSource>;
  /** The signal kinds of the active plugins. */
  readonly signalKinds: ReadonlyArray<RegisteredSignalKind>;
  /** The saved queries of the active plugins, in load order. */
  readonly savedQueries: ReadonlyArray<RegisteredSavedQuery>;
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
  const inbox = yield* externalEntityInbox;
  const taskRows = yield* taskRepository;
  const tasks = yield* TaskService;
  const resources = yield* resourceRepository;
  const lookups = yield* EntityLookups;
  const ingest = yield* ExternalEntityIngest;
  const host = yield* PluginHost;
  const claims = yield* claimRepository;
  const settings = yield* Settings;

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
        kindSources: listEntityKindSources(sources),
        signalKinds: sources.flatMap((source) => source.signalKinds),
        savedQueries: sources.flatMap((source) => source.savedQueries),
      };
    },
  );

  /** Reads what the repository needs to tell whether a plugin and a kind are active, and the time. */
  const readEnvironment: Effect.Effect<EntityReadEnvironment> = Effect.gen(function* () {
    return buildReadEnvironment(yield* readCatalog, yield* nowIso);
  });

  /** Builds the read environment from a catalog already read, at the time `now`. */
  const buildReadEnvironment = (catalog: Catalog, now: string): EntityReadEnvironment => ({
    now,
    activePluginIds: catalog.activePluginIds,
    activeKinds: new Set(catalog.kinds.keys()),
    activeEntityKinds: [...catalog.kinds.values()].map(({ declaration }) =>
      buildActiveEntityKind(declaration),
    ),
    kindSources: catalog.kindSources,
    askingKinds: listAskingKinds(catalog.signalKinds),
  });

  /** Reads what the Inbox's reads need beyond the database. The catalog is read once. */
  const readInboxEnvironment: Effect.Effect<InboxEnvironment> = Effect.gen(function* () {
    const catalog = yield* readCatalog;
    return {
      ...buildReadEnvironment(catalog, yield* nowIso),
      signalKinds: catalog.signalKinds,
      savedQueries: catalog.savedQueries,
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
      const known = Option.getOrUndefined(yield* entities.readTaskableEntity({ ref }));
      return yield* prepareKnownEntityForTask(yield* readCatalog, ref, known);
    });

  /**
   * Prepares `ref` for a Task as `prepareEntityForTask` does, given the
   * `catalog` and the record the rows hold now (`known`, none when there is
   * none), so a caller that prepares many things reads them in one batch.
   */
  const prepareKnownEntityForTask = (
    catalog: Catalog,
    ref: string,
    known: TaskableEntity | undefined,
  ): Effect.Effect<Preparation, InvalidState | SqlError> =>
    Effect.gen(function* () {
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
   * Marks the active Task of `ref` as taken on by the user, now, when it was
   * made some other way (a hand-off, a session, a signal, an event), so the
   * asks raised before this moment stop asking. Changes nothing when the user
   * already took it on. Announces the entity (when its id is known) only when
   * something changed.
   *
   * Reads the active Task, marks its link and returns that same Task in one
   * transaction, so the Task marked is the Task returned. Returns none when
   * the ref has no active Task. A first read outside the transaction ends the
   * common case of no Task without taking the writer.
   */
  const markActiveTaskTakenOn = (
    ref: string,
    entityId: string | undefined,
  ): Effect.Effect<Option.Option<Task>, SqlError> =>
    Effect.flatMap(taskRows.findActiveTaskForRef(ref), (peek) =>
      Option.isNone(peek)
        ? Effect.succeed(peek)
        : markActiveTaskTakenOnInTransaction(ref, entityId),
    );

  /** Marks the active Task of `ref` as taken on, in one transaction: see `markActiveTaskTakenOn`. */
  const markActiveTaskTakenOnInTransaction = (
    ref: string,
    entityId: string | undefined,
  ): Effect.Effect<Option.Option<Task>, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const active = yield* taskRows.findActiveTaskForRef(ref);
        if (Option.isNone(active)) return active;
        const changed = yield* taskRows.markLinkTaken(
          active.value.id,
          ref,
          yield* nowIso,
          yield* currentStamp,
        );
        if (changed && entityId !== undefined) {
          yield* announceEntityChanges({ entityIds: [entityId], affectedTaskIds: [] });
        }
        return active;
      }),
    );

  /**
   * Stores what `prepareEntityForTask` read, when it read, and returns the
   * records of the things in the order of `items`, each checked again: the
   * exact ref, a full record, `access: ok` and an active kind that is not a
   * place. Fails with `Conflict` when the Connection that read a thing can no
   * longer read it, or a record no longer qualifies, so the caller repeats.
   * The records are read in one batch after the stores. Runs in the caller's
   * transaction and never resolves.
   */
  const storePreparedAndCheckEntities = (
    items: ReadonlyArray<{ readonly ref: string; readonly preparation: Preparation }>,
  ): Effect.Effect<ReadonlyArray<TaskableEntity>, Conflict | SqlError> =>
    Effect.gen(function* () {
      const catalog = yield* readCatalog;
      for (const { ref, preparation } of items) {
        if (!preparation.read) continue;
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
      const found = new Map(
        (yield* entities.readTaskableEntities({ refs: items.map((item) => item.ref) })).map(
          (record) => [record.ref, record] as const,
        ),
      );
      const checked: TaskableEntity[] = [];
      for (const { ref } of items) {
        const record = found.get(ref);
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
        checked.push(record);
      }
      return checked;
    });

  /** Stores and checks one prepared thing: see `storePreparedAndCheckEntities`. */
  const storePreparedAndCheckEntity = (
    ref: string,
    preparation: Preparation,
  ): Effect.Effect<TaskableEntity, Conflict | SqlError> =>
    Effect.map(storePreparedAndCheckEntities([{ ref, preparation }]), (records) => records[0]!);

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
        const { ref } = input;
        const record = yield* storePreparedAndCheckEntity(ref, input.preparation);
        const active = Option.getOrUndefined(yield* markActiveTaskTakenOn(ref, record.id));
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
        const projectId =
          input.projectId ?? (yield* findProjectOfRemote(resources, record.targetRemote));
        const task = yield* tasks.createTaskLinkedToRefs({
          refs: [ref],
          title: record.title,
          stage,
          ...(projectId === undefined ? {} : { projectId }),
          following: followed,
        });
        yield* announceEntityChanges({ entityIds: [record.id], affectedTaskIds: [] });
        return { entityId: record.id, taskId: task.id, created: true, stage, followed };
      }),
    );

  /**
   * Fails with `InvalidState`, naming the Tasks, when the refs have more than
   * one active Task between them. Otherwise returns the one Task they share
   * (none when no ref has a Task) and the refs that have it.
   */
  const findSharedActiveTask = (
    refs: ReadonlyArray<string>,
  ): Effect.Effect<
    { readonly taskId: string | undefined; readonly refsWithTask: ReadonlySet<string> },
    InvalidState | SqlError
  > =>
    Effect.gen(function* () {
      const active = yield* taskRows.listActiveTasksForRefs(refs);
      const distinct = [...new Map(active.map((entry) => [entry.id, entry])).values()];
      if (distinct.length > 1) {
        const names = distinct.map((entry) => `"${entry.title}" (${entry.id})`).join(", ");
        return yield* Effect.fail(
          createInvalidStateError(
            `These things are on ${String(distinct.length)} different Tasks: ${names}. They cannot be taken on together. Merge the Tasks first, or take the things on one at a time.`,
          ),
        );
      }
      return { taskId: distinct[0]?.id, refsWithTask: new Set(active.map((entry) => entry.ref)) };
    });

  /**
   * Takes the things on as one Task, in one transaction: see `takeOnTogether`.
   * Looks again for the Task they share, because the first look was outside
   * the transaction. A thing that has no Task is stored and checked as
   * `makeTaskForEntity` does, so a thing that no longer qualifies fails with
   * `Conflict`.
   */
  const makeTaskTogether = (input: {
    readonly records: Arr.NonEmptyReadonlyArray<TaskableEntity>;
    readonly preparations: ReadonlyMap<string, Preparation>;
    readonly title: string;
  }): Effect.Effect<
    EntityTakeOnTogetherResult,
    Unauthenticated | Forbidden | NotFound | InvalidState | Conflict | SqlError
  > =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const refs = Arr.map(input.records, (record) => record.ref);
        const shared = yield* findSharedActiveTask(refs);
        const unprepared = input.records.filter((record) => !shared.refsWithTask.has(record.ref));
        const stored = new Map(
          (yield* storePreparedAndCheckEntities(
            unprepared.map((record) => ({
              ref: record.ref,
              preparation: input.preparations.get(record.ref) ?? { read: false },
            })),
          )).map((record) => [record.ref, record] as const),
        );
        const checked = input.records.map((record) => stored.get(record.ref) ?? record);
        const ids = checked.map((record) => record.id);
        const first = checked[0]!;
        if (shared.taskId === undefined) {
          const projectId = yield* findProjectOfRemote(resources, first.targetRemote);
          const task = yield* tasks.createTaskLinkedToRefs({
            refs,
            title: input.title,
            stage: chooseStageForEntity(first),
            ...(projectId === undefined ? {} : { projectId }),
            following: false,
          });
          const recordId = yield* tasks.recordTakeOn({
            taskId: task.id,
            created: true,
            added: refs,
            taken: refs,
          });
          yield* announceEntityChanges({ entityIds: ids, affectedTaskIds: [] });
          return { taskId: task.id, created: true, recordId, added: ids.length, taken: ids.length };
        }
        const joined = yield* tasks.joinTaskWithRefs({ taskId: shared.taskId, refs });
        const recordId = yield* tasks.recordTakeOn({
          taskId: joined.task.id,
          created: false,
          added: joined.added,
          taken: joined.taken,
        });
        yield* announceEntityChanges({ entityIds: ids, affectedTaskIds: [] });
        return {
          taskId: joined.task.id,
          created: false,
          recordId,
          added: joined.added.length,
          taken: joined.taken.length,
        };
      }),
    );

  /**
   * Reads the entities of `ids` in one batch, in the order of `ids`, or fails
   * with `NotFound` for the first id that has no entity.
   */
  const readTaskableEntitiesOrFail = (
    ids: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<TaskableEntity>, NotFound | SqlError> =>
    Effect.gen(function* () {
      const found = new Map(
        (yield* entities.readTaskableEntities({ ids })).map(
          (record) => [record.id, record] as const,
        ),
      );
      const records: TaskableEntity[] = [];
      for (const id of ids) {
        const record = found.get(id);
        if (record === undefined)
          return yield* Effect.fail(createNotFoundError("no such external entity"));
        records.push(record);
      }
      return records;
    });

  /** Reads the entity of an id, or fails with `NotFound`. */
  const readTaskableEntityOrFail = (
    id: string,
  ): Effect.Effect<TaskableEntity, NotFound | SqlError> =>
    Effect.flatMap(entities.readTaskableEntity({ id }), (found) =>
      Option.isSome(found)
        ? Effect.succeed(found.value)
        : Effect.fail(createNotFoundError("no such external entity")),
    );

  /**
   * Sets things aside or brings them back, as the user, all or none in one
   * transaction. Announces only the things that changed. Fails with
   * `NotFound` naming an id that is unknown, and then changes nothing.
   */
  const moveThings = (
    ids: InboxMove["ids"],
    write: (
      ids: ReadonlyArray<string>,
      actor: string,
      now: string,
    ) => ReturnType<typeof entities.dismiss>,
  ): Effect.Effect<Record<string, never>, Unauthenticated | Forbidden | NotFound | SqlError> =>
    Effect.gen(function* () {
      yield* requireUserActor("task.update", ONLY_THE_USER_TAKES_ON_WORK);
      const actor = yield* currentStamp;
      const now = yield* nowIso;
      // A repeated id moves once.
      const unique = [...new Set(ids)];
      yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const result = yield* write(unique, actor, now);
          if ("missing" in result) {
            return yield* Effect.fail(
              createNotFoundError(`no such external entity: ${result.missing.join(", ")}`),
            );
          }
          const changed = result.moved.filter((entry) => entry.changed);
          if (changed.length === 0) return;
          const active = yield* taskRows.listActiveTasksForRefs(changed.map((entry) => entry.ref));
          yield* announceEntityChanges({
            entityIds: changed.map((entry) => entry.id),
            affectedTaskIds: [...new Set(active.map((task) => task.id))],
          });
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
     * Reads the Inbox in the mode `query` asks for: see `InboxQuery` and
     * `InboxReply`. Needs the grants
     * `task.read` and `signal.query`, because rows show signal text,
     * `workflow.query` and `connection.query`, because the offers name
     * workflows and accounts, and `run.query`, because a row names the
     * workflows running on its Task. Fails with `Validation` for an unknown
     * list, a clause that cannot be answered, or a cursor of another query.
     */
    queryInbox: (
      query: InboxQuery,
    ): Effect.Effect<InboxReply, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.read");
        yield* requireGrant("signal.query");
        yield* requireGrant("workflow.query");
        yield* requireGrant("connection.query");
        yield* requireGrant("run.query");
        return yield* inbox.queryInbox(yield* readInboxEnvironment, query);
      }),

    /**
     * Returns the counts of the Inbox for the sidebar: see `InboxCounts`.
     * Needs the grants `task.read` and `signal.query`.
     */
    countInbox: (): Effect.Effect<InboxCounts, Unauthenticated | Forbidden | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.read");
        yield* requireGrant("signal.query");
        return yield* inbox.countInbox(yield* readInboxEnvironment);
      }),

    /**
     * Returns what the Inbox's rail draws: see `InboxOutline`. The pins and
     * folded sources are the user's own, so a session reads the outline with
     * none pinned and every source open. Needs the grants `task.read`,
     * `signal.query` and `connection.query`, because it names accounts.
     */
    readInboxOutline: (): Effect.Effect<InboxOutline, Unauthenticated | Forbidden | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.read");
        yield* requireGrant("connection.query");
        const actor = yield* requireGrant("signal.query");
        const own: InboxRailSettings =
          actor._tag === "user"
            ? yield* Effect.map(settings.allForUser(actor.userId), (stored) => ({
                pins: stored["inbox.pins"] ?? [],
                browseFolded: stored["inbox.browseFolded"] ?? [],
              }))
            : { pins: [], browseFolded: [] };
        return yield* inbox.readInboxOutline(yield* readInboxEnvironment, own);
      }),

    /**
     * Returns the group of `ref` among the things on the Inbox, in full: see
     * `InboxGroupDetail`. Needs the grants `task.read` and `signal.query`:
     * it shows no signal text, but whether a thing is on the Inbox depends on
     * its signals, and the `NotFound` for a thing that is not would reveal
     * that, as `countInbox` would. Fails with `NotFound` when `ref` is not on
     * the Inbox.
     */
    readInboxGroup: (
      ref: string,
    ): Effect.Effect<InboxGroupDetail, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.read");
        yield* requireGrant("signal.query");
        const found = yield* inbox.readInboxGroup(yield* readInboxEnvironment, ref);
        return yield* Option.match(found, {
          onNone: () => Effect.fail(createNotFoundError("that thing is not on the Inbox")),
          onSome: Effect.succeed,
        });
      }),

    /**
     * Returns the values of one field among the things of a list, for the
     * search's suggestions. Needs the grants `task.read`, `signal.query` and
     * `connection.query`, because the values of `account` are account labels.
     */
    suggestInboxValues: (
      query: InboxValueQuery,
    ): Effect.Effect<InboxValues, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.read");
        yield* requireGrant("signal.query");
        yield* requireGrant("connection.query");
        return yield* inbox.suggestInboxValues(yield* readInboxEnvironment, query);
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
     * Reads, from the source, the blocks the Inbox pane draws for one entity,
     * at most 8, and returns them in order. They are read when asked and never
     * stored. Needs the grants `task.read` and `signal.query`, because blocks
     * are body parts like a signal's. Fails with `NotFound` for an unknown id,
     * a partial record or a place, as `read` does.
     *
     * Answers no blocks when the plugin of the entity's kind is not active or
     * offers none. Fails with `InvalidState` (reason `source-unreadable`)
     * when no Connection could read the source, or the plugin answered
     * blocks of a type the contract does not know. The message is the same safe
     * sentence for every cause; the cause goes to the controller's log.
     */
    readBlocks: (
      id: string,
    ): Effect.Effect<
      EntityBlocks,
      Unauthenticated | Forbidden | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("task.read");
        yield* requireGrant("signal.query");
        const record = yield* readTaskableEntityOrFail(id);
        if (!record.isWorkRecord)
          return yield* Effect.fail(createNotFoundError("no such external entity"));
        const owner = (yield* readCatalog).kinds.get(record.kind);
        if (owner === undefined) return { blocks: [] };
        const unreadable = createInvalidStateError(SOURCE_UNREADABLE_MESSAGE, {
          reason: "source-unreadable",
        });
        const outcome = yield* lookups.readBlocks(
          owner.pluginId,
          record.ref,
          yield* entities.listObservingConnectionIds(record.ref),
        );
        if ("unreadable" in outcome) {
          yield* Effect.logWarning(`No Connection could read the blocks of ${record.ref}.`);
          return yield* Effect.fail(unreadable);
        }
        return yield* Effect.catch(decodeKnownEntityBlocks({ blocks: outcome.blocks }), (error) =>
          Effect.andThen(
            // Only where the value failed (path and message), never the value itself.
            Effect.logWarning(
              `The plugin ${owner.pluginId} returned blocks for ${record.ref} that the contract does not accept: ${truncateMessage(listDecodeIssues(error).map(formatIssue).join("; "))}`,
            ),
            Effect.fail(unreadable),
          ),
        );
      }),

    /**
     * Returns the active Task of the entity, or makes one, and says which.
     * It is idempotent: a second click, or a second account, gets the same
     * Task. A Task that something else made (a hand-off, a session, a signal)
     * is marked as taken on by the user, so the asks raised so far stop asking
     * (`created` is false then). A new Task has the entity's title, the stage its status declares
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
        const active = yield* markActiveTaskTakenOn(record.ref, record.id);
        if (Option.isSome(active)) {
          return { taskId: active.value.id, created: false };
        }
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
            const outcome = yield* tasks.undoCreatedTask(taskId, [record.ref]);
            if (!outcome.undone) {
              return { undone: false, reason: describeUndoRefusal(outcome.reason) };
            }
            yield* announceEntityChanges({ entityIds: [id], affectedTaskIds: [] });
            return { undone: true };
          }),
        );
      }),

    /**
     * Takes several things on as one piece of work, in one Task.
     *
     * - No thing has an active Task: makes one Task with `title`, linked to
     *   every thing, with the stage and the Project that `takeOn` would give
     *   the first thing.
     * - The things that have an active Task all share the same one: links the
     *   others to it.
     * - Either way, marks every link as taken on by the user, as `takeOn` does
     *   for one thing.
     * - Things on two or more different Tasks fail `InvalidState`, naming the
     *   Tasks.
     *
     * The call stores a record of what it wrote, in the same transaction, and
     * the reply names it (`recordId`) so `undoTakeOnTogether` can take exactly
     * that back. Fails with `NotFound` for an unknown id,
     * `InvalidState` for the same thing twice, a place or a thing that could
     * not be read, and `Conflict` when a thing changed while the Task was being
     * made and the call should be repeated. User only.
     */
    takeOnTogether: (
      input: EntityTakeOnTogetherInput,
    ): Effect.Effect<
      EntityTakeOnTogetherResult,
      Unauthenticated | Forbidden | NotFound | InvalidState | Conflict | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireUserActor("task.update", ONLY_THE_USER_TAKES_ON_WORK);
        const records = yield* readTaskableEntitiesOrFail(input.ids);
        if (!Arr.isReadonlyArrayNonEmpty(records) || new Set(input.ids).size !== input.ids.length) {
          return yield* Effect.fail(
            createInvalidStateError(
              "the same thing is named twice; name each thing once to take them on together",
            ),
          );
        }
        const shared = yield* findSharedActiveTask(records.map((record) => record.ref));
        const catalog = yield* readCatalog;
        // Preparing a thing may read it at its source, so the things that need
        // it are prepared a few at a time, not all at once and not one by one.
        const needing = records.filter((record) => !shared.refsWithTask.has(record.ref));
        const prepared = yield* Effect.forEach(
          needing,
          (record) => prepareKnownEntityForTask(catalog, record.ref, record),
          { concurrency: MAX_CONCURRENT_PREPARATIONS },
        );
        const preparations = new Map(
          needing.map((record, n) => [record.ref, prepared[n]!] as const),
        );
        return yield* makeTaskTogether({ records, preparations, title: input.title });
      }),

    /**
     * Takes back the `takeOnTogether` call that wrote the record `recordId`,
     * as far as is safe.
     *
     * - A Task the call made is deleted when nothing was added to it since
     *   (see `TaskService.undoCreatedTask`).
     * - For a Task the call joined, the links it added are removed and the
     *   taken mark it set on the other links is cleared, only while every one
     *   of those links still holds the time the record has (see
     *   `TaskService.reverseTakeOn`).
     *
     * Otherwise changes nothing and says why in a sentence. A call that wrote
     * nothing has nothing to undo, and says so. A refusal is not
     * stored, so a later call looks at the rows again. Once the call has been
     * taken back, a repeat returns `{ undone: true }` and changes nothing.
     * Fails with `NotFound` for an unknown record id. User only.
     */
    undoTakeOnTogether: (
      input: EntityUndoTakeOnTogetherInput,
    ): Effect.Effect<EntityUndoTakeOnResult, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireUserActor("task.update", ONLY_THE_USER_TAKES_ON_WORK);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const found = yield* tasks.readTakeOnRecord(input.recordId);
            if (Option.isNone(found)) {
              return yield* Effect.fail(createNotFoundError("no such take-on record"));
            }
            const record = found.value;
            if (record.undo !== undefined) return record.undo;
            if (record.linksAdded.length === 0 && record.marksTaken.length === 0) {
              return { undone: false, reason: "Nothing was written, so there is nothing to undo." };
            }
            const outcome = yield* tasks.reverseTakeOn(record);
            if (!outcome.undone) {
              return {
                undone: false,
                reason:
                  outcome.reason === "link-changed"
                    ? "A link was changed since, so the Task stays as it is."
                    : describeUndoRefusal(outcome.reason),
              };
            }
            const undone = { undone: true } as const;
            yield* tasks.storeTakeOnUndo(record.id, undone);
            return undone;
          }),
        );
      }),

    /**
     * Takes things off the Inbox, as the user, all or none. An ask raised on
     * one of them after this call brings it back. Fails with `NotFound` for
     * an unknown id. Dismissing a dismissed thing changes nothing. User only.
     */
    dismiss: (
      move: InboxMove,
    ): Effect.Effect<Record<string, never>, Unauthenticated | Forbidden | NotFound | SqlError> =>
      moveThings(move.ids, entities.dismiss),

    /** Brings dismissed things back, all or none. Fails with `NotFound` for an unknown id. User only. */
    restore: (
      move: InboxMove,
    ): Effect.Effect<Record<string, never>, Unauthenticated | Forbidden | NotFound | SqlError> =>
      moveThings(move.ids, entities.restore),

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
          askingKinds: environment.askingKinds,
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
        const known = Option.getOrUndefined(yield* entities.readTaskableEntity({ ref: input.ref }));
        const active = yield* markActiveTaskTakenOn(input.ref, known?.id);
        if (Option.isSome(active)) {
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
     * Links one thing to each of several as the user's own claims (`person`
     * claims, stamped with the user), in one transaction, and announces the
     * changed things once. A target may be a ref nobody has read: the next
     * refresh reads it. The source is never told. Returns `created`, the
     * targets whose claim this call wrote, in the order of `toRefs`. A target
     * the user already linked to `fromRef`, in either direction, changes
     * nothing and is left out.
     *
     * The whole input is checked before anything is written. Fails with
     * `InvalidState` when a target is `fromRef` itself, is given twice, or
     * when a ref is not a ref, and with `NotFound` when Hercule holds no
     * record of `fromRef`. Then nothing changes. User only.
     */
    link: (
      input: EntityLinkInput,
    ): Effect.Effect<
      EntityLinkResult,
      Unauthenticated | Forbidden | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireUserActor("task.update", ONLY_THE_USER_LINKS);
        const { fromRef, toRefs } = input;
        const notARef = [fromRef, ...toRefs].find(isPendingTarget);
        if (notARef !== undefined) {
          return yield* Effect.fail(
            createInvalidStateError(
              `${notARef} is not a ref: "unresolved:" is reserved for the core's own use. Use the ref of the thing.`,
            ),
          );
        }
        if (toRefs.includes(fromRef)) {
          return yield* Effect.fail(
            createInvalidStateError(
              `${fromRef} cannot be linked to itself. Link it to another thing.`,
            ),
          );
        }
        if (new Set(toRefs).size !== toRefs.length) {
          return yield* Effect.fail(
            createInvalidStateError("the same thing is named twice; name each thing once to link"),
          );
        }
        const actor = yield* currentStamp;
        const now = yield* nowIso;
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const changes = yield* claims.changePersonLink({
              change: "link",
              fromRef,
              toRefs,
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
            return {
              created: changes.pairs.filter((pair) => pair.changed).map((pair) => pair.toRef),
            };
          }),
        );
      }),

    /**
     * Removes the user's own claims between one thing and each of several, in
     * either direction, in one transaction, and returns one entry per target
     * in the order of `toRefs`: `removed` is false when the user made no link
     * between the two, and `remaining` is the firmest claim still joining
     * them. A claim a source made, and a hint found in text, stay. Fails with
     * `InvalidState` when a target is given twice. User only.
     */
    unlink: (
      input: EntityLinkInput,
    ): Effect.Effect<EntityUnlinkResult, Unauthenticated | Forbidden | InvalidState | SqlError> =>
      Effect.gen(function* () {
        yield* requireUserActor("task.update", ONLY_THE_USER_LINKS);
        if (new Set(input.toRefs).size !== input.toRefs.length) {
          return yield* Effect.fail(
            createInvalidStateError(
              "the same thing is named twice; name each thing once to unlink",
            ),
          );
        }
        const now = yield* nowIso;
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const changes = yield* claims.changePersonLink({
              change: "unlink",
              fromRef: input.fromRef,
              toRefs: input.toRefs,
            });
            yield* entities.applyClaimChanges(changes, now);
            return {
              results: changes.pairs.map((pair) => ({
                toRef: pair.toRef,
                removed: pair.changed,
                ...(pair.remaining === undefined ? {} : { remaining: pair.remaining }),
              })),
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
  SqlClient.SqlClient | TaskService | EntityLookups | PluginHost | Settings
> = Layer.effect(ExternalEntityService)(make).pipe(Layer.provide(ExternalEntityIngestLayer));
