/**
 * Reads a bearer token from a request. Used by the routes that are not derived
 * from the contract's HttpApi declaration, and so get none of its security
 * handling: the join exchange and the runner socket.
 */
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

/** Returns the request's bearer token, or `undefined` when it has none. */
export const readBearerToken = (
  request: HttpServerRequest.HttpServerRequest,
): string | undefined => {
  const header = request.headers["authorization"];
  if (header === undefined) return undefined;
  const space = header.indexOf(" ");
  if (space < 0 || header.slice(0, space).toLowerCase() !== "bearer") return undefined;
  const token = header.slice(space + 1).trim();
  return token === "" ? undefined : token;
};
