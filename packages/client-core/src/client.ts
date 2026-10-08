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
import { api, type Attachment } from "@hercule/contract";
import { Context, Effect, Result } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import type { ImageFile } from "./attachments/files";
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
  /**
   * Uploads one image with `attachment.create` and returns its record. The
   * file's bytes are the request body; the controller reads the image type
   * from them. Fails with the same errors as any other call.
   */
  readonly uploadAttachment: (file: ImageFile) => Promise<Attachment>;
  /**
   * Reads an image's bytes with `attachment.readContent`, as a `Blob` whose
   * type is the image's type, ready for `URL.createObjectURL`. The bearer
   * token goes in a header, as on every call, never in a URL. Fails with the
   * same errors as any other call.
   */
  readonly readAttachmentContent: (id: string) => Promise<Blob>;
};

/**
 * Only the call signature of `fetch`, which is all the transport uses. The
 * global `fetch` type has extra properties that a test stub would have to fake.
 * The URL is always a string, so a stub can read it without converting it.
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
   *
   * Logout and the error clear only the token their request was sent with,
   * so a login that finished in the meantime keeps its new token.
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

/** One operation of the derived client, before it is wrapped into a promise. */
type Call = (request?: unknown) => Effect.Effect<unknown, unknown>;

/**
 * The client-side middleware that some operation of `Api` requires, or
 * `never` when no operation requires any. A middleware requires a client-side
 * part when it is declared with `requiredForClient: true`.
 */
export type RequiredClientMiddleware<Api> =
  Api extends HttpApi.HttpApi<string, infer Groups> ? HttpApiGroup.MiddlewareClient<Groups> : never;

/**
 * The bearer token one call sends, or `null` for none. Each call provides the
 * token that was current when the call started, so the client knows exactly
 * which token each response belongs to. The request reads its token from
 * here, not from the client's current token, because a login can replace
 * that token while the call is still being built.
 */
