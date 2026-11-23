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
 * A server comes from a plugin's contribution, reached with one of the
 * plugin's Connections, or from an address the user gave, reached with a
 * sign-in the server holds itself.
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
 * A token an MCP server added by address is reached with: one a user pastes,
 * or the access token of an OAuth sign-in. It is at least 8 printable ASCII
 * characters with no space, and not a part of `[removed]`.
 *
 * The limits are not only manners. Hercule replaces a secret it finds in what
 * a server sends with `[removed]`, so a token that is a part of that marker
 * would make the marker look like the secret. A token with spaces could be
 * trimmed by `fetch` in the `Authorization` header while Hercule looks for the
 * untrimmed text, so the secret would not be found. RFC 6750's stricter
 * `b64token` is not required: real servers issue tokens outside it (Notion's
 * hold `:`), and any printable character goes in a header as it is.
 */
export const McpServerToken = Schema.String.check(
  Schema.makeFilter((token) =>
    /^[\x21-\x7E]+$/.test(token) && token.length >= 8 && !"[removed]".includes(token)
      ? undefined
      : "A token is at least 8 printable characters with no spaces. Paste the token alone, without `Bearer ` in front of it.",
  ),
);

/**
 * Where an MCP Server is reached from:
 *
 * - `plugin`: a server a plugin offers, reached with the credential of one of
 *   the plugin's Connections.
 * - `url`: a server the user added by its address. `url` is the address as the
 *   URL standard writes it (`https:a.com/mcp` is `https://a.com/mcp`), and the
 *   one requests go to. `signIn` is what the server
 *   holds now: `none`, a pasted `token`, or `oauth` tokens from signing in.
 *   `signInOffered` is what the server said it accepts the last time it
 *   refused a request with HTTP 401: `oauth` when its answer names an
 *   authorization server, and `token` when only a pasted token can help. It is
 *   `null` until a request has been refused, and a later success does not
 *   clear it. A client reads it to show the token field or a sign-in through
 *   the browser when the status is `needs-sign-in`.
 */
export const McpServerSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("plugin"),
    /** The plugin's MCP server contribution. */
    contributionId: QualifiedContributionId,
    connectionId: Id,
  }),
  Schema.Struct({
    kind: Schema.Literal("url"),
    url: Schema.String,
    signIn: Schema.Literals(["none", "token", "oauth"]),
    signInOffered: Schema.NullOr(Schema.Literals(["oauth", "token"])),
  }),
]);

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
 * server. Left out, it is the contribution's own word for a plugin server,
 * and the first part of the address's host that is not `mcp`, `www` or `api`
 * for a server added by URL.
 *
 * `url` is any text here: the service checks it and says what is wrong. A
 * `token` (see `McpServerToken`) is stored as the server's sign-in before the
 * first check, so the check already carries it.
 */
export const McpServerCreateInput = closedStruct({
  source: Schema.Union([
    closedStruct({
      kind: Schema.Literal("plugin"),
      contributionId: QualifiedContributionId,
      connectionId: Id,
      name: Schema.optionalKey(McpServerName),
    }),
    closedStruct({
      kind: Schema.Literal("url"),
      url: Schema.String,
      name: Schema.optionalKey(McpServerName),
      token: Schema.optionalKey(McpServerToken),
    }),
  ]),
});

export type McpServerCreateInput = Schema.Schema.Type<typeof McpServerCreateInput>;

/**
 * The payload of `mcpServer.update`. A payload with no field is refused as
 * `validation` by the service, not by this schema.
 *
 * `source` is Replace: it moves a server added by address onto a plugin's
 * Connection, and only that move exists, so it has the plugin shape alone. It
 * keeps the server's id, name and every list that names it.
 */
export const McpServerUpdateInput = closedStruct({
  enabled: Schema.optionalKey(Schema.Boolean),
  source: Schema.optionalKey(
    closedStruct({
      kind: Schema.Literal("plugin"),
      contributionId: QualifiedContributionId,
      connectionId: Id,
    }),
  ),
});

export type McpServerUpdateInput = Schema.Schema.Type<typeof McpServerUpdateInput>;

/** The payload of `mcpServer.setToken`: the token the user pasted for the server. */
export const McpServerSetTokenInput = closedStruct({ token: McpServerToken });

export type McpServerSetTokenInput = Schema.Schema.Type<typeof McpServerSetTokenInput>;

/**
 * The address the browser returns to after a sign-in: exactly
 * `http://127.0.0.1:<port>/callback`, with a port from 1 to 65535. Nothing else
 * is a redirect address: not another spelling of the loopback host, not user
 * information, a query or a fragment. A client that catches the return listens
 * on that port. A client that cannot listen (the web app) picks a port nothing
 * listens on, and the user pastes the address the browser ended on.
 */
export const McpServerSignInRedirectUri = Schema.String.check(
  Schema.makeFilter((uri) => {
    const port = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/callback$/.exec(uri)?.[1];
    return port !== undefined && Number(port) <= 65535
      ? undefined
      : "A redirect address is exactly http://127.0.0.1:<port>/callback, with a port from 1 to 65535, and no user name, query or fragment.";
  }),
);

export type McpServerSignInRedirectUri = Schema.Schema.Type<typeof McpServerSignInRedirectUri>;

