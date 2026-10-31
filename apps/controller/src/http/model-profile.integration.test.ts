import { describe, expect, it } from "vitest";
import { completeSetup, send, withServer } from "./testing";

/** Tests `modelProfile.query`, `read` and `update` over a real socket. */
describe("model profiles over HTTP", () => {
  it("lists the profile the upgrade made, and replaces it with a write that names its revision", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);

      const listed = await send("GET", base, "/api/v1/model-profiles", { token });
      expect(listed.status).toBe(200);
      const [main] = (await listed.json()) as Array<{ id: string; name: string; revision: number }>;
      expect(main).toMatchObject({ name: "Main", revision: 1 });

      const accounts = (await (
        await send("GET", base, "/api/v1/provider-accounts", { token })
      ).json()) as Array<{
        id: string;
      }>;
      const payload = {
        expectedRevision: 1,
        name: "Daily",
        // No entries: the account gets its Default Selection when its catalog is read.
        accounts: [{ providerAccountId: accounts[0]!.id, harnessId: null }],
        defaultEntry: null,
        dismissedNewModels: [],
      };
      const path = `/api/v1/model-profiles/${main!.id}`;
      const written = await send("PATCH", base, path, { token, body: payload });
      expect(written.status).toBe(200);
      expect(await written.json()).toMatchObject({
        name: "Daily",
        revision: 2,
        accounts: [{ providerAccountId: accounts[0]!.id, selectionPending: true, entries: [] }],
      });
      expect(await (await send("GET", base, path, { token })).json()).toMatchObject({
        revision: 2,
      });

      // The same write again names the revision it read before the first one.
      const stale = await send("PATCH", base, path, { token, body: payload });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        error: { code: "conflict", message: expect.stringContaining("now revision 2") as unknown },
      });
    });
  });

  it("refuses a caller with no credential", async () => {
    await withServer(async ({ base }) => {
      expect((await send("GET", base, "/api/v1/model-profiles", {})).status).toBe(401);
    });
  });
});
