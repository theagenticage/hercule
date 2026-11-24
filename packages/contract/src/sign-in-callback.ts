/**
 * Reading what the browser came back with after a sign-in of an MCP server or a Connection. The
 * controller, the CLI and the desktop app all judge this return, and they must
 * agree on which returns are well formed, so they all use the one parser here.
 */

import { Schema } from "effect";

/**
 * The address the browser returns to after a sign-in, for an MCP server or a Connection: exactly
 * `http://127.0.0.1:<port>/callback`, with a port from 1 to 65535. Nothing else
 * is a redirect address: not another spelling of the loopback host, not user
 * information, a query or a fragment. A client that catches the return listens
 * on that port. A client that cannot listen (the web app) picks a port nothing
 * listens on, and the user pastes the address the browser ended on.
 */
export const SignInRedirectUri = Schema.String.check(
  Schema.makeFilter((uri) => {
    const port = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/callback$/.exec(uri)?.[1];
    return port !== undefined && Number(port) <= 65535
      ? undefined
      : "A redirect address is exactly http://127.0.0.1:<port>/callback, with a port from 1 to 65535, and no user name, query or fragment.";
  }),
);

export type SignInRedirectUri = Schema.Schema.Type<typeof SignInRedirectUri>;

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
 * Checks that a pasted address is the redirect address the sign-in started
 * with, which tells a user who pasted the address of another sign-in or
 * another window. The port is part of it, and the query is not. An address
 * with a user name or a password never matches.
 */
export const isRedirectAddress = (address: URL, redirectUri: string): boolean => {
  const expected = new URL(redirectUri);
  return (
    address.username === "" &&
    address.password === "" &&
    address.origin === expected.origin &&
    address.pathname === expected.pathname
  );
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
