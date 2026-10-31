import { describe, expect, it } from "vitest";
import {
  decideSessionsEmptyState,
  hasLoggedInRunner,
  type SessionsEmptyState,
} from "./sessions-empty-state";
import {
  BARE,
  HARNESSES,
  PROVIDERS,
  buildProviderAccount,
  buildSnapshot,
  ANTHROPIC_IDENTITY,
  OPENAI_IDENTITY,
  ZAI_IDENTITY,
  WITH_CLAUDE,
} from "./providers.testing";

const waiting = buildProviderAccount(ANTHROPIC_IDENTITY, [
  buildSnapshot({ auth: { status: "unauthenticated" } }),
]);

const loggedIn = buildProviderAccount(ANTHROPIC_IDENTITY, [buildSnapshot()]);

const undrivable = buildProviderAccount(OPENAI_IDENTITY, [
  buildSnapshot({
    auth: { status: "error", message: "no adapter for codex in this runner build" },
  }),
]);

/** Returns the button labels the screen would show, in order. */
const listOfferedLabels = (state: SessionsEmptyState): ReadonlyArray<string> =>
  state.kind !== "sign-in"
    ? []
    : state.offers.flatMap((row) =>
        row.credentialFields.length > 0
          ? row.credentialFields.map((field) => field.label)
          : [row.signInLabel],
      );

const readLead = (state: SessionsEmptyState): string =>
  state.kind === "sign-in" ? state.lead : "";

describe("decideSessionsEmptyState", () => {
  it("returns no-runner when there is no local runner", () => {
    expect(decideSessionsEmptyState(null, [waiting], PROVIDERS, HARNESSES)).toEqual({
      kind: "no-runner",
    });
  });

  it("treats a local runner that is not online as no runner", () => {
    // A sign-in runs on the runner's machine, so an offline runner is as
    // useless for signing in as no runner at all.
    expect(
      decideSessionsEmptyState(
        { ...WITH_CLAUDE, connectivity: "offline" },
        [waiting],
        PROVIDERS,
        HARNESSES,
      ),
    ).toEqual({
      kind: "no-runner",
    });
  });

  it("returns no-harness when the runner reported no harness", () => {
    expect(decideSessionsEmptyState(BARE, [waiting, undrivable], PROVIDERS, HARNESSES)).toEqual({
      kind: "no-harness",
    });
  });

  it("offers a login for every installed harness that is not logged in", () => {
    const state = decideSessionsEmptyState(
      WITH_CLAUDE,
      [waiting, undrivable],
      PROVIDERS,
      HARNESSES,
    );

    expect(state.kind).toBe("sign-in");
    expect(listOfferedLabels(state)).toEqual(["Sign in"]);
    expect(readLead(state)).toContain("runs on this machine");
    expect(readLead(state)).toContain("Sign in to use it in Hercule.");
  });

  it("says `them` when more than one harness is offered", () => {
    // The lead refers back to the harnesses in the headline. With two of
    // them, a singular pronoun would leave the reader guessing which one.
    const machine = {
      ...WITH_CLAUDE,
      facts: {
        ...WITH_CLAUDE.facts!,
        adapters: ["claude-code/claude-code", "codex/codex"],
        harnesses: [
          { name: "claude", present: true, path: "/usr/local/bin/claude" },
          { name: "codex", present: true, path: "/usr/local/bin/codex" },
        ],
      },
    };
    const second = buildProviderAccount(OPENAI_IDENTITY, [
      buildSnapshot({ auth: { status: "unauthenticated" } }),
    ]);
    const state = decideSessionsEmptyState(machine, [waiting, second], PROVIDERS, HARNESSES);

    expect(listOfferedLabels(state)).toEqual(["Sign in", "Sign in"]);
    expect(readLead(state)).toContain("Sign in to use them in Hercule.");
  });

  it("still offers the login when the last probe of an installed harness failed", () => {
    // A failed probe does not mean the harness is missing, so an install
    // prompt would not help.
    const stale = buildProviderAccount(ANTHROPIC_IDENTITY, [
      buildSnapshot({
        auth: { status: "error", message: "the harness did not answer within 15s" },
      }),
    ]);
    const state = decideSessionsEmptyState(WITH_CLAUDE, [stale], PROVIDERS, HARNESSES);

    expect(state.kind).toBe("sign-in");
    expect(listOfferedLabels(state)).toEqual(["Sign in"]);
  });

  it("is ready once one account on the local runner is signed in", () => {
    expect(decideSessionsEmptyState(WITH_CLAUDE, [loggedIn], PROVIDERS, HARNESSES)).toEqual({
      kind: "ready",
      name: "Anthropic",
    });
  });

  it("is ready even when another account is still waiting for a sign-in", () => {
    // One usable account is enough for this screen; the others are managed on
    // the Fleet screen. A "sign in" headline when an account works looks broken.
    const second = buildProviderAccount(OPENAI_IDENTITY, [
      buildSnapshot({ auth: { status: "unauthenticated" } }),
    ]);
    expect(decideSessionsEmptyState(WITH_CLAUDE, [second, loggedIn], PROVIDERS, HARNESSES)).toEqual(
      {
        kind: "ready",
        name: "Anthropic",
      },
    );
  });
});

