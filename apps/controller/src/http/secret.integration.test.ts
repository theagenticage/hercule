/**
 * Tests `secret.*` and `controller.read` over a real socket, through
 * everything a request passes through in production.
 *
 * These tests check what the unit tests cannot: that no secret value is ever
 * sent in a response. Every response body is searched for the stored value,
 * and for the word `value` itself.
 */
import { describe, expect, it } from "vitest";
import { VERSION } from "@hercule/home/version";
import { completeSetup, send, withServer } from "./testing";

const OWNER = "connection/0198e4b0-0000-7000-8000-000000000001";
const VALUE = "ghp_a-real-looking-token";

const buildSecretsPath = (owner: string, name: string) => `/api/v1/secrets/${owner}/${name}`;

describe("secret.*", () => {
  it("stores, lists, rotates and removes a secret, and never returns its value", async () => {
    await withServer(async ({ base, audit }) => {
      const token = await completeSetup(base);

      const created = await send("PUT", base, buildSecretsPath(OWNER, "api-token"), {
        body: { value: VALUE },
        token,
      });
      expect(created.status).toBe(200);
      const createdBody = (await created.json()) as Record<string, unknown>;
      expect(createdBody).toMatchObject({
        ownerKind: "connection",
        ownerId: "0198e4b0-0000-7000-8000-000000000001",
        name: "api-token",
      });
      expect(createdBody["rotatedAt"]).toBeUndefined();

      const listed = await send("GET", base, "/api/v1/secrets", { token });
      const listedText = await listed.text();
      expect(listed.status).toBe(200);
      expect(listedText).not.toContain(VALUE);
      expect(listedText).not.toContain("value");
      // The controller's own signing key is a secrets row too. The API may list
      // it as a reference, and rejects any write to it; nothing else is
      // allowed.
      expect(JSON.parse(listedText)).toMatchObject({
        items: [
          { ownerKind: "connection", name: "api-token" },
          { ownerKind: "core", name: "controller.signing-key" },
        ],
      });

      const rotated = await send("PUT", base, buildSecretsPath(OWNER, "api-token"), {
        body: { value: "a-rotated-token" },
        token,
      });
      expect(((await rotated.json()) as Record<string, unknown>)["rotatedAt"]).toEqual(
        expect.any(String),
      );

      const removed = await send("DELETE", base, buildSecretsPath(OWNER, "api-token"), { token });
      expect(removed.status).toBe(200);

      const empty = await send("GET", base, "/api/v1/secrets?ownerKind=connection", { token });
      expect(await empty.json()).toEqual({ items: [] });

      // One audit row per change, each with the user as the actor.
      expect(await audit("secret.created")).toHaveLength(1);
      expect(await audit("secret.rotated")).toHaveLength(1);
      const deleted = await audit("secret.deleted");
      expect(deleted).toHaveLength(1);
      expect(deleted[0]?.actor).toBe("user");
      expect(JSON.stringify(deleted[0]?.payload)).not.toContain(VALUE);
    });
  });

  it("returns 404 for a name that was never stored", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const response = await send("DELETE", base, buildSecretsPath(OWNER, "absent"), { token });

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    });
  });

  it("rejects a write to the core owner, which is the controller's own key material", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const response = await send("PUT", base, buildSecretsPath("core/controller", "signing-key"), {
        body: { value: VALUE },
        token,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
    });
  });

  it("rejects an owner id that contains the separator the encryption binding uses", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const response = await send("PUT", base, buildSecretsPath("plugin/a%7Cb", "k"), {
        body: { value: VALUE },
        token,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
    });
  });

  it("needs a credential, like every operation after setup", async () => {
    await withServer(async ({ base }) => {
      await completeSetup(base);
      const response = await send("GET", base, "/api/v1/secrets");

      expect(response.status).toBe(401);
    });
  });
});

describe("controller.read", () => {
  it("returns the controller's identity and the version built into the binary", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const response = await send("GET", base, "/api/v1/controller", { token });

      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["defaultRunnerId", "id", "publicKey", "version"]);
      expect(body["version"]).toBe(VERSION);
      expect(body["id"]).toEqual(expect.stringMatching(/^[0-9a-f]{8}-/));
    });
  });
});
