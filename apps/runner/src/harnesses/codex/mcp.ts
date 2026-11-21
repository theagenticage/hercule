/**
 * How a Codex thread gets the session's MCP servers (the MCP Gateway today).
 * Codex reads them from its config, and `thread/start` takes config values as
 * dotted keys. A thread does not keep them: `thread/resume` and `thread/fork`
 * must send them again, or nothing connects and the model's call fails with no
 * message.
 */
import { SESSION_TOKEN_VARIABLE } from "../../credentials/helper";
import type { ResolvedMcpServer } from "../index";
import type { ConfigLayerSource, JsonValue } from "./types";

/**
 * How Codex asks about a call to a tool of an MCP server:
 *
 * - `prompt` asks about every call, whatever the tool's annotations.
 * - `approve` never asks.
 *
 * Codex also has `auto` and `writes`, which let the server's own annotations
 * decide. Those annotations come from an outside server, so they must never
 * lower what the Access Mode asks for.
 */
export type McpToolApprovalMode = "prompt" | "approve";

/**
 * The Codex releases that re-read a server's tool list when the server says it
 * changed (`features.mcp_tool_list_changed`), as a semver range. Codex refuses
 * a config key it does not know, so the key is sent only to a release that has
 * it.
 */
const TOOL_LIST_CHANGED_RANGE = ">=0.164.0";

/**
 * Checks whether a Codex of this version re-reads a server's tool list when
 * the server says it changed. `version` is what `parseVersion` read from the
 * app-server's user agent, or `null`. The check is strict: `null`, a
 * pre-release such as `0.164.0-alpha.1`, and anything that is not a plain
 * semver version such as `0.164.0junk` or `0.164.0.1` all return false. A
 * false positive would make Codex refuse to start the thread, while a false
 * negative only costs a warning.
 */
export const supportsToolListChanged = (version: string | null): boolean =>
  version !== null && Bun.semver.satisfies(version, TOOL_LIST_CHANGED_RANGE);

/**
 * Returns the warning for a session whose Codex does not re-read its tool
 * list, so a Hercule user is not surprised when a new MCP Server does not show
 * up in a running thread.
 */
export const buildNoToolListChangedWarning = (version: string | null): string =>
  `This Codex (${version ?? "unknown version"}) does not re-read its tool list, ` +
  "so an MCP Server added while the thread runs is usable from its next start. " +
  "Upgrade Codex to 0.164.0 or newer.";

/** An MCP server name that some other Codex configuration already sets, and where it is set. */
export interface ConfiguredMcpServer {
  readonly name: string;
  readonly layer: ConfigLayerSource;
}

