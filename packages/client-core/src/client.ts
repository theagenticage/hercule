/**
 * The Hydra client: the contract's derived HttpApi client, wrapped into plain
 * promise-returning functions.
 *
 * This module is the whole reason `client-core` exists. The web app and the CLI
 * see nothing but promises, plain objects and three `Error` subclasses; every
 * Effect type stops here. Nothing about a route is written
 * by hand: the shape below is derived from `api`, so an operation added to the
 * contract appears here with no edit.
 */
import { api } from "@hydra/contract";
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

export type HydraClient = Operations & {
  /**
   * The bearer token sent on every call from now on, and kept where a token
   * store was given. `null` sends none and clears what was kept.
   */
  readonly setToken: (token: string | null) => void;
  /**
   * The same, for a credential that must not outlive this page load: the
   * one-time setup token is presented on the call that spends it and is never
   * written to the store, so a tab closed mid-flight leaves nothing behind.
   */
  readonly presentToken: (token: string | null) => void;
  /** The bearer token currently held. */
  readonly getToken: () => string | null;
};

/**
 * Only the call signature of `fetch`, which is all the transport uses. The
 * global `fetch` type carries extra properties a stub would have to fake.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Where the controller lives, e.g. `http://127.0.0.1:7717`. */
  readonly baseUrl: string;
  /** The bearer token to start with. */
  readonly token?: string | null;
  /** The `fetch` to send through. Defaults to the global one; a seam for tests. */
  readonly fetch?: FetchLike;
  /**
   * Where the token survives a page load. Given one, the client starts with
   * the token it holds and keeps it in step: login and setup put their token
   * in, logout takes it out, and so does an answer the token was rejected by.
   */
  readonly tokenStore?: TokenStore;
}

/**
 * The operations that change which token is held, and what they change it to.
 * Keyed `<group>.<name>`; the value reads the token out of the answer.
 */
const TOKEN_FROM: Record<string, (result: unknown) => string | null> = {
  "setup.complete": (result) => (result as { readonly token: string }).token,
  "auth.login": (result) => (result as { readonly token: string }).token,
  "auth.logout": () => null,
};

export const createClient = (options: ClientOptions): HydraClient => {
  const store = options.tokenStore;

  // A token given to the constructor is the caller's answer and replaces
  // whatever the store holds; only its absence falls back to the store.
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
   * The fetch client reads its `fetch` from the fiber running the request, not
   * from the context the client was built in, so it goes on per call. The
   * wrapper is what tells a request that could not be encoded from an answer
   * that could not be decoded: the two fail alike, and only the transport
   * knows whether anything was sent. The flag is per call, so concurrent calls
   * do not read each other's.
   */
  const run = (effect: Effect.Effect<unknown, unknown>): Promise<unknown> => {
    let sent = false;
    // A `FetchLike`, like the one a caller may pass: the transport calls it
    // with a URL string, which is why `FetchLike` is declared that way.
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

  return client as HydraClient;
};
