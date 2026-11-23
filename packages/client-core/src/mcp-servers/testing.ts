/**
 * Test fixtures for the MCP server models: a Sentry plugin and a Linear
 * plugin, three Connections (a work and a hobby Sentry account, and Linear),
 * and the servers on them. A work and a hobby Sentry server share the name
 * `sentry`, which is the case the models exist to handle.
 */
import {
  ERROR_STATUS,
  listDecodeIssues,
  McpServerSignInRedirectUri,
  McpServerToken,
  parseCallbackQuery,
  type ConflictDetails,
  type Connection,
  type InvalidStateDetails,
  type Issue,
  type McpServer,
  type McpServerSignInStart,
  type PluginDetail,
  type Project,
} from "@hercule/contract";
import { Result, Schema } from "effect";
import type { Answer, Handler } from "../api-stub";
import { suggestServerName } from "./add-by-url";
import { readServerAddress } from "./address.testing";
import { buildMcpServerViews, type McpServerView } from "./views";

const AT = "2026-11-20T09:00:00.000Z";

/** Returns a plugin that declares the Connection type `<id>/<id>` and the MCP server `<id>/<id>` reached with it. */
export const buildPlugin = (id: string, typeName: string): PluginDetail => ({
  id,
  displayName: typeName,
  hostApi: 1,
  capabilities: ["connections", "mcp-servers"],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [
    {
      extensionPoint: "connection-type",
      id: `${id}/${id}`,
      definition: { type: `${id}/${id}`, displayName: typeName, setup: [] },
    },
    {
      extensionPoint: "mcp-server",
      id: `${id}/${id}`,
      definition: {
        displayName: typeName,
        description: `The ${typeName} MCP server.`,
        connectionType: `${id}/${id}`,
        origin: `https://mcp.${id}.example`,
      },
    },
  ],
  intake: { eventKinds: [], signalKinds: [] },
  entityKinds: [],
});

export const SENTRY_PLUGIN = buildPlugin("sentry", "Sentry");
export const LINEAR_PLUGIN = buildPlugin("linear", "Linear");
export const OFFERING_PLUGINS: readonly PluginDetail[] = [SENTRY_PLUGIN, LINEAR_PLUGIN];

/** Returns a connected Connection of `type`, labelled `label`, that acts as `displayName`. */
export const buildConnection = (
  id: string,
  type: string,
  label: string,
  displayName = label,
): Connection => ({
  id,
  type,
  label,
  displayName,
  status: "connected",
  labels: [],
  config: {},
  feedIntervals: {},
  credentials: [],
  createdAt: AT,
  updatedAt: AT,
});

export const SENTRY_WORK_CONNECTION = buildConnection("c-work", "sentry/sentry", "work");
export const SENTRY_HOBBY_CONNECTION = buildConnection("c-hobby", "sentry/sentry", "hobby");
export const LINEAR_CONNECTION = buildConnection("c-linear", "linear/linear", "acme");
export const CONNECTIONS: readonly Connection[] = [
  SENTRY_WORK_CONNECTION,
  SENTRY_HOBBY_CONNECTION,
  LINEAR_CONNECTION,
];

/**
 * Returns a ready server named `name`, reached with the Connection
 * `connectionId` through the plugin of the same name, with two tools that
 * were listed at the last check. `overrides` change any field.
 */
