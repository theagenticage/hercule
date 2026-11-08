/**
 * Takes what a plugin's poll read of External Entities and stores it.
 *
 * A plugin is untrusted input: the service checks the whole call before it
 * writes anything, renders the slots of every observation with the kind's
 * declaration, then writes in one transaction and announces what changed once
 * that transaction commits. A call that breaks a rule is refused whole, with a
 * `PluginError` that says what was wrong, so a failed poll stores nothing.
 *
 * A write that changes what a Task counts of a thing it links also writes the
 * Task's facts, in the same transaction (see `recordingEntityFacts`).
 *
 * The plugins domain cannot import this one (it declares the Entity
 * Observations port instead), so the host passes the reporter, with the kind
 * declarations of its plugin, into every call.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { ExternalRef, formatIssue, listDecodeIssues, truncateMessage } from "@hercule/contract";
import {
  EntityObservation,
  MAX_ENTITY_OBSERVATIONS,
  PluginError,
  type EntityInventory,
  type QualifiedEntityKindDeclaration,
} from "@hercule/plugin-host";
import { assertConnectionIngesting, canConnectionPoll, connectionRepository } from "../connections";
import { announce, nowIso, withTransaction } from "../db";
import {
  buildRecognizedTarget,
  findUrlTarget,
  type EntityReporter,
  type RecognizedTarget,
  type RecognizeText,
} from "../plugins";
import { TaskService } from "../tasks";
import { announceEntityChanges } from "./announce";
import {
  buildConflictWarning,
  buildIncompleteWarning,
  decideConnectionWarning,
} from "./connection-warning";
import { claimRepository, type RecognizedEvidence } from "./claims";
import { isPendingTarget } from "./pending-target";
import {
  externalEntityRepository,
  type EntityEnvironment,
  type ObservedEntity,
} from "./repository";
import { renderEntitySlots, type EntitySlots, type FullEntityObservation } from "./slots";

/** How many problems of a failed decode a message lists. The rest would only hide the first ones. */
const MAX_LISTED_ISSUES = 5;

/** The observation fields that hold a time, which the core stores as UTC with milliseconds. */
const TIME_FIELDS = ["sourceUpdatedAt", "waitingSince", "targetDate", "createdAt"] as const;

const decodeObservations = Schema.decodeUnknownEffect(Schema.Array(EntityObservation), {
  errors: "all",
});

const decodeRef = Schema.decodeUnknownEffect(ExternalRef);

const refuse = (message: string): PluginError =>
  new PluginError({ message: truncateMessage(message) });

/** Returns the declaration of an unqualified kind word of the reporter's plugin, or undefined. */
const findDeclaration = (
  reporter: EntityReporter,
  kind: string,
): QualifiedEntityKindDeclaration | undefined =>
  reporter.kinds.find((declaration) => declaration.word === `${reporter.pluginId}/${kind}`);

/**
 * Returns the observation with each of its time fields converted to UTC with
 * milliseconds, the one format the database compares as text. Fails with a
 * `PluginError` when a time matches the ISO 8601 pattern but is not a real
 * moment, such as month 13.
 */
const normalizeTimes = (
  observation: EntityObservation,
): Effect.Effect<EntityObservation, PluginError> =>
  Effect.gen(function* () {
    const fields: Readonly<Record<string, unknown>> = observation;
    const normalized: Record<string, string> = {};
    for (const field of TIME_FIELDS) {
      const value = fields[field];
      if (typeof value !== "string") continue;
      const moment = Date.parse(value);
      if (Number.isNaN(moment)) {
        return yield* Effect.fail(
          refuse(`${observation.ref}: ${field} "${value}" is not a real date and time.`),
        );
      }
      normalized[field] = new Date(moment).toISOString();
    }
    return { ...observation, ...normalized };
  });

/**
 * Renders the slots of one observation. A full observation renders with its
 * kind's declaration. A partial one carries only a title, so it gets the
 * place-shaped slots (noun, caption, home, section and status), which is what
 * the repository stores from a partial record: its kind is rendered as a
 * place, with no fields.
 */
