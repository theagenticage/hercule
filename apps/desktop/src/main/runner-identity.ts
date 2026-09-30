/**
 * The local-runner probe: asks a loopback port which runner is listening
 * there, so the renderer can tell which runner is on this Mac. Spec 17 (§The
 * "local" runner) owns the rules.
 *
 * Main makes the request for the renderer for two reasons: the runner's
 * identity endpoint lets only the controller's origin read its answer, and the
 * renderer's Content Security Policy lets the page reach only the controller.
 * Main sends only `GET http://127.0.0.1:<port>/identity`. The renderer names
 * the port and nothing else, so it cannot make main request any other host,
 * method or path.
 *
 * This module imports no Electron: the layer is given the function that sends
 * the request, so the service is unit tested with Node's `fetch`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { FetchWithoutRedirects } from "./fetch-without-redirects";
import { readLimitedBody } from "./limited-body";

/**
 * How long main waits for a port's answer. A runner on this Mac answers in a
 * few milliseconds, and the renderer stops waiting after the same time.
 */
const PROBE_TIMEOUT = "1 second";

/** Decodes the identity endpoint's body, or returns none. */
const decodeIdentity = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ runnerId: Schema.String })),
);

/** The local-runner probe. */
export class RunnerIdentity extends Context.Service<
  RunnerIdentity,
  {
    /**
     * Returns the id of the runner that answers `GET /identity` on
     * 127.0.0.1 at `port`, or null when:
     *
     * - nothing answers within 1 second;
     * - the answer is not 200, a redirect included;
     * - the body is longer than 64 KiB or is not `{ "runnerId": string }`.
     *
     * Never fails. The caller checks that the id is the one the controller
     * lists for that port, so any other answer only means "not this runner".
     */
    readonly read: (port: number) => Effect.Effect<string | null>;
  }
>()("hercule/desktop/RunnerIdentity") {}

/** Builds the probe on `fetchWithoutRedirects`, which sends its requests. */
export const makeRunnerIdentityLayer = (
  fetchWithoutRedirects: FetchWithoutRedirects,
): Layer.Layer<RunnerIdentity> =>
  Layer.succeed(RunnerIdentity)({
    read: (port) =>
      Effect.tryPromise(async (signal) => {
        const response = await fetchWithoutRedirects(
          new URL(`http://127.0.0.1:${String(port)}/identity`),
          { method: "GET", headers: {}, signal },
        );
        if (response.status !== 200) {
          await response.body?.cancel();
          return null;
        }
        const body = await readLimitedBody(response);
        return body === null ? null : (Option.getOrNull(decodeIdentity(body))?.runnerId ?? null);
      }).pipe(
        Effect.timeout(PROBE_TIMEOUT),
        Effect.catch(() => Effect.succeed(null)),
      ),
  });
