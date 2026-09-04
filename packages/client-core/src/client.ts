/**
 * The Hydra client: the contract's derived HttpApi client, wrapped into plain
 * promise-returning functions.
 *
 * This module is the whole reason `client-core` exists. The web app and the CLI
 * see nothing but promises, plain objects and two `Error` subclasses; every
 * Effect type stops here (ADR 0017, ADR 0031). Nothing about a route is written
 * by hand: the shape below is derived from `api`, so an operation added to the
 * contract appears here with no edit.
 */
import { api } from "@hydra/contract";
import { Effect, Result } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { toClientError } from "./errors";

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
  /** The bearer token sent on every call from now on. `null` sends none. */
  readonly setToken: (token: string | null) => void;
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
}

export const createClient = (options: ClientOptions): HydraClient => {
  let token = options.token ?? null;

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
   * from the context the client was built in, so an override goes on per call.
   */
  const run = (effect: Effect.Effect<unknown, unknown>): Promise<unknown> =>
    Effect.runPromise(
      Effect.result(
        options.fetch === undefined
          ? effect
          : Effect.provideService(
              effect,
              FetchHttpClient.Fetch,
              options.fetch as typeof globalThis.fetch,
            ),
      ),
    ).then((result) => {
      if (Result.isFailure(result)) {
        throw toClientError(result.failure, options.baseUrl);
      }
      return result.success;
    });

  const client: Record<string, unknown> = {
    setToken: (next: string | null) => {
      token = next;
    },
    getToken: () => token,
  };

  for (const [group, endpoints] of Object.entries(derived)) {
    client[group] = Object.fromEntries(
      Object.entries(endpoints).map(([name, call]) => [
        name,
        (request?: unknown) => run(call(request)),
      ]),
    );
  }

  return client as HydraClient;
};