const renderObservationSlots = (
  declaration: QualifiedEntityKindDeclaration,
  observation: EntityObservation,
): Effect.Effect<EntitySlots, PluginError> => {
  if (observation.partial !== true) return renderEntitySlots(declaration, observation);
  const asPlace: FullEntityObservation = {
    kind: observation.kind,
    ref: observation.ref,
    title: observation.title,
    ...(observation.status === undefined ? {} : { status: observation.status }),
    fields: {},
    concerns: [],
    sourceUpdatedAt: "",
  };
  return renderEntitySlots({ ...declaration, pace: "context" }, asPlace);
};

/** Fails with a `PluginError` when a full observation breaks a rule of its kind that the schema cannot state. */
const assertFullObservationFits = (
  declaration: QualifiedEntityKindDeclaration,
  observation: FullEntityObservation,
): Effect.Effect<void, PluginError> => {
  const where = `${declaration.word} ${observation.ref}`;
  if (observation.concerns.includes("following")) {
    return Effect.fail(
      refuse(
        `${where}: the concern "following" is set by the core, from a Task that follows the thing. A plugin cannot report it, so leave it out.`,
      ),
    );
  }
  if (declaration.pace === "context") {
    return observation.concerns.length === 0
      ? Effect.void
      : Effect.fail(
          refuse(
            `${where}: ${declaration.word} is a place, and a place concerns no one. Report it with an empty concerns list.`,
          ),
        );
  }
  const missing = [
    ...(observation.url === undefined ? ["url"] : []),
    ...(observation.lifecycle === undefined ? ["lifecycle"] : []),
  ];
  return missing.length === 0
    ? Effect.void
    : Effect.fail(
        refuse(
          `${where}: a full observation of a kind with cards needs ${missing.join(" and ")}. Report a partial observation if only the title is known.`,
        ),
      );
};

/**
 * Checks every observation against the reporter's declarations and returns
 * them ready to store: decoded, with times normalized and slots rendered.
 * `onlyKind`, when given, is the one unqualified kind they must all have.
 * Fails with a `PluginError`, naming the first thing wrong, when:
 *
 * - there are more than `MAX_ENTITY_OBSERVATIONS`;
 * - an observation does not match the observation schema (an oversized field,
 *   for example);
 * - a kind is not declared by the plugin, or is not `onlyKind`;
 * - a ref does not start with the `refPrefix` of its kind, or appears twice;
 * - a parent or peer in `relations` starts with `unresolved:`, which is reserved
 *   for the core's own pending targets;
 * - a full observation breaks `assertFullObservationFits`;
 * - the slots cannot be rendered.
 */
export const prepareObservations = (
  reporter: EntityReporter,
  input: ReadonlyArray<unknown>,
  onlyKind?: string,
): Effect.Effect<ReadonlyArray<ObservedEntity>, PluginError> =>
  Effect.gen(function* () {
    if (input.length > MAX_ENTITY_OBSERVATIONS) {
      return yield* Effect.fail(
        refuse(
          `${input.length} observations is more than the limit of ${MAX_ENTITY_OBSERVATIONS} in one call. Report fewer, or report only what concerns the user.`,
        ),
      );
    }
    const observations = yield* Effect.mapError(decodeObservations(input), (error) =>
      refuse(
        `the observations are invalid: ${listDecodeIssues(error)
          .slice(0, MAX_LISTED_ISSUES)
          .map(formatIssue)
          .join("; ")}`,
      ),
    );
    const seen = new Set<string>();
    const prepared: Array<ObservedEntity> = [];
    for (const decoded of observations) {
      const declaration = findDeclaration(reporter, decoded.kind);
      if (declaration === undefined) {
        return yield* Effect.fail(
          refuse(
            `${decoded.ref}: the plugin ${reporter.pluginId} did not declare the entity kind "${decoded.kind}". Add it to the entityKinds of the event source.`,
          ),
        );
      }
      if (onlyKind !== undefined && decoded.kind !== onlyKind) {
        return yield* Effect.fail(
          refuse(
            `${decoded.ref}: this is a "${decoded.kind}", but the inventory is of "${onlyKind}". Report other kinds in their own call, or with refresh.`,
          ),
        );
      }
      if (!decoded.ref.startsWith(declaration.refPrefix)) {
        return yield* Effect.fail(
          refuse(
            `${decoded.ref}: a ${declaration.word} ref must start with "${declaration.refPrefix}".`,
          ),
        );
      }
      if (seen.has(decoded.ref)) {
        return yield* Effect.fail(
          refuse(`${decoded.ref}: the ref appears twice. Report each thing once.`),
        );
      }
      seen.add(decoded.ref);
      const pendingRef = [
        ...(decoded.relations?.partOf ?? []),
        ...(decoded.relations?.linked ?? []),
      ].find(isPendingTarget);
      if (pendingRef !== undefined) {
        return yield* Effect.fail(
          refuse(
            `${decoded.ref}: "${pendingRef}" is not a ref. The prefix "unresolved:" is reserved for the core's own use. Report a web address in relations.linkedUrls instead.`,
          ),
        );
      }
      if (decoded.partial !== true) yield* assertFullObservationFits(declaration, decoded);
      const observation = yield* normalizeTimes(decoded);
      const slots = yield* renderObservationSlots(declaration, observation);
      prepared.push({ kind: declaration.word, observation, slots });
    }
    return prepared;
  });

