import { describe, expect, it } from "vitest";
import { buildErrorBody, createApiStub, type Answer } from "./api-stub";
import { createClient } from "./client";
import { MIN_PASSWORD_LENGTH } from "@hercule/contract";
import { completeSetup, validatePasswordLength } from "./setup";

const PAYLOAD = { username: "rogier", password: "hunter2hunter2", timezone: "Europe/Amsterdam" };

/** Returns a client on a stub controller whose `setup.complete` answers `answer`, and what its token store holds. */
const buildSetup = (answer: Answer) => {
  const api = createApiStub({ "POST /api/v1/setup/complete": answer });
  const stored: Array<string | null> = [];
  const client = createClient({
    baseUrl: "http://127.0.0.1:4937",
    fetch: api.fetch,
    tokenStore: { read: () => null, write: (token) => stored.push(token) },
  });
  return { api, client, stored };
};

describe("completeSetup", () => {
  it("sends the setup token once, and stores only the login token from the reply", async () => {
    const { api, client, stored } = buildSetup({ body: { token: "minted" } });

    expect(await completeSetup(client, "one-time", PAYLOAD)).toEqual({ token: "minted" });

    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.authorization).toBe("Bearer one-time");
    expect(api.calls[0]?.body).toEqual(PAYLOAD);
    expect(client.getToken()).toBe("minted");
    expect(stored).toEqual(["minted"]);
  });

  it("takes the setup token back and fails with the controller's error when setup is refused", async () => {
    const { client, stored } = buildSetup({
      status: 401,
      body: buildErrorBody("unauthenticated", "the setup token has expired"),
    });

    await expect(completeSetup(client, "stale", PAYLOAD)).rejects.toThrow(
      "the setup token has expired",
    );

    expect(client.getToken()).toBeNull();
    expect(stored).not.toContain("stale");
  });
});

describe("validatePasswordLength", () => {
  it("refuses a password shorter than the contract allows, and accepts one that is long enough", () => {
    expect(validatePasswordLength("x".repeat(MIN_PASSWORD_LENGTH - 1))).toBe(
      `Use at least ${String(MIN_PASSWORD_LENGTH)} characters.`,
    );
    expect(validatePasswordLength("x".repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });
});
