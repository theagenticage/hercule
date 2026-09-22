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
import * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";
import { EventSourceNames, PluginError, type EventSourceDefinition } from "@hercule/plugin-host";
import { MAX_EVENT_KIND_LENGTH, MAX_PLUGIN_MESSAGE_LENGTH } from "@hercule/contract";
import { asPluginError, describeFieldIssues } from "./errors";
import type { NewContribution } from "./repository";

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
 * The JSON Schema the catalog holds for one event kind. It is a whole document
 * rather than the root node alone: a schema carrying an identifier is emitted
 * once as a definition and pointed at with a `$ref`, and a reader handed the
 * root by itself could not follow that reference.
 */
const derivePayloadJsonSchema = (schema: Schema.Top): JsonSchema.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(schema);
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions };
};

/**
 * Registers one event source: the row the catalog holds for it, and every kind
 * it declares, in the map an emit is later read against.
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
  kinds: Map<string, Schema.Top>,
): Effect.Effect<void, PluginError> =>
  Effect.gen(function* () {
    const names = yield* Effect.mapError(
      decodeEventSourceNames({ id: definition.id, connectionType: definition.connectionType }),
      asPluginError,
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
        schema: derivePayloadJsonSchema(declaration.schema),
      };
      kinds.set(kind, declaration.schema);
    }
    declared.push({
      owner: pluginId,
      extensionPoint: EVENT_SOURCE,
      id,
      definition: { connectionType: names.connectionType, kinds: catalogued },
    });
  });