const SentToken = Context.Reference<string | null>("@hercule/client-core/SentToken", {
  defaultValue: () => null,
});

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

  /**
   * Clears the token, but only while it is still `sentToken`, the token a
   * call was sent with. A logout or an `unauthenticated` error can arrive
   * after a newer login. Either one means that the old token no longer works,
   * not the new one, so the new token stays.
   */
  const clearTokenIfCurrent = (sentToken: string | null): void => {
    if (token === sentToken) setToken(null);
  };

  // The HTTP client every operation sends through. It adds the bearer token
  // the call was started with.
  const httpClient = Effect.runSync(
    Effect.provide(HttpClient.HttpClient, FetchHttpClient.layer),
  ).pipe(
    HttpClient.mapRequestEffect((request) =>
      Effect.map(SentToken, (sent) =>
        sent === null ? request : HttpClientRequest.bearerToken(request, sent),
      ),
    ),
  );

  /**
   * Builds the derived call for one operation: the encoders for its request
   * and the decoders for its responses, from the operation's schemas.
   *
   * The client builds each operation the first time it is called, not all of
   * them when the client is created. Building all 126 operations up front
   * (the count when this was measured) allocated about 70 MB of short-lived
   * objects at startup. In the desktop app that cost about 6.5 MB of memory
   * and 10 ms on the first screen. A screen calls only a few operations, and
   * building one takes about 0.1 ms.
   */
  const buildCall = (group: string, name: string): Call => {
    // The names are read from the contract at runtime, as plain strings, and
    // the contract's type accepts only its literal names. The casts also hide
    // which client-side middleware this operation requires, so `build` is
    // typed with what any operation of the contract requires instead. The
    // client provides no client-side middleware, and the derived client skips
    // a missing one without an error. Typed this way, `runSync` refuses to
    // compile as soon as any operation requires one.
    const build = HttpApiClient.endpoint(api, {
      group: group as never,
      endpoint: name as never,
      httpClient,
      baseUrl: options.baseUrl,
    }) as Effect.Effect<Call, never, RequiredClientMiddleware<typeof api>>;
    return Effect.runSync(build);
  };

  /**
   * Runs one call and converts its failure into a client error. When the call
   * is one of `TOKEN_FROM`'s operations, `tokenFrom` reads the new token from
   * its result.
   *
   * The call sends the token that is current when `run` starts. A result that
   * sets a token (login, setup) always replaces the current one. A result that
   * clears it (logout, an `unauthenticated` error) clears it only while it is
   * still the token the call sent.
   *
   * The fetch client reads `fetch` from the fiber that runs the request, not
   * from the context the client was built in, so it is provided on each call.
   * The wrapper records whether the request was sent. That is the only way to
   * tell a request that could not be encoded from a response that could not
   * be decoded, because both fail with the same kind of error. The flag is
   * per call, so concurrent calls do not see each other's.
   *
   * Trace propagation is turned off on each call too. By default, Effect's
   * HTTP client adds the tracing headers `b3` and `traceparent` to every
   * request. The controller's CORS preflight allows only `authorization` and
   * `content-type`, so the extra headers would make the browser refuse every
   * request from the desktop app. Nothing is lost without them, because v1
   * exports no spans.
   */
  const run = (
    effect: Effect.Effect<unknown, unknown>,
    tokenFrom: ((result: unknown) => string | null) | undefined,
  ): Promise<unknown> => {
    const sentToken = token;
    let sent = false;
    // The transport calls this with a `URL` object. A `FetchLike` takes the
    // URL as a string, so the URL is converted here.
    const send = (url: URL, init?: RequestInit): Promise<Response> => {
      sent = true;
      return options.fetch === undefined
        ? globalThis.fetch(url.href, init)
        : options.fetch(url.href, init);
    };

    return Effect.runPromise(
      Effect.result(
        effect.pipe(
          Effect.provideService(FetchHttpClient.Fetch, send as typeof globalThis.fetch),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
          Effect.provideService(SentToken, sentToken),
        ),
      ),
    ).then((result) => {
      if (Result.isFailure(result)) {
        const error = toClientError(result.failure, options.baseUrl, sent);
        if (error instanceof ApiError && error.code === "unauthenticated") {
          clearTokenIfCurrent(sentToken);
        }
        throw error;
      }
      if (tokenFrom !== undefined) {
        const next = tokenFrom(result.success);
        if (next === null) clearTokenIfCurrent(sentToken);
        else setToken(next);
      }
      return result.success;
    });
  };

  let readContentCall: Call | undefined;

  const client: Record<string, unknown> = {
    setToken,
    presentToken,
    getToken: () => token,
    uploadAttachment: async (file: ImageFile) =>
      (client as Operations).attachment.create({
        query: { name: file.name },
        payload: new Uint8Array(await file.arrayBuffer()),
      }),
    // The promise methods drop `responseMode`, but the `Blob` needs the
    // response's content type, so this call asks the derived client for the
    // response beside the decoded bytes.
    readAttachmentContent: async (id: string) => {
      readContentCall ??= buildCall("attachment", "readContent");
      const [bytes, response] = (await run(
        readContentCall({ params: { id }, responseMode: "decoded-and-response" }),
        undefined,
      )) as [Uint8Array<ArrayBuffer>, { readonly headers: Readonly<Record<string, string>> }];
      return new Blob([bytes], { type: response.headers["content-type"] ?? "" });
    },
  };

  for (const group of Object.values(api.groups)) {
    client[group.identifier] = Object.fromEntries(
      Object.keys(group.endpoints).map((name) => {
        const tokenFrom = TOKEN_FROM[`${group.identifier}.${name}`];
        let call: Call | undefined;
        return [
          name,
          (request?: unknown) => {
            call ??= buildCall(group.identifier, name);
            return run(call(request), tokenFrom);
          },
        ];
      }),
    );
  }

  return client as HerculeClient;
};
