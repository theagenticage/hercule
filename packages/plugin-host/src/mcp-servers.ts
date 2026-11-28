import { Schema } from "effect";
import { ContributionName } from "./contributions";

/**
 * The longest an MCP Server's name may be. The name is the prefix of every
 * tool the server offers to a session, so a long one eats the tool name's
 * length budget.
 */
export const MAX_MCP_SERVER_NAME_LENGTH = 16;

/**
 * The name `hercule` is kept for the platform's own tools, so no MCP Server
 * can take it as its name.
 */
const RESERVED_MCP_SERVER_NAME = "hercule";

/**
 * The rule of an MCP Server's name, which every client and every plugin
 * follows:
 *
 * - lowercase letters and digits, in groups joined by a single `_`, because
 *   `-` and `.` do not survive Codex's tool names and `__` separates the name
 *   from the tool in a tool name;
 * - 1 to 16 characters;
 * - not `hercule`.
 *
 * A contribution's `id` follows it too, because the id is the default name of
 * the server the user creates from it.
 */
export const McpServerName = Schema.String.check(
  Schema.isBetweenLength(1, MAX_MCP_SERVER_NAME_LENGTH, {
    message: `An MCP server name must be 1 to ${String(MAX_MCP_SERVER_NAME_LENGTH)} characters long, because it is the prefix of every tool the server offers. A contribution's id is the default name, so it follows the same rule.`,
  }),
  Schema.isPattern(/^[a-z0-9]+(_[a-z0-9]+)*$/, {
    message:
      "An MCP server name may hold only lowercase letters, digits and single _ characters between them, because it is the prefix of its tool names. A contribution's id is the default name, so it follows the same rule.",
  }),
  Schema.makeFilter(
    (name) =>
      name === RESERVED_MCP_SERVER_NAME
        ? `An MCP server name cannot be ${RESERVED_MCP_SERVER_NAME}, because that name is kept for the platform's own tools. Choose another name.`
        : undefined,
    { title: `not ${RESERVED_MCP_SERVER_NAME}` },
  ),
);

export type McpServerName = Schema.Schema.Type<typeof McpServerName>;

/**
 * An origin written the way `URL.origin` writes it: a lowercase `http` or
 * `https` scheme, the host, and a port only when it is not the scheme's
 * default. A path (even a lone `/`), a query, a fragment, a user name and a
 * password all fail, because none of them is part of an origin.
 */
export const McpServerOrigin = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const parsed = URL.canParse(value) ? new URL(value) : undefined;
      const isOrigin =
        parsed !== undefined &&
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.origin === value;
      return isOrigin
        ? undefined
        : "An MCP server origin must be exactly the scheme (http or https), the host and an optional port, such as https://mcp.example.com. It cannot have a path, a query, a user name or a password, and a default port is left out.";
    },
    { title: "origin" },
  ),
);

/** The longest description of an MCP server contribution. It is one line in a list, not a paragraph. */
export const MAX_MCP_SERVER_DESCRIPTION_LENGTH = 256;

/**
 * The declarative part of an MCP server contribution: every field except
 * `buildUpstreamRequest`, which is code. The host validates a contribution
 * against this schema and stores it in the catalog with `connectionType`
 * qualified.
 */
export const McpServerDeclaration = Schema.Struct({
  id: McpServerName,
  displayName: ContributionName,
  description: Schema.String.check(
    Schema.isBetweenLength(1, MAX_MCP_SERVER_DESCRIPTION_LENGTH),
    Schema.isPattern(/^[^\r\n]+$/, { message: "An MCP server description must be one line." }),
  ),
  connectionType: ContributionName,
  origin: McpServerOrigin,
});

/**
 * The Connection a plugin's `buildUpstreamRequest` builds a request from: its
 * decoded credentials and its config, read fresh by the core just before the
 * call.
 */
export interface McpServerConnection {
  readonly credentials: Record<string, string>;
  readonly config: unknown;
}

/**
 * Offers one vendor's MCP server to sessions, reached with a Connection of the
 * same plugin. Registering it creates no server: the user switches one on.
 */
export interface McpServerContribution {
  /** The bare word, such as `sentry`. The host qualifies it as `<pluginId>/<id>`. */
  readonly id: string;
  readonly displayName: string;
  /** One line, shown in Settings > MCP servers. */
  readonly description: string;
  /**
   * The Connection type the server is reached with. Must be a Connection type
   * this plugin registers, written as the host qualifies it (`sentry/sentry`).
   */
  readonly connectionType: string;
  /** Scheme, host and optional port of the vendor's server, such as `https://mcp.sentry.dev`. */
  readonly origin: string;
  /**
   * Builds the URL and the headers of a call to the vendor's server. Pure: no
   * I/O. The URL must be on `origin`. The core passes it the Connection's
   * decoded credentials and config, and the result never reaches the catalog
   * or the API.
   */
  readonly buildUpstreamRequest: (connection: McpServerConnection) => {
    readonly url: string;
    readonly headers: Record<string, string>;
  };
}
