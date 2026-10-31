/**
 * Tests what the Models section draws from a Model Profile: the sections in
 * the profile's order, the default entry, "in pi" for an entry that runs in
 * another harness than its section, and which problems show under a row.
 */
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_IDENTITY,
  HARNESSES,
  OPENAI_IDENTITY,
  PROVIDERS,
  WITH_CLAUDE,
  ZAI_IDENTITY,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
  buildSnapshot,
  type ProviderAccountIdentity,
} from "../providers.testing";
import { buildModelProfileSections } from "./profile-sections";

const ACCOUNTS = [
  buildProviderAccount(ANTHROPIC_IDENTITY),
  buildProviderAccount({ ...OPENAI_IDENTITY, label: "work" }),
  buildProviderAccount(ZAI_IDENTITY),
];
const CATALOGS = {
  accounts: ACCOUNTS,
  providers: PROVIDERS,
  harnesses: HARNESSES,
  runners: [WITH_CLAUDE],
};

describe("buildModelProfileSections", () => {
  it("returns one section per account in the profile's order, named and marked as its account", () => {
    const profile = buildModelProfile([
      buildProfileSection(OPENAI_IDENTITY, [buildProfileEntry(OPENAI_IDENTITY, "gpt-6")]),
      buildProfileSection(ANTHROPIC_IDENTITY, "pending"),
    ]);

    const sections = buildModelProfileSections(profile, CATALOGS);

    expect(
      sections.map(({ name, pluginId, selectionPending }) => [name, pluginId, selectionPending]),
    ).toEqual([
      ["OpenAI · work", "openai", false],
      ["Anthropic", "anthropic", true],
    ]);
    expect(sections[0]!.rows.map(({ name }) => name)).toEqual(["gpt-6"]);
  });

  it("marks the default entry, and only the one that matches the stored harness too", () => {
    const sonnet = buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet");
    const sonnetInPi = buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet", {
      harnessId: "pi/pi",
      resolvedHarnessId: "pi/pi",
    });
    const profile = buildModelProfile(
      [buildProfileSection(ANTHROPIC_IDENTITY, [sonnet, sonnetInPi])],
      {
        defaultEntry: {
          providerAccountId: ANTHROPIC_IDENTITY.id,
          model: "sonnet",
          harnessId: "pi/pi",
        },
      },
    );

    const [section] = buildModelProfileSections(profile, CATALOGS);

    expect(section!.rows.map(({ isDefault }) => isDefault)).toEqual([false, true]);
  });

  it("names the harness of an entry that runs in another harness than its section", () => {
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [
        buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet"),
        buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet", {
          harnessId: "pi/pi",
          resolvedHarnessId: "pi/pi",
        }),
      ]),
    ]);

    const [section] = buildModelProfileSections(profile, CATALOGS);

    expect(section!.rows.map(({ otherHarnessName }) => otherHarnessName)).toEqual([null, "pi"]);
  });

  it("compares with the section's own harness when the profile picks one for it", () => {
    const profile = buildModelProfile([
      buildProfileSection(
        ANTHROPIC_IDENTITY,
        [
          buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet", { resolvedHarnessId: "pi/pi" }),
          buildProfileEntry(ANTHROPIC_IDENTITY, "opus", {
            resolvedHarnessId: "claude-code/claude-code",
          }),
        ],
        { harnessId: "pi/pi" },
      ),
    ]);

    const [section] = buildModelProfileSections(profile, CATALOGS);

    expect(section!.rows.map(({ otherHarnessName }) => otherHarnessName)).toEqual([
      null,
      "Claude Code",
    ]);
  });

  it("lists the models whose entries follow the section's harness", () => {
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [
        buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet"),
        buildProfileEntry(ANTHROPIC_IDENTITY, "opus", {
          harnessId: "pi/pi",
          resolvedHarnessId: "pi/pi",
        }),
      ]),
    ]);

    const [section] = buildModelProfileSections(profile, CATALOGS);

    expect(section!.sectionHarnessModels).toEqual(["sonnet"]);
  });

  it("counts an entry that names the section's own harness outright among the section's models", () => {
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [
        buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet", {
          harnessId: ANTHROPIC_IDENTITY.harnessId,
        }),
      ]),
    ]);

    const [section] = buildModelProfileSections(profile, CATALOGS);

    expect(section!.sectionHarnessModels).toEqual(["sonnet"]);
  });

  it("shows a problem with the model, never one with the machine", () => {
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [
        buildProfileEntry(ANTHROPIC_IDENTITY, "gone", {
          problem: { reason: "model-left-catalog", message: "Anthropic no longer lists gone." },
        }),
        buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet", {
          problem: { reason: "not-signed-in", message: "Sign in to Claude Code." },
        }),
        buildProfileEntry(ANTHROPIC_IDENTITY, "opus"),
      ]),
    ]);

    const [section] = buildModelProfileSections(profile, CATALOGS);

    expect(section!.rows.map(({ problem }) => problem)).toEqual([
      "Anthropic no longer lists gone.",
      null,
      null,
    ]);
  });

  it("leaves out a section whose account is gone", () => {
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, []),
      buildProfileSection(ZAI_IDENTITY, []),
    ]);

    const sections = buildModelProfileSections(profile, {
      ...CATALOGS,
      accounts: [ACCOUNTS[0]!],
    });

    expect(sections.map(({ providerAccountId }) => providerAccountId)).toEqual([
      ANTHROPIC_IDENTITY.id,
    ]);
  });
});

