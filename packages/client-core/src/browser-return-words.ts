/**
 * The words of the wait for the browser's return from a sign-in, shared by the
 * MCP servers added by URL and the Connections whose redirect returns to the
 * user's machine. They live outside the `mcp-servers` folder because the first
 * screen reaches the Connections' code, and it must not reach that folder.
 */

/** The sentence for a wait for the browser that the app ended itself, such as when its listener closed. */
export const BROWSER_WAIT_STOPPED = "The app stopped waiting for the browser. Start again.";

/** The sentence for a browser that did not come back before the listener's time limit. */
export const BROWSER_WAIT_TIMED_OUT =
  "The browser did not come back within 10 minutes. Start again.";

/** Returns the text under the paste field for an address that is not a redirect answer. `reason` is the parser's own words. */
export const describePasteRefusal = (reason: string): string =>
  `That is not what the browser ended on: ${reason}.`;