export const buildServer = (
  id: string,
  name: string,
  connectionId: string,
  overrides: Partial<McpServer> = {},
): McpServer => ({
  id,
  name,
  source: { kind: "plugin", contributionId: `${name}/${name}`, connectionId },
  enabled: true,
  status: "ready",
  statusDetail: null,
  tools: [
    { name: "search", description: "Searches." },
    { name: "read", description: "Reads." },
  ],
  checkedAt: AT,
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

export const SENTRY_WORK = buildServer("s-work", "sentry", "c-work");
export const SENTRY_HOBBY = buildServer("s-hobby", "sentry", "c-hobby");
export const LINEAR = buildServer("s-linear", "linear", "c-linear");

/** Returns the views of `servers` on the fixture Connections and plugins. */
export const buildViews = (servers: readonly McpServer[]): McpServerView[] =>
  buildMcpServerViews(servers, CONNECTIONS, OFFERING_PLUGINS);

/** What a project needs to be in the fake controller's world. */
export interface FakeMcpProject {
  readonly id: string;
  readonly mcpServerIds: readonly string[];
}

/**
 * A browser sign-in that `mcpServer.startSignIn` began and `finishSignIn` has
 * not. The controller keeps one per server, in memory. A test that needs the
 * `state` to build the browser's return reads it here.
 */
export interface FakeSignInAttempt {
  /** The one-time `state` the browser's return must carry. */
  readonly state: string;
  readonly redirectUri: string;
  /** The address `startSignIn` answered, which the browser opens. */
  readonly authorizationUrl: string;
  readonly expiresAtMillis: number;
}

/** What the fake controller holds. A test changes it to play another client's write. */
export interface McpWorld<P extends FakeMcpProject = Project> {
  servers: McpServer[];
  projects: P[];
  /** The plugins the controller knows, which offer the servers a server can be made from or moved onto. */
  plugins: PluginDetail[];
  /** The Connections the user holds. The fake serves no list of them. */
  connections: Connection[];
  /** The setting `thread.mcpServerIds`, as stored: it may name a deleted server. */
  defaultIds: string[];
  /** The ids `mcpServer.check` was called on, in order. */
  checked: string[];
  /** The tokens given to `mcpServer.create` or `mcpServer.setToken` and accepted, in order. */
  tokens: { readonly id: string; readonly token: string }[];
  /** The browser sign-in that waits to be finished, by server id. */
  signIns: Map<string, FakeSignInAttempt>;
}

export interface McpWorldOptions<P extends FakeMcpProject = Project> {
  readonly servers: readonly McpServer[];
  readonly projects: readonly P[];
  readonly defaultIds?: readonly string[] | undefined;
  /** Defaults to the fixture plugins. */
  readonly plugins?: readonly PluginDetail[] | undefined;
  /** Defaults to the fixture Connections. */
  readonly connections?: readonly Connection[] | undefined;
}

/** Returns a world that holds copies of the lists in `options`. */
export const buildMcpWorld = <P extends FakeMcpProject = Project>(
  options: McpWorldOptions<P>,
): McpWorld<P> => ({
  servers: [...options.servers],
  projects: [...options.projects],
  plugins: [...(options.plugins ?? OFFERING_PLUGINS)],
  connections: [...(options.connections ?? CONNECTIONS)],
  defaultIds: [...(options.defaultIds ?? [])],
  checked: [],
  tokens: [],
  signIns: new Map(),
});

export interface McpControllerOptions {
  /** The ids that servers created through `mcpServer.create` get, in order. */
  readonly createdIds?: readonly string[];
  /** Settings the user holds besides `thread.mcpServerIds`, which every read returns too. */
  readonly otherUserSettings?: Readonly<Record<string, unknown>>;
}

/** How long a started browser sign-in can be finished, as in the controller. */
const SIGN_IN_LIFETIME_MILLIS = 10 * 60 * 1000;

/**
 * The error codes an authorization endpoint may send back (RFC 6749 section
 * 4.1.2.1). The refusal names the code only when it is one of these, as the
 * controller does.
 */
const STANDARD_AUTHORIZATION_ERRORS: ReadonlySet<string> = new Set([
  "invalid_request",
  "unauthorized_client",
  "access_denied",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
]);

/** The columns a write sets when a server's old result no longer holds. */
const BACK_TO_CHECKING = { status: "checking", statusDetail: null } as const;

/** The error envelope the controller sends: a code, a message and the details of that code. */
interface FakeError {
  readonly code: "validation" | "not_found" | "conflict" | "invalid_state";
  readonly message: string;
  readonly details?: ConflictDetails | InvalidStateDetails | { readonly issues: readonly Issue[] };
}

// The contract's error constructors check ids as UUIDs, and the fixtures of
// client-core use short ids, so the envelopes are built here instead.

const buildValidationError = (
  issues: readonly Issue[],
  message = "the request is not valid",
): FakeError => ({ code: "validation", message, details: { issues } });

const buildNotFoundError = (message: string): FakeError => ({ code: "not_found", message });

const buildConflictError = (message: string, details: ConflictDetails): FakeError => ({
  code: "conflict",
  message,
  details,
});

const buildInvalidStateError = (message: string, details?: InvalidStateDetails): FakeError => ({
  code: "invalid_state",
  message,
  ...(details === undefined ? {} : { details }),
});

/** Returns the answer the controller sends for `error`: its HTTP status and its envelope. */
const answerRefusal = (error: FakeError): Answer => ({
  status: ERROR_STATUS[error.code],
  body: { error },
});

const NO_SUCH_SERVER = "no such MCP server; `hercule mcp-server list` shows the servers there are";

const notFound = (): Answer => answerRefusal(buildNotFoundError(NO_SUCH_SERVER));

/**
 * Checks `value` against `schema`, as the controller's transport checks a
 * payload before the operation runs. Returns the `validation` answer, with
 * the issues on `path`, or `undefined` when the value is fine.
 */
const refuseInvalidValue = (
  schema: Schema.ConstraintDecoder<unknown>,
  value: unknown,
  path: readonly string[],
): Answer | undefined => {
  const result = Schema.decodeUnknownResult(schema)(value);
  return Result.isFailure(result)
    ? answerRefusal(
        buildValidationError(
          listDecodeIssues(result.failure).map((issue) => ({
            path: [...path, ...issue.path],
            message: issue.message,
          })),
        ),
      )
    : undefined;
};

/** What a plugin's `mcp-server` contribution declares, as far as the rules here read it. */
interface McpServerContribution {
  readonly id: string;
  readonly displayName: string;
  readonly connectionType: string;
  readonly origin: string;
}

/**
 * Compares a pasted address to the redirect address a sign-in started with,
 * as the controller does: the origin and the path count, the query does not,
 * and an address with a user name or a password never matches.
 */
const isRedirectAddress = (address: URL, redirectUri: string): boolean => {
  const expected = new URL(redirectUri);
  return (
    address.username === "" &&
    address.password === "" &&
    address.origin === expected.origin &&
    address.pathname === expected.pathname
  );
};

/**
 * Returns the handlers that play the controller on `world`: the MCP
 * servers' reads and writes, the projects' list and update, and the settings'
 * read and update. The handlers read the world when they answer, so a test
 * that changes the world changes the next answer. The Connections' and the
 * plugins' lists are not here: a test serves them as it needs, and the world
 * holds them for the rules below.
 *
 * The handlers of one server exist for each server the world holds when this
 * is called and for each of `createdIds`, so a test that adds a server to the
 * world calls this after.
 *
 * The rules are the controller's (`McpServerService` and its OAuth sign-in),
 * with the controller's refusals and words:
 *
 * - `mcpServer.create` refuses an address that is not an http or https
 *   address, or holds a user name, a password or a `#fragment`, a name that
 *   cannot be made from the address, and a token that breaks `McpServerToken`
 *   (`validation`). It refuses `conflict` (`mcp-server-exists`) for a second
 *   server of one contribution and Connection, or of one address, where two
 *   spellings of one address are one address. Otherwise it adds a server that
 *   is `checking` with no tools, under the next of `createdIds`. A server
 *   added by URL has no sign-in until a token is given.
 * - `mcpServer.update` takes `enabled` and `source` (Replace). Switching on
 *   puts the status back to `checking`. Replace moves a server added by URL
 *   onto a plugin's Connection, and refuses a server that is a plugin server
 *   already (`invalid_state`), a contribution or Connection that does not
 *   exist or does not fit, an address that is not on the contribution's
 *   origin (`validation`), and a second server for the Connection
 *   (`conflict`). It ends the server's waiting browser sign-in.
 * - `mcpServer.setToken` refuses a token that breaks `McpServerToken`
 *   (`validation`) and a plugin server (`invalid_state`). Otherwise it records
 *   the token, ends the server's waiting browser sign-in, and marks the server
 *   `checking` with a pasted token as its sign-in.
 * - `mcpServer.startSignIn` refuses a redirect address that breaks
 *   `McpServerSignInRedirectUri` (`validation`), a plugin server
 *   (`invalid_state`), and a server whose `signInOffered` is `token`
 *   (`sign-in-unsupported`). Otherwise it keeps an attempt in
 *   `world.signIns` with a fresh `state`, and replaces the server's older
 *   one. It answers an authorization address on the host `auth.<the
 *   server's host>` that carries the `state`, and the time the attempt runs
 *   out (ten minutes, by the clock `Date.now` reads).
 * - `mcpServer.finishSignIn` takes the whole address the browser ended on, or
 *   its query. It refuses text that is not a redirect answer (`validation`),
 *   an answer with no waiting attempt, an attempt that ran out, or another
 *   `state` (`sign-in-expired`), a whole address that is not the attempt's
 *   redirect address (`validation`, and the attempt stays), and an answer with
 *   an `error` instead of a `code` (`sign-in-refused`). An attempt is used
 *   once: any answer with its `state` takes it. Otherwise it marks the server
 *   `checking` with OAuth as its sign-in.
 * - `mcpServer.delete` drops the server from every project's list. It leaves
 *   the default list as stored, and reading the settings drops the ids of
 *   deleted servers, as the controller does.
 * - `mcpServer.check` marks the server `checking` and records the call. The
 *   test plays the check's end by changing the world and pushing `mcpServer`.
 */
export const buildMcpControllerHandlers = <P extends FakeMcpProject>(
  world: McpWorld<P>,
  options: McpControllerOptions = {},
): Record<string, Handler> => {
  const createdIds = options.createdIds ?? [];
  const replaceServer = (id: string, change: Partial<McpServer>): McpServer | undefined => {
    const current = world.servers.find((each) => each.id === id);
    if (current === undefined) return undefined;
    const next = { ...current, ...change };
    world.servers = world.servers.map((each) => (each.id === id ? next : each));
    return next;
  };
  const readSettings = () => ({
    controller: {},
    user: {
      ...options.otherUserSettings,
      "thread.mcpServerIds": world.defaultIds.filter((id) =>
        world.servers.some((each) => each.id === id),
      ),
    },
  });

  const buildPluginServerExistsConflict = (contributionId: string, existing: McpServer): Answer =>
    answerRefusal(
      buildConflictError(
        `This account already has an MCP server for ${contributionId}: ${existing.name} (${existing.id}). Use that server, or delete it first with \`hercule mcp-server delete ${existing.id}\`.`,
        { reason: "mcp-server-exists", mcpServerId: existing.id },
      ),
    );

  /** Returns the server of `contributionId` on `connectionId`, if there is one. The fake takes a Connection for the account behind it. */
  const findPluginServer = (contributionId: string, connectionId: string): McpServer | undefined =>
    world.servers.find(
      (each) =>
        each.source.kind === "plugin" &&
        each.source.contributionId === contributionId &&
        each.source.connectionId === connectionId,
    );

  /** Answers that a plugin server has no sign-in of its own: its credential is its Connection's. */
  const refuseForPluginServer = (connectionId: string): Answer => {
    const connection = world.connections.find((each) => each.id === connectionId);
    const reached =
      connection === undefined
        ? "a Connection of its plugin"
        : `the Connection ${connection.label}`;
    return answerRefusal(
      buildInvalidStateError(
        `this server is reached with ${reached}; reconnect that Connection in Settings > Connections instead`,
      ),
    );
  };

  /**
   * Finds the contribution and the Connection a plugin server is made of.
   * Returns the `validation` refusal when no plugin offers the contribution,
   * the Connection does not exist, or it is not of the type the contribution
   * is reached with.
   */
  const readPluginTarget = (
    contributionId: string,
    connectionId: string,
  ): { readonly contribution: McpServerContribution } | { readonly refusal: FakeError } => {
    const contribution = world.plugins
      .flatMap((plugin) => plugin.contributions)
      .find((each) => each.extensionPoint === "mcp-server" && each.id === contributionId);
    if (contribution === undefined) {
      return {
        refusal: buildValidationError([
          {
            path: ["source", "contributionId"],
            message: "no plugin offers an MCP server with this id",
          },
        ]),
      };
    }
    const definition = contribution.definition as Omit<McpServerContribution, "id">;
    const connection = world.connections.find((each) => each.id === connectionId);
    if (connection === undefined) {
      return {
        refusal: buildValidationError([
          { path: ["source", "connectionId"], message: "no such connection" },
        ]),
      };
    }
    if (connection.type !== definition.connectionType) {
      return {
        refusal: buildValidationError([
          {
            path: ["source", "connectionId"],
            message: `this server is reached with a ${definition.connectionType} connection, and this connection is a ${connection.type} connection`,
          },
        ]),
      };
    }
    return { contribution: { id: contributionId, ...definition } };
  };

  const createUrlServer = (
    id: string,
    source: { readonly url: string; readonly name?: string; readonly token?: string },
  ): Answer => {
    if (source.token !== undefined) {
      const invalid = refuseInvalidValue(McpServerToken, source.token, ["source", "token"]);
      if (invalid !== undefined) return invalid;
    }
    const address = readServerAddress(source.url);
    if ("refusal" in address) {
      return answerRefusal(
        buildValidationError([{ path: ["source", "url"], message: address.refusal }]),
      );
    }
    const holder = world.servers.find((each) => {
      if (each.source.kind !== "url") return false;
      const stored = readServerAddress(each.source.url);
      return "normalizedUrl" in stored && stored.normalizedUrl === address.normalizedUrl;
    });
    if (holder !== undefined) {
      return answerRefusal(
        buildConflictError(
          `You added this server before, as ${holder.name} (${holder.id}). One address is one server: use that one, or delete it first with \`hercule mcp-server delete ${holder.id}\`.`,
          { reason: "mcp-server-exists", mcpServerId: holder.id },
        ),
      );
    }
    const name = source.name ?? suggestServerName(address.url);
    if (name === null) {
      return answerRefusal(
        buildValidationError([
          {
            path: ["source", "name"],
            message: `The address's host ${new URL(address.url).hostname} gives no usable server name. Give the server a name of your own with --name. A name is 1 to 16 lowercase letters and digits, joined by single underscores, and is not hercule.`,
          },
        ]),
      );
    }
    if (source.token !== undefined) world.tokens.push({ id, token: source.token });
    const created = buildServer(id, name, "unused", {
      status: "checking",
      tools: [],
      checkedAt: null,
      source: {
        kind: "url",
        url: address.url,
        signIn: source.token === undefined ? "none" : "token",
        signInOffered: null,
      },
    });
    world.servers = [...world.servers, created];
    return { body: created };
  };

  const createPluginServer = (
    id: string,
    source: { readonly contributionId: string; readonly connectionId: string; name?: string },
  ): Answer => {
    const target = readPluginTarget(source.contributionId, source.connectionId);
    if ("refusal" in target) return answerRefusal(target.refusal);
    const existing = findPluginServer(source.contributionId, source.connectionId);
    if (existing !== undefined)
      return buildPluginServerExistsConflict(source.contributionId, existing);
    const created = buildServer(
      id,
      source.name ?? source.contributionId.slice(source.contributionId.lastIndexOf("/") + 1),
      source.connectionId,
      {
        status: "checking",
        tools: [],
        checkedAt: null,
        source: {
          kind: "plugin",
          contributionId: source.contributionId,
          connectionId: source.connectionId,
        },
      },
    );
    world.servers = [...world.servers, created];
    return { body: created };
  };

  /**
   * Moves the server `current`, which was added by URL, onto a plugin's
   * Connection (Replace). Returns the refusal, or the new server.
   */
  const replaceWithPluginSource = (
    current: McpServer,
    target: { readonly contributionId: string; readonly connectionId: string },
    enabled: boolean | undefined,
  ): Answer => {
    if (current.source.kind === "plugin") {
      return answerRefusal(
        buildInvalidStateError(
          "this server is already reached with a Connection; Replace moves a server added by address",
        ),
      );
    }
    const planned = readPluginTarget(target.contributionId, target.connectionId);
    if ("refusal" in planned) return answerRefusal(planned.refusal);
    const { contribution } = planned;
    if (new URL(current.source.url).origin !== contribution.origin) {
      return answerRefusal(
        buildValidationError([
          {
            path: ["source", "contributionId"],
            message: `this server's address is not on ${contribution.origin}, the address the ${contribution.displayName} server is reached at`,
          },
        ]),
      );
    }
    const existing = findPluginServer(target.contributionId, target.connectionId);
    if (existing !== undefined)
      return buildPluginServerExistsConflict(target.contributionId, existing);
    world.signIns.delete(current.id);
    return {
      body: replaceServer(current.id, {
        ...BACK_TO_CHECKING,
        enabled: enabled ?? current.enabled,
        source: {
          kind: "plugin",
          contributionId: target.contributionId,
          connectionId: target.connectionId,
        },
      }),
    };
  };

  const handlers: Record<string, Handler> = {
    "GET /api/v1/projects": () => ({ body: { items: world.projects } }),
    "GET /api/v1/settings": () => ({ body: readSettings() }),
    "PATCH /api/v1/settings": (call) => {
      world.defaultIds = (call.body as { user: { "thread.mcpServerIds": string[] } }).user[
        "thread.mcpServerIds"
      ];
      return { body: readSettings() };
    },
    "GET /api/v1/mcp-servers": () => ({
      body: { items: world.servers.toSorted((a, b) => a.name.localeCompare(b.name)) },
    }),
    "POST /api/v1/mcp-servers": (call) => {
      const { source } = call.body as {
        source:
          | { kind: "url"; url: string; name?: string; token?: string }
          | { kind: "plugin"; contributionId: string; connectionId: string; name?: string };
      };
      const id = createdIds[world.servers.filter((each) => createdIds.includes(each.id)).length]!;
      return source.kind === "url" ? createUrlServer(id, source) : createPluginServer(id, source);
    },
  };
  for (const id of [...world.servers.map((each) => each.id), ...createdIds]) {
    handlers[`GET /api/v1/mcp-servers/${id}`] = () => {
      const found = world.servers.find((each) => each.id === id);
      return found === undefined ? notFound() : { body: found };
    };
    handlers[`PATCH /api/v1/mcp-servers/${id}`] = (call) => {
      const { enabled, source } = call.body as {
        enabled?: boolean;
        source?: { kind: "plugin"; contributionId: string; connectionId: string };
      };
      if (enabled === undefined && source === undefined) {
        return answerRefusal(
          buildValidationError([{ path: ["enabled"], message: "give enabled or source" }]),
        );
      }
      const current = world.servers.find((each) => each.id === id);
      if (current === undefined) return notFound();
      if (source !== undefined) return replaceWithPluginSource(current, source, enabled);
      if (enabled === undefined || current.enabled === enabled) return { body: current };
      // Switching off leaves the status: a client shows Off from `enabled`.
      return { body: replaceServer(id, enabled ? { enabled, ...BACK_TO_CHECKING } : { enabled }) };
    };
    handlers[`POST /api/v1/mcp-servers/${id}/token`] = (call) => {
      const { token } = call.body as { token: string };
      const invalid = refuseInvalidValue(McpServerToken, token, ["token"]);
      if (invalid !== undefined) return invalid;
      const current = world.servers.find((each) => each.id === id);
      if (current === undefined) return notFound();
      if (current.source.kind !== "url") return refuseForPluginServer(current.source.connectionId);
      world.tokens.push({ id, token });
      world.signIns.delete(id);
      return {
        body: replaceServer(id, {
          ...BACK_TO_CHECKING,
          source: { ...current.source, signIn: "token" },
        }),
      };
    };
    handlers[`POST /api/v1/mcp-servers/${id}/sign-in`] = (call) => {
      const { redirectUri } = call.body as { redirectUri: string };
      const invalid = refuseInvalidValue(McpServerSignInRedirectUri, redirectUri, ["redirectUri"]);
      if (invalid !== undefined) return invalid;
      const current = world.servers.find((each) => each.id === id);
      if (current === undefined) return notFound();
      if (current.source.kind !== "url") return refuseForPluginServer(current.source.connectionId);
      if (current.source.signInOffered === "token") {
        return answerRefusal(
          buildInvalidStateError(
            `${current.name} cannot be signed in through the browser: it offers no sign-in through the browser. Paste a token instead: hercule mcp-server set-token ${id}`,
            { reason: "sign-in-unsupported" },
          ),
        );
      }
      // The authorization server is another host than the MCP server, as it is in practice.
      const authorizationUrl = new URL(
        "/authorize",
        `https://auth.${new URL(current.source.url).host}`,
      );
      const state = crypto.randomUUID();
      authorizationUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: "fake-client",
        redirect_uri: redirectUri,
        state,
      }).toString();
      const attempt: FakeSignInAttempt = {
        state,
        redirectUri,
        authorizationUrl: authorizationUrl.href,
        expiresAtMillis: Date.now() + SIGN_IN_LIFETIME_MILLIS,
      };
      world.signIns.set(id, attempt);
      return {
        body: {
          authorizationUrl: attempt.authorizationUrl,
          expiresAt: new Date(attempt.expiresAtMillis).toISOString(),
        } satisfies McpServerSignInStart,
      };
    };
    handlers[`POST /api/v1/mcp-servers/${id}/sign-in/finish`] = (call) => {
      const { callbackQuery } = call.body as { callbackQuery: string };
      const current = world.servers.find((each) => each.id === id);
      if (current === undefined) return notFound();
      if (current.source.kind !== "url") return refuseForPluginServer(current.source.connectionId);
      const callback = parseCallbackQuery(callbackQuery);
      if (callback._tag === "Refused") {
        return answerRefusal(
          buildValidationError([{ path: ["callbackQuery"], message: callback.reason }]),
        );
      }
      const attempt = world.signIns.get(id);
      if (
        attempt === undefined ||
        attempt.expiresAtMillis <= Date.now() ||
        attempt.state !== callback.state
      ) {
        if (attempt !== undefined && attempt.expiresAtMillis <= Date.now()) {
          world.signIns.delete(id);
        }
        return answerRefusal(
          buildInvalidStateError(
            `This sign-in can no longer be finished: it ran out (it lasts ten minutes), a newer sign-in replaced it, or the server's sign-in changed. Start it again: hercule mcp-server sign-in ${id}`,
            { reason: "sign-in-expired" },
          ),
        );
      }
      if (
        callback.address !== undefined &&
        !isRedirectAddress(callback.address, attempt.redirectUri)
      ) {
        return answerRefusal(
          buildValidationError([
            {
              path: ["callbackQuery"],
              message:
                "this address is not the redirect address of the sign-in that waits: paste the address the browser ended on after you signed in to this server",
            },
          ]),
        );
      }
      world.signIns.delete(id);
      if (callback.code === undefined) {
        const { error } = callback;
        return answerRefusal(
          buildInvalidStateError(
            `${
              error !== undefined && STANDARD_AUTHORIZATION_ERRORS.has(error)
                ? `The authorization server did not sign you in (${error}).`
                : "The authorization server did not sign you in."
            } Start the sign-in again.`,
            { reason: "sign-in-refused" },
          ),
        );
      }
      return {
        body: replaceServer(id, {
          ...BACK_TO_CHECKING,
          source: { ...current.source, signIn: "oauth", signInOffered: "oauth" },
        }),
      };
    };
    handlers[`DELETE /api/v1/mcp-servers/${id}`] = () => {
      world.servers = world.servers.filter((each) => each.id !== id);
      world.signIns.delete(id);
      world.projects = world.projects.map((project) => ({
        ...project,
        mcpServerIds: project.mcpServerIds.filter((each) => each !== id),
      }));
      return { body: {} };
    };
    handlers[`POST /api/v1/mcp-servers/${id}/check`] = () => {
      world.checked.push(id);
      replaceServer(id, { status: "checking" });
      return { body: {} };
    };
  }
  for (const { id } of world.projects) {
    handlers[`PATCH /api/v1/projects/${id}`] = (call) => {
      const { mcpServerIds } = call.body as { mcpServerIds: string[] };
      const index = world.projects.findIndex((each) => each.id === id);
      const next = { ...world.projects[index]!, mcpServerIds };
      world.projects[index] = next;
      return { body: next };
    };
  }
  return handlers;
};
