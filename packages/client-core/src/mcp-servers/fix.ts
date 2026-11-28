/**
 * What fixes an MCP Server that is not working, as a thread's line and a
 * server's page offer it. Both read these functions, so the web app and the
 * desktop app cannot disagree about which button a reason gets.
 */
import type { TranscriptRow } from "@hercule/contract";
import { offersBrowserSignIn } from "./sign-in-words";
import { describeSignInAction, type McpServerView, type SignInAction } from "./views";

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
  | SignInAction
  | {
      readonly kind: "open-server";
      readonly mcpServerId: string;
      readonly label: "Open server";
    };

/**
 * Returns the button that fixes `entry`, or `null` when there is none:
 *
 * - `needs-sign-in`: the sign-in button of the server (`describeSignInAction`);
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
    case "needs-sign-in":
      return describeSignInAction(view);
    case "unreachable":
    case "error":
    case "switched-off":
      return { kind: "open-server", mcpServerId: view.server.id, label: "Open server" };
    default:
      return null;
  }
};

/** A thread's warning line: how it is drawn, and the buttons it offers. */
export interface McpWarningLine {
  /**
   * `fail` when at least one server has a button, because the user must act;
   * `quiet` when there is nothing to do, as quiet as any warning.
   */
  readonly tone: "quiet" | "fail";
  /** One button for each entry that has a fix, in the order of the entries. Entries are not merged. */
  readonly fixes: readonly { readonly key: string; readonly fix: WarningFix }[];
}

/**
 * Returns how a `runtime.warning` naming `entries` is drawn: its tone and
 * its buttons, decided by `decideWarningFix` from the servers as they are
 * now. `key` identifies a button among the others of one line (the server
 * and the reason), so an app can use it as the element key.
 */
export const buildMcpWarningLine = (
  entries: readonly McpServerWarningEntry[],
  views: readonly McpServerView[],
): McpWarningLine => {
  const fixes = entries.flatMap((entry) => {
    const fix = decideWarningFix(entry, views);
    return fix === null ? [] : [{ key: `${entry.mcpServerId}:${entry.reason}`, fix }];
  });
  return { tone: fixes.length === 0 ? "quiet" : "fail", fixes };
};

/** The button of a server's status band. */
export type StatusBandAction =
  | SignInAction
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
  /** What the status means and what to do. */
  readonly text: string;
  /** The server's own reason (`statusDetail`), drawn under the text. `null` when it has none. */
  readonly detail: string | null;
  readonly action: StatusBandAction | null;
}

/**
 * Returns what the band says to do for a server added by URL that needs
 * sign-in. A server that signs in through the browser is signed in there, and
 * a pasted token is named as the other way.
 */
const describeUrlSignInText = (view: McpServerView): string =>
  offersBrowserSignIn(view.server)
    ? "Sign in through your browser, or paste a token, and this server comes back with it."
    : "Paste a new token, and this server comes back with it.";

/**
 * Returns the band for a server's page, or `null` when the page draws none:
 * the server is ready, or it needs sign-in with no Connection to reconnect.
 * The one button of the band is "Check now" for an unreachable server or one
 * in error. For a server that needs sign-in it is the server's sign-in
 * button (`describeSignInAction`).
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
      const action = describeSignInAction(view);
      if (action === null) return null;
      return {
        tone: "fail",
        heading: "Needs sign-in.",
        text:
          action.kind === "reconnect"
            ? `${action.label} in your browser, and this server comes back with it.`
            : describeUrlSignInText(view),
        detail: view.statusDetail,
        action,
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
        text: "The server did not return its tools. Check now asks it again.",
        detail: view.statusDetail,
        action: { kind: "check", label: "Check now" },
      };
  }
};
