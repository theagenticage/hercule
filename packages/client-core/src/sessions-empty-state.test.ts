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

/** Returns the button labels the screen would show, in order. */
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
  it("returns no-runner when there is no local runner", () => {
    expect(decideSessionsEmptyState(null, [waiting])).toEqual({ kind: "no-runner" });
  });

  it("treats a local runner that is not online as no runner", () => {
    // A login runs on the runner's machine, so an offline runner is as
    // useless for logging in as no runner at all.
    expect(
      decideSessionsEmptyState({ ...WITH_CLAUDE, connectivity: "offline" }, [waiting]),
    ).toEqual({
      kind: "no-runner",
    });
  });

  it("returns no-harness when the runner reported no harness", () => {
    expect(decideSessionsEmptyState(BARE, [waiting, undrivable])).toEqual({ kind: "no-harness" });
  });

  it("offers a login for every installed harness that is not logged in", () => {
    const state = decideSessionsEmptyState(WITH_CLAUDE, [waiting, undrivable]);

    expect(state.kind).toBe("sign-in");
    expect(listOfferedLabels(state)).toEqual(["Log in"]);
    expect(readLead(state)).toContain("runs on this machine");
    expect(readLead(state)).toContain("Log in to use it in Hercule.");
  });

  it("says `them` when more than one harness is offered", () => {
    // The lead refers back to the harnesses in the headline. With two of
    // them, a singular pronoun would leave the reader guessing which one.
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

  it("still offers the login when the last probe of an installed harness failed", () => {
    // A failed probe does not mean the harness is missing, so an install
    // prompt would not help.
    const stale = buildInstance("claude-code", "Claude Code", [
      buildSnapshot({
        auth: { status: "error", message: "the harness did not answer within 15s" },
      }),
    ]);
    const state = decideSessionsEmptyState(WITH_CLAUDE, [stale]);

    expect(state.kind).toBe("sign-in");
    expect(listOfferedLabels(state)).toEqual(["Log in"]);
  });

  it("is ready once one instance on the local runner is logged in", () => {
    expect(decideSessionsEmptyState(WITH_CLAUDE, [loggedIn])).toEqual({
      kind: "ready",
      name: "Claude Code",
    });
  });

  it("is ready even when another instance is still waiting for a login", () => {
    // One usable harness is enough for this screen; the others are managed on
    // the Fleet screen. A "log in" headline when a harness works looks broken.
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
 * A harness that signs in with a value the user types, rather than a browser
 * login. The screen must say correctly where that value is stored: by the
 * controller, not on the machine the thread runs on.
 */
describe("decideSessionsEmptyState for a harness that signs in with a key", () => {
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

  it("offers the key, and says where the key is stored", () => {
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

  it("says where each kind of credential is stored when both are offered", () => {
    // Each sentence is true of only one kind of credential, so a screen that
    // offers both shows both sentences.
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
    // Offering both kinds needs at least two harnesses, so this lead is plural.
    expect(readLead(state)).toContain("Sign in to use them in Hercule.");
  });
});
