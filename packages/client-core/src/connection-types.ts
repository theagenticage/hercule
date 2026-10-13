/**
 * The connection types a screen offers, derived from the plugin list. A
 * connection type is a plugin contribution, so the types come from the
 * plugin list rather than from an operation of their own, and so do the
 * feeds a type's event source polls and the ways a type can be set up.
 */
import type { PluginDetail } from "@hercule/contract";
import { readJsonObject } from "./json-shape";

/** One secret a setup asks the user to paste. */
export interface CredentialField {
  readonly name: string;
  readonly label: string;
  readonly help?: string;
}

/**
 * One step of a setup flow, as the plugin host declares it. A newer host can
 * add step kinds this build does not know, so a screen must check which steps
 * it can render rather than assume it can render them all.
 */
export type SetupStep =
  | { readonly kind: "checklist"; readonly markdown: string }
  | { readonly kind: "credentials"; readonly fields: ReadonlyArray<CredentialField> }
  | { readonly kind: "oauth" }
  | { readonly kind: "device" }
  | { readonly kind: "pairing" };

/** A connection type as the screen offers it. */
export interface ConnectionType {
  /** `<pluginId>/<word>`, as the plugin list has it. Sent back as is, never parsed. */
  readonly type: string;
  readonly displayName: string;
  /**
   * The name of the plugin that declares the type, for the line under the
   * type's name. Two plugins may each declare a type called Gmail, so the type
   * name alone is not enough to tell them apart. See `showsPluginName`.
   */
  readonly pluginName: string;
  readonly setup: ReadonlyArray<SetupStep>;
  readonly configSchema?: Record<string, unknown>;
  /**
   * The feeds the type's event source polls, in the order the plugin declares
   * them. Empty for a type no event source polls, such as a chat channel.
   */
  readonly feeds: ReadonlyArray<ConnectionFeed>;
}

/** One feed an event source polls for every Connection of its type. */
export interface ConnectionFeed {
  /** The feed's name, such as `repos`. The key of the Connection's `feedIntervals`. */
  readonly name: string;
  /** The seconds between polls when the user sets no interval of their own. */
  readonly defaultIntervalSeconds: number;
  /**
   * The shortest interval the user may set, in seconds. A feed that declares
   * no minimum may not poll faster than its default, so this is the default then.
   */
  readonly minIntervalSeconds: number;
}

/**
 * Returns the feeds of every event source in the plugin list, keyed by the
 * connection type the event source polls for. A feed whose declaration does not
 * have the expected shape is left out: the definition arrives as untyped
 * JSON, and a form cannot offer an interval it cannot read.
 */
const listFeedsByConnectionType = (
  plugins: ReadonlyArray<PluginDetail>,
): ReadonlyMap<string, ReadonlyArray<ConnectionFeed>> => {
  const feedsByType = new Map<string, ReadonlyArray<ConnectionFeed>>();
  for (const plugin of plugins) {
    for (const contribution of plugin.contributions) {
      if (contribution.extensionPoint !== "event-source") continue;
      const definition = readJsonObject(contribution.definition);
      const connectionType = definition?.["connectionType"];
      const declared = readJsonObject(definition?.["feeds"]);
      if (typeof connectionType !== "string" || declared === undefined) continue;
      const feeds = Object.entries(declared).flatMap(([name, value]) => {
        const feed = readJsonObject(value);
        const defaultIntervalSeconds = feed?.["defaultIntervalSeconds"];
        const minIntervalSeconds = feed?.["minIntervalSeconds"] ?? defaultIntervalSeconds;
        return typeof defaultIntervalSeconds === "number" && typeof minIntervalSeconds === "number"
          ? [{ name, defaultIntervalSeconds, minIntervalSeconds }]
          : [];
      });
      feedsByType.set(connectionType, feeds);
    }
  }
  return feedsByType;
};

/**
 * Returns the connection types declared in the plugin list. There is no
 * separate operation for them: a type is a plugin contribution, so the plugin
 * list the plugins screen already fetches contains every type. Disabled
 * plugins are included, because their `register()` still ran, so their types
 * can still validate what the user pastes.
 *
 * Each type carries the feeds of the type's event source. An event source is
 * a contribution of its own, so its feeds are matched to the type by the
 * connection type the event source names. The controller refuses a second
 * event source for one type, so a type has at most one.
 */
export const listConnectionTypes = (
  plugins: ReadonlyArray<PluginDetail>,
): ReadonlyArray<ConnectionType> => {
  const feedsByType = listFeedsByConnectionType(plugins);
  return plugins.flatMap((plugin) =>
    plugin.contributions
      .filter((contribution) => contribution.extensionPoint === "connection-type")
      .flatMap((contribution) => {
        // A contribution's definition arrives as untyped JSON.
        const definition = readJsonObject(contribution.definition);
        const type = definition?.["type"];
        const displayName = definition?.["displayName"];
        if (typeof type !== "string" || typeof displayName !== "string") return [];
        const setup = definition?.["setup"];
        const configSchema = readJsonObject(definition?.["configSchema"]);
        return [
          {
            type,
            displayName,
            pluginName: plugin.displayName,
            setup: Array.isArray(setup) ? (setup as ReadonlyArray<SetupStep>) : [],
            ...(configSchema === undefined ? {} : { configSchema }),
            feeds: feedsByType.get(type) ?? [],
          },
        ];
      }),
  );
};

/**
 * Checks whether a screen shows the plugin's name under the type's name. The
 * plugin's name is there to tell apart two plugins that declare a type of the
 * same name. When the plugin is named like its type, as a GitHub plugin that
 * declares a GitHub type is, the plugin's name would only repeat the type's.
 */
export const showsPluginName = (type: ConnectionType): boolean =>
  type.pluginName !== type.displayName;

/**
 * One way to obtain a connection's credential:
 *
 * - `device`: the user enters a code at the provider (a device flow).
 * - `oauth`: the browser goes to the provider and comes back (a redirect flow).
 * - `credentials`: the user pastes the secrets.
 * - `pairing`: the user sends the bot a one-time code from a chat account.
 */
export type SetupFlow = "device" | "oauth" | "credentials" | "pairing";

const SETUP_FLOWS: ReadonlyArray<string> = ["device", "oauth", "credentials", "pairing"];

/**
 * Returns every way the connection type can be set up, in the order its setup
 * declares them. The first flow is the one the type prefers; a type with more
 * than one lets the user pick. Every screen that depends on the setup flow
 * uses this function rather than scanning the steps itself.
 *
 * A step kind this build does not know is left out, because it comes from a
 * newer host. An empty list therefore means that the screen cannot set the
 * type up, and should say so rather than guess.
 */
export const listSetupFlows = (type: ConnectionType): ReadonlyArray<SetupFlow> => {
  const kinds: ReadonlyArray<string> = type.setup.map((step) => step.kind);
  // Two credential steps are one flow: the user pastes all their fields at once.
  return [...new Set(kinds)].filter((kind): kind is SetupFlow => SETUP_FLOWS.includes(kind));
};

/** Returns the secret fields the type's setup asks the user to paste, in declared order. */
export const listCredentialFields = (type: ConnectionType): ReadonlyArray<CredentialField> =>
  type.setup.flatMap((step) => (step.kind === "credentials" ? [...step.fields] : []));
