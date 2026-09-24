import { describe, expect, it } from "vitest";
import type { ProviderInstance } from "@hercule/contract";
import { decideSessionsEmptyState, type SessionsEmptyState } from "./sessions-empty-state";
import { BARE, buildInstance, buildSnapshot, WITH_CLAUDE } from "./providers.testing";

const waiting = buildInstance("claude-code", "Claude Code", [
  buildSnapshot({ auth: { status: "unauthenticated" } }),
]);

const loggedIn = buildInstance("claude-code", "Claude Code", [buildSnapshot()]);

const undrivable = buildInstance("codex", "Codex", [
  buildSnapshot({
    auth: { status: "error", message: "no adapter for codex in this runner build" },
  }),
]);

/** What the screen would put on the buttons, in order. */
const listOfferedLabels = (state: SessionsEmptyState): ReadonlyArray<string> =>
  state.kind !== "sign-in"
    ? []
    : state.offers.flatMap((row) =>
        row.secretFields.length > 0
          ? row.secretFields.map((field) => field.label)
          : [row.logInLabel],
      );

const readLead = (state: SessionsEmptyState): string =>
  state.kind === "sign-in" ? state.lead : "";

describe("decideSessionsEmptyState", () => {
  it("has nothing to offer when no runner answered on this machine", () => {
    expect(decideSessionsEmptyState(null, [waiting])).toEqual({ kind: "no-runner" });
  });

  it("reads a local runner that is not connected as no runner at all", () => {
    // The screen offers a login, and a login runs on the machine: a row that
    // says `offline` can no more be logged in to than one that is absent.
    expect(
      decideSessionsEmptyState({ ...WITH_CLAUDE, connectivity: "offline" }, [waiting]),
    ).toEqual({
      kind: "no-runner",
    });
  });

  it("says the machine has no harness when it reported none", () => {
    expect(decideSessionsEmptyState(BARE, [waiting, undrivable])).toEqual({ kind: "no-harness" });
  });

  it("offers a login for every harness that is there and not logged in", () => {
    const state = decideSessionsEmptyState(WITH_CLAUDE, [waiting, undrivable]);

    expect(state.kind).toBe("sign-in");
    expect(listOfferedLabels(state)).toEqual(["Log in"]);
    expect(readLead(state)).toContain("runs on this machine");
    expect(readLead(state)).toContain("Log in to use it in Hercule.");
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
    const second = buildInstance("codex", "Codex", [
      buildSnapshot({ auth: { status: "unauthenticated" } }),
    ]);
    const state = decideSessionsEmptyState(machine, [waiting, second]);

    expect(listOfferedLabels(state)).toEqual(["Log in", "Log in"]);
    expect(readLead(state)).toContain("Log in to use them in Hercule.");
  });

  it("still offers the login when the last probe of a harness that is here failed", () => {
    // A failed probe does not mean the harness is missing; an install prompt
    // would send the user nowhere.
    const stale = buildInstance("claude-code", "Claude Code", [
      buildSnapshot({
        auth: { status: "error", message: "the harness did not answer within 15s" },
      }),
    ]);
    const state = decideSessionsEmptyState(WITH_CLAUDE, [stale]);

    expect(state.kind).toBe("sign-in");
    expect(listOfferedLabels(state)).toEqual(["Log in"]);
  });

  it("is ready once one instance on this machine is logged in", () => {
    expect(decideSessionsEmptyState(WITH_CLAUDE, [loggedIn])).toEqual({
      kind: "ready",
      name: "Claude Code",
    });
  });

  it("is ready even when another instance is still waiting for a login", () => {
    // One usable harness is what the screen is about; the rest is Fleet's
    // business, and a "log in" headline over a working install reads as broken.
    const second = buildInstance("codex", "Codex", [
      buildSnapshot({ auth: { status: "unauthenticated" } }),
    ]);
    expect(decideSessionsEmptyState(WITH_CLAUDE, [second, loggedIn])).toEqual({
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
describe("decideSessionsEmptyState for a harness that takes a key", () => {
  const FIELD = {
    name: "zaiApiKey",
    title: "Z.ai API key",
    description: "From your Z.ai Coding Plan subscription.",
    set: false,
  };

  const keyed: ProviderInstance = {
    ...buildInstance("pi", "pi", [buildSnapshot({ auth: { status: "unauthenticated" } })]),
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
    const state = decideSessionsEmptyState(WITH_PI, [keyed]);

    expect(listOfferedLabels(state)).toEqual(["Enter Z.ai API key"]);
    expect(readLead(state)).toContain("kept by the controller");
    expect(readLead(state)).not.toContain("stays there");
    expect(readLead(state)).toContain("Enter its key to use it in Hercule.");
  });

  it("asks for the keys in the plural when two harnesses want one", () => {
    const other: ProviderInstance = {
      ...buildInstance("codex", "Codex", [buildSnapshot({ auth: { status: "unauthenticated" } })]),
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
    const state = decideSessionsEmptyState(machine, [keyed, other]);

    expect(listOfferedLabels(state)).toEqual(["Enter Z.ai API key", "Enter Codex API key"]);
    expect(readLead(state)).toContain("Enter their keys to use them in Hercule.");
  });

  it("says where each kind of credential goes where both are on offer", () => {
    // Neither sentence is true of the other offer, so a screen showing both
    // says both.
    const state = decideSessionsEmptyState(
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

    expect(listOfferedLabels(state)).toEqual(["Enter Z.ai API key", "Log in"]);
    expect(readLead(state)).toContain("stays there");
    expect(readLead(state)).toContain("kept by the controller");
    // Both kinds on offer is two harnesses at least, so this lead is plural.
    expect(readLead(state)).toContain("Sign in to use them in Hercule.");
  });
});
