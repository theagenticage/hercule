/**
 * Sends the connect check's requests through Chromium's network stack, the
 * one the app's page uses, rather than through Node's. The check must see the
 * network exactly as the page will: the macOS proxy settings, and the
 * certificates the Keychain trusts, such as a company's own certificate
 * authority. Node's `fetch` uses neither, so it could find a controller
 * unreachable that the page reaches.
 *
 * Electron's `net.fetch` uses that stack too, but it cannot send the check's
 * requests:
 *
 * - asked not to follow a redirect, it fails instead of returning the
 *   redirect;
 * - it cannot send an OPTIONS request with the page's origin, because
 *   Chromium sends a preflight of its own first, and then fails.
 *
 * So this module builds on `net.request`. It returns the answer's status,
 * headers and body rather than a `Response`, because `new Response` refuses a
 * status outside 200-599, which a server can still send. Node's `fetch` passes
 * such a status on too.
 *
 * The unit tests pass Node's `fetch` to the check in its place, so only the
 * packaged app runs this module. The end-to-end tests reach it with:
 *
 * - an answer without a body, the controller's 204 to the preflight, on every
 *   connect that passes;
 * - a redirect;
 * - a controller that never answers, which the check stops after 5 seconds;
 * - a header that `Headers` refuses, on a page and on a redirect;
 * - the status 999.
 */
import { Readable } from "node:stream";
import { net } from "electron";

/**
 * Sends one HTTP request with `method` and `headers` to `url`, and returns
 * the answer's status, headers and body, as `fetch` returns them. A redirect
 * is returned as the answer itself, with its status and `location` header,
 * and is not followed. Aborting `signal` stops the request, even while its
 * body is being read. Fails when the request fails or is aborted.
 */
export type FetchWithoutRedirects = (
  url: URL,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  },
) => Promise<Pick<Response, "status" | "headers" | "body">>;

/**
 * Converts headers as Electron gives them to standard `Headers`.
 *
 * - A header sent more than once is joined with ", ", as Node's `fetch` joins
 *   it, so a proxy that adds a second `access-control-allow-origin` is refused
 *   in the packaged app as it is in the unit tests.
 * - A header that `Headers` refuses is left out. Electron decodes header
 *   values as UTF-8, and `Headers` refuses a value with a character past
 *   U+00FF, such as `€`, or the replacement character Electron puts in place
 *   of a Latin-1 `é`. Leaving such a header out changes nothing the check
 *   sees: it reads only `location` and the CORS headers, which are plain ASCII
 *   whenever they are valid.
 */
const buildHeaders = (headers: Record<string, string | ReadonlyArray<string>>): Headers => {
  const built = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    try {
      built.set(name, typeof value === "string" ? value : value.join(", "));
    } catch {
      // `Headers` refused the header; see above for why the check can do without it.
    }
  }
  return built;
};

/**
 * Sends a request through the default session's network stack; see
 * FetchWithoutRedirects. Call it only once the app is ready, as any `net`
 * request.
 *
 * The request sends no cookies or stored HTTP credentials, as the page's own
 * calls to the controller send none.
 */
export const fetchWithoutRedirects: FetchWithoutRedirects = (url, { method, headers, signal }) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const request = net.request({ url: url.href, method, redirect: "manual", credentials: "omit" });
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
    /** Fails the request with `error`, and stops it. */
    const failRequest = (error: Error) => {
      reject(error);
      request.abort();
    };
    signal.addEventListener(
      "abort",
      () => failRequest(new DOMException("The request was aborted.", "AbortError")),
      { once: true },
    );
    // Stays for the request's whole life: the request emits an error when its
    // connection fails after the response arrived, and an error without a
    // listener would crash main.
    request.on("error", reject);
    // The two listeners below catch whatever they throw: an error thrown in a
    // `net` listener reaches main as an uncaught exception, which shows
    // Electron's error dialog and leaves the request's promise unsettled.
    request.on("redirect", (status, _method, _redirectUrl, redirectHeaders) => {
      try {
        resolve({ status, headers: buildHeaders(redirectHeaders), body: null });
        request.abort();
      } catch (error) {
        failRequest(error as Error);
      }
    });
    request.on("response", (response) => {
      try {
        // Electron's response is a Node readable stream, whatever its type says.
        const stream = response as unknown as Readable;
        // Closing the response, as cancelling its body does, stops the request,
        // as it does with Node's `fetch`. The check cancels a body past its size
        // limit.
        stream.once("close", () => request.abort());
        resolve({
          status: response.statusCode,
          headers: buildHeaders(response.headers),
          body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
        });
      } catch (error) {
        failRequest(error as Error);
      }
    });
    request.end();
  });
