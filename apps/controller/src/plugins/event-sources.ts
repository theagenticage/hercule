/**
 * Registers a plugin's event source: the catalog row for the source, the
 * schema of every event kind it declares, and the live source the ingest
 * loops open for each Connection.
 *
 * This lives next to the host rather than inside it, because the host
 * registers one extension point after another, and everything about one
 * extension point belongs in one place. It is a leaf: the host calls it, and
 * it calls nothing in the host.
 */
import * as Effect from "effect/Effect";
import type * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";
import {
  EventSourceNames,
  FeedDeclaration,
  PluginError,
  type EventSourceContribution,
  type PluginManifest,
} from "@hercule/plugin-host";
import {
  MAX_EVENT_KIND_LENGTH,
  MAX_FEED_INTERVAL_SECONDS,
  MAX_PLUGIN_MESSAGE_LENGTH,
} from "@hercule/contract";
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

/**
 * An event source a plugin registered at boot: what the ingest loops need to
 * open it for one Connection and to check what it emits. The catalog row holds
 * the same facts without `open` and the schemas, which no JSON column can
 * hold.
 *
 * - `id` is the qualified `<pluginId>/<word>` id.
 * - `connectionType` is the qualified type of the Connections it is opened for.
 * - `feeds` are the decoded feed declarations, keyed by feed name.
 * - `kinds` are the kinds it may emit, keyed by name.
 * - `resources` is whether the manifest requested the `resources` capability,
 *   which decides whether `open` receives the Connection's Resources.
 */