/** What Hercule reads of a `config/read` reply: where each setting comes from, and each layer's own settings. */
export interface ConfigSources {
  /** The layer that sets each effective key, by dotted key. Only layers that are in force. */
  readonly origins: ReadonlyArray<{ readonly key: string; readonly layer: ConfigLayerSource }>;
  /** Every layer Codex found, including a project's that is not trusted (yet), with its settings. */
  readonly layers: ReadonlyArray<{ readonly layer: ConfigLayerSource; readonly config: unknown }>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Checks that a value names a configuration layer with the path Hercule shows for it. */
const isLayerSource = (value: unknown): value is ConfigLayerSource => {
  if (!isRecord(value) || typeof value["type"] !== "string") return false;
  if (value["type"] === "project") return typeof value["dotCodexFolder"] === "string";
  const needsFile = ["user", "system", "packagedDefaults", "legacyManagedConfigTomlFromFile"];
  return !needsFile.includes(value["type"]) || typeof value["file"] === "string";
};

/**
 * Reads the part of a `config/read` reply that `findConfiguredMcpServers`
 * uses. Returns `undefined` when the reply does not have the expected shape,
 * so the caller can treat it like a failed request instead of guessing that
 * no layer sets a server. `layers` may be `null` in the reply, and is then
 * empty.
 */
export const parseConfigSources = (reply: unknown): ConfigSources | undefined => {
  if (!isRecord(reply) || !isRecord(reply["origins"])) return undefined;
  const origins: Array<ConfigSources["origins"][number]> = [];
  for (const [key, origin] of Object.entries(reply["origins"])) {
    if (!isRecord(origin) || !isLayerSource(origin["name"])) return undefined;
    origins.push({ key, layer: origin["name"] });
  }
  const rawLayers = reply["layers"] ?? [];
  if (!Array.isArray(rawLayers)) return undefined;
  const layers: Array<ConfigSources["layers"][number]> = [];
  for (const layer of rawLayers as ReadonlyArray<unknown>) {
    if (!isRecord(layer) || !isLayerSource(layer["name"])) return undefined;
    layers.push({ layer: layer["name"], config: layer["config"] });
  }
  return { origins, layers };
};

/**
 * Returns the names, of those given, that Codex's own configuration already
 * sets, each with the layer that sets it. A name counts as set when:
 *
 * - a layer's own settings have a `mcp_servers.<name>` table, whatever is in
 *   it. Every layer found counts, including a project's `.codex/config.toml`
 *   that is not trusted yet: `thread/start` with a writable sandbox marks the
 *   project trusted and merges its table on that same call, after the
 *   configuration was read.
 * - or the effective `origins` have a key `mcp_servers.<name>` or starting
 *   with `mcp_servers.<name>.`.
 *
 * Codex merges every layer's table of a server name into one, so a repository
 * that sets any key of the gateway's name changes how the gateway behaves: its
 * `approval_mode` for one tool would lower the approval, and Codex has no way
 * to clear that key. A name set elsewhere is therefore not given to Codex.
 */
export const findConfiguredMcpServers = (
  sources: ConfigSources,
  names: ReadonlyArray<string>,
): ReadonlyArray<ConfiguredMcpServer> =>
  names.flatMap((name) => {
    const prefix = `mcp_servers.${name}`;
    const fromLayer = sources.layers.find(({ config }) => {
      const servers = isRecord(config) ? config["mcp_servers"] : undefined;
      return isRecord(servers) && Object.hasOwn(servers, name);
    })?.layer;
    const layer =
      fromLayer ??
      sources.origins.find(({ key }) => key === prefix || key.startsWith(`${prefix}.`))?.layer;
    return layer === undefined ? [] : [{ name, layer }];
  });

/** Describes the file or folder a configuration layer comes from, for a message. */
const describeLayer = (layer: ConfigLayerSource): string => {
  switch (layer.type) {
    case "project":
      return `This repository's .codex/config.toml (${layer.dotCodexFolder})`;
    case "user":
    case "system":
    case "packagedDefaults":
    case "legacyManagedConfigTomlFromFile":
      return `The Codex configuration file ${layer.file}`;
    default:
      return `Codex's ${layer.type} configuration`;
  }
};

/**
 * Returns the warning for a session whose MCP server name is set in Codex's
 * own configuration, so the thread gets none of Hercule's MCP Servers. Names
 * the file and what to do about it.
 */
export const buildMcpNameTakenWarning = ({ name, layer }: ConfiguredMcpServer): string =>
  `${describeLayer(layer)} configures an MCP server named "${name}", the name Hercule gives ` +
  "its MCP Gateway, so this thread gets none of its MCP Servers. " +
  "Rename or remove that server there to use them.";

/**
 * Returns the warning for a session whose Codex configuration could not be
 * read, so Hercule cannot tell whether its MCP server name is taken. The
 * thread then gets none of Hercule's MCP Servers. `reason` is Codex's own
 * error message.
 */
export const buildMcpConfigUnreadWarning = (reason: string): string =>
  `Codex could not read its configuration (${reason}), so this thread gets none of ` +
  "Hercule's MCP Servers. Fix the configuration it names to use them.";

/**
 * Returns the `config` for the session's MCP servers, to send with
 * `thread/start`, `thread/resume` and `thread/fork`. Returns an empty object
 * when there are no servers, so no key reaches Codex. The caller passes only
 * servers whose name `findConfiguredMcpServers` found free.
 *
 * - Each server gets its URL, and the name of the variable that holds the
 *   session's token, never the token: Codex reads the variable itself when it
 *   connects and sends the token as a bearer token.
 * - Each server gets the approval mode of the session's Access Mode.
 * - The tool list feature is set only when the running Codex has it.
 *
 * Exported so the real-binary test starts Codex with exactly this config.
 */
export const buildMcpServerConfig = (
  servers: ReadonlyArray<ResolvedMcpServer>,
  approvalMode: McpToolApprovalMode,
  toolListChanged: boolean,
): Record<string, JsonValue> =>
  servers.length === 0
    ? {}
    : {
        ...Object.fromEntries(
          servers.flatMap((server): Array<[string, JsonValue]> => [
            [`mcp_servers.${server.name}.url`, server.url],
            [`mcp_servers.${server.name}.bearer_token_env_var`, SESSION_TOKEN_VARIABLE],
            [`mcp_servers.${server.name}.default_tools_approval_mode`, approvalMode],
          ]),
        ),
        ...(toolListChanged ? { "features.mcp_tool_list_changed": true } : {}),
      };
