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
import type { Issue, PluginDetail } from "@hydra/contract";
import { ApiError } from "./errors";

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

/** A connection type as the screen offers it, with the plugin that declared it. */
export interface ConnectionType {
  readonly pluginId: string;
  /** Setup renders either way: `register()` ran, so the type can still validate. */
  readonly pluginEnabled: boolean;
  readonly type: string;
  readonly displayName: string;
  readonly setup: ReadonlyArray<SetupStep>;
  readonly oauth?: Record<string, unknown>;
  readonly configSchema?: Record<string, unknown>;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The connection types the plugin catalog holds. There is no read of its own
 * for them: a type is a contribution, so the catalog the plugins screen already
 * fetches is the whole of it. A contribution whose definition is not a type -
 * another extension point, or a definition this app cannot read - is left out.
 */
export const connectionTypes = (
  plugins: ReadonlyArray<PluginDetail>,
): ReadonlyArray<ConnectionType> =>
  plugins.flatMap((plugin) =>
    plugin.contributions
      .filter((contribution) => contribution.extensionPoint === "connection-type")
      .flatMap((contribution) => {
        const definition = asRecord(contribution.definition);
        const type = definition?.["type"];
        const displayName = definition?.["displayName"];
        if (typeof type !== "string" || typeof displayName !== "string") return [];
        const setup = definition?.["setup"];
        const oauth = asRecord(definition?.["oauth"]);
        const configSchema = asRecord(definition?.["configSchema"]);
        return [
          {
            pluginId: plugin.id,
            pluginEnabled: plugin.enabled,
            type,
            displayName,
            setup: Array.isArray(setup) ? (setup as ReadonlyArray<SetupStep>) : [],
            ...(oauth === undefined ? {} : { oauth }),
            ...(configSchema === undefined ? {} : { configSchema }),
          },
        ];
      }),
  );

/** What a refused write blamed, read against one group of a connection's fields. */
export interface ConnectionIssues {
  /** The message per field name, for the issues whose path names this group. */
  readonly perField: Readonly<Record<string, string>>;
  /** Whether anything else was refused, which only the form itself can say. */
  readonly rest: boolean;
}

/**
 * A refusal's issues split by the group they name. A connection write carries
 * two kinds of field - the pasted credentials and the type's own settings - so
 * a path is `["credentials", <name>]` or `["config", <name>]`, and only the
 * form rendering that group can put the message under the field.
 */
export const connectionIssues = (
  error: unknown,
  group: "credentials" | "config",
): ConnectionIssues => {
  if (error === null || error === undefined) return { perField: {}, rest: false };
  if (!(error instanceof ApiError) || error.code !== "validation") {
    return { perField: {}, rest: true };
  }
  const issues = asRecord(error.details)?.["issues"];
  if (!Array.isArray(issues)) return { perField: {}, rest: true };

  const perField: Record<string, string> = {};
  let rest = false;
  for (const issue of issues as ReadonlyArray<Issue>) {
    const [head, name] = issue.path;
    if (head === group && name !== undefined) perField[name] ??= issue.message;
    else rest = true;
  }
  return { perField, rest };
};
