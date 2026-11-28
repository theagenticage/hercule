/**
 * The one kind of request the controller sends to a provider with an account's
 * key: a GET with headers that may hold the placeholder `{apiKey}`. The key
 * check (spec 06 section 15.2) and the usage read (section 18) both send it.
 *
 * The key travels in a header of that request, so:
 *
 * - redirects are never followed, because one would carry the key to another
 *   host;
 * - the key is never logged and never put in an error: the errors here hold
 *   no request, and the callers add only the provider's name, a status, or the
 *   provider's own words about why it refused.
 */
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/** The most characters of a provider's refusal that are kept. */
const MAX_REFUSAL_LENGTH = 500;

/**
 * The most bytes of a key check's or usage read's response body that are read.
 * The provider is a third party, so a body that never ends must not hold the
 * request open or fill memory.
 */
const MAX_BODY_BYTES = 64 * 1024;

const API_KEY_PLACEHOLDER = "{apiKey}";

/** The connection failed or closed while the response body was being read. */
export class ResponseBodyUnreadable extends Data.TaggedError("ResponseBodyUnreadable") {}

/** The request could not be completed: the provider was not reached, or did not answer in time. */
export class KeyRequestUnreachable extends Data.TaggedError("KeyRequestUnreachable") {}

/** The request a kind declares: a fixed URL and the headers to send. */
export interface KeyRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** The error body that Anthropic, OpenAI and most other providers send: `{"error":{"message":"..."}}`. */
const decodeRefusalBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })),
);

/**
 * Returns `message` on one line, without control characters (the message is
 * shown to the user, and a terminal would run an escape sequence in it), and
 * at most 500 characters.
 */
export const cleanRefusalMessage = (message: string): string =>
  message
    .replace(/\s+/g, " ")
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, MAX_REFUSAL_LENGTH);

/**
 * Returns the words a provider gave for refusing a key: the `error.message`
 * of its JSON body, cleaned by `cleanRefusalMessage`. Returns `fallback` when
 * the body holds no such message.
 */
export const readRefusalMessage = (body: string, fallback: string): string => {
  const message = Option.match(decodeRefusalBody(body), {
    onNone: () => "",
    onSome: (decoded) => cleanRefusalMessage(decoded.error.message),
  });
  return message === "" ? fallback : message;
};

/**
 * Reads at most `maxBytes` of the response body as text and ignores the rest.
 * Returns the text and whether the whole body fitted. Fails with
 * `ResponseBodyUnreadable` when the connection fails or closes before the body
 * ends (a body that does not end is not a body that is empty).
 *
 * It reads on until it has seen one byte more than `maxBytes`, so a body of
 * exactly `maxBytes` is complete and a longer one is told apart from it.
 */
export const readBodyWithin = (
  response: HttpClientResponse.HttpClientResponse,
  maxBytes: number,
): Effect.Effect<{ readonly text: string; readonly complete: boolean }, ResponseBodyUnreadable> =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    yield* Stream.runForEachWhile(response.stream, (chunk) =>
      Effect.sync(() => {
        chunks.push(chunk);
        size += chunk.length;
        return size <= maxBytes;
      }),
    );
    return {
      text: new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes)),
      complete: size <= maxBytes,
    };
  }).pipe(Effect.mapError(() => new ResponseBodyUnreadable()));

/**
 * Reads at most 64 kB of the response body as text and ignores the rest. It is
 * the bound for the small answers: a key check's refusal and a usage reading.
 * Returns an empty string when the body cannot be read.
 */
export const readBoundedBody = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<string> =>
  readBodyWithin(response, MAX_BODY_BYTES).pipe(
    Effect.map(({ text }) => text),
    Effect.orElseSucceed(() => ""),
  );

/** Checks that the key holds only visible ASCII characters, which is all a header value may safely hold. */
export const isHeaderSafe = (apiKey: string): boolean => !/[^!-~]/.test(apiKey);

/** Returns the headers with `{apiKey}` in each value replaced by the key. */
const substituteApiKey = (
  headers: Readonly<Record<string, string>>,
  apiKey: Redacted.Redacted<string>,
): Record<string, string> => {
  const key = Redacted.value(apiKey);
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      // A function, so a `$` in the key is not read as a replacement pattern.
      value.replaceAll(API_KEY_PLACEHOLDER, () => key),
    ]),
  );
};

/**
 * Sends the GET request with the key in its headers, and runs `handle` on the
 * response while its body is still open. The caller reads the body there, with
 * `readBoundedBody`, and only when it needs it.
 *
 * Fails with `KeyRequestUnreachable` when the provider cannot be reached, or
 * when the request, `handle` included, takes longer than `timeout`. Fails with
 * whatever `handle` fails with. `apiKey` must pass `isHeaderSafe`: the caller
 * checks that, because only it knows what to tell the user.
 *
 * `client` must be an `HttpClient.withScope` client, so that the response body
 * a handler did not read is aborted when the request ends.
 */
export const sendKeyRequest = <A, E>(
  client: HttpClient.HttpClient.With<HttpClientError.HttpClientError, Scope.Scope>,
  request: KeyRequest,
  apiKey: Redacted.Redacted<string>,
  timeout: Duration.Duration,
  handle: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>,
): Effect.Effect<A, E | KeyRequestUnreachable> =>
  Effect.gen(function* () {
    const response = yield* client
      .get(request.url, { headers: substituteApiKey(request.headers, apiKey) })
      .pipe(
        // `fetch` follows redirects unless told not to.
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        // The provider is a third party: no trace headers go to it.
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        // The error holds the request and its headers, which hold the key.
        Effect.mapError(() => new KeyRequestUnreachable()),
      );
    return yield* handle(response);
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(new KeyRequestUnreachable()),
    }),
  );
