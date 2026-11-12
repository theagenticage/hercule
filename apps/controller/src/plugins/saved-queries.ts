/**
 * Checks the saved queries an event source declares, and returns them
 * qualified with the plugin's id, ready for the Inbox's rail.
 *
 * A saved query is data, so the host checks all of it when the plugin loads.
 * A mistake then refuses the source while the plugin's author reads the
 * error, instead of showing an empty list to the user later.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CORE_INBOX_FIELD_KEYS,
  CORE_INBOX_FIELDS,
  describeClauseForFieldType,
  MAX_SAVED_QUERIES_PER_PLUGIN,
  PluginError,
  SavedQuery,
  type EntityFieldType,
  type InboxClause,
  type PluginManifest,
  type QualifiedEntityKindDeclaration,
} from "@hercule/plugin-host";
import { describeFieldIssues } from "./errors";

/**
 * One saved query of the Inbox, the core's or a plugin's. A plugin's is its
 * declaration with the qualified id (`github/review-requests`) and clauses
 * whose `kind` and `signal` values are qualified.
 */
export interface RegisteredSavedQuery extends Omit<SavedQuery, "word"> {
  readonly id: string;
  /** The id of the plugin that declared it. Absent for a core query. */
  readonly source?: string;
}

/** What a saved query may name: the plugin's own kinds, and the queries it already has. */
export interface SavedQueryContext {
  /** The qualified signal kinds the plugin's sources declare, this source included. */
  readonly signalKinds: ReadonlySet<string>;
  /** The entity kinds the plugin's sources declare, this source included. */
  readonly entityKinds: ReadonlyArray<QualifiedEntityKindDeclaration>;
  /** The qualified ids of the plugin's saved queries that other sources registered. */
  readonly takenIds: ReadonlySet<string>;
}

const decodeSavedQuery = Schema.decodeUnknownEffect(SavedQuery, { errors: "all" });

/**
 * Returns the reason a clause is wrong, written to say what to do, or
 * undefined when it is right. `fieldTypes` maps the keys of the fields the
 * plugin declares to their types.
 */
const findClauseProblem = (
  clause: InboxClause,
  fieldTypes: ReadonlyMap<string, EntityFieldType>,
  context: SavedQueryContext,
  pluginId: string,
): string | undefined => {
  if (clause.source !== undefined || clause.connectionId !== undefined) {
    return `the clause on "${clause.key}" names a source or a Connection. A saved query of a plugin is always about its own source, and a plugin cannot know a Connection, so remove source and connectionId.`;
  }
  const type: EntityFieldType | undefined =
    CORE_INBOX_FIELDS.find((field) => field.key === clause.key)?.type ?? fieldTypes.get(clause.key);
  const shape = type === undefined ? undefined : describeClauseForFieldType(type);
  if (shape === undefined) {
    return `the clause key "${clause.key}" is neither one of the Inbox's own keys (${CORE_INBOX_FIELD_KEYS.join(", ")}) nor a field the plugin declares. Use one of those keys.`;
  }
  if (!shape.operators.includes(clause.op)) {
    return `the clause on "${clause.key}" uses "${clause.op}", but that key takes ${shape.operators.map((op) => `"${op}"`).join(" or ")}. Change the operator.`;
  }
  if (typeof clause.value !== shape.value) {
    return `the clause on "${clause.key}" has a value that is not a ${shape.value}. Write a ${shape.value} value.`;
  }
  if (clause.key === "kind" || clause.key === "signal") {
    const qualified = `${pluginId}/${String(clause.value)}`;
    const isSignal = clause.key === "signal";
    const known = isSignal
      ? context.signalKinds.has(qualified)
      : context.entityKinds.some((kind) => kind.word === qualified);
    if (!known) {
      return `the clause on "${clause.key}" names "${String(clause.value)}", which the plugin does not declare as ${isSignal ? "a signal kind" : "an entity kind"}. Write the word of one of the plugin's own ${isSignal ? "signal" : "entity"} kinds, without the plugin's id.`;
    }
  }
  return undefined;
};

/**
 * Decodes the saved queries of one event source, and returns them qualified.
 * Fails with a `PluginError` naming the query when:
 *
 * - its word, name, order or a clause is invalid, or it has more than
 *   `MAX_SAVED_QUERY_CLAUSES` clauses;
 * - another saved query of the plugin has the same word, or the plugin has
 *   more than `MAX_SAVED_QUERIES_PER_PLUGIN` in all;
 * - a clause has a key that is neither a core key nor a declared field, an
 *   operator or value that does not fit the key, or a `source` or
 *   `connectionId`;
 * - a `kind` or `signal` clause names a word the plugin does not declare.
 */
export const decodeSavedQueries = (
  manifest: PluginManifest,
  sourceId: string,
  declarations: ReadonlyArray<SavedQuery>,
  context: SavedQueryContext,
): Effect.Effect<ReadonlyArray<RegisteredSavedQuery>, PluginError> =>
  Effect.gen(function* () {
    const fieldTypes = new Map<string, EntityFieldType>();
    for (const kind of context.entityKinds) {
      for (const field of kind.fields ?? []) {
        if (!fieldTypes.has(field.key)) fieldTypes.set(field.key, field.type);
      }
    }
    const registered: Array<RegisteredSavedQuery> = [];
    for (const declaration of declarations) {
      const invalid = (reason: string) =>
        new PluginError({
          message: `the saved query ${declaration.word} of the event source ${sourceId} is invalid: ${reason}`,
        });
      const query = yield* Effect.mapError(decodeSavedQuery(declaration), (error) =>
        invalid(describeFieldIssues(error)),
      );
      const id = `${manifest.id}/${query.word}`;
      if (context.takenIds.has(id) || registered.some((other) => other.id === id)) {
        return yield* Effect.fail(
          invalid(
            `the plugin declares it twice. Give each saved query of the plugin its own word.`,
          ),
        );
      }
      if (context.takenIds.size + registered.length >= MAX_SAVED_QUERIES_PER_PLUGIN) {
        return yield* Effect.fail(
          invalid(
            `the plugin declares more than ${String(MAX_SAVED_QUERIES_PER_PLUGIN)} saved queries. Remove one.`,
          ),
        );
      }
      for (const clause of query.clauses) {
        const problem = findClauseProblem(clause, fieldTypes, context, manifest.id);
        if (problem !== undefined) return yield* Effect.fail(invalid(problem));
      }
      registered.push({
        id,
        source: manifest.id,
        name: query.name,
        order: query.order,
        clauses: query.clauses.map((clause) =>
          clause.key === "kind" || clause.key === "signal"
            ? { ...clause, value: `${manifest.id}/${String(clause.value)}` }
            : clause,
        ),
      });
    }
    return registered;
  });