/**
 * A world where an Anthropic API key can run in Claude Code and in pi, so a
 * section has a harness to choose. pi lists its own models, Claude Code takes
 * the provider's.
 */
const KEY_IDENTITY: ProviderAccountIdentity = {
  id: "account-key",
  providerId: "anthropic/anthropic",
  kind: "api-key",
  harnessId: "claude-code/claude-code",
  label: null,
};
const CLAUDE = "claude-code/claude-code";
const PI = "pi/pi";
const KEY_PROVIDERS = PROVIDERS.map((provider) =>
  provider.id === "anthropic/anthropic"
    ? {
        ...provider,
        kinds: [
          ...provider.kinds,
          {
            id: "api-key",
            title: "API key",
            description: "An Anthropic API key.",
            setup: [],
            harnesses: [CLAUDE, PI],
          },
        ],
      }
    : provider,
);
const KEY_HARNESSES = HARNESSES.map((harness) => {
  if (harness.id === CLAUDE) {
    const [support] = harness.runs;
    return {
      ...harness,
      runs: [
        { ...support!, kinds: [...support!.kinds, { kind: "api-key", modelArgument: "{model}" }] },
      ],
    };
  }
  if (harness.id === PI) {
    return {
      ...harness,
      runs: [
        ...harness.runs,
        {
          providerId: "anthropic/anthropic",
          kinds: [{ kind: "api-key", modelArgument: "anthropic/{model}" }],
          models: "own-list" as const,
        },
      ],
    };
  }
  return harness;
});
const piModels = (...slugs: string[]) =>
  buildSnapshot({
    harnessId: PI,
    models: slugs.map((slug) => ({
      slug,
      name: slug,
      imageInput: { maxBytes: null },
      options: [],
    })),
  });
const WITH_CLAUDE_AND_PI = {
  ...WITH_CLAUDE,
  facts: {
    ...WITH_CLAUDE.facts!,
    harnesses: WITH_CLAUDE.facts!.harnesses.map((binary) =>
      binary.name === "pi" ? { ...binary, present: true } : binary,
    ),
  },
};
const OTHER_MACHINE = { ...WITH_CLAUDE, id: "runner-beelink", name: "beelink" };
const KEY_CATALOGS: Parameters<typeof buildModelProfileSections>[1] = {
  accounts: [buildProviderAccount(KEY_IDENTITY, [piModels("opus")])],
  providers: KEY_PROVIDERS,
  harnesses: KEY_HARNESSES,
  runners: [WITH_CLAUDE_AND_PI],
};
const inPi = { harnessId: PI, resolvedHarnessId: PI };

const readSection = (
  entries: Parameters<typeof buildProfileSection>[1],
  fields: Parameters<typeof buildProfileSection>[2] = {},
  catalogs: Partial<typeof KEY_CATALOGS> = {},
) =>
  buildModelProfileSections(
    buildModelProfile([buildProfileSection(KEY_IDENTITY, entries, fields)]),
    { ...KEY_CATALOGS, ...catalogs },
  )[0]!;

