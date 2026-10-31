import { describe, expect, it } from "vitest";
import type { AccountKind } from "@hercule/plugin-host";
import { findCredentialSecretName } from "./providers";

const kind = (setup: AccountKind["setup"]): AccountKind => ({
  id: "kind",
  title: "Kind",
  description: "A kind.",
  setup,
  harnesses: ["alpha/alpha"],
});

describe("findCredentialSecretName", () => {
  it("returns apiKey for a kind with a credentials step", () => {
    expect(
      findCredentialSecretName(
        kind([{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }]),
      ),
    ).toBe("apiKey");
  });

  it("returns token for a kind whose harness login makes a token", () => {
    expect(
      findCredentialSecretName(kind([{ kind: "harness-login", method: "create-token" }])),
    ).toBe("token");
  });

  it("returns nothing for a kind that signs in on each machine", () => {
    expect(
      findCredentialSecretName(kind([{ kind: "harness-login", method: "sign-in" }])),
    ).toBeUndefined();
  });

  it("returns nothing for a kind with no credential step at all", () => {
    expect(findCredentialSecretName(kind([{ kind: "oauth" }]))).toBeUndefined();
  });
});
