import { describe, expect, it } from "vitest";
import type { ProviderInstance } from "@hydra/contract";
import { sessionsEmptyState, type SessionsEmptyState } from "./sessions-empty-state";
import { BARE, instance, snapshot, WITH_CLAUDE } from "./providers.testing";

const waiting = instance("claude-code", "Claude Code", [
  snapshot({ auth: { status: "unauthenticated" } }),
]);

const loggedIn = instance("claude-code", "Claude Code", [snapshot()]);

const undrivable = instance("codex", "Codex", [
  snapshot({
    auth: { status: "error", message: "no adapter for codex in this runner build" },
  }),
]);

/** What the screen would put on the buttons, in order. */
const offered = (state: SessionsEmptyState): ReadonlyArray<string> =>
  state.kind !== "sign-in"
    ? []
    : state.offers.flatMap((row) =>
        row.secretFields.length > 0
          ? row.secretFields.map((field) => field.label)
          : [row.logInLabel],
      );

const leadOf = (state: SessionsEmptyState): string => (state.kind === "sign-in" ? state.lead : "");

describe("sessionsEmptyState", () => {
  it("has nothing to offer when no runner answered on this machine", () => {
    expect(sessionsEmptyState(null, [waiting])).toEqual({ kind: "no-runner" });
  });

  it("reads a local runner that is not connected as no runner at all", () => {
    // The screen offers a login, and a login runs on the machine: a row that
    // says `offline` can no more be logged in to than one that is absent.
    expect(sessionsEmptyState({ ...WITH_CLAUDE, connectivity: "offline" }, [waiting])).toEqual({
      kind: "no-runner",
    });
  });

  it("says the machine has no harness when it reported none", () => {
    expect(sessionsEmptyState(BARE, [waiting, undrivable])).toEqual({ kind: "no-harness" });
  });

  it("offers a login for every harness that is there and not logged in", () => {
    const state = sessionsEmptyState(WITH_CLAUDE, [waiting, undrivable]);

    expect(state.kind).toBe("sign-in");
    expect(offered(state)).toEqual(["Log in"]);
    expect(leadOf(state)).toContain("runs on this machine");
    expect(leadOf(state)).toContain("Log in to use it in Hydra.");
  });

  it("says `them` when the headline names more than one harness", () => {
    // The lead points back at the headline's list, so a list of two read with
    // a singular pronoun would leave the reader guessing which one it meant.
    const machine = {
      ...WITH_CLAUDE,
      facts: {
        ...WITH_CLAUDE.facts!,
        adapters: ["claude-code", "codex"],
        providers: [
          { name: "claude", present: true, path: "/usr/local/bin/claude" },
          { name: "codex", present: true, path: "/usr/local/bin/codex" },
        ],
      },
    };
    const second = instance("codex", "Codex", [snapshot({ auth: { status: "unauthenticated" } })]);
    const state = sessionsEmptyState(machine, [waiting, second]);

    expect(offered(state)).toEqual(["Log in", "Log in"]);
    expect(leadOf(state)).toContain("Log in to use them in Hydra.");
  });

  it("still offers the login when the last probe of a harness that is here failed", () => {
    // A failed probe does not mean the harness is missing; an install prompt
    // would send the user nowhere.
    const stale = instance("claude-code", "Claude Code", [
      snapshot({
        auth: { status: "error", message: "the harness did not answer within 15s" },
      }),
    ]);
    const state = sessionsEmptyState(WITH_CLAUDE, [stale]);

    expect(state.kind).toBe("sign-in");
    expect(offered(state)).toEqual(["Log in"]);
  });

  it("is ready once one instance on this machine is logged in", () => {
    expect(sessionsEmptyState(WITH_CLAUDE, [loggedIn])).toEqual({
      kind: "ready",
      name: "Claude Code",
    });
  });

  it("is ready even when another instance is still waiting for a login", () => {
    // One usable harness is what the screen is about; the rest is Fleet's
    // business, and a "log in" headline over a working install reads as broken.
    const second = instance("codex", "Codex", [snapshot({ auth: { status: "unauthenticated" } })]);
    expect(sessionsEmptyState(WITH_CLAUDE, [second, loggedIn])).toEqual({
      kind: "ready",
      name: "Claude Code",
    });
  });
});

/**
 * A harness signed in with a value the user types rather than a browser flow.
 * What the screen says about where that value goes has to be true of it: it is
 * kept by the controller, not by the machine the thread happens to run on.
 */
describe("sessionsEmptyState for a harness that takes a key", () => {
  const FIELD = {
    name: "zaiApiKey",
    title: "Z.ai API key",
    description: "From your Z.ai Coding Plan subscription.",
    set: false,
  };

  const keyed: ProviderInstance = {
    ...instance("pi", "pi", [snapshot({ auth: { status: "unauthenticated" } })]),
    binaryName: "pi",
    secretFields: [FIELD],
  };

  const WITH_PI = {
    ...WITH_CLAUDE,
    facts: {
      ...WITH_CLAUDE.facts!,
      providers: [{ name: "pi", present: true, path: "/usr/local/bin/pi" }],
      adapters: ["pi"],
    },
  };

  it("offers the key, and says where the key is kept", () => {
    const state = sessionsEmptyState(WITH_PI, [keyed]);

    expect(offered(state)).toEqual(["Enter Z.ai API key"]);
    expect(leadOf(state)).toContain("kept by the controller");
    expect(leadOf(state)).not.toContain("stays there");
    expect(leadOf(state)).toContain("Enter its key to use it in Hydra.");
  });

  it("asks for the keys in the plural when two harnesses want one", () => {
    const other: ProviderInstance = {
      ...instance("codex", "Codex", [snapshot({ auth: { status: "unauthenticated" } })]),
      binaryName: "codex",
      secretFields: [{ ...FIELD, name: "codexApiKey", title: "Codex API key" }],
    };
    const machine = {
      ...WITH_PI,
      facts: {
        ...WITH_PI.facts,
        adapters: ["pi", "codex"],
        providers: [
          ...WITH_PI.facts.providers,
          { name: "codex", present: true, path: "/usr/local/bin/codex" },
        ],
      },
    };
    const state = sessionsEmptyState(machine, [keyed, other]);

    expect(offered(state)).toEqual(["Enter Z.ai API key", "Enter Codex API key"]);
    expect(leadOf(state)).toContain("Enter their keys to use them in Hydra.");
  });

  it("says where each kind of credential goes where both are on offer", () => {
    // Neither sentence is true of the other offer, so a screen showing both
    // says both.
    const state = sessionsEmptyState(
      {
        ...WITH_PI,
        facts: {
          ...WITH_PI.facts,
          adapters: ["pi", "claude-code"],
          providers: [...WITH_PI.facts.providers, { name: "claude", present: true }],
        },
      },
      [keyed, waiting],
    );

    expect(offered(state)).toEqual(["Enter Z.ai API key", "Log in"]);
    expect(leadOf(state)).toContain("stays there");
    expect(leadOf(state)).toContain("kept by the controller");
    // Both kinds on offer is two harnesses at least, so this lead is plural.
    expect(leadOf(state)).toContain("Sign in to use them in Hydra.");
  });
});