describe("the section's harness pill", () => {
  it("makes 'Same as the account' with the account's harness the current choice while the section follows it", () => {
    const { harness } = readSection([]);

    expect(harness.choices.find(({ isCurrent }) => isCurrent)).toMatchObject({
      harnessId: null,
      resolvedHarnessId: CLAUDE,
      name: "Same as the account · Claude Code",
    });
  });

  it("makes the harness the profile names for the section the current choice", () => {
    const { harness } = readSection([], { harnessId: PI, resolvedHarnessId: PI });

    expect(harness.choices.find(({ isCurrent }) => isCurrent)).toMatchObject({
      harnessId: PI,
      resolvedHarnessId: PI,
      name: "pi",
    });
  });

  it("lists 'Same as the account' first, then every harness, and checks what the section is set to", () => {
    const { harness } = readSection([], { harnessId: PI, resolvedHarnessId: PI });

    expect(
      harness.choices.map(({ harnessId, name, isCurrent }) => [harnessId, name, isCurrent]),
    ).toEqual([
      [null, "Same as the account · Claude Code", false],
      [CLAUDE, "Claude Code", false],
      ["codex/codex", "Codex", false],
      [PI, "pi", true],
    ]);
  });

  it("is fixed when the account's kind can run in one harness only", () => {
    const section = buildModelProfileSections(
      buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [])]),
      CATALOGS,
    )[0]!;

    expect(section.harness.isFixed).toBe(true);
    expect(section.harness.choices.find(({ harnessId }) => harnessId === "pi/pi")).toMatchObject({
      unavailableReason: "Anthropic allows a Claude subscription only in Claude Code",
    });
  });

  it("is not fixed when two harnesses can be picked", () => {
    expect(readSection([]).harness.isFixed).toBe(false);
  });

  it("is not fixed while the section is stuck in a struck harness and another harness can be picked", () => {
    // pi is on no machine, and the section is set to it: Claude Code is the way out.
    const { harness } = readSection(
      [],
      { harnessId: PI, resolvedHarnessId: PI },
      { runners: [WITH_CLAUDE] },
    );

    expect(harness.choices.find(({ isCurrent }) => isCurrent)).toMatchObject({
      unavailableReason: "pi is on no machine",
    });
    expect(harness.isFixed).toBe(false);
  });

  it("is fixed when the only harness that can be picked is the one the section runs in", () => {
    const { harness } = readSection([], {}, { runners: [WITH_CLAUDE] });

    expect(harness.isFixed).toBe(true);
  });

  it("strikes a harness that is on no machine, with the account sheet's words", () => {
    const { harness } = readSection([], {}, { runners: [WITH_CLAUDE] });

    expect(harness.choices.find(({ harnessId }) => harnessId === PI)).toMatchObject({
      unavailableReason: "pi is on no machine",
    });
  });

  it("notes the machines a pickable harness is not on", () => {
    const { harness } = readSection([], {}, { runners: [WITH_CLAUDE_AND_PI, OTHER_MACHINE] });

    const notes = harness.choices.map(({ harnessId, note }) => [harnessId, note]);
    expect(notes).toEqual([
      [null, null],
      [CLAUDE, null],
      ["codex/codex", null],
      [PI, "Not on beelink"],
    ]);
  });

  it("strikes a harness that does not know a model the section's followers would move to it, naming the models", () => {
    const { harness } = readSection([
      buildProfileEntry(KEY_IDENTITY, "sonnet", { name: "Sonnet 5" }),
      buildProfileEntry(KEY_IDENTITY, "haiku", { name: "Haiku 5" }),
      buildProfileEntry(KEY_IDENTITY, "opus", { name: "Opus 5" }),
    ]);

    expect(harness.choices.find(({ harnessId }) => harnessId === PI)).toMatchObject({
      unavailableReason: "pi doesn't know Sonnet 5 and Haiku 5",
    });
  });

  it("does not strike a harness for a model the section already holds in it", () => {
    const keyInPi = { ...KEY_IDENTITY, harnessId: PI };
    const section = buildModelProfileSections(
      buildModelProfile([
        buildProfileSection(keyInPi, [buildProfileEntry(keyInPi, "sonnet", { name: "Sonnet 5" })]),
      ]),
      { ...KEY_CATALOGS, accounts: [buildProviderAccount(keyInPi, [piModels("opus")])] },
    )[0]!;

    expect(section.harness.choices.find(({ harnessId }) => harnessId === PI)).toMatchObject({
      unavailableReason: null,
      isCurrent: false,
    });
  });

  it("strikes a harness that would hold one model twice, naming the model", () => {
    const { harness } = readSection(
      [
        buildProfileEntry(KEY_IDENTITY, "sonnet", { name: "Sonnet 5" }),
        buildProfileEntry(KEY_IDENTITY, "sonnet", { name: "Sonnet 5", ...inPi }),
      ],
      {},
      { accounts: [buildProviderAccount(KEY_IDENTITY, [piModels("sonnet")])] },
    );

    expect(harness.choices.find(({ harnessId }) => harnessId === PI)).toMatchObject({
      unavailableReason: "Sonnet 5 would be in the menu twice in pi",
    });
  });

  it("checks the 'Same as the account' choice against the account's harness", () => {
    // The account's default is pi, which does not know the follower "sonnet".
    const keyInPi = { ...KEY_IDENTITY, harnessId: PI };
    const section = buildModelProfileSections(
      buildModelProfile([
        buildProfileSection(
          keyInPi,
          [buildProfileEntry(keyInPi, "sonnet", { name: "Sonnet 5", resolvedHarnessId: CLAUDE })],
          { harnessId: CLAUDE, resolvedHarnessId: CLAUDE },
        ),
      ]),
      { ...KEY_CATALOGS, accounts: [buildProviderAccount(keyInPi, [piModels("opus")])] },
    )[0]!;

    expect(section.harness.choices[0]).toMatchObject({
      harnessId: null,
      resolvedHarnessId: PI,
      isCurrent: false,
      unavailableReason: "pi doesn't know Sonnet 5",
    });
  });

  it("does not strike 'Same as the account' when no entry follows the section", () => {
    const keyInPi = { ...KEY_IDENTITY, harnessId: PI };
    const section = buildModelProfileSections(
      buildModelProfile([
        buildProfileSection(
          keyInPi,
          [buildProfileEntry(keyInPi, "opus", { harnessId: CLAUDE, resolvedHarnessId: CLAUDE })],
          { harnessId: CLAUDE, resolvedHarnessId: CLAUDE },
        ),
      ]),
      { ...KEY_CATALOGS, accounts: [buildProviderAccount(keyInPi, [piModels("sonnet")])] },
    )[0]!;

    expect(section.harness.choices[0]).toMatchObject({ harnessId: null, unavailableReason: null });
  });

  it("strikes 'Same as the account' when the account's default harness has no plugin any more", () => {
    const keyInGone = { ...KEY_IDENTITY, harnessId: "gone/gone" };
    const section = buildModelProfileSections(
      buildModelProfile([
        buildProfileSection(keyInGone, [], { harnessId: PI, resolvedHarnessId: PI }),
      ]),
      { ...KEY_CATALOGS, accounts: [buildProviderAccount(keyInGone, [piModels("opus")])] },
    )[0]!;

    expect(section.harness.choices[0]).toMatchObject({
      harnessId: null,
      name: "Same as the account · gone/gone",
      unavailableReason: "gone/gone is not installed in this Hercule",
    });
  });

  it("never strikes what the section is set to for its entries", () => {
    const { harness } = readSection([buildProfileEntry(KEY_IDENTITY, "sonnet", { ...inPi })], {
      harnessId: PI,
      resolvedHarnessId: PI,
    });

    expect(harness.choices.find(({ harnessId }) => harnessId === PI)).toMatchObject({
      unavailableReason: null,
      isCurrent: true,
    });
  });

  it("keeps a harness the section is set to that no longer exists, checked, last", () => {
    const { harness } = readSection([], { harnessId: "gone/gone", resolvedHarnessId: "gone/gone" });

    expect(harness.choices.at(-1)).toMatchObject({
      harnessId: "gone/gone",
      name: "gone/gone",
      isCurrent: true,
      unavailableReason: "gone/gone is not installed in this Hercule",
    });
  });
});

