/**
 * Integration tests for recording a credential's use while a promotion
 * freezes the controller, over HTTP against a real controller.
 *
 * Every authenticated request records its credential's use: a login token's
 * expiry moves later, and an API key's last use is stamped. A GET is served
 * while the controller is frozen, so these tests check that a GET answers
 * as usual but records nothing. The new machine's copy of the data was taken
 * before the request, so a write here would be lost or would split the two
 * copies.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { freezeController, requestTransfer } from "../promotion/testing";
import { completeSetup, get, post, withServer, type ServerHarness } from "./testing";

/** Runs a SQL query against the harness's database and returns its rows. */
const query = <Row extends object>(
  harness: ServerHarness,
  run: (sql: ServerHarness["sql"]) => Effect.Effect<ReadonlyArray<Row>, unknown>,
): Promise<ReadonlyArray<Row>> => Effect.runPromise(Effect.orDie(run(harness.sql)));

describe("a credential used for a GET while the controller is frozen", () => {
  it("leaves a login token's expiry where it was, and moves it once the freeze ends", async () => {
    await withServer(async (harness) => {
      const bearer = await completeSetup(harness.base);
      // The controller is frozen with an API key, so the login token's last
      // use stays where the test puts it.
      const minted = await post(harness.base, "/api/v1/api-keys", { name: "laptop" }, bearer);
      const key = (await minted.json()) as { token: string };
      // Makes the last recorded use an hour old, so the next use renews the
      // token. The database refuses this write once the controller is frozen,
      // so it is made before.
      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await query(harness, (sql) => sql`UPDATE login_tokens SET last_used_at = ${anHourAgo}`);
      const promotionToken = await freezeController(harness.base, key.token);
      const readExpiry = async (): Promise<ReadonlyArray<{ expires_at: string }>> =>
        query(harness, (sql) => sql<{ expires_at: string }>`SELECT expires_at FROM login_tokens`);
      const before = await readExpiry();

      expect((await get(harness.base, "/api/v1/api-keys", bearer)).status).toBe(200);

      expect(await readExpiry()).toEqual(before);
      const cancelled = await requestTransfer(harness.base, promotionToken, "DELETE");
      expect(cancelled.status).toBe(204);
      expect((await get(harness.base, "/api/v1/api-keys", bearer)).status).toBe(200);
      expect(await readExpiry()).not.toEqual(before);
    });
  });

  it("leaves an API key's last use unrecorded", async () => {
    await withServer(async (harness) => {
      const bearer = await completeSetup(harness.base);
      const minted = await post(harness.base, "/api/v1/api-keys", { name: "laptop" }, bearer);
      const key = (await minted.json()) as { id: string; token: string };
      await freezeController(harness.base, bearer);

      expect((await get(harness.base, "/api/v1/api-keys", key.token)).status).toBe(200);

      const rows = await query(
        harness,
        (sql) => sql<{ last_used_at: string | null }>`SELECT last_used_at FROM api_keys`,
      );
      expect(rows).toEqual([{ last_used_at: null }]);
    });
  });
});
