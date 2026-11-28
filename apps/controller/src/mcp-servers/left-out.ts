/**
 * Why an MCP Server in a session's list could not be called at the session's
 * last start (spec 21 section 3.8), and the words the Thread says it in.
 */
import { MAX_FACT_ITEMS, type McpServerLeftOutReason } from "@hercule/protocol";
import {
  decideUnavailableReason,
  describeSignInFix,
  type McpServerAvailabilityView,
} from "./catalogue";
import type { McpServerStoredSource } from "./repository";

/** What one start decides for every server of the session's list alike. */
export interface StartDelivery {
  /**
   * Whether the session's runner negotiated the MCP Servers capability of the
   * session's harness. Only a harness that declares `native` has one a runner
   * can lack, so `decideNoGatewayReason` reads it only for such a harness.
   */
  readonly runnerReachesMcpServers: boolean;
  /** The session's harness's declared `mcpPassthrough`. */
  readonly harnessPassthrough: "native" | "unsupported";
  /** Whether the grants of the session's permission profile include `mcp.use`. */
  readonly profileGrantsMcpUse: boolean;
}

/** Why a start gives the harness no MCP Gateway entry. */
export type NoGatewayReason = Extract<
  McpServerLeftOutReason,
  "runner-too-old" | "harness-unsupported"
>;

/**
 * Returns why a start gives the harness no MCP Gateway entry, or `null` when
 * it gives one. Judges the harness first: a harness that does not declare
 * `native` is `harness-unsupported` whatever the runner negotiated, because no
 * runner lists a capability for a harness that cannot take the entry.
 * `runner-too-old` means the harness is `native` and its runner lacks the
 * harness's capability.
 */
export const decideNoGatewayReason = (
  delivery: Pick<StartDelivery, "runnerReachesMcpServers" | "harnessPassthrough">,
): NoGatewayReason | null => {
  if (delivery.harnessPassthrough === "unsupported") return "harness-unsupported";
  return delivery.runnerReachesMcpServers ? null : "runner-too-old";
};

/**
 * Returns why the server cannot be called at a start, or `null` when it can.
 * When several reasons apply, it returns the first of this order, which is the
 * order of spec 21 section 3.8:
 *
 * 1. `harness-unsupported`: the harness does not declare `native`
 * 2. `runner-too-old`: the harness is `native` and its runner lacks the
 *    harness's capability
 * 3. `missing-grant`
 * 4. `switched-off`
 * 5. `checking`: its first list has not ended, before any cause in its
 *    Connection or plugin
 * 6. what its Connection, its plugin and its stored status say
 *    (`decideUnavailableReason`): `needs-sign-in`, `unreachable` or `error`.
 *    A server whose plugin or Connection is switched off has the reason
 *    `error`, so it needs none of its own.
 *
 * The view is read at the start, so a Connection or plugin that changed
 * before the follower wrote it is not missed.
 */
export const decideLeftOutReason = (
  delivery: StartDelivery,
  view: McpServerAvailabilityView,
): McpServerLeftOutReason | null => {
  const noGateway = decideNoGatewayReason(delivery);
  if (noGateway !== null) return noGateway;
  if (!delivery.profileGrantsMcpUse) return "missing-grant";
  if (!view.server.enabled) return "switched-off";
  if (view.server.status === "checking") return "checking";
  return decideUnavailableReason(view);
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

/**
 * Returns the words a warning uses for a reason. A server added by URL has no
 * Connection to reconnect, so for `needs-sign-in` its words say where the
 * user signs in.
 */
const describeLeftOutReason = (
  reason: McpServerLeftOutReason,
  sourceKind: McpServerStoredSource["kind"],
): string =>
  reason === "needs-sign-in" && sourceKind === "url"
    ? `needs sign-in: ${describeSignInFix(sourceKind)}`
    : REASON_WORDS[reason];

/** One server a start left out: which one, its name in the list, how it was added, and why. */
export interface LeftOutServer {
  readonly mcpServerId: string;
  readonly name: string;
  readonly sourceKind: McpServerStoredSource["kind"];
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
  const words = named.map(
    ({ name, sourceKind, reason }) => `${name} (${describeLeftOutReason(reason, sourceKind)})`,
  );
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
