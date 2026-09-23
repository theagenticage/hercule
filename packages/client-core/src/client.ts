/**
 * The Hercule client: the contract's derived HttpApi client, wrapped into plain
 * promise-returning functions.
 *
 * This module is the reason `client-core` exists. The web app and the CLI see
 * only promises, plain objects and three `Error` subclasses; no Effect type
 * gets past this module. No route is written by hand: the client's shape is
 * derived from `api`, so an operation added to the contract appears here with
 * no edit.
 */
import { api } from "@hercule/contract";
import { Effect, Result } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { ApiError, toClientError } from "./errors";
import type { TokenStore } from "./token-store";

/** The derived client, with every Effect method turned into a promise method. */
type Promisified<T> = {
  readonly [K in keyof T]: T[K] extends (
    request: infer Request,
  ) => Effect.Effect<infer Success, unknown, unknown>
    ? void extends Request
      ? () => Promise<Success>
      : (request: Omit<Request, "responseMode">) => Promise<Success>
    : Promisified<T[K]>;
};

/** Every operation, grouped by entity: `client.profile.read({ params })`. */
export type Operations = Promisified<HttpApiClient.ForApi<typeof api>>;

export type HerculeClient = Operations & {
  /**
   * Sets the bearer token sent on every later call, and saves it in the token
   * store when there is one. `null` sends no token and clears the store.
   */
  readonly setToken: (token: string | null) => void;
  /**
   * Sets the bearer token like `setToken`, but never saves it, for a token
   * that must not outlive this page load. The one-time setup token is sent
   * only on the call that uses it up, so a tab closed during setup leaves no
   * token behind.
   */
  readonly presentToken: (token: string | null) => void;
  /** Returns the current bearer token, or `null` when there is none. */
  readonly getToken: () => string | null;
};

/**
 * Only the call signature of `fetch`, which is all the transport uses. The
 * global `fetch` type has extra properties that a test stub would have to fake.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** The controller's address, for example `http://127.0.0.1:7717`. */
  readonly baseUrl: string;
  /** The bearer token to start with. */
  readonly token?: string | null;
  /** The `fetch` to send requests with. Defaults to the global one; tests pass a stub. */
  readonly fetch?: FetchLike;
  /**
   * Where the token is kept across page loads. With a store, the client
   * starts with the stored token and keeps the store up to date:
   *
   * - login and setup store their new token;
   * - logout clears it;
   * - an `unauthenticated` error clears it too.
   */
  readonly tokenStore?: TokenStore;
}

/**
 * The operations that change the current token, keyed `<group>.<name>`. Each
 * value returns the new token from the operation's result.
 */
const TOKEN_FROM: Record<string, (result: unknown) => string | null> = {
  "setup.complete": (result) => (result as { readonly token: string }).token,
  "auth.login": (result) => (result as { readonly token: string }).token,
  "auth.logout": () => null,
};

/** Creates a client for the controller at `options.baseUrl`. */
export const createClient = (options: ClientOptions): HerculeClient => {
  const store = options.tokenStore;

  // A token passed in the options replaces the stored one. The stored token
  // is used only when the options have none.
  let token = options.token === undefined ? (store?.read() ?? null) : options.token;
  if (options.token !== undefined) store?.write(options.token);

  const presentToken = (next: string | null): void => {
    token = next;
  };

  const setToken = (next: string | null): void => {
    presentToken(next);
    store?.write(next);
  };

  const derived = Effect.runSync(
    HttpApiClient.make(api, {
      baseUrl: options.baseUrl,
      transformClient: HttpClient.mapRequest((request) =>
        token === null ? request : HttpClientRequest.bearerToken(request, token),
      ),
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ) as Record<string, Record<string, (request?: unknown) => Effect.Effect<unknown, unknown>>>;

  /**
   * Runs one call and converts its failure into a client error.
   *
   * The fetch client reads `fetch` from the fiber that runs the request, not
   * from the context the client was built in, so it is provided on each call.
   * The wrapper records whether the request was sent. That is the only way to
   * tell a request that could not be encoded from a response that could not
   * be decoded, because both fail with the same kind of error. The flag is
   * per call, so concurrent calls do not see each other's.
   */
  const run = (effect: Effect.Effect<unknown, unknown>): Promise<unknown> => {
    let sent = false;
    // A `FetchLike`, like the one a caller may pass. The transport calls it
    // with a URL string, which is why `FetchLike` takes a string.
    const send: FetchLike = (url, init) => {
      sent = true;
      return options.fetch === undefined ? globalThis.fetch(url, init) : options.fetch(url, init);
    };

    return Effect.runPromise(
      Effect.result(
        Effect.provideService(effect, FetchHttpClient.Fetch, send as typeof globalThis.fetch),
      ),
    ).then((result) => {
      if (Result.isFailure(result)) {
        const error = toClientError(result.failure, options.baseUrl, sent);
        if (error instanceof ApiError && error.code === "unauthenticated") setToken(null);
        throw error;
      }
      return result.success;
    });
  };

  const client: Record<string, unknown> = {
    setToken,
    presentToken,
    getToken: () => token,
  };

  for (const [group, endpoints] of Object.entries(derived)) {
    client[group] = Object.fromEntries(
      Object.entries(endpoints).map(([name, call]) => {
        const tokenFrom = TOKEN_FROM[`${group}.${name}`];
        return [
          name,
          (request?: unknown) =>
            tokenFrom === undefined
              ? run(call(request))
              : run(call(request)).then((result) => {
                  setToken(tokenFrom(result));
                  return result;
                }),
        ];
      }),
    );
  }

  return client as HerculeClient;
};