/** The payload of `mcpServer.startSignIn`: the address the browser returns to. */
export const McpServerStartSignInInput = closedStruct({ redirectUri: McpServerSignInRedirectUri });

export type McpServerStartSignInInput = Schema.Schema.Type<typeof McpServerStartSignInInput>;

/**
 * What `mcpServer.startSignIn` answers: the address to open in a browser, and
 * the time after which the sign-in cannot be finished. The address holds a
 * one-time `state`, and nothing a client may keep.
 */
export const McpServerSignInStart = Schema.Struct({
  authorizationUrl: Schema.String,
  expiresAt: Timestamp,
});

export type McpServerSignInStart = Schema.Schema.Type<typeof McpServerSignInStart>;

/**
 * The payload of `mcpServer.finishSignIn`: what the browser was sent back
 * with. It is the whole address the browser ended on, or only its query string
 * (`code`, `state` and `iss`, or `error`). The text holds the sign-in's
 * one-time code, so it is never logged or kept.
 */
export const McpServerFinishSignInInput = closedStruct({ callbackQuery: Schema.NonEmptyString });

export type McpServerFinishSignInInput = Schema.Schema.Type<typeof McpServerFinishSignInInput>;

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
    // - `conflict`: details say which. `mcp-server-exists`: a server of this
    //   contribution and account, or of this address, exists. For an address,
    //   two spellings of one address are one address: the scheme and host
    //   case, the default port and one trailing `/` do not count.
    //   `mcp-server-on-plugin-origin`: the address is one a plugin offers a
    //   server for, so the server is made from the plugin's Connection.
    // - `validation`: the name breaks the rules of `McpServerName`, or none
    //   can be made from the address's host; the address is not http or
    //   https, holds a user name or password, or ends in a `#fragment`; no
    //   plugin offers the contribution, or the Connection does not exist or
    //   is not of the contribution's Connection type.
    HttpApiEndpoint.post("create", "/mcp-servers", {
      payload: McpServerCreateInput,
      success: McpServer,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Conflict, Internal],
    }),
    // Switches the server on or off, or moves a server added by address onto
    // a plugin's Connection (Replace), or both in one call.
    //
    // - `validation`: the payload gives no field; or, for `source`, no plugin
    //   offers the contribution, the Connection does not exist or is not of
    //   its type, or the server's address is not on the contribution's origin.
    // - `conflict`: details say `mcp-server-exists`, naming the plugin server
    //   the contribution already has for the Connection's account.
    // - `invalid_state`: `source` is given and the server is a plugin server
    //   already.
    HttpApiEndpoint.patch("update", "/mcp-servers/:id", {
      params,
      payload: McpServerUpdateInput,
      success: McpServer,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Conflict, InvalidState, Internal],
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
    // Gives a server added by URL the token the user pasted for it, replacing
    // any sign-in it holds. The server goes to `checking`, on or off. A server
    // that is on lists its tools again with the token; a server that is
    // switched off is checked with the token when it is switched on.
    // Answers with the server.
    //
    // - `invalid_state`: the server is a plugin server, which is reached with
    //   its Connection's credential.
    HttpApiEndpoint.post("setToken", "/mcp-servers/:id/token", {
      params,
      payload: McpServerSetTokenInput,
      success: McpServer,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    // Starts the sign-in of a server added by URL, through its OAuth server,
    // and answers the address to open in a browser. It changes nothing stored:
    // the attempt lives in the controller's memory for ten minutes, and a newer
    // start for the same server replaces it.
    //
    // - `validation`: the redirect address is not the exact loopback form.
    // - `invalid_state`: the details say which. No details: the server is a
    //   plugin server, which is reached with its Connection's credential.
    //   `sign-in-unsupported`: the server offers no sign-in through the browser.
    //   `sign-in-expired`: a newer start or another sign-in for this server
    //   overtook this start while it was discovering; start again.
    //   `source-unreadable`: the server or its authorization server could not be
    //   reached, or answered what OAuth does not allow; trying again later may
    //   work.
    HttpApiEndpoint.post("startSignIn", "/mcp-servers/:id/sign-in", {
      params,
      payload: McpServerStartSignInInput,
      success: McpServerSignInStart,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    // Finishes a sign-in that `startSignIn` began, with what the browser came
    // back with, and answers with the server, in status `checking` with sign-in
    // `oauth`. A server that is on lists its tools again with the new tokens.
    //
    // - `validation`: the text is not a redirect answer: it has no `state`,
    //   repeats a parameter, holds both or neither of `code` and `error`, or is
    //   an address for another redirect address than the one the sign-in used.
    // - `invalid_state`: the details say which. `sign-in-expired`: no sign-in
    //   of this server waits for that `state` (it ran out, was replaced, or the
    //   server's sign-in changed); start again. `sign-in-refused`: the user or
    //   the provider said no, the provider refused the code, or the answer came
    //   from another issuer. `sign-in-unsupported`: the authorization server
    //   issued an access token that is not a bearer token, so only a pasted
    //   token works for this server. `source-unreadable`: the token endpoint
    //   could not be reached; the sign-in is used up, so start again. No
    //   details: the server is a plugin server.
    HttpApiEndpoint.post("finishSignIn", "/mcp-servers/:id/sign-in/finish", {
      params,
      payload: McpServerFinishSignInInput,
      success: McpServer,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
