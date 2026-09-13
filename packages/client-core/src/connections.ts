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
import type { PluginDetail } from "@hydra/contract";

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
  readonly type: string;
  readonly displayName: string;
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
            setup: Array.isArray(setup) ? (setup as ReadonlyArray<SetupStep>) : [],
            ...(configSchema === undefined ? {} : { configSchema }),
          },
        ];
      }),
  );
