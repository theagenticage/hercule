/**
 * Tests the rule for whether a Provider Account can run in a harness on a
 * runner, which every caller of the rule shares.
 */
import { describe, expect, it } from "vitest";
import { CODEX_VERSION } from "@hercule/home/version";
import type { RunnerFacts } from "@hercule/protocol";
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
    expect(decideHarnessOnRunner(factsWith(), harness, null)).toBe("runnable");
    expect(decideHarnessOnRunner(factsWith(), harness, CODEX_VERSION)).toBe("runnable");
  });

  it("is missing before the runner's first report, or when the adapter is there and the binary is not", () => {
    expect(decideHarnessOnRunner(null, harness, null)).toBe("missing");
    expect(
      decideHarnessOnRunner(
        factsWith({ harnesses: [{ name: "codex", present: false }] }),
        harness,
        null,
      ),
    ).toBe("missing");
  });

  it("has no adapter when the runner's build lacks it, whether or not the binary is there", () => {
    expect(decideHarnessOnRunner(factsWith({ adapters: [] }), harness, null)).toBe("no-adapter");
    expect(
      decideHarnessOnRunner(
        factsWith({ adapters: [], harnesses: [{ name: "codex", present: false }] }),
        harness,
        null,
      ),
    ).toBe("no-adapter");
  });

  it("is below the floor when the reported version is older than this build supports", () => {
    expect(decideHarnessOnRunner(factsWith(), harness, "0.0.1")).toBe("below-floor");
  });
});

describe("findHarnessProblem", () => {
  it("is null when any runner can run it, and otherwise says whether it is missing or old", () => {
    expect(findHarnessProblem(harness, ["missing", "runnable"])).toBeNull();
    expect(findHarnessProblem(harness, [])).toContain("Codex is not installed");
    expect(findHarnessProblem(harness, ["missing", "below-floor"])).toBe(
      `Codex is older than this version of Hercule supports on every machine that has it; update it to ${CODEX_VERSION} or newer`,
    );
  });

  it("tells the user to update Hercule only when every runner lacks the adapter", () => {
    const updateHercule =
      "Hercule cannot run Codex on any connected machine; update Hercule on a machine first";
    expect(findHarnessProblem(harness, ["no-adapter", "no-adapter"])).toBe(updateHercule);
    expect(findHarnessProblem(harness, ["no-adapter", "missing"])).toContain("is not installed");
    expect(findHarnessProblem(harness, ["no-adapter", "below-floor"])).toContain("is older than");
    expect(findHarnessProblem(harness, ["no-adapter", "runnable"])).toBeNull();
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
