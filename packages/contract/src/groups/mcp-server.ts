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
 * The longest MCP Server name. A tool's name for the model is the server's
 * name and the tool's name joined, and a harness limits that whole name, so a
 * long server name would leave no room for the tool's.
 */
export const MAX_MCP_SERVER_NAME_LENGTH = 16;

/** The name kept for Hercule's own tools. */
const RESERVED_MCP_SERVER_NAME = "hercule";

/**
 * What a client calls an MCP Server: lowercase letters and digits with a
 * single `_` between them, 1 to 16 characters, and not `hercule`.
 *
 * There is no `-` or `.`, because Codex turns them into `_`. There is no
 * double underscore, because that separates the server's name from the
 * tool's in the gateway's tool names (spec 21 section 2.2).
 */
export const McpServerName = Schema.String.check(
  Schema.isBetweenLength(1, MAX_MCP_SERVER_NAME_LENGTH),
  Schema.isPattern(/^[a-z0-9]+(_[a-z0-9]+)*$/, {
    expected: "lowercase letters and digits, in groups joined by single underscores",
  }),
  Schema.makeFilter((name) =>
    name === RESERVED_MCP_SERVER_NAME
      ? `The name ${RESERVED_MCP_SERVER_NAME} is kept for Hercule's own tools. Choose another name.`
      : undefined,
  ),
);

export type McpServerName = Schema.Schema.Type<typeof McpServerName>;

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
    // - `not_found`: no such Connection, or it is not of the contribution's
    //   plugin.
    // - `conflict`: a server of this contribution and account exists.
    // - `validation`: the name breaks the rules of `McpServerName`.
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
