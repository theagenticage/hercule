/**
 * Tests what the Models section draws from a Model Profile: the sections in
 * the profile's order, the default entry, "in pi" for an entry that runs in
 * another harness than its section, and which problems show under a row.
 */
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_API_KEY_IDENTITY,
  ANTHROPIC_IDENTITY,
  HARNESSES,
  HARNESSES_WITH_ANTHROPIC_API_KEY,
  OPENAI_IDENTITY,
  PROVIDERS,
  PROVIDERS_WITH_ANTHROPIC_API_KEY,
  WITH_CLAUDE,
  WITH_CLAUDE_AND_PI,
  ZAI_IDENTITY,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
  buildSnapshot,
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
  now: new Date("2026-10-31T12:00:00Z"),
  timezone: "UTC",
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

  it("carries the models announced as new above the rows, with when they arrived", () => {
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet")], {
        newModels: [
          { model: "opus-5.6", name: "Opus 5.6", firstSeenAt: "2026-10-26T08:00:00.000Z" },
          { model: "haiku-5", name: "Haiku 5", firstSeenAt: "2025-03-02T08:00:00.000Z" },
        ],
      }),
      buildProfileSection(OPENAI_IDENTITY, "pending"),
    ]);

    const [anthropic, openai] = buildModelProfileSections(profile, CATALOGS);

    expect(anthropic!.newModels).toEqual([
      {
        providerAccountId: ANTHROPIC_IDENTITY.id,
        model: "opus-5.6",
        name: "Opus 5.6",
        arrivalText: "arrived 26 Oct",
      },
      {
        providerAccountId: ANTHROPIC_IDENTITY.id,
        model: "haiku-5",
        name: "Haiku 5",
        arrivalText: "arrived 2 Mar 2025",
      },
    ]);
    expect(openai!.newModels).toEqual([]);
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

const CLAUDE = "claude-code/claude-code";
const PI = "pi/pi";

// The sections below use an Anthropic API key, which can run in Claude Code
// and in pi, so a section has a harness to choose. pi lists its own models,
// Claude Code takes the provider's.
const KEY = ANTHROPIC_API_KEY_IDENTITY;
const KEY_IN_PI = { ...KEY, harnessId: PI };
const OTHER_MACHINE = { ...WITH_CLAUDE, id: "runner-beelink", name: "beelink" };
const inPi = { harnessId: PI, resolvedHarnessId: PI };

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

/**
 * Returns the section of the API key `identity` as the Models section draws
 * it, with pi listing only "opus" unless `catalogs` says otherwise.
 */
const readSection = (
  entries: Parameters<typeof buildProfileSection>[1],
  fields: Parameters<typeof buildProfileSection>[2] = {},
  catalogs: Partial<Parameters<typeof buildModelProfileSections>[1]> = {},
  identity = KEY,
) =>
  buildModelProfileSections(buildModelProfile([buildProfileSection(identity, entries, fields)]), {
    accounts: [buildProviderAccount(identity, [piModels("opus")])],
    providers: PROVIDERS_WITH_ANTHROPIC_API_KEY,
    harnesses: HARNESSES_WITH_ANTHROPIC_API_KEY,
    runners: [WITH_CLAUDE_AND_PI],
    now: new Date("2026-10-31T12:00:00Z"),
    timezone: "UTC",
    ...catalogs,
  })[0]!;

