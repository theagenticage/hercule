/**
 * Tests `listProviderAccountHarnessChoices`: which harnesses an account can
 * run in, and the first reason it cannot, for every account kind the shipped
 * plugins declare.
 */
import { describe, expect, it } from "vitest";
import type { Harness, Provider, Runner } from "@hercule/contract";
import { BARE, HARNESSES, PROVIDERS, WITH_CLAUDE } from "./providers.testing";
import { listProviderAccountHarnessChoices } from "./provider-account-harnesses";

const CLAUDE_CODE = "claude-code/claude-code";
const CODEX = "codex/codex";
const PI = "pi/pi";

/** The kinds of the shipped plugins, with their real titles and the harnesses their terms allow. */
const SHIPPED_PROVIDERS: ReadonlyArray<Provider> = [
  {
    ...PROVIDERS[0]!,
    kinds: [
      {
        ...PROVIDERS[0]!.kinds[0]!,
        id: "subscription-per-machine",
        title: "Claude subscription, signed in on each machine",
        harnesses: [CLAUDE_CODE],
      },
      {
        ...PROVIDERS[0]!.kinds[0]!,
        id: "subscription-token",
        title: "Claude subscription, every machine",
        harnesses: [CLAUDE_CODE],
      },
      { ...PROVIDERS[0]!.kinds[0]!, id: "api-key", title: "API key", harnesses: [CLAUDE_CODE, PI] },
    ],
  },
  {
    ...PROVIDERS[1]!,
    kinds: [
      {
        ...PROVIDERS[1]!.kinds[0]!,
        id: "subscription-per-machine",
        title: "ChatGPT subscription, signed in on each machine",
        harnesses: [CODEX],
      },
      { ...PROVIDERS[1]!.kinds[0]!, id: "api-key", title: "API key", harnesses: [CODEX, PI] },
    ],
  },
  PROVIDERS[2]!,
];

/** What each shipped harness runs, as its plugin declares it. */
const SHIPPED_HARNESSES: ReadonlyArray<Harness> = [
  {
    ...HARNESSES[0]!,
    runs: [
      {
        providerId: "anthropic/anthropic",
        kinds: [
          { kind: "subscription-per-machine", modelArgument: "{model}" },
          { kind: "subscription-token", modelArgument: "{model}" },
          { kind: "api-key", modelArgument: "{model}" },
        ],
        models: "all",
      },
    ],
  },
  {
    ...HARNESSES[1]!,
    runs: [
      {
        providerId: "openai/openai",
        kinds: [
          { kind: "subscription-per-machine", modelArgument: "{model}" },
          { kind: "api-key", modelArgument: "{model}" },
        ],
        models: "all",
      },
    ],
  },
  {
    ...HARNESSES[2]!,
    runs: [
      {
        providerId: "anthropic/anthropic",
        kinds: [{ kind: "api-key", modelArgument: "anthropic/{model}" }],
        models: "own-list",
      },
      {
        providerId: "openai/openai",
        kinds: [{ kind: "api-key", modelArgument: "openai/{model}" }],
        models: "own-list",
      },
      {
        providerId: "zai/zai",
        kinds: [{ kind: "api-key", modelArgument: "zai/{model}" }],
        models: "own-list",
      },
    ],
  },
];

/** A runner that has every shipped harness installed. */
const WITH_ALL: Runner = {
  ...BARE,
  facts: {
    ...BARE.facts!,
    harnesses: ["claude", "codex", "pi"].map((name) => ({ name, present: true })),
  },
};

const choose = (
  providerId: string,
  kind: string,
  runners: ReadonlyArray<Runner> = [WITH_ALL],
  harnesses: ReadonlyArray<Harness> = SHIPPED_HARNESSES,
) =>
  Object.fromEntries(
    listProviderAccountHarnessChoices(
      { providerId, kind, label: "Work" },
      SHIPPED_PROVIDERS,
      harnesses,
      runners,
    ).map((choice) => [choice.harnessId, choice.unavailableReason]),
  );

