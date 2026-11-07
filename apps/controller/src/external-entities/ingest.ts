/**
 * Takes what a plugin's poll read of External Entities and stores it.
 *
 * A plugin is untrusted input: the service checks the whole call before it
 * writes anything, renders the slots of every observation with the kind's
 * declaration, then writes in one transaction and announces what changed once
 * that transaction commits. A call that breaks a rule is refused whole, with a
 * `PluginError` that says what was wrong, so a failed poll stores nothing.
 *
 * The plugins domain cannot import this one (it declares the Entity
 * Observations port instead), so the host passes the reporter, with the kind
 * declarations of its plugin, into every call.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import { assertConnectionIngesting } from "../connections";
import { announce, nowIso, withTransaction } from "../db";
import type { EntityReporter } from "../plugins";
import { announceEntityChanges } from "./announce";
import {
  externalEntityRepository,
  type EntityEnvironment,
  type EntityWriteChanges,
  type InvalidInventory,
  type ObservedEntity,
} from "./repository";
import { renderEntitySlots, type EntitySlots, type FullEntityObservation } from "./slots";

/** How many problems of a failed decode a message lists. The rest would only hide the first ones. */
const MAX_LISTED_ISSUES = 5;

/** The observation fields that hold a time, which the core stores as UTC with milliseconds. */
const TIME_FIELDS = ["sourceUpdatedAt", "waitingSince", "targetDate"] as const;

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
      if (decoded.partial !== true) yield* assertFullObservationFits(declaration, decoded);
      const observation = yield* normalizeTimes(decoded);
      const slots = yield* renderObservationSlots(declaration, observation);
      prepared.push({ kind: declaration.word, observation, slots });
    }
    return prepared;
  });

/** Turns the repository's refusal of a duplicate ref into the plugin's error. */
const refuseInvalidInventory = (error: InvalidInventory): Effect.Effect<never, PluginError> =>
  Effect.fail(refuse(error.message));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* externalEntityRepository;

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

  /** Records the announcements of a write: the changed entities and Tasks, and the Connection when its warning changed. */
  const announceWrite = (connectionId: string, changes: EntityWriteChanges) =>
    Effect.gen(function* () {
      yield* Effect.provideService(
        announceEntityChanges({
          changedRefs: [...new Set([...changes.changedRefs, ...changes.relationChangedRefs])],
          affectedTaskIds: changes.affectedTaskIds,
        }),
        SqlClient.SqlClient,
        sql,
      );
      if (changes.warningChanged) {
        yield* announce({ _tag: "record", topic: "connection", id: connectionId, kind: "updated" });
      }
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
        const observed = yield* prepareObservations(
          reporter,
          inventory.observations,
          inventory.kind,
        );
        yield* writeAsReporter(reporter, (environment) =>
          Effect.gen(function* () {
            const changes = yield* repository
              .reconcile({
                connectionId: reporter.connectionId,
                kind: declaration.word,
                complete: inventory.complete,
                observed,
                actor: `plugin:${reporter.pluginId}`,
                environment,
              })
              .pipe(Effect.catchTag("InvalidInventory", refuseInvalidInventory));
            yield* announceWrite(reporter.connectionId, changes);
          }),
        );
      }),

    /** Updates what is known of entities without touching any concern. Refuses like `reconcile`. */
    refresh: (
      reporter: EntityReporter,
      observations: ReadonlyArray<EntityObservation>,
    ): Effect.Effect<void, PluginError> =>
      Effect.gen(function* () {
        const observed = yield* prepareObservations(reporter, observations);
        yield* writeAsReporter(reporter, (environment) =>
          Effect.gen(function* () {
            const changes = yield* repository
              .refresh({ connectionId: reporter.connectionId, observed, environment })
              .pipe(Effect.catchTag("InvalidInventory", refuseInvalidInventory));
            yield* announceWrite(reporter.connectionId, changes);
          }),
        );
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
            const changes = yield* repository.reportMissing({
              connectionId: reporter.connectionId,
              ref,
              reason,
              environment,
            });
            yield* announceWrite(reporter.connectionId, changes);
          }),
        );
      }),
  };
});

/** Stores what a plugin's poll read of External Entities. Used only by the Entity Observations port. */
export class ExternalEntityIngest extends Context.Service<
  ExternalEntityIngest,
  Effect.Success<typeof make>
>()("hercule/controller/external-entities/ExternalEntityIngest") {}

export const ExternalEntityIngestLayer: Layer.Layer<
  ExternalEntityIngest,
  never,
  SqlClient.SqlClient
> = Layer.effect(ExternalEntityIngest)(make);
