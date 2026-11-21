/**
 * What fixes an MCP Server that is not working, as a thread's line and a
 * server's page offer it. Both read these functions, so the web app and the
 * desktop app cannot disagree about which button a reason gets.
 */
import type { TranscriptRow } from "@hercule/contract";
import { describeReconnect, type McpServerView, type ReconnectTarget } from "./views";

/**
 * One server a `runtime.warning` names, and why: the entry of the event's
 * `mcpServers` field. The reason is a reason a start leaves a server out, or
 * `not-in-list` or `timed-out` for a refused call (spec 21 section 3.6).
 */
export type McpServerWarningEntry = NonNullable<
  Extract<TranscriptRow["event"], { _tag: "runtime.warning" }>["mcpServers"]
>[number];

/** The button a thread's line draws for one server it names. */
export type WarningFix =
  | ({ readonly kind: "reconnect" } & ReconnectTarget)
  | {
      readonly kind: "open-server";
      readonly mcpServerId: string;
      readonly label: "Open server";
    };

/**
 * Returns the button that fixes `entry`, or `null` when there is none:
 *
 * - `needs-sign-in`: reconnect the server's Connection;
 * - `unreachable`, `error`, `switched-off`: open the server's page;
 * - every other reason has no fix: the line's text says what to do (a runner
 *   or harness that cannot take servers, a server still checking, a call
 *   that timed out, a server not in the thread's list).
 *
 * A server that is not in `views` (deleted since the line was written) has no
 * button either. The reason decides, not the server's status now, because
 * the line records what happened then.
 */
export const decideWarningFix = (
  entry: McpServerWarningEntry,
  views: readonly McpServerView[],
): WarningFix | null => {
  const view = views.find((each) => each.server.id === entry.mcpServerId);
  if (view === undefined) return null;
  switch (entry.reason) {
    case "needs-sign-in": {
      const reconnect = describeReconnect(view);
      return reconnect === null ? null : { kind: "reconnect", ...reconnect };
    }
    case "unreachable":
    case "error":
    case "switched-off":
      return { kind: "open-server", mcpServerId: view.server.id, label: "Open server" };
    default:
      return null;
  }
};

/**
 * Checks whether the user can act on a warning: at least one server it names
 * has a fix button. Such a line is drawn in the failure colours, because the
 * user must act; a line with nothing to do stays as quiet as any warning.
 */
export const isActionableWarning = (
  entries: readonly McpServerWarningEntry[],
  views: readonly McpServerView[],
): boolean => entries.some((entry) => decideWarningFix(entry, views) !== null);

/** The button of a server's status band. */
export type StatusBandAction =
  | ({ readonly kind: "reconnect" } & ReconnectTarget)
  | { readonly kind: "check"; readonly label: "Check now" };

/**
 * The band over a server's page while it is not ready. A screen draws the
 * spinner itself for a server that is `checking`.
 */
export interface StatusBand {
  /** `fail` for the three statuses that need the user, `quiet` for checking and off. */
  readonly tone: "quiet" | "fail";
  /** The bold first words, such as "Off.", or `null` when the text stands alone. */
  readonly heading: string | null;
  /** What the status means and what to do, or `null` when the reason in `detail` is all there is. */
  readonly text: string | null;
  /** The server's own reason (`statusDetail`), drawn under the text. `null` when it has none. */
  readonly detail: string | null;
  readonly action: StatusBandAction | null;
}

/**
 * Returns the band for a server's page, or `null` when the page draws none:
 * the server is ready, or it needs sign-in with no Connection to reconnect.
 * The one button of the band is "Check now" for an unreachable server or one
 * in error, and the Connection's Reconnect for a server that needs sign-in.
 */
export const decideStatusBand = (view: McpServerView): StatusBand | null => {
  switch (view.displayStatus) {
    case "ready":
      return null;
    case "checking":
      return {
        tone: "quiet",
        heading: null,
        text: "Checking: asking the server for its tools.",
        detail: null,
        action: null,
      };
    case "off":
      return {
        tone: "quiet",
        heading: "Off.",
        text: "No thread gets this server. Its name, its sign-in and the projects that name it are kept.",
        detail: null,
        action: null,
      };
    case "needs-sign-in": {
      const reconnect = describeReconnect(view);
      if (reconnect === null) return null;
      return {
        tone: "fail",
        heading: "Needs sign-in.",
        text: `${reconnect.label} in your browser, and this server comes back with it.`,
        detail: view.statusDetail,
        action: { kind: "reconnect", ...reconnect },
      };
    }
    case "unreachable":
      return {
        tone: "fail",
        heading: "Unreachable.",
        text: "Hercule asks again, with a longer wait each time. A thread that starts meanwhile says the server was left out, and gets it once it is ready.",
        detail: view.statusDetail,
        action: { kind: "check", label: "Check now" },
      };
    case "error":
      return {
        tone: "fail",
        heading: "Error.",
        text: null,
        detail: view.statusDetail,
        action: { kind: "check", label: "Check now" },
      };
  }
};
