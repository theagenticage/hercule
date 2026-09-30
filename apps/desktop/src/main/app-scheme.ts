/**
 * The `app` scheme: how main serves the renderer to the window.
 *
 * - The packaged app serves the files of the renderer's build, from its own
 *   bundle. It reads them itself rather than fetching `file://` URLs: the app
 *   loads nothing over `file://` (spec 17, §Security baseline).
 * - In development, main forwards each request to the renderer's Vite dev
 *   server.
 *
 * Every response, a 404 too, carries the renderer's Content-Security-Policy,
 * built for the controller URL saved at the time of the request.
 */
import path from "node:path";
import { net } from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { AppSettings } from "./app-settings";
import { buildContentSecurityPolicy } from "./content-security-policy";
import { buildDevServerUrl } from "./dev-server-url";
import { buildRendererFileTable, findRendererFile } from "./renderer-files";

/** Returns an empty response with `status`. */
const answerWithStatus = (status: number): Response => new Response(null, { status });

/**
 * Returns `response` with the Content-Security-Policy header set to `policy`.
 * It copies the response, because the headers of a fetched response cannot
 * be changed.
 */
const addContentSecurityPolicy = (response: Response, policy: string): Response => {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", policy);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/**
 * Builds the answerer of the packaged app. It lists the files of the
 * renderer's build once, here, and answers a request with the file the
 * request asks for, or with 404 when that file is not in the list (see
 * `findRendererFile`).
 *
 * The build sits next to main, in `out/renderer`.
 */
const makeBuildAnswerer = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  // The app's own build is always there; without it there is nothing to show.
  const table = buildRendererFileTable(path.join(import.meta.dirname, "../renderer"));
  return (request: Request): Effect.Effect<Response> => {
    const file = findRendererFile(table, request.url);
    if (file === null) return Effect.succeed(answerWithStatus(404));
    return fs.readFile(file.path).pipe(
      Effect.map((bytes) => new Response(bytes, { headers: { "content-type": file.contentType } })),
      // The build's own files are always readable, so this is logged.
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning(`Could not read the file for ${request.url}: ${error.message}`),
          answerWithStatus(404),
        ),
      ),
    );
  };
});

/**
 * Builds the answerer of development: it forwards a request to the dev server
 * at `devServerUrl`, and answers 404 for a request not on the renderer's
 * origin and 502 when the dev server does not answer.
 *
 * The request's headers go along, because Vite reads `accept` and
 * `sec-fetch-dest` to tell a page load from a module import. The one header
 * left out is `origin`: a request from main that carries the window's origin
 * fails with net::ERR_FAILED.
 */
const makeDevServerAnswerer =
  (devServerUrl: string) =>
  (request: Request): Effect.Effect<Response> => {
    const target = buildDevServerUrl(devServerUrl, request.url);
    if (target === null) return Effect.succeed(answerWithStatus(404));
    const headers = new Headers(request.headers);
    headers.delete("origin");
    return Effect.tryPromise(() => net.fetch(target, { headers })).pipe(
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning(`The dev server did not answer ${target}: ${error.message}`),
          answerWithStatus(502),
        ),
      ),
    );
  };

/** Builds the `app` scheme's service; see `makeAppSchemeLayer`. */
const make = (devServerUrl: string | null) =>
  Effect.gen(function* () {
    const settings = yield* AppSettings;
    const answerRequest =
      devServerUrl === null ? yield* makeBuildAnswerer : makeDevServerAnswerer(devServerUrl);
    return {
      /**
       * Answers one request on the `app` scheme. Never fails: a request main
       * cannot answer gets an error status.
       */
      answer: (request: Request): Effect.Effect<Response> =>
        Effect.gen(function* () {
          const response = yield* answerRequest(request);
          const controllerUrl = yield* settings.readControllerUrl;
          const policy = buildContentSecurityPolicy(controllerUrl, devServerUrl);
          return addContentSecurityPolicy(response, policy);
        }),
    };
  });

/** Serves the renderer on the `app` scheme. */
export class AppScheme extends Context.Service<
  AppScheme,
  Effect.Success<ReturnType<typeof make>>
>()("hercule/desktop/AppScheme") {}

/**
 * Builds the `app` scheme's service. `devServerUrl` is the renderer's dev
 * server in development, and null in the packaged app, which then serves its
 * own build.
 */
export const makeAppSchemeLayer = (
  devServerUrl: string | null,
): Layer.Layer<AppScheme, never, AppSettings | FileSystem.FileSystem> =>
  Layer.effect(AppScheme)(make(devServerUrl));