/** The most things one text may name. The rest of the text is not searched for more. */
const MAX_TARGETS_PER_TEXT = 20;

const buildTargetKey = (target: RecognizedTarget): string =>
  target.recognized === "ref"
    ? `ref\u0000${target.ref}`
    : JSON.stringify([target.pluginId, target.kind, target.scopeHint, target.identifier]);

/**
 * Recognizes the web addresses and texts of prepared observations over the
 * plugins behind `recognize`, and returns the observations with the result
 * attached (`ObservedEntity.recognized`). Observations that carry neither are
 * returned as they are.
 *
 * - A web address is given the first recognition with `form: "url"` among the
 *   active plugins, in registry order. No such recognition leaves it out.
 * - A text is given every thing any plugin recognizes in it, each once, at
 *   most `MAX_TARGETS_PER_TEXT`.
 * - The same address or text is recognized once per call, however many
 *   observations carry it.
 * - A text with a `revision` is not searched when the stored claims of its
 *   `evidenceKey` were made from the same revision (`readStoredRevisions`,
 *   called once for the whole call). It is marked `"unchanged"` and its claims
 *   stay as they are, even when the plugin that found them is disabled now.
 *
 * Run it after `prepareObservations`, so every address and text is within the
 * bounds, and outside the transaction: recognition is pure but may take as
 * many calls as the call has texts.
 */