describe("the section's harness pill", () => {
  it("makes 'Same as the account' with the account's harness the current choice while the section follows it", () => {
    const { harness } = readSection([]);

    expect(harness.choices.find(({ isCurrent }) => isCurrent)).toMatchObject({
      harnessId: null,
      resolvedHarnessId: CLAUDE,
      name: "Same as the account · Claude Code",
    });
  });

  it("lists 'Same as the account' first, then every harness, and checks the one the section is set to", () => {
    const { harness } = readSection([], inPi);

    expect(
      harness.choices.map(({ harnessId, name, isCurrent }) => [harnessId, name, isCurrent]),
    ).toEqual([
      [null, "Same as the account · Claude Code", false],
      [CLAUDE, "Claude Code", false],
      ["codex/codex", "Codex", false],
      [PI, "pi", true],
    ]);
  });

  it.each([
    {
      when: "the account's kind can run in one harness only",
      read: () =>
        buildModelProfileSections(
          buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [])]),
          CATALOGS,
        )[0]!,
      isFixed: true,
    },
    { when: "two harnesses can be picked", read: () => readSection([]), isFixed: false },
    {
      when: "the section is stuck in a struck harness and another harness can be picked",
      read: () => readSection([], inPi, { runners: [WITH_CLAUDE] }),
      isFixed: false,
    },
    {
      when: "the only harness that can be picked is the one the section runs in",
      read: () => readSection([], {}, { runners: [WITH_CLAUDE] }),
      isFixed: true,
    },
  ])("sets isFixed to $isFixed when $when", ({ read, isFixed }) => {
    expect(read().harness.isFixed).toBe(isFixed);
  });

  it("strikes pi for a Claude subscription, with the provider's reason", () => {
    const { harness } = buildModelProfileSections(
      buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [])]),
      CATALOGS,
    )[0]!;

    expect(harness.choices.find(({ harnessId }) => harnessId === PI)).toMatchObject({
      unavailableReason: "Anthropic allows a Claude subscription only in Claude Code",
    });
  });

  it("strikes a harness that is on no machine, with the account sheet's words, even when the section is set to it", () => {
    const runners = [WITH_CLAUDE];

    const { harness } = readSection([], {}, { runners });
    const stuck = readSection([], inPi, { runners }).harness;

    expect(harness.choices.find(({ harnessId }) => harnessId === PI)).toMatchObject({
      unavailableReason: "pi is on no machine",
    });
    expect(stuck.choices.find(({ isCurrent }) => isCurrent)).toMatchObject({
      harnessId: PI,
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
      buildProfileEntry(KEY, "sonnet", { name: "Sonnet 5" }),
      buildProfileEntry(KEY, "haiku", { name: "Haiku 5" }),
      buildProfileEntry(KEY, "opus", { name: "Opus 5" }),
    ]);

    expect(harness.choices.find(({ harnessId }) => harnessId === PI)).toMatchObject({
      unavailableReason: "pi doesn't know Sonnet 5 and Haiku 5",
    });
  });

  it("does not strike a harness for a model the section already holds in it", () => {
    const { harness } = readSection(
      [buildProfileEntry(KEY_IN_PI, "sonnet", { name: "Sonnet 5" })],
      {},
      {},
      KEY_IN_PI,
    );

    expect(harness.choices.find(({ harnessId }) => harnessId === PI)).toMatchObject({
      unavailableReason: null,
      isCurrent: false,
    });
  });

  it("strikes a harness that would hold one model twice, naming the model", () => {
    const { harness } = readSection(
      [
        buildProfileEntry(KEY, "sonnet", { name: "Sonnet 5" }),
        buildProfileEntry(KEY, "sonnet", { name: "Sonnet 5", ...inPi }),
      ],
      {},
      { accounts: [buildProviderAccount(KEY, [piModels("sonnet")])] },
    );

    expect(harness.choices.find(({ harnessId }) => harnessId === PI)).toMatchObject({
      unavailableReason: "Sonnet 5 would be in the menu twice in pi",
    });
  });

  it("checks the 'Same as the account' choice against the account's harness", () => {
    // The account's default is pi, which does not know the follower "sonnet".
    const { harness } = readSection(
      [buildProfileEntry(KEY_IN_PI, "sonnet", { name: "Sonnet 5", resolvedHarnessId: CLAUDE })],
      { harnessId: CLAUDE, resolvedHarnessId: CLAUDE },
      {},
      KEY_IN_PI,
    );

    expect(harness.choices[0]).toMatchObject({
      harnessId: null,
      resolvedHarnessId: PI,
      isCurrent: false,
      unavailableReason: "pi doesn't know Sonnet 5",
    });
  });

  it("does not strike 'Same as the account' when no entry follows the section", () => {
    const { harness } = readSection(
      [buildProfileEntry(KEY_IN_PI, "opus", { harnessId: CLAUDE, resolvedHarnessId: CLAUDE })],
      { harnessId: CLAUDE, resolvedHarnessId: CLAUDE },
      { accounts: [buildProviderAccount(KEY_IN_PI, [piModels("sonnet")])] },
      KEY_IN_PI,
    );

    expect(harness.choices[0]).toMatchObject({ harnessId: null, unavailableReason: null });
  });

  it("strikes 'Same as the account' when the account's default harness has no plugin any more", () => {
    const { harness } = readSection([], inPi, {}, { ...KEY, harnessId: "gone/gone" });

    expect(harness.choices[0]).toMatchObject({
      harnessId: null,
      name: "Same as the account · gone/gone",
      unavailableReason: "gone/gone is not installed in this Hercule",
    });
  });

  it("never strikes what the section is set to for its entries", () => {
    const { harness } = readSection([buildProfileEntry(KEY, "sonnet", inPi)], inPi);

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
    const [row] = readSection([buildProfileEntry(KEY, "opus")]).rows;

    expect(
      row!.runsIn.map(({ harnessId, name, isCurrent }) => [harnessId, name, isCurrent]),
    ).toEqual([
      [null, "Claude Code", true],
      [PI, "pi", false],
    ]);
  });

  it("writes the harness out for a section that names one, and puts the section's harness first", () => {
    const [row] = readSection(
      [buildProfileEntry(KEY, "opus", { harnessId: CLAUDE, resolvedHarnessId: CLAUDE })],
      inPi,
    ).rows;

    expect(row!.runsIn.map(({ harnessId, isCurrent }) => [harnessId, isCurrent])).toEqual([
      [null, false],
      [CLAUDE, true],
    ]);
  });

  it("strikes a harness that does not know the model", () => {
    const [row] = readSection([buildProfileEntry(KEY, "sonnet")]).rows;

    expect(row!.runsIn[1]).toMatchObject({ unavailableReason: "pi doesn't know this model" });
  });

  it("strikes a harness that already holds the model for another entry", () => {
    const [claudeRow, piRow] = readSection([
      buildProfileEntry(KEY, "opus"),
      buildProfileEntry(KEY, "opus", inPi),
    ]).rows;

    expect(claudeRow!.runsIn[1]).toMatchObject({ unavailableReason: "Already in the menu in pi" });
    expect(piRow!.runsIn[0]).toMatchObject({
      unavailableReason: "Already in the menu in Claude Code",
    });
  });

  it("keeps the harness the entry runs in even when the kind cannot run in it or it no longer exists", () => {
    const [row] = readSection([
      buildProfileEntry(KEY, "opus", { harnessId: "gone/gone", resolvedHarnessId: "gone/gone" }),
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
        buildProfileEntry(KEY, "opus", { resolvedHarnessId: PI }),
        buildProfileEntry(KEY, "opus", { harnessId: CLAUDE, resolvedHarnessId: CLAUDE }),
      ],
      inPi,
    ).rows;

    // Both rows hold opus, so each harness is taken by the other row.
    expect(followingRow!.alsoOfferIn).toEqual([]);
    expect(namedRow!.alsoOfferIn).toEqual([]);

    const [soleRow] = readSection(
      [buildProfileEntry(KEY, "opus", { resolvedHarnessId: PI })],
      inPi,
    ).rows;
    expect(soleRow!.alsoOfferIn).toMatchObject([
      { harnessId: CLAUDE, resolvedHarnessId: CLAUDE, name: "Claude Code" },
    ]);

    const [offeredRow] = readSection(
      [buildProfileEntry(KEY, "opus", { harnessId: CLAUDE, resolvedHarnessId: CLAUDE })],
      inPi,
    ).rows;
    expect(offeredRow!.alsoOfferIn).toMatchObject([
      { harnessId: null, resolvedHarnessId: PI, name: "pi" },
    ]);
  });

  it("does not offer the model in a harness that is struck through", () => {
    const [row] = readSection([buildProfileEntry(KEY, "sonnet")]).rows;

    expect(row!.alsoOfferIn).toEqual([]);
  });
});
