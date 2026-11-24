/**
 * The words of the browser sign-in of a server added by URL (spec 17
 * §Settings, MCP servers, Adding and replacing; spec 14 for the paste). The
 * web app and the desktop app draw these and add none of their own.
 */
import type { McpServer } from "@hercule/contract";
import {
  BROWSER_WAIT_STOPPED,
  BROWSER_WAIT_TIMED_OUT,
  describePasteRefusal,
} from "../browser-return-words";

export { BROWSER_WAIT_STOPPED, describePasteRefusal };

/** Why a browser sign-in ended without a server that is signed in. */
export type SignInRefusalReason =
  /** The sign-in ran out, or another sign-in of this server overtook it. */
  | "sign-in-expired"
  /** The user or the provider said no, the provider refused the code, or the answer came from another issuer. */
  | "sign-in-refused"
  /** The server, its authorization server or its token endpoint could not be reached, or answered what OAuth does not allow. */
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
 * `detail` is the controller's own message. It is the sentence for `failed`
 * and `source-unreadable`, and is ignored for the other reasons, which have a
 * sentence of their own. A server that cannot be signed in to has many
 * possible causes, from an outage to metadata that breaks the rules, and only
 * the controller's message names the one that happened.
 */
export const describeSignInRefusal = (reason: SignInRefusalReason, detail: string): string => {
  switch (reason) {
    case "sign-in-expired":
      return "This sign-in ran out, or another one for this server replaced it. Start again.";
    case "sign-in-refused":
      return "The browser or the provider refused the sign-in. Nothing was changed. You can start again.";
    case "timed-out":
      return BROWSER_WAIT_TIMED_OUT;
    case "source-unreadable":
    case "failed":
      return detail;
  }
};

/** The sentence over the token field when the controller says only a pasted token works for this server. */
export const BROWSER_SIGN_IN_UNSUPPORTED =
  "This server does not allow a sign-in through the browser. Paste a token instead.";
