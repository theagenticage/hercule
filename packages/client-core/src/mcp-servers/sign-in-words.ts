/**
 * The words of the browser sign-in of a server added by URL (spec 17
 * §Settings, MCP servers, Adding and replacing; spec 14 for the paste). The
 * web app and the desktop app draw these and add none of their own.
 */
import type { McpServer } from "@hercule/contract";

/** Why a browser sign-in ended without a server that is signed in. */
export type SignInRefusalReason =
  /** The sign-in ran out, or another sign-in of this server overtook it. */
  | "sign-in-expired"
  /** The user or the provider said no, the provider refused the code, or the answer came from another issuer. */
  | "sign-in-refused"
  /** The server, its authorization server or its token endpoint could not be reached. */
  | "source-unreadable"
  /** The browser did not come back within 10 minutes. Only the desktop app waits for it. */
  | "timed-out"
  /** Any other failure, such as a lost connection or an address the controller refused. */
  | "failed";

/** The first words of the sign-in dialog's browser choice. */
export const BROWSER_SIGN_IN_LABEL = "Sign in with your browser";

/** Returns whether the server added by URL can sign in through the browser: it offers OAuth, or already holds an OAuth sign-in. */
export const offersBrowserSignIn = (server: McpServer): boolean =>
  server.source.kind === "url" &&
  (server.source.signInOffered === "oauth" || server.source.signIn === "oauth");

/**
 * Returns the sentence that says why a browser sign-in ended, and what to do.
 * `detail` is the controller's own message for `failed`, and is ignored for
 * the other reasons, which have a sentence of their own.
 */
export const describeSignInRefusal = (reason: SignInRefusalReason, detail: string): string => {
  switch (reason) {
    case "sign-in-expired":
      return "This sign-in ran out, or another one for this server replaced it. Start again.";
    case "sign-in-refused":
      return "The browser or the provider refused the sign-in. Nothing was changed. You can start again.";
    case "source-unreadable":
      return "The server or its sign-in service could not be reached. Try again later.";
    case "timed-out":
      return "The browser did not come back within 10 minutes. Start again.";
    case "failed":
      return detail;
  }
};

/** The sentence over the token field when the controller says only a pasted token works for this server. */
export const BROWSER_SIGN_IN_UNSUPPORTED =
  "This server does not allow a sign-in through the browser. Paste a token instead.";

/** What the dialog says while it waits for the browser. */
export interface SignInWaitingWords {
  /** "Finish in your browser". */
  readonly heading: string;
  /** Who asks for the approval, such as "You will approve on auth.example.com.". Always shown, so the user knows before the browser opens. */
  readonly approval: string;
  /** What to do in the browser, and how the sign-in comes back. */
  readonly instruction: string;
  /** The button that opens the sign-in page: "Open again" when the app opened it already, else "Open the sign-in page". */
  readonly openLabel: string;
  /** The question over the paste for a sign-in the app waits for, or `null` when the paste is the only way back. */
  readonly pasteQuestion: string | null;
  /** The button that shows the paste field for a sign-in the app waits for, or `null` when the field is always shown. */
  readonly pasteToggle: string | null;
  readonly pasteLabel: "Address the browser ended on";
  readonly pasteSubmit: "Finish sign-in";
}

/**
 * Returns the words of the waiting step. `returnBy` is how the browser comes
 * back: `listener` when the desktop app catches it itself, `paste` when the
 * user pastes the address the browser ended on. `openedByApp` is true when
 * the app opens the sign-in page itself, which only the desktop app does.
 */
export const describeSignInWaiting = ({
  approvalHost,
  returnBy,
  openedByApp,
}: {
  readonly approvalHost: string;
  readonly returnBy: "listener" | "paste";
  readonly openedByApp: boolean;
}): SignInWaitingWords => ({
  heading: "Finish in your browser",
  approval: `You will approve on ${approvalHost}.`,
  instruction:
    returnBy === "listener"
      ? "Approve the sign-in there. This window finishes by itself when the browser comes back."
      : "Approve the sign-in there. The browser then shows an error page for an address that starts with http://127.0.0.1. Copy that address from the address bar and paste it here.",
  openLabel: openedByApp ? "Open again" : "Open the sign-in page",
  pasteQuestion:
    returnBy === "listener" ? "Approved, and the browser did not come back here?" : null,
  pasteToggle: returnBy === "listener" ? "Paste the browser's address…" : null,
  pasteLabel: "Address the browser ended on",
  pasteSubmit: "Finish sign-in",
});

/** Returns the text under the paste field for an address that is not a redirect answer. `reason` is the parser's own words. */
export const describePasteRefusal = (reason: string): string =>
  `That is not what the browser ended on: ${reason}.`;
