import { describe, expect, it } from "vitest";
import { createFakeOAuthProvider } from "./testing";

describe("the fake OAuth provider", () => {
  it("kills a refresh token the moment it is used, and refuses the replay with invalid_grant", async () => {
    const provider = createFakeOAuthProvider();
    const issued = (await provider.issueTokens().json()) as { refresh_token: string };

    const rotated = provider.rotateRefreshToken({ refresh_token: issued.refresh_token });
    const replayed = provider.rotateRefreshToken({ refresh_token: issued.refresh_token });

    expect(rotated.status).toBe(200);
    expect(replayed.status).toBe(400);
    expect(await replayed.json()).toEqual({ error: "invalid_grant" });
  });

  it("answers a grant that has no answer of its own with the fallback, even when it is named like an object property", async () => {
    const provider = createFakeOAuthProvider();
    provider.answers.token = () => Response.json({ error: "fallback" }, { status: 400 });
    const asked = await provider.handle(
      new Request("http://provider.test/token", {
        method: "POST",
        body: new URLSearchParams({ grant_type: "constructor" }),
      }),
    );

    expect(await asked?.json()).toEqual({ error: "fallback" });
  });
});
