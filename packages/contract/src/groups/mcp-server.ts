/**
 * MCP Servers: the remote servers that offer tools to sessions, reached
 * through the MCP Gateway (spec 11 section 2, `mcpServer`; spec 21).
 *
 * The record holds where the server is reached from, the user's on/off
 * switch, and what the last check found: a status and the tools the server
 * listed. A server's name is fixed at creation. Every change to a record,
 * including one a check makes, reaches clients through the live topic
 * `mcpServer`.
 *
 * Only servers a plugin offers exist so far. A server added by its address
 * has its own source kind, built later.
 */
import { Schema } from "effect";
import { McpServerName } from "@hercule/plugin-host";
import { McpServerLeftOutReason } from "@hercule/protocol";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { closedStruct } from "../closed";
import {
  Conflict,
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { Id, isQualifiedId, Timestamp } from "../ids";
import { Authenticated } from "../security";

/**
 * The name rule of an MCP Server is owned by the plugin host, because a
 * plugin's contribution id follows it too: it is the default name of the
 * server. Clients get it from here.
 */
export { MAX_MCP_SERVER_NAME_LENGTH, McpServerName } from "@hercule/plugin-host";

/**
 * What a check or a sign-in last found:
 *
 * - `checking`: a list of the server's tools is running or about to run;
 * - `ready`: the last list succeeded;
 * - `needs-sign-in`: the server refused the credential Hercule holds for it;
 * - `unreachable`: the server could not be reached;
 * - `error`: the server answered in a way Hercule could not use.
 *
 * A switched-off server has no status of its own: `enabled` says it.
 */
export const McpServerStatus = Schema.Literals([
  "checking",
  "ready",
  "needs-sign-in",
  "unreachable",
  "error",
]);

export type McpServerStatus = Schema.Schema.Type<typeof McpServerStatus>;

/**
 * Why a server in a session's list could not be called at the session's last
 * start (spec 21 section 3.8). The protocol owns it, because a
 * `runtime.warning` names the same reasons. A client reads it to say what to
 * do:
 *
 * - `harness-unsupported`: the session's harness cannot be given MCP servers;
 * - `runner-too-old`: the session's harness can be given them, but its runner
 *   does not support that harness's MCP servers;
 * - `missing-grant`: the session's Permission Profile lacks `mcp.use`;
 * - `switched-off`: the server's `enabled` is false;
 * - `checking`: the server's first list of tools has not ended;
 * - `needs-sign-in`, `unreachable`, `error`: the server's status at that start.
 *
 * When several reasons apply, the first in this order is the one recorded.
 */
export { McpServerLeftOutReason } from "@hercule/protocol";

/**
 * A list of MCP Server ids, as a Project, a session or the thread default
 * holds one. The list is in the order the caller gave. The id rules (the
 * servers exist, none twice, no two of one name) are the service's.
 */
export const McpServerIds = Schema.Array(Id);

/**
 * One entry of a session's own list of MCP Servers.
 *
 * `name` is the server's name when the entry was written and never changes.
 * `leftOut` is why the last start could not call the server, or `null` when it
 * could, and also for an entry added since that start.
 */
export const SessionMcpServer = Schema.Struct({
  mcpServerId: Id,
  name: McpServerName,
  leftOut: Schema.NullOr(McpServerLeftOutReason),
});

export type SessionMcpServer = Schema.Schema.Type<typeof SessionMcpServer>;

/** A contribution's id, qualified with its plugin's id, such as `sentry/sentry`. */
const QualifiedContributionId = Schema.String.check(
  Schema.makeFilter((id) =>
    isQualifiedId(id)
      ? undefined
      : "Write a contribution id as <plugin id>/<contribution>, such as sentry/sentry.",
  ),
);

/**
 * Where an MCP Server is reached from: a server a plugin offers, reached with
 * the credential of one of the plugin's Connections.
 */
export const McpServerSource = Schema.Struct({
  kind: Schema.Literal("plugin"),
  /** The plugin's MCP server contribution. */
  contributionId: QualifiedContributionId,
  connectionId: Id,
});

export type McpServerSource = Schema.Schema.Type<typeof McpServerSource>;

/** The public summary of one tool a server offers. */
export const McpServerTool = Schema.Struct({
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.String,
});

export type McpServerTool = Schema.Schema.Type<typeof McpServerTool>;

/** An MCP Server. */
export const McpServer = Schema.Struct({
  id: Id,
  name: McpServerName,
  source: McpServerSource,
  /** The user's switch. Off is `false`, never a delete. */
  enabled: Schema.Boolean,
  status: McpServerStatus,
  /** The reason for the status in words a person can act on, or `null`. */
  statusDetail: Schema.NullOr(Schema.String),
  /** What the server listed when it was last checked successfully. */
  tools: Schema.Array(McpServerTool),
  /** The time of the last successful list, or `null`. */
  checkedAt: Schema.NullOr(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type McpServer = Schema.Schema.Type<typeof McpServer>;

/**
 * The payload of `mcpServer.create`. `name` is the one a client gives the
 * server; left out, it is the contribution's own word.
 */
export const McpServerCreateInput = closedStruct({
  source: closedStruct({
    kind: Schema.Literal("plugin"),
    contributionId: QualifiedContributionId,
    connectionId: Id,
    name: Schema.optionalKey(McpServerName),
  }),
});

export type McpServerCreateInput = Schema.Schema.Type<typeof McpServerCreateInput>;

/**
 * The payload of `mcpServer.update`. A payload with no field is refused as
 * `validation` by the service, not by this schema.
 */
export const McpServerUpdateInput = closedStruct({
  enabled: Schema.optionalKey(Schema.Boolean),
});

export type McpServerUpdateInput = Schema.Schema.Type<typeof McpServerUpdateInput>;

const params = { id: Id };

export const mcpServer = HttpApiGroup.make("mcpServer")
  .add(
    // Every server, sorted by name. A user has few, so it is not paged and
    // takes no filter.
    HttpApiEndpoint.get("query", "/mcp-servers", {
      success: Schema.Struct({ items: Schema.Array(McpServer) }),
      error: [Unauthenticated, Forbidden, Internal],
    }),
    HttpApiEndpoint.get("read", "/mcp-servers/:id", {
      params,
      success: McpServer,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    // Answers at once with the server in status `checking`.
    //
    // - `conflict`: a server of this contribution and account exists.
    // - `validation`: the name breaks the rules of `McpServerName`, no plugin
    //   offers the contribution, or the Connection does not exist or is not
    //   of the contribution's Connection type.
    HttpApiEndpoint.post("create", "/mcp-servers", {
      payload: McpServerCreateInput,
      success: McpServer,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Conflict, Internal],
    }),
    // `validation`: the payload gives no field.
    HttpApiEndpoint.patch("update", "/mcp-servers/:id", {
      params,
      payload: McpServerUpdateInput,
      success: McpServer,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.delete("delete", "/mcp-servers/:id", {
      params,
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    // Starts a new list of the server's tools and answers at once; the
    // result reaches clients through the live topic.
    //
    // - `invalid_state`: the server is switched off.
    HttpApiEndpoint.post("check", "/mcp-servers/:id/check", {
      params,
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