export interface RegisteredEventSource {
  readonly id: string;
  readonly pluginId: string;
  readonly connectionType: string;
  readonly feeds: Readonly<Record<string, FeedDeclaration>>;
  readonly kinds: ReadonlyMap<string, RegisteredEventKind>;
  readonly resources: boolean;
  readonly open: EventSourceContribution["open"];
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

// A feed name follows the rules of a source's own id: the plugin-host package
// exports that schema only as a field of `EventSourceNames`.
const decodeFeedName = Schema.decodeUnknownEffect(EventSourceNames.fields.id, { errors: "all" });

const decodeFeedDeclaration = Schema.decodeUnknownEffect(FeedDeclaration, { errors: "all" });

/**
 * Decodes a source's feeds, and returns them keyed by name. Fails with a
 * `PluginError` when the source declares no feed, and with one naming the
 * feed when:
 *
 * - its name is empty, longer than a contribution name may be, or holds a `/`;
 * - its intervals are not positive whole numbers of seconds;
 * - its minimum interval is longer than its default;
 * - its default interval is longer than one day, the longest interval a
 *   Connection may set.
 *
 * A source without feeds would hold a handle open that the host never polls,
 * so nothing would ever be emitted through it.
 *
 * A feed name is a key of a Connection's `feedIntervals` and is shown in the
 * Connection's form, so it follows the rules of every other contribution name.
 */
const decodeFeeds = (
  sourceId: string,
  feeds: Record<string, unknown>,
): Effect.Effect<Record<string, FeedDeclaration>, PluginError> =>
  Effect.gen(function* () {
    if (Object.keys(feeds).length === 0) {
      return yield* Effect.fail(
        new PluginError({
          message: `the event source ${sourceId} declares no feeds, so the host would never poll it. Declare at least one feed in the source's feeds.`,
        }),
      );
    }
    const decoded: Record<string, FeedDeclaration> = {};
    for (const [name, declaration] of Object.entries(feeds)) {
      yield* Effect.mapError(
        decodeFeedName(name),
        (error) =>
          new PluginError({
            message: `the feed name "${name}" is invalid: ${describeFieldIssues(error)}`,
          }),
      );
      const feed = yield* Effect.mapError(
        decodeFeedDeclaration(declaration),
        (error) =>
          new PluginError({
            message: `the feed ${name} is invalid: ${describeFieldIssues(error)}`,
          }),
      );
      // The minimum is the floor below which a user's own interval is
      // refused. A floor above the default would refuse the default itself.
      if (
        feed.minIntervalSeconds !== undefined &&
        feed.minIntervalSeconds > feed.defaultIntervalSeconds
      ) {
        return yield* Effect.fail(
          new PluginError({
            message: `the feed ${name} has a minimum interval of ${String(feed.minIntervalSeconds)} seconds, which is longer than its default of ${String(feed.defaultIntervalSeconds)} seconds. Make the minimum no longer than the default.`,
          }),
        );
      }
      // A minimum above the maximum is refused by the check above, since it
      // is then also above the default.
      if (feed.defaultIntervalSeconds > MAX_FEED_INTERVAL_SECONDS) {
        return yield* Effect.fail(
          new PluginError({
            message: `the feed ${name} has a default interval of ${String(feed.defaultIntervalSeconds)} seconds, which is longer than the longest interval of ${String(MAX_FEED_INTERVAL_SECONDS)} seconds (one day). Make the default no longer than that.`,
          }),
        );
      }
      decoded[name] = feed;
    }
    return decoded;
  });

/**
 * Registers one event source. Adds its catalog row to `declared`, adds each of
 * its kinds to `kinds`, which is the map used to decode emitted payloads and
 * to look up the kind of a trigger, and adds the live source to `sources`.
 * Fails with a `PluginError` if:
 *
 * - the manifest did not request the `events` capability;
 * - a name is invalid, or a kind is declared twice;
 * - the Connection type belongs to another plugin, or already has a source;
 * - a kind has the name of a core kind;
 * - a feed is invalid, as `decodeFeeds` explains.
 *
 * The collections belong to the registration pass, which passes them in for
 * this function to append to. A pass registers every plugin before anything
 * is stored, so a duplicate is caught in the array. If it were caught by the
 * primary key instead, the failed insert would also lose every other
 * plugin's rows.
 */
export const registerEventSourceContribution = (
  manifest: PluginManifest,
  contribution: EventSourceContribution,
  declared: Array<NewContribution>,
  kinds: Map<string, RegisteredEventKind>,
  sources: Array<RegisteredEventSource>,
): Effect.Effect<void, PluginError> =>
  Effect.gen(function* () {
    const pluginId = manifest.id;
    const names = yield* Effect.mapError(
      decodeEventSourceNames({ id: contribution.id, connectionType: contribution.connectionType }),
      toPluginError,
    );
    // A source writes to the event log through `emit`, which is what the
    // `events` capability grants. Refusing here tells the author at boot,
    // rather than at the first emit of a running Connection.
    if (!manifest.capabilities.includes("events")) {
      return yield* Effect.fail(
        new PluginError({
          message: `the event source ${names.id} emits events, but the manifest did not request the events capability. Add "events" to the manifest's capabilities.`,
        }),
      );
    }
    // A source ingests with the credentials of its Connections, which only
    // the plugin that owns their type can read.
    if (!names.connectionType.startsWith(`${pluginId}/`)) {
      return yield* Effect.fail(
        new PluginError({
          message: `the event source ${names.id} is for the Connection type ${names.connectionType}, which another plugin owns. A source can only ingest for a Connection type of its own plugin, "${pluginId}/<type>".`,
        }),
      );
    }
    // The catalog id, built like a connection type's: the plugin's id and the
    // id the source declared.
    const id = `${pluginId}/${names.id}`;
    // A Connection has one ingest handle and one set of stored state, so a
    // second source for the same type would have no handle of its own and
    // would share the first source's cursors.
    const claimed = sources.find((source) => source.connectionType === names.connectionType);
    if (claimed !== undefined) {
      return yield* Effect.fail(
        new PluginError({
          message: `the event sources ${claimed.id} and ${id} are both for the Connection type ${names.connectionType}. A Connection type can have one event source; declare every feed and kind on one source.`,
        }),
      );
    }
    if (declared.some((row) => row.extensionPoint === EVENT_SOURCE && row.id === id)) {
      return yield* Effect.fail(
        new PluginError({ message: `the ${EVENT_SOURCE} contribution ${id} is registered twice` }),
      );
    }
    const catalogued: Record<
      string,
      { readonly description: string; readonly schema: JsonSchema.JsonSchema }
    > = {};
    const sourceKinds = new Map<string, RegisteredEventKind>();
    for (const [kind, declaration] of Object.entries(contribution.kinds)) {
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
      const registered: RegisteredEventKind = {
        kind,
        pluginId,
        connectionType: names.connectionType,
        description: declaration.description,
        schema: declaration.schema,
      };
      kinds.set(kind, registered);
      sourceKinds.set(kind, registered);
    }
    const feeds = yield* decodeFeeds(names.id, contribution.feeds);
    declared.push({
      owner: pluginId,
      extensionPoint: EVENT_SOURCE,
      id,
      definition: { connectionType: names.connectionType, kinds: catalogued, feeds },
    });
    sources.push({
      id,
      pluginId,
      connectionType: names.connectionType,
      feeds,
      kinds: sourceKinds,
      resources: manifest.capabilities.includes("resources"),
      open: contribution.open,
    });
  });
