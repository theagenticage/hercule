/**
 * Tests CORS through the real controller over a real socket, so the order in
 * which the wrappers run is tested too: an error response written by the
 * error envelope must also carry the CORS header, or the desktop app could
 * not read the error.
 */
import { describe, expect, it } from "vitest";
import { ALL_OPERATIONS, DESKTOP_APP_ORIGIN } from "@hercule/contract";
import { completeSetup, withServer } from "./testing";

describe("CORS for the desktop app", () => {
  it("names the desktop app's origin on setup.read", async () => {
    await withServer(async ({ base }) => {
      const response = await fetch(`${base}/api/v1/setup`, {
        headers: { origin: DESKTOP_APP_ORIGIN },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(DESKTOP_APP_ORIGIN);
      expect(response.headers.get("vary")).toBe("origin");
    });
  });

  it("names it on an error response too, so the desktop app can read the error", async () => {
    await withServer(async ({ base }) => {
      await completeSetup(base);
      const response = await fetch(`${base}/api/v1/settings`, {
        headers: { origin: DESKTOP_APP_ORIGIN, authorization: "Bearer not-a-token" },
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("access-control-allow-origin")).toBe(DESKTOP_APP_ORIGIN);
      expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    });
  });

  it("answers a preflight with every method the contract uses, without reaching the routes", async () => {
    await withServer(async ({ base }) => {
      const response = await fetch(`${base}/api/v1/auth/login`, {
        method: "OPTIONS",
        headers: {
          origin: DESKTOP_APP_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });

      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(response.headers.get("access-control-allow-origin")).toBe(DESKTOP_APP_ORIGIN);
      const methods = response.headers.get("access-control-allow-methods")?.split(", ");
      expect(methods).toEqual(
        [...new Set(ALL_OPERATIONS.map((operation) => operation.method))].sort(),
      );
      expect(response.headers.get("access-control-allow-headers")).toBe(
        "authorization, content-type",
      );
      expect(response.headers.get("access-control-max-age")).toBe("7200");
    });
  });

  it("gives another origin no CORS header, and its preflight the 404 envelope", async () => {
    await withServer(async ({ base }) => {
      const read = await fetch(`${base}/api/v1/setup`, {
        headers: { origin: "https://evil.example" },
      });
      expect(read.status).toBe(200);
      expect(read.headers.get("access-control-allow-origin")).toBeNull();
      expect(read.headers.get("vary")).toBe("origin");

      const preflight = await fetch(`${base}/api/v1/auth/login`, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
      });
      expect(preflight.status).toBe(404);
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
      expect(preflight.headers.get("access-control-allow-methods")).toBeNull();
      expect(await preflight.json()).toMatchObject({ error: { code: "not_found" } });
    });
  });
});
