/**
 * Why an MCP Server in a session's list could not be called at the session's
 * last start (spec 21 section 3.8), and the words the Thread says it in.
 */
import type { McpServerStatus } from "@hercule/contract";
import type { McpServerLeftOutReason } from "@hercule/protocol";

/** What one start decides for every server of the session's list alike. */
export interface StartDelivery {
  /** Whether the session's runner negotiated the `mcpServers` capability. */
  readonly runnerReachesMcpServers: boolean;
  /** The session's harness's declared `mcpPassthrough`. */
  readonly harnessPassthrough: "native" | "unsupported";
  /** Whether the grants of the session's permission profile include `mcp.use`. */
  readonly profileGrantsMcpUse: boolean;
}

/** What decides a left-out reason for one server: the user's switch and the status the checks wrote. */
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
 * A server whose plugin or Connection is switched off already has the status
 * `error`, so it needs no reason of its own.
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
 * The most servers one warning names. A list has no length limit, but the
 * warning's `mcpServers` field and message are bounded
 * (`MAX_FACT_ITEMS`, `MAX_MESSAGE_LENGTH`), and a message that names every
 * server of a very long list would not be read anyway.
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
 * message that names each server and its reason in words, and the `mcpServers`
 * field that names them for a client. For example, "MCP servers not available
 * in this session: sentry (its runner is too old to reach MCP servers), linear
 * (needs sign-in)". Names the first 20 servers and ends the message with "and
 * N more" when there are more.
 */
export const buildLeftOutWarning = (
  leftOut: ReadonlyArray<LeftOutServer>,
): {
  readonly message: string;
  readonly mcpServers: ReadonlyArray<Pick<LeftOutServer, "mcpServerId" | "reason">>;
} => {
  const named = leftOut.slice(0, MAX_NAMED_LEFT_OUT);
  const omitted = leftOut.length - named.length;
  const words = named.map(({ name, reason }) => `${name} (${REASON_WORDS[reason]})`);
  return {
    message: `MCP servers not available in this session: ${words.join(", ")}${
      omitted > 0 ? `, and ${String(omitted)} more` : ""
    }`,
    mcpServers: named.map(({ mcpServerId, reason }) => ({ mcpServerId, reason })),
  };
};
