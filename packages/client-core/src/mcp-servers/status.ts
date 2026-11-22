/**
 * What a screen shows as an MCP server's status, and what each status means.
 * Every screen that draws or counts a server's status reads this one table,
 * so none of them keeps its own list of the statuses that "fail" or "need
 * sign-in". The `+` row of the composer reads it on the first screen, so this
 * file imports nothing.
 */

/**
 * What a screen shows as a server's status. It is the record's `status`, but
 * `off` comes first: a server whose `enabled` is false reads "off" whatever
 * its status was when the user switched it off.
 */
export type McpServerDisplayStatus =
  | "off"
  | "ready"
  | "checking"
  | "needs-sign-in"
  | "unreachable"
  | "error";

/** What one display status means to a screen. */
export interface McpServerStatusFacts {
  /** The one word a screen shows for the status. */
  readonly word: string;
  /** Whether the server needs the user: it needs sign-in, is unreachable or is in error. A screen draws it in the failure colour. */
  readonly failing: boolean;
  /** Whether the server picker writes `word` beside the server. A ready or a checking server shows no word there. */
  readonly showsWordInPicker: boolean;
  /** Whether the user fixes the server by signing in again. */
  readonly needsSignIn: boolean;
}

/** The facts of every display status. A status added to the type fails to compile until it has a row here. */
export const MCP_SERVER_STATUS_FACTS: Readonly<
  Record<McpServerDisplayStatus, McpServerStatusFacts>
> = {
  off: { word: "off", failing: false, showsWordInPicker: true, needsSignIn: false },
  ready: { word: "ready", failing: false, showsWordInPicker: false, needsSignIn: false },
  checking: { word: "checking", failing: false, showsWordInPicker: false, needsSignIn: false },
  "needs-sign-in": {
    word: "needs sign-in",
    failing: true,
    showsWordInPicker: true,
    needsSignIn: true,
  },
  unreachable: {
    word: "unreachable",
    failing: true,
    showsWordInPicker: true,
    needsSignIn: false,
  },
  error: { word: "error", failing: true, showsWordInPicker: true, needsSignIn: false },
};
