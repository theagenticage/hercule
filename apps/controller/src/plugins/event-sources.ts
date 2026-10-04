/**
 * Registers a plugin's event source: the catalog row for the source, and the
 * schema of every event kind it declares.
 *
 * This lives next to the host rather than inside it, because the host
 * registers one extension point after another, and everything about one
 * extension point belongs in one place. It is a leaf: the host calls it, and
 * it calls nothing in the host.
 */
import * as Effect from "effect/Effect";
import type * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";
import { EventSourceNames, PluginError, type EventSourceContribution } from "@hercule/plugin-host";
import { MAX_EVENT_KIND_LENGTH, MAX_PLUGIN_MESSAGE_LENGTH } from "@hercule/contract";
import { isCoreEventKind, type DeclaredEventKindWithConnectionType } from "../events";
import { toPluginError, describeFieldIssues } from "./errors";
import { deriveCatalogJsonSchema } from "./json-schema";
import type { NewContribution } from "./repository";

/**
 * An event kind a plugin registered at boot, with the id of that plugin and
 * the schema that emitted payloads are decoded against. `connectionType` is
 * always set, because a plugin's events always arrive through a Connection.
 */
export interface RegisteredEventKind extends DeclaredEventKindWithConnectionType {
  readonly pluginId: string;
  readonly connectionType: string;
  readonly schema: Schema.Top;
}

/** The name of the extension point this module registers into. */
const EVENT_SOURCE = "event-source";

// Decodes the two names that identify an event source. Its kinds are decoded
// one at a time below, because each declaration holds a schema object.
const decodeEventSourceNames = Schema.decodeUnknownEffect(EventSourceNames, { errors: "all" });

/**
 * One event kind as a plugin declares it, without the schema: a name short
 * enough for its column, and a one-line description of the event. Both are
 * stored and sent to clients.
 */
const EventKindHeader = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_EVENT_KIND_LENGTH)),
  description: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_PLUGIN_MESSAGE_LENGTH),
  ),
});

const decodeEventKindHeader = Schema.decodeUnknownEffect(EventKindHeader, { errors: "all" });

/**
 * Registers one event source. Adds its catalog row to `declared`, and adds
 * each of its kinds to `kinds`, which is the map used to decode emitted
 * payloads and to look up the kind of a trigger. Fails with a `PluginError` if
 * a name is invalid, a kind is declared twice, or a kind has the name of a
 * core kind.
 *
 * Both collections belong to the registration pass, which passes them in for
 * this function to append to. A pass registers every plugin before anything
 * is stored, so a duplicate is caught in the array. If it were caught by the
 * primary key instead, the failed insert would also lose every other
 * plugin's rows.
 */
export const registerEventSourceContribution = (
  pluginId: string,
  definition: EventSourceContribution,
  declared: Array<NewContribution>,
  kinds: Map<string, RegisteredEventKind>,
): Effect.Effect<void, PluginError> =>
  Effect.gen(function* () {
    const names = yield* Effect.mapError(
      decodeEventSourceNames({ id: definition.id, connectionType: definition.connectionType }),
      toPluginError,
    );
    // The catalog id, built like a connection type's: the plugin's id and the
    // id the source declared.
    const id = `${pluginId}/${names.id}`;
    if (declared.some((row) => row.extensionPoint === EVENT_SOURCE && row.id === id)) {
      return yield* Effect.fail(
        new PluginError({ message: `the ${EVENT_SOURCE} contribution ${id} is registered twice` }),
      );
    }
    const catalogued: Record<
      string,
      { readonly description: string; readonly schema: JsonSchema.JsonSchema }
    > = {};
    for (const [kind, declaration] of Object.entries(definition.kinds)) {
      // A kind is looked up by name alone, across every plugin, so the name
      // must show its owner, and readers take the part before the first dot
      // as the owner. It is checked here, where the plugin author sees the
      // error, rather than at the first emit, where the caller would see an
      // error about someone else's mistake.
      if (!kind.startsWith(`${pluginId}.`)) {
        return yield* Effect.fail(
          new PluginError({
            message: `the event kind ${kind} does not begin with "${pluginId}."`,
          }),
        );
      }
      // An event kind is known by its name only. A plugin kind with the name
      // of a core kind would make that name ambiguous, for the triggers that
      // listen for it and for the Scheduler's cron.tick alike.
      if (isCoreEventKind(kind)) {
        return yield* Effect.fail(
          new PluginError({
            message: `the event kind ${kind} is already declared by the core. An event kind is known by its name only, so the two kinds could not be told apart. Give the kind another name.`,
          }),
        );
      }
      // If two sources of one plugin declared the same kind, the last one
      // registered would silently replace the first.
      if (kinds.has(kind)) {
        return yield* Effect.fail(
          new PluginError({ message: `the event kind ${kind} is declared twice` }),
        );
      }
      // The error message includes the kind's name, because a plugin that
      // declares many kinds needs to know which one is invalid.
      yield* Effect.mapError(
        decodeEventKindHeader({ name: kind, description: declaration.description }),
        (error) =>
          new PluginError({
            message: `the event kind ${kind} is invalid: ${describeFieldIssues(error)}`,
          }),
      );
      catalogued[kind] = {
        description: declaration.description,
        schema: deriveCatalogJsonSchema(declaration.schema),
      };
      kinds.set(kind, {
        kind,
        pluginId,
        connectionType: names.connectionType,
        description: declaration.description,
        schema: declaration.schema,
      });
    }
    declared.push({
      owner: pluginId,
      extensionPoint: EVENT_SOURCE,
      id,
      definition: { connectionType: names.connectionType, kinds: catalogued },
    });
  });
