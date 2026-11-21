/**
 * How a Codex thread gets the session's MCP servers (the MCP Gateway today).
 * Codex reads them from its config, and `thread/start` takes config values as
 * dotted keys. A thread does not keep them: `thread/resume` and `thread/fork`
 * must send them again, or nothing connects and the model's call fails with no
 * message.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { AccessMode } from "@hercule/protocol";
import { SESSION_TOKEN_VARIABLE } from "../../credentials/helper";
import type { ResolvedMcpServer } from "../index";
import type { Rpc } from "./rpc";
import type { ConfigReadParams, JsonValue } from "./types";

/**
 * How Codex asks about a call to a tool of an MCP server, for each Access
 * Mode. It is not a thread setting: it goes in the MCP servers' config.
 *
 * - `prompt` asks about every call, whatever the tool's annotations. A tool's
 *   annotations (such as "read only") come from an outside server, so they
 *   must never lower the mode (spec 06 section 10.2). Every Access Mode but
 *   full access uses it. In `auto` mode, Codex's own reviewer then judges each
 *   call, as it does for other actions.
 * - `approve` asks nobody. Full access uses it, and Codex never asks under the
 *   approval policy `never` anyway.
 *
 * Codex also has `auto` and `writes`, which let the server's own annotations
 * decide. Hercule never uses them.
 */
const MCP_TOOL_APPROVAL_MODES: Readonly<Record<AccessMode, "prompt" | "approve">> = {
  "approval-required": "prompt",
  "auto-accept-edits": "prompt",
  auto: "prompt",
  "full-access": "approve",
};

/**
 * What Hercule reads of a `config/read` reply: every layer of Codex's
 * configuration, with its source and its own settings. `layers` is `null`
 * when Codex was not asked for layers. A layer Codex found but does not use
 * yet, such as a project's `.codex/config.toml` that is not trusted, is
 * listed with its settings all the same.
 */
