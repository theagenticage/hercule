/**
 * The address of an MCP Server added by URL: what a user may give, the key
 * that makes two spellings of one address count as one server, the name a
 * server gets when the user gives none, and which plugin's server an address
 * belongs to (spec 21 sections 2.2 and 2.3).
 *
 * Every function here is pure. A refusal is a `Validation` error whose issue
 * names the field the user gave and says what to give instead.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createValidationError, type Validation } from "@hercule/contract";
import { McpServerName } from "@hercule/plugin-host";

/** An address a user gave, read and checked. */
export interface ServerAddress {
  /**
   * The address as the WHATWG URL parser writes it (`href`). It is what
   * requests go to. The parser only spells the address the way every client
   * does: `https:example.com/mcp` becomes `https://example.com/mcp`, the scheme
   * and host are in lower case, the default port is gone and a bare `?` with
   * nothing after it is gone. `foldEquivalentSpellings` then removes a
   * trailing `.` from the host and spells the path's percent-escapes in their
   * one canonical form. The path's own characters, its trailing slash and the
   * query are kept, because a server may need them as they are.
   */
  readonly url: string;
  /**
   * The key two spellings of one address share, which the one-server-per-address
   * rule compares. See `buildNormalizedAddress`.
   */
  readonly normalizedUrl: string;
  /** Scheme, host and port when it is not the default: what a plugin's contribution declares as its `origin`. */
  readonly origin: string;
}

const refuseUrl = (message: string): Effect.Effect<never, Validation> =>
  Effect.fail(createValidationError([{ path: ["source", "url"], message }]));

const refuseName = (message: string): Effect.Effect<never, Validation> =>
  Effect.fail(createValidationError([{ path: ["source", "name"], message }]));

/** The characters RFC 3986 section 2.3 calls unreserved: escaping one of them changes nothing. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * Rewrites the address in place so that spellings that reach the same server
 * become one spelling (RFC 3986 section 6.2.2.2, and the absolute form of a
 * host name):
 *
 * - Every trailing `.` is removed from the host, so `https://mcp.sentry.dev./mcp`
 *   and `https://mcp.sentry.dev../mcp` are `https://mcp.sentry.dev/mcp`. A host
 *   such as `.` that would be left empty is kept.
 * - A percent-escape of an unreserved character (`A-Z a-z 0-9 - . _ ~`) in the
 *   path becomes the character itself, so `/%6Dcp` is `/mcp`. Every other
 *   escape stays an escape, with its hex digits in upper case, so `%2f` is
 *   `%2F`. A reserved character is never decoded, because `%2F` and `/` mean
 *   different things to a server.
 *
 * Repeated slashes (`/mcp//`) are not folded into one: a server may route
 * `/mcp/` and `/mcp//` differently, and no rule says they are one address.
 * The query is left as it is.
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
 * Builds the key that makes two spellings of one address one server. It is
 * taken from the address as the WHATWG URL parser reads it, so the scheme and
 * host are in lower case, the scheme's default port is gone, and dot segments
 * (`/a/../b`) are resolved. `foldEquivalentSpellings` has already run on the
 * address, so a trailing `.` on the host is gone and the path's percent-escapes
 * are canonical. On top of that, exactly one trailing `/` is removed from
 * the path (a path ending in `//` keeps its other slash), so `https://a.com`, `https://a.com/` and `https://a.com/mcp/`
 * match `https://a.com` and `https://a.com/mcp`. The case of the path and the
 * query are kept exactly, because a server may tell them apart. A bare `?`
 * with nothing after it is the same address as none: `parseServerAddress`
 * removes it from the address, so the key and the address agree.
 */
const buildNormalizedAddress = (parsed: URL): string => {
  const path = parsed.pathname.endsWith("/") ? parsed.pathname.slice(0, -1) : parsed.pathname;
  return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
};

