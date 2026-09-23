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
import { isCoreEventKind, type NameableEventKind } from "../events";
import { asPluginError, describeFieldIssues } from "./errors";
import { deriveCatalogJsonSchema } from "./json-schema";
import type { NewContribution } from "./repository";

/**
 * One event kind a boot registered: the kind as a trigger names it, the plugin
 * that declared it, and the live schema an emitted payload is read against. A
 * plugin's events always arrive through a Connection, so the Connection type
 * is always present.
 */
export interface RegisteredEventKind extends NameableEventKind {
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
 * Registers one event source: the row the catalog holds for it, and every kind
 * it declares, in the map that an emit is read against and that a trigger's
 * kind is looked up in.
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
      // A trigger names a kind by its name alone, so a plugin kind with the
      // name of a core kind would make one name mean two kinds.
      if (isCoreEventKind(kind)) {
        return yield* Effect.fail(
          new PluginError({
            message: `the event kind ${kind} is a kind the core declares, and a trigger could not tell the two apart: declare the kind under another name`,
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
