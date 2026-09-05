/**
 * Reading a bearer credential off a request, for the routes that are not
 * derived from the contract's HttpApi declaration and so get none of its
 * security handling: the join exchange and the runner socket.
 */
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

/** The bearer token a request presents, or nothing when it presents none. */
export const bearerOf = (request: HttpServerRequest.HttpServerRequest): string | undefined => {
  const header = request.headers["authorization"];
  if (header === undefined) return undefined;
  const space = header.indexOf(" ");
  if (space < 0 || header.slice(0, space).toLowerCase() !== "bearer") return undefined;
  const token = header.slice(space + 1).trim();
  return token === "" ? undefined : token;
};
