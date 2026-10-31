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
  ZAI_IDENTITY,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
} from "../providers.testing";
import { buildModelProfileSections } from "./profile-sections";

const ACCOUNTS = [
  buildProviderAccount(ANTHROPIC_IDENTITY),
  buildProviderAccount({ ...OPENAI_IDENTITY, label: "work" }),
  buildProviderAccount(ZAI_IDENTITY),
];
const CATALOGS = { accounts: ACCOUNTS, providers: PROVIDERS, harnesses: HARNESSES };

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
