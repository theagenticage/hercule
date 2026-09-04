import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { apiKey } from "./groups/api-key";
import { auth } from "./groups/auth";
import { profile } from "./groups/profile";
import { secret } from "./groups/secret";
import { setup } from "./groups/setup";
import { user } from "./groups/user";
import { MAX_PASSWORD_LENGTH, MAX_SECRET_VALUE_LENGTH, MIN_PASSWORD_LENGTH } from "./strings";

const decode = (schema: unknown, input: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(schema as Schema.Codec<unknown, unknown>)(input))
    ._tag;

/** One endpoint of a group, by the identifier the group declares it under. */
const endpointOf = (group: unknown, identifier: string): Record<string, unknown> => {
  const endpoints = (group as { endpoints: Record<string, unknown> }).endpoints;
  const endpoint = endpoints[identifier];
  if (endpoint === undefined) throw new Error(`no endpoint ${identifier}`);
  return endpoint as Record<string, unknown>;
};

/**
 * What an endpoint validates its JSON request body against. `payload` is a map
 * from content type to the schemas declared for it; the API speaks JSON only.
 */
const payloadOf = (group: unknown, identifier: string): unknown => {
  const byContentType = endpointOf(group, identifier)["payload"] as Map<
    string,
    { readonly schemas: ReadonlyArray<unknown> }
  >;
  const json = byContentType.get("application/json");
  if (json === undefined) throw new Error(`${identifier} declares no JSON payload`);
  return json.schemas[0];
};

const PASSWORD = "correct horse battery staple";
const TOO_LONG_PASSWORD = "x".repeat(MAX_PASSWORD_LENGTH + 1);
const HUGE = "x".repeat(20_000);

describe("bounds on free text", () => {
  it("caps the login username and password, so an anonymous caller cannot write megabytes", () => {
    const login = payloadOf(auth, "login");
    expect(decode(login, { username: "rogier", password: PASSWORD })).toBe("Success");
    expect(decode(login, { username: HUGE, password: PASSWORD })).toBe("Failure");
    expect(decode(login, { username: "rogier", password: TOO_LONG_PASSWORD })).toBe("Failure");
    // A login must not tell an anonymous caller what the policy is: a short
    // password is `unauthenticated` after the check, not `validation` before it.
    expect(decode(login, { username: "rogier", password: "n" })).toBe("Success");
  });

  it("applies the password policy where a password is chosen", () => {
    const complete = payloadOf(setup, "complete");
    const shortest = "x".repeat(MIN_PASSWORD_LENGTH);
    expect(decode(complete, { username: "r", password: shortest, timezone: "UTC" })).toBe(
      "Success",
    );
    expect(decode(complete, { username: "r", password: shortest.slice(1), timezone: "UTC" })).toBe(
      "Failure",
    );
    expect(decode(complete, { username: "r", password: PASSWORD, timezone: HUGE })).toBe("Failure");

    const setPassword = payloadOf(user, "setPassword");
    expect(decode(setPassword, { current: PASSWORD, next: PASSWORD })).toBe("Success");
    expect(decode(setPassword, { current: PASSWORD, next: "short" })).toBe("Failure");
    expect(decode(setPassword, { current: TOO_LONG_PASSWORD, next: PASSWORD })).toBe("Failure");
  });

  it("caps the names a caller chooses", () => {
    expect(decode(payloadOf(apiKey, "create"), { name: "x".repeat(128) })).toBe("Success");
    expect(decode(payloadOf(apiKey, "create"), { name: "x".repeat(129) })).toBe("Failure");
    expect(decode(payloadOf(profile, "create"), { name: "x".repeat(128), grants: [] })).toBe(
      "Success",
    );
    expect(decode(payloadOf(profile, "create"), { name: "x".repeat(129), grants: [] })).toBe(
      "Failure",
    );
  });

  it("caps both halves of a secret's owner and its name", () => {
    const params = endpointOf(secret, "set")["params"];
    const owner = { ownerKind: "plugin", ownerId: "x".repeat(256) };
    expect(decode(params, { ...owner, name: "x".repeat(256) })).toBe("Success");
    expect(decode(params, { ...owner, name: "x".repeat(257) })).toBe("Failure");
    expect(decode(params, { ownerKind: "plugin", ownerId: "x".repeat(257), name: "n" })).toBe(
      "Failure",
    );
  });

  it("caps a secret's value, which is the largest thing the API accepts", () => {
    const set = payloadOf(secret, "set");
    expect(decode(set, { value: "x".repeat(MAX_SECRET_VALUE_LENGTH) })).toBe("Success");
    expect(decode(set, { value: "x".repeat(MAX_SECRET_VALUE_LENGTH + 1) })).toBe("Failure");
    expect(decode(set, { value: "" })).toBe("Failure");
  });
});
