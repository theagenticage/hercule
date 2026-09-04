import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { completeSetup, send, withServer } from "./testing";

/** `settings.read` and `settings.update` over a real socket. */
const read = (base: string, token: string) => send("GET", base, "/api/v1/settings", { token });

const patch = (base: string, body: unknown, token: string) =>
  send("PATCH", base, "/api/v1/settings", { body, token });

describe("settings over HTTP", () => {
  it("answers with what the boot seeded, and takes a write in both scopes", async () => {
    await withServer(async (base) => {
      const token = await completeSetup(base);

      const seeded = (await (await read(base, token)).json()) as {
        controller: Record<string, unknown>;
        user: Record<string, unknown>;
      };
      expect(seeded.controller["retention.events"]).toBe(90);
      // Setup chose the timezone; nothing else in the user scope is set yet.
      expect(seeded.user).toEqual({ timezone: "Europe/Amsterdam" });

      const response = await patch(
        base,
        { controller: { "backup.time": "04:15" }, user: { "topics.order": ["intake"] } },
        token,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        controller: { "backup.time": "04:15", "retention.events": 90 },
        user: { timezone: "Europe/Amsterdam", "topics.order": ["intake"] },
      });

      expect(await (await read(base, token)).json()).toMatchObject({
        controller: { "backup.time": "04:15" },
      });
    });
  });

  it("refuses an unknown key rather than stripping it (spec 11 section 2)", async () => {
    await withServer(async (base) => {
      const token = await completeSetup(base);

      const response = await patch(base, { user: { timezone: "UTC", nope: 1 } }, token);
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: {
          code: string;
          details: { issues: ReadonlyArray<{ path: ReadonlyArray<string> }> };
        };
      };
      expect(body.error.code).toBe("validation");
      expect(body.error.details.issues.some((issue) => issue.path.includes("nope"))).toBe(true);

      // Nothing was written: the whole patch is refused, not the part it liked.
      const state = (await (await read(base, token)).json()) as { user: Record<string, unknown> };
      expect(state.user["timezone"]).toBe("Europe/Amsterdam");
    });
  });

  it("refuses a value the key's schema rejects", async () => {
    await withServer(async (base) => {
      const token = await completeSetup(base);
      const response = await patch(base, { controller: { "backup.time": "25:00" } }, token);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
    });
  });

  it("keys the user scope by the user, not by the scope name", async () => {
    await withServer(async (base, _audit, sql) => {
      const token = await completeSetup(base);
      expect((await patch(base, { user: { timezone: "UTC" } }, token)).status).toBe(200);

      const rows = await Effect.runPromise(
        Effect.orDie(
          Effect.all({
            user: sql<{
              readonly key: string;
            }>`SELECT s.key FROM user_settings s JOIN users u ON u.id = s.user_id WHERE u.username = 'rogier'`,
            scoped: sql<{
              readonly n: number;
            }>`SELECT count(*) AS n FROM settings WHERE scope = 'user'`,
          }),
        ),
      );
      expect(rows.user).toEqual([{ key: "timezone" }]);
      expect(rows.scoped[0]?.n).toBe(0);
    });
  });

  it("refuses a patch that names no setting", async () => {
    await withServer(async (base, audit) => {
      const token = await completeSetup(base);
      const response = await patch(base, {}, token);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
      expect(await audit("settings.updated")).toEqual([]);
    });
  });

  it("needs a credential", async () => {
    await withServer(async (base) => {
      await completeSetup(base);
      expect((await send("GET", base, "/api/v1/settings")).status).toBe(401);
    });
  });

  it("stamps the write in the audit log, with the keys and not the values", async () => {
    await withServer(async (base, audit) => {
      const token = await completeSetup(base);
      await patch(base, { user: { "thread.model": "claude-opus-5" } }, token);

      const entries = await audit("settings.updated");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toBe("user");
      expect(entries[0]?.payload).toEqual({ keys: [{ scope: "user", key: "thread.model" }] });
    });
  });
});
