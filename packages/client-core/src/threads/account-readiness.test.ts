/**
 * Tests `decideAccountReadiness`: where a Provider Account can run in a harness.
 * An account whose credential the controller keeps works on every runner that
 * has the harness, whatever a probe last found; an account that signs in on each
 * machine works where its probe found it signed in as its own person.
 */
import { describe, expect, it, vi } from "vitest";
import type { Runner } from "@hercule/contract";
import {
  ANTHROPIC_IDENTITY,
  BARE,
  HARNESSES,
  PROVIDERS,
  WITH_AGENTS,
  ZAI_IDENTITY,
  buildProviderAccount,
  buildSnapshot,
} from "../providers.testing";
import { decideAccountReadiness } from "./account-readiness";

const CATALOGS = { providers: PROVIDERS, harnesses: HARNESSES };

/** A runner with `pi` installed, and a build that can drive it. */
const WITH_PI: Runner = {
  ...BARE,
  facts: {
    ...BARE.facts!,
    harnesses: [{ name: "pi", present: true, path: "/usr/local/bin/pi" }],
    adapters: ["pi/pi"],
  },
};

describe("decideAccountReadiness", () => {
  describe("an account that works on every machine (a key)", () => {
    const zai = buildProviderAccount(ZAI_IDENTITY, []);

    it("is ready on a runner with the harness, though no probe of the account is stored there", () => {
      expect(decideAccountReadiness(CATALOGS, zai, "pi/pi", WITH_PI)).toBe("ready");
    });

    it("stays ready when the last probe on that runner failed", () => {
      const failed = buildProviderAccount(ZAI_IDENTITY, [
        buildSnapshot({
          runnerId: WITH_PI.id,
          auth: { status: "error", message: "timed out" },
        }),
      ]);

      expect(decideAccountReadiness(CATALOGS, failed, "pi/pi", WITH_PI)).toBe("ready");
    });

    it("is missing the harness on a runner that does not have it", () => {
      expect(decideAccountReadiness(CATALOGS, zai, "pi/pi", BARE)).toBe("harness-missing");
    });

    it("is missing the harness when the runner has the binary but its build has no adapter", () => {
      const noAdapter: Runner = { ...WITH_PI, facts: { ...WITH_PI.facts!, adapters: [] } };

      expect(decideAccountReadiness(CATALOGS, zai, "pi/pi", noAdapter)).toBe("harness-missing");
    });
  });

  describe("a token account", () => {
    const token = (expiresAt: string | null) => ({
      ...buildProviderAccount(ANTHROPIC_IDENTITY, []),
      kind: "subscription-token",
      expiresAt,
    });
    const WITH_CLAUDE: Runner = {
      ...BARE,
      facts: {
        ...BARE.facts!,
        harnesses: [{ name: "claude", present: true, path: "/usr/local/bin/claude" }],
        adapters: ["claude-code/claude-code"],
      },
    };
    const catalogs = {
      providers: PROVIDERS.map((provider) =>
        provider.id === "anthropic/anthropic"
          ? {
              ...provider,
              kinds: [
                {
                  id: "subscription-token",
                  title: "Claude subscription, every machine",
                  description: "A token.",
                  setup: [{ kind: "harness-login" as const, method: "create-token" as const }],
                  harnesses: ["claude-code/claude-code"],
                },
              ],
            }
          : provider,
      ),
      harnesses: HARNESSES,
    };

    it("is ready on a runner with the harness while the token lasts", () => {
      vi.useFakeTimers({ now: new Date("2026-10-31T12:00:00.000Z") });
      expect(
        decideAccountReadiness(
          catalogs,
          token("2027-10-31T12:00:00.000Z"),
          "claude-code/claude-code",
          WITH_CLAUDE,
        ),
      ).toBe("ready");
      vi.useRealTimers();
    });

    it("has no token yet while its expiry is unset, even where the harness is installed", () => {
      expect(
        decideAccountReadiness(catalogs, token(null), "claude-code/claude-code", WITH_CLAUDE),
      ).toBe("token-missing");
    });

    it("is not ready once the token is past its expiry, on any runner", () => {
      vi.useFakeTimers({ now: new Date("2026-10-31T12:00:00.000Z") });
      expect(
        decideAccountReadiness(
          catalogs,
          token("2026-10-30T12:00:00.000Z"),
          "claude-code/claude-code",
          WITH_CLAUDE,
        ),
      ).toBe("token-expired");
      vi.useRealTimers();
    });
  });

  describe("an account that signs in on each machine", () => {
    const signedIn = (identity: string | undefined) =>
      buildSnapshot({
        runnerId: WITH_AGENTS.id,
        auth: identity === undefined ? { status: "ok" } : { status: "ok", identity },
      });
    const account = (
      accountIdentity: string | null,
      snapshots = [signedIn("rogier@example.com")],
    ) => ({
      ...buildProviderAccount(ANTHROPIC_IDENTITY, snapshots),
      identity: accountIdentity,
    });
    const decide = (subject: ReturnType<typeof account>) =>
      decideAccountReadiness(CATALOGS, subject, ANTHROPIC_IDENTITY.harnessId, WITH_AGENTS);

    it("is ready where its probe found it signed in", () => {
      expect(decide(account(null))).toBe("ready");
    });

    it("is not signed in where it was never probed, or the probe found it signed out", () => {
      expect(decide(account(null, []))).toBe("not-signed-in");
      expect(
        decide(
          account(null, [
            buildSnapshot({ runnerId: WITH_AGENTS.id, auth: { status: "unauthenticated" } }),
          ]),
        ),
      ).toBe("not-signed-in");
    });

    it("is not signed in where the login belongs to someone else than the account", () => {
      expect(decide(account("work@example.com"))).toBe("not-signed-in");
    });

    it("compares identities without regard to case", () => {
      expect(decide(account("Rogier@Example.com"))).toBe("ready");
    });

    it("trusts a probe that names nobody", () => {
      expect(decide(account("work@example.com", [signedIn(undefined)]))).toBe("ready");
    });
  });

  describe("the harness on the runner, whatever the kind of account", () => {
    const tooOld = (runner: Runner) => ({
      providers: PROVIDERS,
      harnesses: HARNESSES.map((harness) => ({
        ...harness,
        runners: [
          {
            runnerId: runner.id,
            installed: true,
            version: "0.0.1",
            versionVerdict: "below-floor" as const,
          },
        ],
      })),
    });
    const signedInOnAgents = buildProviderAccount(ANTHROPIC_IDENTITY, [
      buildSnapshot({ runnerId: WITH_AGENTS.id, auth: { status: "ok" } }),
    ]);

    it("is missing the harness when an old signed-in probe outlives the harness", () => {
      expect(
        decideAccountReadiness(CATALOGS, signedInOnAgents, "claude-code/claude-code", BARE),
      ).toBe("harness-missing");
    });

    it("is missing the harness when the catalog does not list it", () => {
      expect(
        decideAccountReadiness(
          { providers: PROVIDERS, harnesses: [] },
          signedInOnAgents,
          "claude-code/claude-code",
          WITH_AGENTS,
        ),
      ).toBe("harness-missing");
    });

    it("is too old for a signed-in account when the harness is below the floor", () => {
      expect(
        decideAccountReadiness(
          tooOld(WITH_AGENTS),
          signedInOnAgents,
          "claude-code/claude-code",
          WITH_AGENTS,
        ),
      ).toBe("harness-too-old");
    });

    it("is too old for a key account when the harness is below the floor", () => {
      expect(
        decideAccountReadiness(
          tooOld(WITH_PI),
          buildProviderAccount(ZAI_IDENTITY, []),
          "pi/pi",
          WITH_PI,
        ),
      ).toBe("harness-too-old");
    });

    it("judges a harness on another runner's verdict only for that runner", () => {
      expect(
        decideAccountReadiness(
          tooOld({ ...BARE, id: "another-runner" }),
          signedInOnAgents,
          "claude-code/claude-code",
          WITH_AGENTS,
        ),
      ).toBe("ready");
    });
  });
});