describe("listProviderAccountHarnessChoices", () => {
  it("lists every harness in the order given, with its name", () => {
    const choices = listProviderAccountHarnessChoices(
      { providerId: "zai/zai", kind: "api-key", label: null },
      SHIPPED_PROVIDERS,
      [...SHIPPED_HARNESSES].reverse(),
      [WITH_ALL],
    );

    expect(choices.map((choice) => choice.harnessName)).toEqual(["pi", "Codex", "Claude Code"]);
  });

  describe("when the provider allows the kind only in some harnesses", () => {
    it.each([
      [
        "anthropic/anthropic",
        "subscription-per-machine",
        {
          [CODEX]: "Anthropic allows a Claude subscription only in Claude Code",
          [PI]: "Anthropic allows a Claude subscription only in Claude Code",
        },
      ],
      [
        "anthropic/anthropic",
        "subscription-token",
        {
          [CODEX]: "Anthropic allows a Claude subscription only in Claude Code",
          [PI]: "Anthropic allows a Claude subscription only in Claude Code",
        },
      ],
      [
        "anthropic/anthropic",
        "api-key",
        { [CODEX]: "Anthropic allows an API key only in Claude Code and pi" },
      ],
      [
        "openai/openai",
        "subscription-per-machine",
        {
          [CLAUDE_CODE]: "OpenAI allows a ChatGPT subscription only in Codex",
          [PI]: "OpenAI allows a ChatGPT subscription only in Codex",
        },
      ],
      [
        "openai/openai",
        "api-key",
        { [CLAUDE_CODE]: "OpenAI allows an API key only in Codex and pi" },
      ],
      [
        "zai/zai",
        "api-key",
        {
          [CLAUDE_CODE]: "Z.ai allows an API key only in pi",
          [CODEX]: "Z.ai allows an API key only in pi",
        },
      ],
    ])("explains it for %s %s", (providerId, kind, expected) => {
      expect(choose(providerId, kind)).toMatchObject(expected);
    });
  });

  it("allows the harnesses an account of each shipped kind may run in", () => {
    expect(choose("anthropic/anthropic", "subscription-per-machine")[CLAUDE_CODE]).toBeNull();
    expect(choose("anthropic/anthropic", "api-key")).toMatchObject({
      [CLAUDE_CODE]: null,
      [PI]: null,
    });
    expect(choose("openai/openai", "subscription-per-machine")[CODEX]).toBeNull();
    expect(choose("openai/openai", "api-key")).toMatchObject({ [CODEX]: null, [PI]: null });
    expect(choose("zai/zai", "api-key")[PI]).toBeNull();
  });

  it("says the harness cannot run the kind when its runs do not list it, even if the terms allow it", () => {
    const withoutOpenAi = SHIPPED_HARNESSES.map((harness) =>
      harness.id === CODEX ? { ...harness, runs: [] } : harness,
    );

    expect(
      choose("openai/openai", "subscription-per-machine", [WITH_ALL], withoutOpenAi)[CODEX],
    ).toBe("Codex can't run OpenAI's ChatGPT subscription");
    expect(
      choose(
        "anthropic/anthropic",
        "api-key",
        [WITH_ALL],
        [{ ...SHIPPED_HARNESSES[0]!, runs: [] }, ...SHIPPED_HARNESSES.slice(1)],
      )[CLAUDE_CODE],
    ).toBe("Claude Code can't run Anthropic's API key");
  });

  it("says the harness is on no machine when no runner has it", () => {
    expect(choose("zai/zai", "api-key", [WITH_CLAUDE])[PI]).toBe("pi is on no machine");
    expect(choose("openai/openai", "api-key", [WITH_CLAUDE])[CODEX]).toBe("Codex is on no machine");
  });

  it("does not count a retired runner or one that reported no facts", () => {
    const retired: Runner = { ...WITH_ALL, lifecycle: "retired" };
    const unknown: Runner = { ...WITH_ALL, id: "runner-unknown", facts: null };

    expect(choose("zai/zai", "api-key", [retired, unknown])[PI]).toBe("pi is on no machine");
  });

  it("counts a runner that is offline, because its facts still say what is installed", () => {
    const offline: Runner = { ...WITH_ALL, connectivity: "offline" };

    expect(choose("zai/zai", "api-key", [offline])[PI]).toBeNull();
  });

  it("gives the first reason that fails: the provider's terms before the harness's support before the machine", () => {
    const noRuns = SHIPPED_HARNESSES.map((harness) => ({ ...harness, runs: [] }));

    expect(choose("zai/zai", "api-key", [], noRuns)).toEqual({
      [CLAUDE_CODE]: "Z.ai allows an API key only in pi",
      [CODEX]: "Z.ai allows an API key only in pi",
      [PI]: "pi can't run Z.ai's API key",
    });
    expect(choose("zai/zai", "api-key", [])[PI]).toBe("pi is on no machine");
  });

  it("says no harness is known to run an account whose kind its provider no longer declares", () => {
    expect(choose("zai/zai", "gone-key")[PI]).toBe("Z.ai no longer offers this kind of account");
    expect(choose("gone/gone", "api-key")[PI]).toBe(
      "gone/gone no longer offers this kind of account",
    );
  });
});
