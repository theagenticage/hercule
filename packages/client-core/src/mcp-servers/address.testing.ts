/**
 * How the fake controller reads the address of an MCP server added by URL.
 * It mirrors the controller's `parseServerAddress` (apps/controller/src/mcp-servers/addresses.ts),
 * which a client cannot import. `address.testing.test.ts` pins the cases the
 * controller's own tests pin, so the two cannot drift apart unnoticed.
 */

/** An address a user gave, read and checked. */
export interface FakeServerAddress {
  /** The address as the URL parser writes it: what requests go to. */
  readonly url: string;
  /** The key two spellings of one address share, which the one-server-per-address rule compares. */
  readonly normalizedUrl: string;
  /** Scheme, host and port when it is not the default: what a plugin's contribution declares as its `origin`. */
  readonly origin: string;
}

/** What a refused address comes with: the message of the `validation` error, on the field `source.url`. */
export interface RefusedServerAddress {
  readonly refusal: string;
}

/** The characters RFC 3986 section 2.3 calls unreserved: escaping one of them changes nothing. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * Rewrites `parsed` in place so that spellings that reach the same server
 * become one: every trailing `.` is removed from the host (a host that would
 * be left empty keeps its last one), and a percent-escape of an unreserved
 * character in the path becomes the character, while every other escape keeps
 * its hex digits in upper case.
 */
const foldEquivalentSpellings = (parsed: URL): void => {
  let hostname = parsed.hostname;
  while (hostname.length > 1 && hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  parsed.hostname = hostname;
  parsed.pathname = parsed.pathname.replace(/%([0-9A-Fa-f]{2})/g, (_escape, hex: string) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED.test(character) ? character : `%${hex.toUpperCase()}`;
  });
};

/**
 * Reads the address a user gave, as the controller does. Returns the refusal
 * when the text is not an address, is not `http:` or `https:`, holds a user
 * name or password, or holds a `#fragment`. The key of two spellings of one
 * address is the same: the scheme and host case, the default port, a trailing
 * `.` on the host, the case of a percent-escape and one trailing `/` do not
 * count, and the case of the path, the query and repeated slashes do.
 */
export const readServerAddress = (input: string): FakeServerAddress | RefusedServerAddress => {
  const url = input.trim();
  if (!URL.canParse(url)) {
    return {
      refusal:
        "This is not an address. Give the server's full address, such as https://mcp.example.com/mcp.",
    };
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      refusal: `The address must start with http:// or https://, and this one starts with ${parsed.protocol}. Give the server's full address, such as https://mcp.example.com/mcp.`,
    };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return {
      refusal:
        "The address holds a user name or a password. An address is shown whole to everyone who can read the server, so a secret must not be part of it. Remove it, and give the credential as a token instead: --token-stdin when you add the server, or `hercule mcp-server set-token` after.",
    };
  }
  // The parser reads a lone `#` as an empty fragment, so the text is checked, not `parsed.hash`.
  if (url.includes("#")) {
    return {
      refusal:
        "The address ends in a #fragment, which is never sent to a server. Remove everything from the # on.",
    };
  }
  // The parser keeps a bare `?` in `href` and reports its `search` as empty. Setting it removes it.
  if (parsed.search === "") parsed.search = "";
  foldEquivalentSpellings(parsed);
  const path = parsed.pathname.endsWith("/") ? parsed.pathname.slice(0, -1) : parsed.pathname;
  return {
    url: parsed.href,
    normalizedUrl: `${parsed.protocol}//${parsed.host}${path}${parsed.search}`,
    origin: parsed.origin,
  };
};
