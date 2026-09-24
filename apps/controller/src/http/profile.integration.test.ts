import { describe, expect, it } from "vitest";
import type { Profile } from "@hercule/contract";
import { completeSetup, post, send, withServer } from "./testing";

/** Permission profiles over a real socket. */
const listProfiles = async (base: string, token: string, query = ""): Promise<Profile[]> => {
  const response = await send("GET", base, `/api/v1/profiles${query}`, { token });
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: Profile[] }).items;
};

describe("permission profiles over HTTP", () => {
  it("lists the three profiles Hercule ships, by name", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const items = await listProfiles(base, token);
      expect(items.map((profile) => profile.name)).toEqual(["assistant", "unrestricted", "worker"]);
      expect(items.every((profile) => profile.shipped)).toBe(true);
    });
  });

  it("creates, reads, edits and deletes one the user made", async () => {
    await withServer(async ({ base, audit }) => {
      const token = await completeSetup(base);

      const created = await post(
        base,
        "/api/v1/profiles",
        {
          name: "reviewer",
          grants: ["task.read", "run.read"],
        },
        token,
      );
      expect(created.status).toBe(200);
      const profile = (await created.json()) as Profile;
      expect(profile).toMatchObject({ name: "reviewer", shipped: false });

      const read = await send("GET", base, `/api/v1/profiles/${profile.id}`, { token });
      expect(await read.json()).toEqual(profile);

      const updated = await send("PATCH", base, `/api/v1/profiles/${profile.id}`, {
        body: { name: "auditor" },
        token,
      });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({
        name: "auditor",
        grants: ["task.read", "run.read"],
      });

      const deleted = await send("DELETE", base, `/api/v1/profiles/${profile.id}`, { token });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({});

      expect((await listProfiles(base, token)).map((one) => one.name)).not.toContain("auditor");
      expect((await audit("profile.created")).map((entry) => entry.actor)).toEqual(["user"]);
      expect(await audit("profile.updated")).toHaveLength(1);
      expect((await audit("profile.deleted"))[0]?.payload).toMatchObject({ name: "auditor" });
    });
  });

  it("refuses a second profile with a name one already holds", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const response = await post(base, "/api/v1/profiles", { name: "worker", grants: [] }, token);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "conflict" } });
    });
  });

  it("refuses a grant outside the vocabulary, before anything is written", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const response = await post(
        base,
        "/api/v1/profiles",
        { name: "broken", grants: ["task.explode"] },
        token,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
      expect((await listProfiles(base, token)).map((one) => one.name)).not.toContain("broken");
    });
  });

  it("edits a shipped profile but refuses to delete one", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const worker = (await listProfiles(base, token)).find((one) => one.name === "worker");
      expect(worker).toBeDefined();

      const edited = await send("PATCH", base, `/api/v1/profiles/${worker!.id}`, {
        body: { grants: ["task.read"] },
        token,
      });
      expect(edited.status).toBe(200);
      expect(await edited.json()).toMatchObject({ grants: ["task.read"], shipped: true });

      const deleted = await send("DELETE", base, `/api/v1/profiles/${worker!.id}`, { token });
      expect(deleted.status).toBe(409);
      expect(await deleted.json()).toMatchObject({ error: { code: "invalid_state" } });

      expect((await listProfiles(base, token)).map((one) => one.name)).toContain("worker");
    });
  });

  it("answers not_found for an id nobody has, and 401 with no credential", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const missing = "0199e0e7-9999-7000-8000-000000000000";
      expect((await send("GET", base, `/api/v1/profiles/${missing}`, { token })).status).toBe(404);
      expect((await send("GET", base, "/api/v1/profiles")).status).toBe(401);
    });
  });
});