/**
 * Reads the address a user gave. Fails with a `Validation` error on
 * `["source", "url"]` when the text is not an address, is not `http:` or
 * `https:`, holds a user name or password, or holds a `#fragment`. A
 * fragment and a password are refused and not dropped, so the address a user
 * sees is the address the server is called at. Userinfo is refused and a
 * query is not, because an HTTP client sends userinfo as credentials of its
 * own (a `Basic` Authorization header) next to the token, which a query never
 * is. The query is part of the address and is shown whole, like the rest.
 */
export const parseServerAddress = (input: string): Effect.Effect<ServerAddress, Validation> =>
  Effect.gen(function* () {
    const url = input.trim();
    if (!URL.canParse(url)) {
      return yield* refuseUrl(
        "This is not an address. Give the server's full address, such as https://mcp.example.com/mcp.",
      );
    }
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return yield* refuseUrl(
        `The address must start with http:// or https://, and this one starts with ${parsed.protocol}. Give the server's full address, such as https://mcp.example.com/mcp.`,
      );
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return yield* refuseUrl(
        "The address holds a user name or a password. An address is shown whole to everyone who can read the server, so a secret must not be part of it. Remove it, and give the credential as a token instead: --token-stdin when you add the server, or `hercule mcp-server set-token` after.",
      );
    }
    // The parser reads a lone `#` as an empty fragment, so the text is checked, not `parsed.hash`.
    if (url.includes("#")) {
      return yield* refuseUrl(
        "The address ends in a #fragment, which is never sent to a server. Remove everything from the # on.",
      );
    }
    // The parser keeps a bare `?` in `href` and reports its `search` as empty.
    // Setting `search` to the empty text removes it.
    if (parsed.search === "") parsed.search = "";
    foldEquivalentSpellings(parsed);
    return {
      url: parsed.href,
      normalizedUrl: buildNormalizedAddress(parsed),
      origin: parsed.origin,
    };
  });

/** The host labels that say what a server is and not whose it is, so they never name a server. */
const GENERIC_HOST_LABELS: ReadonlyArray<string> = ["mcp", "www", "api"];

const isValidName = Schema.is(McpServerName);

/**
 * Builds the name a server gets when the user gives none: the first label of
 * the address's host (which the URL parser has put in lower case) that is not
 * `mcp`, `www` or `api`, with
 * each run of characters outside `a-z` and `0-9` turned into one `_`, the
 * `_` at either end removed, cut to 16 characters and trimmed of a trailing
 * `_` again. `https://mcp.notion.com/mcp` gives `notion`.
 *
 * Fails with a `Validation` error on `["source", "name"]` when no label is
 * left, or the result breaks the rule of `McpServerName` (it is `hercule`, say).
 * The message tells the user to give a name.
 *
 * An IP address has no name in it. Its first label is used all the same: the
 * host `192.168.0.1` gives `192`, which passes the rule. An IPv6 host such as
 * `[::1]` gives its letters and digits (`1`) the same way.
 */
export const buildDefaultServerName = (address: ServerAddress): Effect.Effect<string, Validation> =>
  Effect.gen(function* () {
    const { hostname } = new URL(address.url);
    const label = hostname.split(".").find((one) => !GENERIC_HOST_LABELS.includes(one));
    const name = (label ?? "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 16)
      .replace(/_+$/, "");
    if (!isValidName(name)) {
      return yield* refuseName(
        `The address's host ${hostname} gives no usable server name. Give the server a name of your own with --name. A name is 1 to 16 lowercase letters and digits, joined by single underscores, and is not hercule.`,
      );
    }
    return name;
  });

/**
 * Returns the contribution whose `origin` is this origin, or `undefined` when
 * none is. When several contributions share an origin, the first registered
 * one is returned. Only contributions the plugin host knows can be passed: one
 * whose registration failed is not known, so its origin is not reserved.
 */
export const findPluginOnOrigin = <Contribution extends { readonly origin: string }>(
  origin: string,
  contributions: ReadonlyArray<Contribution>,
): Contribution | undefined => contributions.find((one) => one.origin === origin);
