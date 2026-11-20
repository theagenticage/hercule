/**
 * Why an MCP Server in a session's list could not be called at the session's
 * last start (spec 21 section 3.8), and the words the Thread says it in.
 */
import type { McpServerStatus } from "@hercule/contract";
import { MAX_FACT_ITEMS, type McpServerLeftOutReason } from "@hercule/protocol";

/** What one start decides for every server of the session's list alike. */
export interface StartDelivery {
  /** Whether the session's runner negotiated the `mcpServers` capability. */
  readonly runnerReachesMcpServers: boolean;
  /** The session's harness's declared `mcpPassthrough`. */
  readonly harnessPassthrough: "native" | "unsupported";
  /** Whether the grants of the session's permission profile include `mcp.use`. */
  readonly profileGrantsMcpUse: boolean;
}

/**
 * What decides a left-out reason for one server: the user's switch and its
 * status. At a start the status is the current one, with the state of the
 * server's Connection and plugin folded in (`readCurrentAvailability`).
 */
export interface ServerAvailability {
  readonly enabled: boolean;
  readonly status: McpServerStatus;
}

/**
 * Returns why the server cannot be called at a start, or `null` when it can.
 * When several reasons apply, it returns the first of this order, which is the
 * order of spec 21 section 3.8:
 *
 * 1. `runner-too-old`
 * 2. `harness-unsupported`
 * 3. `missing-grant`
 * 4. `switched-off`
 * 5. the server's status, when it is not `ready`: `checking` (its first list
 *    has not ended), `needs-sign-in`, `unreachable` or `error`
 *
 * A server whose plugin or Connection is switched off has the status `error`,
 * so it needs no reason of its own.
 */
export const decideLeftOutReason = (
  delivery: StartDelivery,
  server: ServerAvailability,
): McpServerLeftOutReason | null => {
  if (!delivery.runnerReachesMcpServers) return "runner-too-old";
  if (delivery.harnessPassthrough === "unsupported") return "harness-unsupported";
  if (!delivery.profileGrantsMcpUse) return "missing-grant";
  if (!server.enabled) return "switched-off";
  return server.status === "ready" ? null : server.status;
};

const REASON_WORDS: Readonly<Record<McpServerLeftOutReason, string>> = {
  "runner-too-old": "its runner is too old to reach MCP servers",
  "harness-unsupported": "its harness cannot be given MCP servers",
  "missing-grant": "its permission profile lacks the mcp.use grant",
  "switched-off": "switched off",
  checking: "still being checked",
  "needs-sign-in": "needs sign-in",
  unreachable: "unreachable",
  error: "failed its last check",
};

/**
 * The most servers the message of a warning names in words. A list has no
 * length limit, and a message that names every server of a very long list
 * would not be read anyway. The structured entries of the warning are bounded
 * on their own, by the wire limit `MAX_FACT_ITEMS`.
 */
const MAX_NAMED_LEFT_OUT = 20;

/** One server a start left out: which one, its name in the list, and why. */
export interface LeftOutServer {
  readonly mcpServerId: string;
  readonly name: string;
  readonly reason: McpServerLeftOutReason;
}

/**
 * Builds the `runtime.warning` a start writes for the servers it left out: a
 * message that names servers and their reasons in words, and the `mcpServers`
 * field that names them for a client. For example, "MCP servers not available
 * in this session: sentry (its runner is too old to reach MCP servers), linear
 * (needs sign-in)".
 *
 * - The message names the first 20 servers and ends with "and N more" for the
 *   rest.
 * - The field holds the first 64 servers, the most the wire allows, so each
 *   of them gets its fix button. When more than 64 are left out, the message
 *   also says how many of them are not in the field.
 */
export const buildLeftOutWarning = (
  leftOut: ReadonlyArray<LeftOutServer>,
): {
  readonly message: string;
  readonly mcpServers: ReadonlyArray<Pick<LeftOutServer, "mcpServerId" | "reason">>;
} => {
  const named = leftOut.slice(0, MAX_NAMED_LEFT_OUT);
  const forClient = leftOut.slice(0, MAX_FACT_ITEMS);
  const omitted = leftOut.length - named.length;
  const withoutEntry = leftOut.length - forClient.length;
  const words = named.map(({ name, reason }) => `${name} (${REASON_WORDS[reason]})`);
  const rest =
    omitted === 0
      ? ""
      : `, and ${String(omitted)} more${
          withoutEntry > 0 ? ` (${String(withoutEntry)} of them are not given a fix button)` : ""
        }`;
  return {
    message: `MCP servers not available in this session: ${words.join(", ")}${rest}`,
    mcpServers: forClient.map(({ mcpServerId, reason }) => ({ mcpServerId, reason })),
  };
};
