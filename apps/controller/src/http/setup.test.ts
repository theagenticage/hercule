/**
 * `setup.complete` over a real socket: what a single-use setup token is worth
 * when more than one caller presents it at the same moment.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { PASSWORD, SETUP_TOKEN, send, withServer } from "./testing";

const complete = (base: string, username: string) =>
  send("POST", base, "/api/v1/setup/complete", {
    body: { username, password: PASSWORD, timezone: "Europe/Amsterdam" },
    token: SETUP_TOKEN,
  });

describe("setup.complete over HTTP", () => {
  it("finishes first run once, however many callers race with the same token", async () => {
    await withServer(async (base, audit, sql) => {
      const responses = await Promise.all(
        ["alice", "bob", "carol", "dave"].map((username) => complete(base, username)),
      );

      const accepted = responses.filter((response) => response.status === 200);
      expect(accepted).toHaveLength(1);
      // The losers are refused by whichever guard sees them first: the gate,
      // once the token hash is cleared, or the claim on the completion stamp.
      for (const refused of responses.filter((response) => response.status !== 200)) {
        expect([401, 409]).toContain(refused.status);
      }
      expect(await accepted[0]!.json()).toMatchObject({ token: expect.any(String) as string });

      const rows = await Effect.runPromise(
        Effect.orDie(
          Effect.all({
            users: sql<{ readonly username: string }>`SELECT username FROM users`,
            tokens: sql<{ readonly n: number }>`SELECT count(*) AS n FROM login_tokens`,
            settings: sql<{ readonly n: number }>`SELECT count(*) AS n FROM user_settings`,
          }),
        ),
      );
      expect(rows.users).toHaveLength(1);
      expect(rows.tokens[0]?.n).toBe(1);
      expect(rows.settings[0]?.n).toBe(1);
      expect(await audit("setup.completed")).toHaveLength(1);
    });
  });
});
