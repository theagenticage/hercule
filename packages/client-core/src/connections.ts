/**
 * What a client knows about connections that is not a plain read.
 *
 * The OAuth redirect URI is derived from the origin the browser is at: the
 * controller cannot see it, and it is what the user registers with the
 * provider, so the screen that shows it and the service that builds it read the
 * same function. The type catalog is read the same way: a connection type is a
 * plugin contribution, so what the screen can offer is a reading of the plugin
 * listing rather than a read of its own.
 */
import { GITHUB_CONNECTION_TYPE, type Connection, type PluginDetail } from "@hercule/contract";

/**
 * The accounts a repo can be reached through. Two screens offer them - the
 * composer's add-repo form and Settings > Threads - and which type counts is a
 * domain fact, not a filter each screen rewrites.
 */
export const githubConnections = (connections: readonly Connection[]): readonly Connection[] =>
  connections.filter((connection) => connection.type === GITHUB_CONNECTION_TYPE);

/** The path the controller serves the provider's redirect on. */
const CALLBACK_PATH = "/oauth/callback";

/** The redirect URI to register for this origin, with no doubled slash. */
export const redirectUriFor = (origin: string): string =>
  `${origin.replace(/\/+$/, "")}${CALLBACK_PATH}`;

/** One secret a setup asks the user to paste. */
export interface CredentialField {
  readonly name: string;
  readonly label: string;
  readonly help?: string;
}

/**
 * One step of a setup flow, as the host declares it. A catalog read at runtime
 * can carry a kind a later host added, which is why the screen reading these
 * steps asks what it can render rather than assuming it rendered everything.
 */
export type SetupStep =
  | { readonly kind: "checklist"; readonly markdown: string }
  | { readonly kind: "credentials"; readonly fields: ReadonlyArray<CredentialField> }
  | { readonly kind: "oauth" }
  | { readonly kind: "pairing" };

/** A connection type as the screen offers it. */
export interface ConnectionType {
  /** `<pluginId>/<word>`, as the catalog lists it. Sent back, never parsed. */
  readonly type: string;
  readonly displayName: string;
  /**
   * The plugin that declares it, for the line under the name. Two plugins may
   * each declare a type called Gmail, so the name alone does not say which.
   */
  readonly pluginName: string;
  readonly setup: ReadonlyArray<SetupStep>;
  readonly configSchema?: Record<string, unknown>;
}

/** A contribution's definition as an object: it crosses the wire as bare JSON. */
const asDefinition = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The connection types the plugin catalog holds. There is no read of its own
 * for them: a type is a contribution, so the catalog the plugins screen already
 * fetches is the whole of it. Whether the plugin is enabled is not asked:
 * `register()` ran either way, so the type can still validate what is pasted.
 */
export const connectionTypes = (
  plugins: ReadonlyArray<PluginDetail>,
): ReadonlyArray<ConnectionType> =>
  plugins.flatMap((plugin) =>
    plugin.contributions
      .filter((contribution) => contribution.extensionPoint === "connection-type")
      .flatMap((contribution) => {
        const definition = asDefinition(contribution.definition);
        const type = definition?.["type"];
        const displayName = definition?.["displayName"];
        if (typeof type !== "string" || typeof displayName !== "string") return [];
        const setup = definition?.["setup"];
        const configSchema = asDefinition(definition?.["configSchema"]);
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
 * How a type is set up, as one word. A setup is a list of steps and only one of
 * them decides how the credential is obtained, so every screen that branches on
 * a setup branches on this rather than scanning the steps for itself. A catalog
 * from a newer host can carry a step kind this build cannot render, which is
 * what `unknown` is: a screen says so rather than guessing.
 */
export const setupFlowOf = (
  type: ConnectionType,
): "oauth" | "credentials" | "pairing" | "unknown" => {
  if (type.setup.some((step) => step.kind === "oauth")) return "oauth";
  if (type.setup.some((step) => step.kind === "credentials")) return "credentials";
  if (type.setup.some((step) => step.kind === "pairing")) return "pairing";
  return "unknown";
};

/** The secrets this type's setup asks the user to paste, in the order declared. */
export const credentialFieldsOf = (type: ConnectionType): ReadonlyArray<CredentialField> =>
  type.setup.flatMap((step) => (step.kind === "credentials" ? [...step.fields] : []));
