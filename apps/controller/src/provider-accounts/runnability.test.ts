/**
 * Tests the rule for whether a Provider Account can run in a harness on a
 * runner, which every caller of the rule shares.
 */
import { describe, expect, it } from "vitest";
import type { RunnerFacts } from "@hercule/protocol";
import { findVersionFloor } from "../harnesses";
import type { RegisteredHarness, RegisteredProvider } from "../plugins";
import {
  decideHarnessOnRunner,
  describeProviderAccount,
  findCredentialProblem,
  findHarnessProblem,
  isIdentityCompatible,
} from "./runnability";

// A harness this build pins a version for, so "below the floor" can happen.
const harness = {
  id: "codex/codex",
  binaryName: "codex",
  displayName: "Codex",
} as unknown as RegisteredHarness;

const factsWith = (overrides: Partial<RunnerFacts> = {}): RunnerFacts => ({
  os: "linux",
  arch: "x64",
  totalMemoryBytes: 1,
  docker: false,
  toolchains: [],
  harnesses: [{ name: "codex", present: true }],
  adapters: ["codex/codex"],
  identityPort: 1,
  ...overrides,
});

const providers = [
  {
    id: "openai",
    displayName: "OpenAI",
    kinds: [
      { id: "api-key", setup: [{ kind: "key" }] },
      { id: "subscription-token", setup: [{ kind: "harness-login" }] },
    ],
  },
] as unknown as ReadonlyArray<RegisteredProvider>;

const account = (kind: string, credentialExpiresAt: string | null = null) => ({
  providerId: "openai",
  kind,
  label: "work",
  credentialExpiresAt,
});

describe("decideHarnessOnRunner", () => {
  it("is runnable when the binary and the adapter are there and the version is not below the floor", () => {
    const floor = findVersionFloor("codex/codex")!;
    expect(decideHarnessOnRunner(factsWith(), harness, null)).toBe("runnable");
    expect(decideHarnessOnRunner(factsWith(), harness, floor)).toBe("runnable");
  });

  it("is missing before the runner's first report, without the binary, or without an adapter", () => {
    expect(decideHarnessOnRunner(null, harness, null)).toBe("missing");
    expect(
      decideHarnessOnRunner(
        factsWith({ harnesses: [{ name: "codex", present: false }] }),
        harness,
        null,
      ),
    ).toBe("missing");
    expect(decideHarnessOnRunner(factsWith({ adapters: [] }), harness, null)).toBe("missing");
  });

  it("is below the floor when the reported version is older than this build supports", () => {
    expect(decideHarnessOnRunner(factsWith(), harness, "0.0.1")).toBe("below-floor");
  });
});

describe("findHarnessProblem", () => {
  it("is null when any runner can run it, and otherwise says whether it is missing or old", () => {
    expect(findHarnessProblem(harness, ["missing", "runnable"])).toBeNull();
    expect(findHarnessProblem(harness, [])).toContain("Codex is not installed");
    expect(findHarnessProblem(harness, ["missing", "below-floor"])).toContain(
      "Codex is older than this version of Hercule supports",
    );
  });
});

// The messages for a missing key, a missing token and an expired token are
// tested through the services that report them (account-runners.test.ts and
// harness-account.test.ts). The instant of expiry is only reachable here.
describe("findCredentialProblem", () => {
  it("counts the instant of expiry as expired", () => {
    const now = Date.parse("2026-10-31T00:00:00.000Z");
    const [provider] = providers;
    const kind = provider!.kinds.find((one) => one.id === "subscription-token")!;

    expect(
      findCredentialProblem(
        account("subscription-token", "2026-10-31T00:00:00.000Z"),
        provider!,
        kind,
        true,
        now,
      ),
    ).toBe("OpenAI · work's token expired on 2026-10-31. Make a new one in Settings › Providers.");
    expect(
      findCredentialProblem(
        account("subscription-token", "2026-10-31T00:00:01.000Z"),
        provider!,
        kind,
        true,
        now,
      ),
    ).toBeNull();
  });

  it("calls an expired key a key, and says to add a new one", () => {
    const [provider] = providers;
    const kind = provider!.kinds.find((one) => one.id === "api-key")!;

    expect(
      findCredentialProblem(
        account("api-key", "2026-10-30T09:00:00.000Z"),
        provider!,
        kind,
        true,
        Date.parse("2026-10-31T00:00:00.000Z"),
      ),
    ).toBe("OpenAI · work's key expired on 2026-10-30. Add a new key in Settings › Providers.");
  });
});

describe("isIdentityCompatible", () => {
  it("accepts an unknown identity on either side, and the same person whatever the case", () => {
    expect(isIdentityCompatible(null, "a@example.com")).toBe(true);
    expect(isIdentityCompatible("a@example.com", null)).toBe(true);
    expect(isIdentityCompatible("A@Example.com", "a@example.com")).toBe(true);
    expect(isIdentityCompatible("a@example.com", "b@example.com")).toBe(false);
  });
});

describe("describeProviderAccount", () => {
  it("joins the provider and the label, and falls back to the provider id", () => {
    expect(describeProviderAccount(account("api-key"), providers)).toBe("OpenAI · work");
    expect(describeProviderAccount({ providerId: "zzz", label: null }, providers)).toBe("zzz");
  });
});