const recognizeEvidence = (
  observed: ReadonlyArray<ObservedEntity>,
  recognize: RecognizeText,
  readStoredRevisions: (
    refs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyMap<string, string>>>,
): Effect.Effect<ReadonlyArray<ObservedEntity>> =>
  Effect.gen(function* () {
    const carriers = observed.filter(
      ({ observation }) =>
        (observation.relations?.linkedUrls?.length ?? 0) > 0 ||
        (observation.texts?.length ?? 0) > 0,
    );
    if (carriers.length === 0) return observed;

    const refsWithRevisions = carriers
      .filter(({ observation }) =>
        observation.texts?.some(({ revision }) => revision !== undefined),
      )
      .map(({ observation }) => observation.ref);
    const storedRevisions =
      refsWithRevisions.length === 0
        ? new Map<string, ReadonlyMap<string, string>>()
        : yield* readStoredRevisions(refsWithRevisions);

    const urlTargets = new Map<string, RecognizedTarget | undefined>();
    const textTargets = new Map<string, ReadonlyArray<RecognizedTarget>>();
    const recognizeUrl = (url: string) =>
      Effect.gen(function* () {
        if (urlTargets.has(url)) return urlTargets.get(url);
        const target = findUrlTarget(yield* recognize(url));
        urlTargets.set(url, target);
        return target;
      });
    const recognizeText = (text: string) =>
      Effect.gen(function* () {
        const known = textTargets.get(text);
        if (known !== undefined) return known;
        const targets = new Map<string, RecognizedTarget>();
        for (const recognition of yield* recognize(text)) {
          const target = buildRecognizedTarget(recognition);
          if (target !== undefined) targets.set(buildTargetKey(target), target);
          if (targets.size === MAX_TARGETS_PER_TEXT) break;
        }
        const list = [...targets.values()];
        textTargets.set(text, list);
        return list;
      });

    const recognizedByRef = new Map<string, RecognizedEvidence>();
    for (const { observation } of carriers) {
      const urls = new Map<string, RecognizedTarget>();
      for (const url of new Set(observation.relations?.linkedUrls ?? [])) {
        const target = yield* recognizeUrl(url);
        if (target !== undefined) urls.set(url, target);
      }
      const texts = new Map<string, ReadonlyArray<RecognizedTarget> | "unchanged">();
      for (const { evidenceKey, text, revision } of observation.texts ?? []) {
        if (texts.has(evidenceKey)) continue;
        const unchanged =
          revision !== undefined &&
          storedRevisions.get(observation.ref)?.get(evidenceKey) === revision;
        texts.set(evidenceKey, unchanged ? "unchanged" : yield* recognizeText(text));
      }
      recognizedByRef.set(observation.ref, { urlTargets: urls, textTargets: texts });
    }
    return observed.map((entry) => {
      const recognized = recognizedByRef.get(entry.observation.ref);
      return recognized === undefined ? entry : { ...entry, recognized };
    });
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* externalEntityRepository;
  const claims = yield* claimRepository;
  const connections = yield* connectionRepository;
  const tasks = yield* TaskService;

  /**
   * Runs `write`, which changes what is stored of `refs`, and records the
   * facts that change makes about the things Tasks link (a lifecycle change,
   * a first sight of a linked ref, a change of access that changes what a Task
   * counts). The repository stays SQL: the rules live in the Task service.
   *
   * Call it inside the transaction of the write. The snapshot costs one
   * statement when no live Task links any of `refs`, which is the usual poll.
   */
  const recordingEntityFacts = <A, E>(
    refs: ReadonlyArray<string>,
    write: Effect.Effect<A, E | SqlError>,
  ): Effect.Effect<A, E | SqlError> =>
    Effect.gen(function* () {
      const snapshot = yield* tasks.snapshotLinkedEntities(refs);
      const written = yield* write;
      yield* tasks.recordEntityFacts(snapshot);
      return written;
    });

  /**
   * Runs `write` in one transaction on behalf of the reporter's Connection,
   * and records the announcements it returns. Dies with
   * `ConnectionNotIngesting` when the Connection was deleted or left the
   * ingesting statuses, so nothing is written after a delete or a disable has
   * committed. A database failure is a defect.
   */
  const writeAsReporter = <A>(
    reporter: EntityReporter,
    write: (environment: EntityEnvironment) => Effect.Effect<A, PluginError | SqlError>,
  ): Effect.Effect<A, PluginError> =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      // Only this plugin's own Connections observe its refs, so its being
      // active (it is polling) is all the repository needs to know.
      const environment: EntityEnvironment = { now, activePluginIds: [reporter.pluginId] };
      return yield* withTransaction(
        sql,
        Effect.andThen(assertConnectionIngesting(sql, reporter.connectionId), write(environment)),
      );
    }).pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));

  /**
   * Attaches what the plugins recognize in the addresses and texts of
   * `observed` (see `recognizeEvidence`), reading the stored text revisions
   * with one statement of its own. A database failure is a defect. Returns
   * `observed` as it is when there is no recognizer.
   */
  const recognizeObserved = (
    reporter: EntityReporter,
    observed: ReadonlyArray<ObservedEntity>,
    recognize: RecognizeText | undefined,
  ): Effect.Effect<ReadonlyArray<ObservedEntity>> =>
    recognize === undefined
      ? Effect.succeed(observed)
      : recognizeEvidence(observed, recognize, (refs) =>
          Effect.orDie(claims.readStoredTextRevisions(reporter.connectionId, refs)),
        );

  /**
   * Stores observations as a refresh does (see `repository.refresh`) and
   * announces what changed. Both a poll and a user's lookup store a read this
   * way. Call it inside the transaction that guards the Connection.
   */
  const refreshAndAnnounce = (
    connectionId: string,
    observed: ReadonlyArray<ObservedEntity>,
    environment: EntityEnvironment,
  ) =>
    Effect.flatMap(
      recordingEntityFacts(
        observed.map(({ observation }) => observation.ref),
        repository.refresh({ connectionId, observed, environment }),
      ),
      announceEntityChanges,
    );

  /**
   * Brings the Connection's one warning in line with what the read of `kind`
   * left unresolved (`wanted`, or nothing). Returns whether the warning
   * changed.
   */
  const syncConnectionWarning = (input: {
    readonly connectionId: string;
    readonly kind: string;
    readonly wanted: string | undefined;
    readonly now: string;
  }): Effect.Effect<boolean, SqlError> =>
    Effect.gen(function* () {
      const found = yield* connections.one(input.connectionId);
      if (Option.isNone(found)) return false;
      const recorded = yield* repository.recordUnresolvedKind(input);
      const warning = decideConnectionWarning({
        current: found.value.warning,
        kind: input.kind,
        ...recorded,
      });
      if (warning === undefined) return false;
      yield* connections.update(input.connectionId, { warning }, input.now);
      return true;
    });

  return {
    /**
     * Replaces what the Connection says about one kind, in one transaction.
     * `inventory.kind` and the kinds of its observations are unqualified words
     * of the reporter's plugin. See `prepareObservations` for what is refused.
     * Nothing is written when the call is refused.
     */
    reconcile: (
      reporter: EntityReporter,
      inventory: EntityInventory,
      recognize?: RecognizeText,
    ): Effect.Effect<void, PluginError> =>
      Effect.gen(function* () {
        const declaration = findDeclaration(reporter, inventory.kind);
        if (declaration === undefined) {
          return yield* Effect.fail(
            refuse(
              `the plugin ${reporter.pluginId} did not declare the entity kind "${inventory.kind}". Add it to the entityKinds of the event source.`,
            ),
          );
        }
        const observed = yield* recognizeObserved(
          reporter,
          yield* prepareObservations(reporter, inventory.observations, inventory.kind),
          recognize,
        );
        yield* writeAsReporter(reporter, (environment) =>
          Effect.gen(function* () {
            const changes = yield* recordingEntityFacts(
              observed.map((entry) => entry.observation.ref),
              repository.reconcile({
                connectionId: reporter.connectionId,
                kind: declaration.word,
                complete: inventory.complete,
                observed,
                actor: `plugin:${reporter.pluginId}`,
                environment,
              }),
            );
            const warningChanged = yield* syncConnectionWarning({
              connectionId: reporter.connectionId,
              kind: declaration.word,
              wanted: !inventory.complete
                ? buildIncompleteWarning(declaration.word)
                : changes.conflicts.length > 0
                  ? buildConflictWarning(declaration.word)
                  : undefined,
              now: environment.now,
            });
            yield* announceEntityChanges(changes);
            if (warningChanged) {
              yield* announce({
                _tag: "record",
                topic: "connection",
                id: reporter.connectionId,
                kind: "updated",
              });
            }
          }),
        );
      }),

    /** Updates what is known of entities without touching any concern. Refuses like `reconcile`. */
    refresh: (
      reporter: EntityReporter,
      observations: ReadonlyArray<EntityObservation>,
      recognize?: RecognizeText,
    ): Effect.Effect<void, PluginError> =>
      Effect.gen(function* () {
        const observed = yield* recognizeObserved(
          reporter,
          yield* prepareObservations(reporter, observations),
          recognize,
        );
        yield* writeAsReporter(reporter, (environment) =>
          refreshAndAnnounce(reporter.connectionId, observed, environment),
        );
      }),

    /**
     * Stores one thing that a user's lookup read, as a poll's `refresh` would,
     * and announces what changed. Call it inside the caller's transaction.
     * The thing is already prepared (see `prepareObservations`), because
     * preparing it needs no transaction.
     *
     * Returns false, and writes nothing, when the Connection that read the
     * thing can no longer poll (it was deleted or disabled, or its plugin
     * stopped), so the caller can tell the user to try again. This is an
     * answer, not a defect as in a poll: the user is waiting for it.
     */
    storeRead: (input: {
      readonly connectionId: string;
      readonly observed: ObservedEntity;
      readonly activePluginIds: ReadonlyArray<string>;
    }): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        const connection = Option.getOrUndefined(yield* connections.one(input.connectionId));
        if (
          connection === undefined ||
          !canConnectionPoll(connection.status, input.activePluginIds.includes(connection.pluginId))
        ) {
          return false;
        }
        const now = yield* nowIso;
        yield* refreshAndAnnounce(input.connectionId, [input.observed], {
          now,
          activePluginIds: input.activePluginIds,
        });
        return true;
      }),

    /**
     * Returns up to `limit` refs of the unqualified kind that the Connection
     * should read now, and marks them as tried. Announces nothing. Fails with
     * a `PluginError` when the plugin did not declare the kind.
     */
    listWanted: (
      reporter: EntityReporter,
      kind: string,
      limit: number,
    ): Effect.Effect<ReadonlyArray<string>, PluginError> =>
      Effect.gen(function* () {
        const declaration = findDeclaration(reporter, kind);
        if (declaration === undefined) {
          return yield* Effect.fail(
            refuse(
              `the plugin ${reporter.pluginId} did not declare the entity kind "${kind}". Add it to the entityKinds of the event source.`,
            ),
          );
        }
        // SQLite reads a negative LIMIT as no limit at all.
        const wanted = Math.min(Math.max(Math.floor(limit), 0), MAX_ENTITY_OBSERVATIONS);
        return yield* writeAsReporter(reporter, ({ now }) =>
          repository.listWanted({
            connectionId: reporter.connectionId,
            refPrefix: declaration.refPrefix,
            limit: wanted,
            now,
            // A place has no card, so a signal on one stays on its own.
            includesSignalRefs: declaration.pace !== "context",
          }),
        );
      }),

    /**
     * Records that the Connection could not read a ref. Fails with a
     * `PluginError` when the ref is not valid or no kind of the plugin owns
     * it.
     */
    reportMissing: (
      reporter: EntityReporter,
      ref: string,
      reason: "inaccessible" | "deleted",
    ): Effect.Effect<void, PluginError> =>
      Effect.gen(function* () {
        yield* Effect.mapError(decodeRef(ref), (error) =>
          refuse(`the ref is invalid: ${listDecodeIssues(error).map(formatIssue).join("; ")}`),
        );
        if (!reporter.kinds.some((declaration) => ref.startsWith(declaration.refPrefix))) {
          return yield* Effect.fail(
            refuse(
              `${ref}: no entity kind of the plugin ${reporter.pluginId} owns this ref. A ref starts with the refPrefix of its kind.`,
            ),
          );
        }
        yield* writeAsReporter(reporter, (environment) =>
          Effect.gen(function* () {
            const changes = yield* recordingEntityFacts(
              [ref],
              repository.reportMissing({
                connectionId: reporter.connectionId,
                ref,
                reason,
                environment,
              }),
            );
            yield* announceEntityChanges(changes);
          }),
        );
      }),
  };
});

/** Stores what a plugin's poll read of External Entities, and records the facts that the change makes about the things Tasks link. Used only by the Entity Observations port. */
export class ExternalEntityIngest extends Context.Service<
  ExternalEntityIngest,
  Effect.Success<typeof make>
>()("hercule/controller/external-entities/ExternalEntityIngest") {}

export const ExternalEntityIngestLayer: Layer.Layer<
  ExternalEntityIngest,
  never,
  SqlClient.SqlClient | TaskService
> = Layer.effect(ExternalEntityIngest)(make);