const ConfigReadReply = Schema.Struct({
  layers: Schema.Array(
    Schema.Struct({
      name: Schema.Struct({
        type: Schema.String,
        file: Schema.optional(Schema.String),
        dotCodexFolder: Schema.optional(Schema.String),
      }),
      config: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
});

type ConfigLayer = (typeof ConfigReadReply.Type)["layers"][number];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Returns the first layer whose settings have anything under
 * `mcp_servers.<name>`: the table, a key in it, or a nested key. Codex merges
 * every layer's table of a server name into one, so a repository that sets any
 * key of the gateway's name changes how the gateway behaves: its
 * `approval_mode` for one tool would lower the approval, and Codex has no way
 * to clear that key. Every layer counts, including a project's that is not
 * trusted yet: `thread/start` with a writable sandbox marks the project
 * trusted and merges its table on that same call, after the configuration was
 * read.
 */
const findLayerSettingServer = (
  layers: ReadonlyArray<ConfigLayer>,
  name: string,
): ConfigLayer | undefined =>
  layers.find(({ config }) => {
    const servers = config["mcp_servers"];
    return isRecord(servers) && Object.hasOwn(servers, name);
  });

/** Describes the file or folder a configuration layer comes from, for a message. */
const describeLayer = ({ name: source }: ConfigLayer): string => {
  if (source.type === "project" && source.dotCodexFolder !== undefined) {
    return `This repository's .codex/config.toml (${source.dotCodexFolder})`;
  }
  return source.file === undefined
    ? `Codex's ${source.type} configuration`
    : `The Codex configuration file ${source.file}`;
};

/**
 * Returns the warning for a session whose MCP server name is set in Codex's
 * own configuration, so the thread gets none of Hercule's MCP Servers. Names
 * the file and what to do about it.
 */
const buildMcpNameTakenWarning = (name: string, layer: ConfigLayer): string =>
  `${describeLayer(layer)} configures an MCP server named "${name}", the name Hercule gives ` +
  "its MCP Gateway, so this thread gets none of its MCP Servers. " +
  "Rename or remove that server there to use them.";

/**
 * Returns the warning for a session whose Codex configuration could not be
 * read, so Hercule cannot tell whether its MCP server name is taken. The
 * thread then gets none of Hercule's MCP Servers. `reason` is Codex's own
 * error message, or says that its reply was not understood.
 */
const buildMcpConfigUnreadWarning = (reason: string): string =>
  `Codex could not read its configuration (${reason}), so this thread gets none of ` +
  "Hercule's MCP Servers. Fix the configuration it names to use them.";

/**
 * Returns the `config` for these MCP servers, to send with `thread/start`,
 * `thread/resume` and `thread/fork`. The caller passes at least one server,
 * and only servers whose name no layer of Codex's configuration sets.
 *
 * - Each server gets its URL, and the name of the variable that holds the
 *   session's token, never the token: Codex reads the variable itself when it
 *   connects and sends the token as a bearer token.
 * - Each server gets the approval mode of `accessMode`.
 * - Codex is told to re-read a server's tool list when the server says it
 *   changed (`features.mcp_tool_list_changed`).
 *
 * Exported so the real-binary test starts Codex with exactly this config.
 * `decideMcpConfig` is what a session start calls.
 */
export const buildMcpServerConfig = (
  servers: ReadonlyArray<ResolvedMcpServer>,
  accessMode: AccessMode,
): Record<string, JsonValue> => ({
  ...Object.fromEntries(
    servers.flatMap((server): Array<[string, JsonValue]> => [
      [`mcp_servers.${server.name}.url`, server.url],
      [`mcp_servers.${server.name}.bearer_token_env_var`, SESSION_TOKEN_VARIABLE],
      [
        `mcp_servers.${server.name}.default_tools_approval_mode`,
        MCP_TOOL_APPROVAL_MODES[accessMode],
      ],
    ]),
  ),
  "features.mcp_tool_list_changed": true,
});

/** What `decideMcpConfig` decides for a session start. */
interface McpConfigDecision {
  /** The dotted keys to send with `thread/start`, `thread/resume` and `thread/fork`, or `undefined` to send no `config`. */
  readonly config: Record<string, JsonValue> | undefined;
  /** What to tell the user, to show once the session has started. */
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Decides which of the session's MCP servers the Codex thread gets, and
 * returns the `config` that gives them and the warnings to show. This is the
 * one place that decides, so all three ways to open a thread send the same.
 *
 * - With no server, makes no request and returns no config. Neither does a
 *   session whose servers all have a taken name.
 * - Asks Codex for its configuration as seen from `cwd`, and gives a server
 *   only when no layer of it already sets its name (see `findLayerSettingServer`).
 *   Each name that is taken gets a warning.
 * - When the reply cannot be read, the thread gets no server, because Hercule
 *   cannot tell whether the name is taken, and the warning says why. A reply is
 *   unread when the request failed, when `layers` is missing or invalid, and
 *   when a layer has no settings object. Codex then usually refuses to open the
 *   thread on the same configuration, and that failure reports it.
 *
 * Never fails.
 */
export const decideMcpConfig = (input: {
  readonly rpc: Rpc;
  readonly cwd: string | null;
  readonly servers: ReadonlyArray<ResolvedMcpServer>;
  readonly accessMode: AccessMode;
}): Effect.Effect<McpConfigDecision> => {
  const unread = (reason: string): McpConfigDecision => ({
    config: undefined,
    warnings: [buildMcpConfigUnreadWarning(reason)],
  });
  if (input.servers.length === 0) return Effect.succeed({ config: undefined, warnings: [] });
  return Effect.match(
    input.rpc.request("config/read", {
      cwd: input.cwd,
      includeLayers: true,
    } satisfies ConfigReadParams),
    {
      onFailure: (error) => unread(error.message),
      onSuccess: (reply): McpConfigDecision => {
        const decoded = Schema.decodeUnknownOption(ConfigReadReply)(reply);
        if (Option.isNone(decoded)) return unread("its reply to config/read was not understood");
        const { layers } = decoded.value;
        const warnings: Array<string> = [];
        const free: Array<ResolvedMcpServer> = [];
        for (const server of input.servers) {
          const taking = findLayerSettingServer(layers, server.name);
          if (taking === undefined) free.push(server);
          else warnings.push(buildMcpNameTakenWarning(server.name, taking));
        }
        return {
          config: free.length === 0 ? undefined : buildMcpServerConfig(free, input.accessMode),
          warnings,
        };
      },
    },
  );
};