describe("a row's harness choices", () => {
  it("lists the section's harness first as the choice that follows the section, then the others the kind can run in", () => {
    const [row] = readSection([buildProfileEntry(KEY_IDENTITY, "opus")]).rows;

    expect(
      row!.runsIn.map(({ harnessId, name, isCurrent }) => [harnessId, name, isCurrent]),
    ).toEqual([
      [null, "Claude Code", true],
      [PI, "pi", false],
    ]);
  });

  it("writes the harness out for a section that names one, and puts the section's harness first", () => {
    const [row] = readSection(
      [buildProfileEntry(KEY_IDENTITY, "opus", { harnessId: CLAUDE, resolvedHarnessId: CLAUDE })],
      { harnessId: PI, resolvedHarnessId: PI },
    ).rows;

    expect(row!.runsIn.map(({ harnessId, isCurrent }) => [harnessId, isCurrent])).toEqual([
      [null, false],
      [CLAUDE, true],
    ]);
  });

  it("strikes a harness that does not know the model", () => {
    const [row] = readSection([buildProfileEntry(KEY_IDENTITY, "sonnet")]).rows;

    expect(row!.runsIn[1]).toMatchObject({ unavailableReason: "pi doesn't know this model" });
  });

  it("strikes a harness that already holds the model for another entry", () => {
    const [claudeRow, piRow] = readSection([
      buildProfileEntry(KEY_IDENTITY, "opus"),
      buildProfileEntry(KEY_IDENTITY, "opus", inPi),
    ]).rows;

    expect(claudeRow!.runsIn[1]).toMatchObject({ unavailableReason: "Already in the menu in pi" });
    expect(piRow!.runsIn[0]).toMatchObject({
      unavailableReason: "Already in the menu in Claude Code",
    });
  });

  it("strikes a harness that is on no machine with the account sheet's words", () => {
    const [row] = readSection(
      [buildProfileEntry(KEY_IDENTITY, "opus")],
      {},
      { runners: [WITH_CLAUDE] },
    ).rows;

    expect(row!.runsIn[1]).toMatchObject({ unavailableReason: "pi is on no machine" });
  });

  it("keeps the harness the entry runs in even when the kind cannot run in it or it no longer exists", () => {
    const [row] = readSection([
      buildProfileEntry(KEY_IDENTITY, "opus", {
        harnessId: "gone/gone",
        resolvedHarnessId: "gone/gone",
      }),
    ]).rows;

    expect(row!.runsIn.map(({ name, isCurrent }) => [name, isCurrent])).toEqual([
      ["Claude Code", false],
      ["pi", false],
      ["gone/gone", true],
    ]);
  });

  it("lists nothing when the account can run in one harness only", () => {
    const [section] = buildModelProfileSections(
      buildModelProfile([
        buildProfileSection(ANTHROPIC_IDENTITY, [buildProfileEntry(ANTHROPIC_IDENTITY, "opus")]),
      ]),
      CATALOGS,
    );

    expect(section!.rows[0]).toMatchObject({ runsIn: [], alsoOfferIn: [] });
  });

  it("offers the model in the pickable harnesses it is not in, writing null for the section's harness", () => {
    const [followingRow, namedRow] = readSection(
      [
        buildProfileEntry(KEY_IDENTITY, "opus", { resolvedHarnessId: PI }),
        buildProfileEntry(KEY_IDENTITY, "opus", {
          harnessId: CLAUDE,
          resolvedHarnessId: CLAUDE,
        }),
      ],
      { harnessId: PI, resolvedHarnessId: PI },
    ).rows;

    // Both rows hold opus, so each harness is taken by the other row.
    expect(followingRow!.alsoOfferIn).toEqual([]);
    expect(namedRow!.alsoOfferIn).toEqual([]);

    const [soleRow] = readSection(
      [buildProfileEntry(KEY_IDENTITY, "opus", { resolvedHarnessId: PI })],
      { harnessId: PI, resolvedHarnessId: PI },
    ).rows;
    expect(soleRow!.alsoOfferIn).toMatchObject([
      { harnessId: CLAUDE, resolvedHarnessId: CLAUDE, name: "Claude Code" },
    ]);

    const [offeredRow] = readSection(
      [buildProfileEntry(KEY_IDENTITY, "opus", { harnessId: CLAUDE, resolvedHarnessId: CLAUDE })],
      { harnessId: PI, resolvedHarnessId: PI },
    ).rows;
    expect(offeredRow!.alsoOfferIn).toMatchObject([
      { harnessId: null, resolvedHarnessId: PI, name: "pi" },
    ]);
  });

  it("does not offer the model in a harness that is struck through", () => {
    const [row] = readSection([buildProfileEntry(KEY_IDENTITY, "sonnet")]).rows;

    expect(row!.alsoOfferIn).toEqual([]);
  });
});
