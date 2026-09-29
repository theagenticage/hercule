/**
 * Tests `user.read` over a real socket: the route, its handler, and the
 * credential check that runs before the service is called. Which actors the
 * service refuses is tested beside the service.
 */
import { describe, expect, it } from "vitest";
import { completeSetup, get, post, USERNAME, withServer } from "./testing";

describe("user.read over HTTP", () => {
  it("returns the username to a login token and to an API key", async () => {
    await withServer(async ({ base }) => {
      const bearer = await completeSetup(base);
      const minted = await post(base, "/api/v1/api-keys", { name: "laptop" }, bearer);
      expect(minted.status).toBe(200);
      const key = (await minted.json()) as { token: string };

      for (const token of [bearer, key.token]) {
        const response = await get(base, "/api/v1/user", token);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ username: USERNAME });
      }
    });
  });

  it("refuses a caller with no credential", async () => {
    await withServer(async ({ base }) => {
      await completeSetup(base);

      const response = await get(base, "/api/v1/user");
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    });
  });
});
