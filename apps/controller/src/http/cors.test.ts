/**
 * Tests the CORS wrapper against a stub application, so each case shows
 * exactly which headers the wrapper adds and whether the request reached the
 * application at all. `cors.integration.test.ts` runs the same rules
 * through the real controller.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { DESKTOP_APP_ORIGIN } from "@hercule/contract";
import { withCors } from "./cors";

/**
 * Sends one request through `withCors` around a stub application that
 * answers `200` with a fixed header, plus `appHeaders`. Returns the response
 * and whether the stub ran.
 */
const sendThroughCors = async (
  method: string,
  headers: Record<string, string>,
  appHeaders: Record<string, string> = {},
) => {
  let reached = false;
  const stub = Effect.sync(() => {
    reached = true;
    return HttpServerResponse.text("from the app", {
      headers: { "x-from-app": "yes", ...appHeaders },
    });
  });
  const request = HttpServerRequest.fromWeb(
    new Request("http://controller.test/api/v1/auth/login", { method, headers }),
  );
  const response = await Effect.runPromise(
    withCors(stub).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request)),
  );
  return { response, reached };
};

/** Returns the names of the CORS headers on a response, sorted. */
const listCorsHeaders = (response: HttpServerResponse.HttpServerResponse): Array<string> =>
  Object.keys(response.headers)
    .filter((name) => name.startsWith("access-control-"))
    .sort();

const PREFLIGHT_HEADERS = {
  "access-control-request-method": "POST",
  "access-control-request-headers": "authorization, content-type",
};

describe("withCors", () => {
  it("names the desktop app's origin on a response to it", async () => {
    const { response, reached } = await sendThroughCors("GET", { origin: DESKTOP_APP_ORIGIN });

    expect(reached).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers["x-from-app"]).toBe("yes");
    expect(response.headers["access-control-allow-origin"]).toBe(DESKTOP_APP_ORIGIN);
    expect(listCorsHeaders(response)).toEqual(["access-control-allow-origin"]);
    expect(response.headers.vary).toBe("origin");
  });

  it("adds no CORS header for another origin, or for no origin, but still varies on the origin", async () => {
    for (const headers of [{ origin: "https://evil.example" }, { origin: "null" }, {}]) {
      const { response, reached } = await sendThroughCors("GET", headers);

      expect(reached).toBe(true);
      expect(response.status).toBe(200);
      expect(response.headers["x-from-app"]).toBe("yes");
      expect(listCorsHeaders(response), JSON.stringify(headers)).toEqual([]);
      expect(response.headers.vary).toBe("origin");
    }
  });

  it("adds origin to the app's own vary header, and never twice", async () => {
    for (const headers of [{ origin: DESKTOP_APP_ORIGIN }, {}]) {
      const merged = await sendThroughCors("GET", headers, { vary: "accept-encoding" });
      expect(merged.response.headers.vary, JSON.stringify(headers)).toBe("accept-encoding, origin");

      const listed = await sendThroughCors("GET", headers, { vary: "Accept-Encoding, Origin" });
      expect(listed.response.headers.vary, JSON.stringify(headers)).toBe("Accept-Encoding, Origin");
    }
  });

  it("answers a preflight from the desktop app itself, with exactly the four headers", async () => {
    const { response, reached } = await sendThroughCors("OPTIONS", {
      origin: DESKTOP_APP_ORIGIN,
      ...PREFLIGHT_HEADERS,
    });

    expect(reached).toBe(false);
    expect(response.status).toBe(204);
    expect(response.body._tag).toBe("Empty");
    expect(listCorsHeaders(response)).toEqual([
      "access-control-allow-headers",
      "access-control-allow-methods",
      "access-control-allow-origin",
      "access-control-max-age",
    ]);
    expect(response.headers["access-control-allow-origin"]).toBe(DESKTOP_APP_ORIGIN);
    expect(response.headers["access-control-allow-methods"]).toBe("DELETE, GET, PATCH, POST, PUT");
    expect(response.headers["access-control-allow-headers"]).toBe("authorization, content-type");
    expect(response.headers["access-control-max-age"]).toBe("7200");
  });

  it("passes a preflight from another origin to the app, which decides what it gets", async () => {
    const { response, reached } = await sendThroughCors("OPTIONS", {
      origin: "https://evil.example",
      ...PREFLIGHT_HEADERS,
    });

    expect(reached).toBe(true);
    expect(response.headers["x-from-app"]).toBe("yes");
    expect(listCorsHeaders(response)).toEqual([]);
  });

  it("passes an OPTIONS request that is not a preflight to the app, even from the desktop app", async () => {
    const { response, reached } = await sendThroughCors("OPTIONS", { origin: DESKTOP_APP_ORIGIN });

    expect(reached).toBe(true);
    expect(response.headers["access-control-allow-origin"]).toBe(DESKTOP_APP_ORIGIN);
    expect(listCorsHeaders(response)).toEqual(["access-control-allow-origin"]);
  });
});
