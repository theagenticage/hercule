import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { parseTokens, serializeTokens, type TokenSet } from "./oauth";

const TOKEN = "gho_secret-access-token";

describe("parseTokens", () => {
  it("parses what serializeTokens wrote", async () => {
    const tokens: TokenSet = {
      accessToken: TOKEN,
      refreshToken: "refresh-1",
      expiresAt: "2026-10-02T00:00:00.000Z",
    };
    expect(await Effect.runPromise(parseTokens(serializeTokens(tokens)))).toEqual(tokens);
  });

  it.each([
    ["text that is not JSON", `{accessToken: ${TOKEN}`],
    ["JSON in another shape", JSON.stringify({ accessToken: 7, note: TOKEN })],
    ["JSON that is not an object", JSON.stringify(TOKEN)],
  ])("fails with StoredTokensUnreadable, quoting nothing, on %s", async (_, stored) => {
    const failure = await Effect.runPromise(Effect.flip(parseTokens(stored)));

    expect(failure._tag).toBe("StoredTokensUnreadable");
    expect(String(failure)).not.toContain(TOKEN);
    expect(JSON.stringify(failure)).not.toContain(TOKEN);
  });
});
