/**
 * Reading what the browser came back with after an MCP server's sign-in. The
 * controller, the CLI and the desktop app all judge this return, and they must
 * agree on which returns are well formed, so they all use the one parser here.
 */

/** What the browser came back with, read from the text a client sent. */
export interface ParsedCallback {
  readonly _tag: "Callback";
  /** The address the browser ended on, when the text is a whole address. */
  readonly address: URL | undefined;
  readonly state: string;
  /** The authorization code. Exactly one of `code` and `error` is set. */
  readonly code: string | undefined;
  /** The error code the authorization server sent instead of a code. */
  readonly error: string | undefined;
  /**
   * The issuer the authorization server says the answer is from (RFC 9207).
   * `undefined` when the answer has no `iss` parameter at all. An `iss` that is
   * present and empty stays the empty text, so it is told apart from an absent
   * one and is compared like any other value.
   */
  readonly iss: string | undefined;
}

/** Text that is not a well-formed return. `reason` never quotes the text, because the text holds a code. */
export interface RefusedCallback {
  readonly _tag: "Refused";
  readonly reason: string;
}

/**
 * Parses what the browser came back with. The text is the whole address the
 * browser ended on, or only its query (with or without the leading `?`). A
 * fragment is dropped. Returns `Refused` when the text is not a redirect
 * answer:
 *
 * - it starts like an address and is not one;
 * - a parameter appears twice (the answer would have two readings);
 * - there is no `state`;
 * - it holds both `code` and `error`, or neither.
 *
 * A `state`, `code` or `error` with an empty value counts as absent. An empty
 * `iss` does not: it is kept as the empty text, which no issuer equals.
 */
export const parseCallbackQuery = (text: string): ParsedCallback | RefusedCallback => {
  const trimmed = text.trim();
  let address: URL | undefined;
  let query: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    address = URL.parse(trimmed) ?? undefined;
    if (address === undefined) {
      return {
        _tag: "Refused",
        reason: "this is not an address: paste the address the browser ended on",
      };
    }
    query = address.search;
  } else {
    query = trimmed.split("#")[0] ?? "";
  }
  const params = new URLSearchParams(query);
  if (new Set(params.keys()).size !== [...params.keys()].length) {
    return { _tag: "Refused", reason: "a parameter appears twice, so the answer has two readings" };
  }
  const read = (name: string): string | undefined => {
    const value = params.get(name);
    return value === null || value === "" ? undefined : value;
  };
  const state = read("state");
  if (state === undefined) {
    return {
      _tag: "Refused",
      reason: "there is no state: paste the whole address the browser ended on, or its query",
    };
  }
  const code = read("code");
  const error = read("error");
  if ((code === undefined) === (error === undefined)) {
    return { _tag: "Refused", reason: "the answer holds both a code and an error, or neither" };
  }
  return { _tag: "Callback", address, state, code, error, iss: params.get("iss") ?? undefined };
};

/**
 * Returns the `state` of an authorization address, which the browser's return
 * must carry, or `undefined` when the address has none or an empty one.
 */
export const readAuthorizationState = (authorizationUrl: string): string | undefined => {
  const state = new URL(authorizationUrl).searchParams.get("state");
  return state === null || state === "" ? undefined : state;
};

/**
 * Returns the host (with its port, when it has one) of an authorization
 * address: the host whose page asks the user to approve the sign-in. A client
 * shows it beside the address, because the user may not know the server by
 * that host. Throws when `authorizationUrl` is not an address, which the
 * controller never sends.
 */
export const readApprovalHost = (authorizationUrl: string): string =>
  new URL(authorizationUrl).host;
