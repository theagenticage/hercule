/**
 * Client-side rules about connections that go beyond a plain read.
 *
 * The OAuth redirect URI is built from the browser's origin, which the
 * controller cannot see. The user registers that URI with the provider, so the
 * screen that shows it and the service that builds it use the same function.
 * The connection types are derived in the same way: a connection type is a
 * plugin contribution, so the types come from the plugin list rather than from
 * an operation of their own.
 */
import {
  GITHUB_CONNECTION_TYPE,
  type Connection,
  type ConnectionDevicePoll,
  type ConnectionDeviceStart,
  type PluginDetail,
} from "@hercule/contract";
import { readJsonObject } from "./json-shape";

/**
 * Returns the GitHub connections: the accounts a repo can be cloned through.
 * Two screens offer them (the composer's add-repo form and Settings > Threads),
 * so the filter is written once here rather than in each screen.
 */
export const filterGitHubConnections = (
  connections: readonly Connection[],
): readonly Connection[] =>
  connections.filter((connection) => connection.type === GITHUB_CONNECTION_TYPE);

/** The path the controller serves the provider's redirect on. */
const CALLBACK_PATH = "/oauth/callback";

/** Returns the redirect URI to register for this origin, without a double slash. */
export const buildRedirectUri = (origin: string): string =>
  `${origin.replace(/\/+$/, "")}${CALLBACK_PATH}`;

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
   * name alone is not enough to tell them apart.
   */
  readonly pluginName: string;
  readonly setup: ReadonlyArray<SetupStep>;
  readonly configSchema?: Record<string, unknown>;
}

/**
 * Returns the connection types declared in the plugin list. There is no
 * separate operation for them: a type is a plugin contribution, so the plugin
 * list the plugins screen already fetches contains every type. Disabled
 * plugins are included, because their `register()` still ran, so their types
 * can still validate what the user pastes.
 */
export const listConnectionTypes = (
  plugins: ReadonlyArray<PluginDetail>,
): ReadonlyArray<ConnectionType> =>
  plugins.flatMap((plugin) =>
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
          },
        ];
      }),
  );

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

/**
 * Returns how many milliseconds to wait before polling a device flow again,
 * or `null` when the flow has ended and must not be polled again.
 *
 * `outcome` is the last poll's result, or `undefined` before the first poll,
 * when the wait is the one the start returned. A `slow-down` outcome carries
 * the new, longer wait, so every outcome that keeps the flow open is read the
 * same way.
 */
export const computeNextPollDelay = (
  start: ConnectionDeviceStart,
  outcome: ConnectionDevicePoll | undefined,
): number | null => {
  if (outcome === undefined) return start.interval * 1000;
  return "interval" in outcome ? outcome.interval * 1000 : null;
};

/** Returns the secret fields the type's setup asks the user to paste, in declared order. */
export const listCredentialFields = (type: ConnectionType): ReadonlyArray<CredentialField> =>
  type.setup.flatMap((step) => (step.kind === "credentials" ? [...step.fields] : []));
