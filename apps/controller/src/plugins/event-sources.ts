/**
 * What a plugin contributing a source of events registers: the row the
 * catalog holds for the source, and the live schema of every kind it declares.
 *
 * It sits beside the host rather than inside it because the host's registration
 * surface is a list of extension points, and the whole of what one of them
 * takes belongs in one place. A leaf: the host calls this, and this calls
 * nothing of the host's.
 */
import * as Effect from "effect/Effect";
import type * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";
import { EventSourceNames, PluginError, type EventSourceDefinition } from "@hercule/plugin-host";
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

/** The extension point this registers into; the column takes any name. */
const EVENT_SOURCE = "event-source";

// The two names an event source is identified by. Its kinds are read one at a
// time below, because each declaration holds a live schema.
const decodeEventSourceNames = Schema.decodeUnknownEffect(EventSourceNames, { errors: "all" });

/**
 * One event kind as a plugin declares it, minus the schema: a name that no
 * column would truncate, and a line saying what the event means. Both reach a
 * column and the wire.
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
 * Both collections are the registration pass's own, handed in and appended to,
 * because a pass registers every plugin before any of it is stored: a duplicate
 * is caught against the array rather than against the primary key, where it
 * would take every other plugin's rows with it.
 */
export const registerEventSourceContribution = (
  pluginId: string,
  definition: EventSourceDefinition,
  declared: Array<NewContribution>,
  kinds: Map<string, RegisteredEventKind>,
): Effect.Effect<void, PluginError> =>
  Effect.gen(function* () {
    const names = yield* Effect.mapError(
      decodeEventSourceNames({ id: definition.id, connectionType: definition.connectionType }),
      toPluginError,
    );
    // The identity the catalog keys on, made the same way a connection type's
    // is: the plugin's id and the word it declared.
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
      // A kind is looked up by name alone, across every plugin, so it has to
      // say who owns it, and the name in front of the first dot is what a
      // reader takes the owner to be. Refused here, where the plugin author is
      // told, rather than at the first emit, where the caller would be told
      // about somebody else's mistake.
      if (!kind.startsWith(`${pluginId}.`)) {
        return yield* Effect.fail(
          new PluginError({
            message: `the event kind ${kind} does not begin with "${pluginId}."`,
          }),
        );
      }
      // A trigger refers to a kind by its name only. A plugin kind with the
      // name of a core kind would make that name ambiguous.
      if (isCoreEventKind(kind)) {
        return yield* Effect.fail(
          new PluginError({
            message: `the event kind ${kind} is already declared by the core. A trigger refers to a kind by its name only, so it could not tell the two kinds apart. Give the kind another name.`,
          }),
        );
      }
      // Two sources of one plugin claiming one kind would leave the last one
      // registered answering for both.
      if (kinds.has(kind)) {
        return yield* Effect.fail(
          new PluginError({ message: `the event kind ${kind} is declared twice` }),
        );
      }
      // The kind's name is carried into the refusal, because a plugin
      // declaring many kinds needs to be told which one.
      yield* Effect.mapError(
        decodeEventKindHeader({ name: kind, description: declaration.description }),
        (error) =>
          new PluginError({
            message: `the event kind ${kind} is refused: ${describeFieldIssues(error)}`,
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