/**
 * A harness that signs in with a value the user types, rather than a browser
 * login. The screen must say correctly where that value is stored: by the
 * controller, not on the machine the thread runs on.
 */
describe("decideSessionsEmptyState for a harness that signs in with a key", () => {
  const keyed = buildProviderAccount(ZAI_IDENTITY, [
    buildSnapshot({ auth: { status: "unauthenticated" } }),
  ]);

  const WITH_PI = {
    ...WITH_CLAUDE,
    facts: {
      ...WITH_CLAUDE.facts!,
      harnesses: [{ name: "pi", present: true, path: "/usr/local/bin/pi" }],
      adapters: ["pi/pi"],
    },
  };

  it("offers the key, and says where the key is stored", () => {
    const state = decideSessionsEmptyState(WITH_PI, [keyed], PROVIDERS, HARNESSES);

    expect(listOfferedLabels(state)).toEqual(["Enter API key"]);
    expect(readLead(state)).toContain("kept by the controller");
    expect(readLead(state)).not.toContain("stays there");
    expect(readLead(state)).toContain("Enter its key to use it in Hercule.");
  });

  it("asks for the keys in the plural when two harnesses want one", () => {
    // OpenAI offers a key here too, so two accounts each want one.
    const providers = PROVIDERS.map((provider) =>
      provider.id === "openai/openai"
        ? {
            ...provider,
            kinds: [
              {
                id: "api-key",
                title: "API key",
                description: "An OpenAI API key.",
                setup: [
                  {
                    kind: "credentials" as const,
                    fields: [{ name: "apiKey", label: "Codex API key" }],
                  },
                ],
                harnesses: ["codex/codex"],
              },
            ],
          }
        : provider,
    );
    const other = {
      ...buildProviderAccount(OPENAI_IDENTITY, [
        buildSnapshot({ auth: { status: "unauthenticated" } }),
      ]),
      kind: "api-key",
    };
    const machine = {
      ...WITH_PI,
      facts: {
        ...WITH_PI.facts,
        adapters: ["pi/pi", "codex/codex"],
        harnesses: [
          ...WITH_PI.facts.harnesses,
          { name: "codex", present: true, path: "/usr/local/bin/codex" },
        ],
      },
    };
    const state = decideSessionsEmptyState(machine, [keyed, other], providers, HARNESSES);

    expect(listOfferedLabels(state)).toEqual(["Enter API key", "Enter Codex API key"]);
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
          adapters: ["pi/pi", "claude-code/claude-code"],
          harnesses: [...WITH_PI.facts.harnesses, { name: "claude", present: true }],
        },
      },
      [keyed, waiting],
      PROVIDERS,
      HARNESSES,
    );

    expect(listOfferedLabels(state)).toEqual(["Enter API key", "Sign in"]);
    expect(readLead(state)).toContain("stays there");
    expect(readLead(state)).toContain("kept by the controller");
    // Offering both kinds needs at least two harnesses, so this lead is plural.
    expect(readLead(state)).toContain("Sign in to use them in Hercule.");
  });
});

describe("hasLoggedInRunner", () => {
  it("is true when an online runner has a logged-in harness", () => {
    expect(hasLoggedInRunner([BARE], [loggedIn], PROVIDERS, HARNESSES)).toBe(true);
  });

  it("is false when no harness is logged in", () => {
    expect(hasLoggedInRunner([BARE], [waiting], PROVIDERS, HARNESSES)).toBe(false);
  });

  it("is false when the runner with the login is offline", () => {
    expect(
      hasLoggedInRunner([{ ...BARE, connectivity: "offline" }], [loggedIn], PROVIDERS, HARNESSES),
    ).toBe(false);
  });

  it("is false with no runners", () => {
    expect(hasLoggedInRunner([], [loggedIn], PROVIDERS, HARNESSES)).toBe(false);
  });
});
