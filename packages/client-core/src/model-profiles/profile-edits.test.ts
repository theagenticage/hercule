/**
 * Tests the profile edit helpers, each of which turns one user change to a
 * Model Profile (as read) into the `ModelProfileUpdateInput` that writes it.
 * The tests check the one change, and that the rest of the profile is sent as
 * stored: the revision that was read, the stored entries (never the resolved
 * harness or the extra fields of a read), and no entries for a section that
 * is still pending.
 */
import { describe, expect, it } from "vitest";
import type { ModelProfile, ModelProfileEntry } from "@hercule/contract";
import {
  ANTHROPIC_IDENTITY,
  OPENAI_IDENTITY,
  ZAI_IDENTITY,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
} from "../providers.testing";
import {
  addModelProfileAccount,
  addModelProfileEntries,
  addNewModelToProfile,
  dismissNewModel,
  makeDefaultModelProfileEntry,
  moveModelProfileAccount,
  moveModelProfileEntry,
  moveModelProfileEntryToHarness,
  offerModelProfileEntryIn,
  renameModelProfile,
  setModelProfileAccountHarness,
  setModelProfileEntryIncluded,
  takeOutModelProfileEntry,
} from "./profile-edits";

const CLAUDE = ANTHROPIC_IDENTITY.id;
const CODEX = OPENAI_IDENTITY.id;
const ZAI = ZAI_IDENTITY.id;
/** The account the picker adds to, as the picker has it: its id and its default harness. */

/** Returns the stored form of an entry of `identity`, which follows its section's harness. */
const stored = (
  identity: { readonly id: string },
  model: string,
  harnessId: string | null = null,
): ModelProfileEntry => ({ providerAccountId: identity.id, model, harnessId });

const SONNET = buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet", { name: "Sonnet 5" });
const OPUS = buildProfileEntry(ANTHROPIC_IDENTITY, "opus", { name: "Opus 5" });
const HAIKU = buildProfileEntry(ANTHROPIC_IDENTITY, "haiku", { name: "Haiku 5" });
const GPT = buildProfileEntry(OPENAI_IDENTITY, "gpt-6", { name: "GPT-6" });
/** The same model as Sonnet, offered in pi as well. */
const SONNET_IN_PI = buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet", {
  name: "Sonnet 5",
  harnessId: "pi/pi",
  resolvedHarnessId: "pi/pi",
});

/** Claude's Sonnet, Opus, Haiku, then Codex's GPT, with Sonnet as the default, read at revision 7. */
const PROFILE: ModelProfile = buildModelProfile(
  [
    buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, OPUS, HAIKU]),
    buildProfileSection(OPENAI_IDENTITY, [GPT]),
  ],
  {
    revision: 7,
    defaultEntry: stored(ANTHROPIC_IDENTITY, "sonnet"),
    dismissedNewModels: [{ providerAccountId: CODEX, model: "gpt-5" }],
  },
);

const readModels = (input: {
  accounts: ReadonlyArray<{ entries?: readonly ModelProfileEntry[] }>;
}) => input.accounts.map((section) => section.entries?.map((entry) => entry.model));

describe("the write shape every edit starts from", () => {
  it("sends the profile as read, with the revision it was read at, and strips what only a read has", () => {
    const input = moveModelProfileAccount(PROFILE, CLAUDE, 0);

    expect(input).toEqual({
      expectedRevision: 7,
      name: "Main",
      accounts: [
        {
          providerAccountId: CLAUDE,
          harnessId: null,
          entries: [
            stored(ANTHROPIC_IDENTITY, "sonnet"),
            stored(ANTHROPIC_IDENTITY, "opus"),
            stored(ANTHROPIC_IDENTITY, "haiku"),
          ],
        },
        { providerAccountId: CODEX, harnessId: null, entries: [stored(OPENAI_IDENTITY, "gpt-6")] },
      ],
      defaultEntry: stored(ANTHROPIC_IDENTITY, "sonnet"),
      dismissedNewModels: [{ providerAccountId: CODEX, model: "gpt-5" }],
    });
  });

  it("keeps the stored harness of an entry and of a section, never the resolved one", () => {
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, SONNET_IN_PI], {
        harnessId: "claude-code/claude-code",
      }),
    ]);

    const [section] = moveModelProfileAccount(profile, CLAUDE, 0).accounts;

    expect(section).toEqual({
      providerAccountId: CLAUDE,
      harnessId: "claude-code/claude-code",
      entries: [
        stored(ANTHROPIC_IDENTITY, "sonnet", null),
        stored(ANTHROPIC_IDENTITY, "sonnet", "pi/pi"),
      ],
    });
  });

  it("sends a section that is still pending without entries, so it keeps waiting for its Default Selection", () => {
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [SONNET]),
      buildProfileSection(OPENAI_IDENTITY, "pending"),
    ]);

    const input = makeDefaultModelProfileEntry(profile, stored(ANTHROPIC_IDENTITY, "sonnet"));

    expect(input.accounts[1]).toEqual({ providerAccountId: CODEX, harnessId: null });
    expect(input.accounts[1]).not.toHaveProperty("entries");
  });

  it("sends an emptied section with an empty list, which is kept as no entries", () => {
    const profile = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [])]);

    expect(moveModelProfileAccount(profile, CLAUDE, 0).accounts[0]).toEqual({
      providerAccountId: CLAUDE,
      harnessId: null,
      entries: [],
    });
  });
});

describe("moveModelProfileEntry", () => {
  it("moves an entry within its section to the index given", () => {
    expect(
      readModels(moveModelProfileEntry(PROFILE, stored(ANTHROPIC_IDENTITY, "haiku"), 0)),
    ).toEqual([["haiku", "sonnet", "opus"], ["gpt-6"]]);
    expect(
      readModels(moveModelProfileEntry(PROFILE, stored(ANTHROPIC_IDENTITY, "sonnet"), 2)),
    ).toEqual([["opus", "haiku", "sonnet"], ["gpt-6"]]);
  });

  it("clamps an index outside the section to its ends", () => {
    expect(
      readModels(moveModelProfileEntry(PROFILE, stored(ANTHROPIC_IDENTITY, "opus"), 99))[0],
    ).toEqual(["sonnet", "haiku", "opus"]);
    expect(
      readModels(moveModelProfileEntry(PROFILE, stored(ANTHROPIC_IDENTITY, "opus"), -3))[0],
    ).toEqual(["opus", "sonnet", "haiku"]);
  });

  it("tells two entries of one model in different harnesses apart", () => {
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, SONNET_IN_PI, OPUS]),
    ]);

    const [section] = moveModelProfileEntry(
      profile,
      stored(ANTHROPIC_IDENTITY, "sonnet", "pi/pi"),
      0,
    ).accounts;

    expect(section?.entries?.map((entry) => [entry.model, entry.harnessId])).toEqual([
      ["sonnet", "pi/pi"],
      ["sonnet", null],
      ["opus", null],
    ]);
  });

  it("changes nothing for an entry the profile does not hold", () => {
    expect(moveModelProfileEntry(PROFILE, stored(ANTHROPIC_IDENTITY, "gone"), 0)).toEqual(
      moveModelProfileAccount(PROFILE, CLAUDE, 0),
    );
  });
});

describe("moveModelProfileAccount", () => {
  it("moves a section to the index given, keeping its entries", () => {
    const input = moveModelProfileAccount(PROFILE, CODEX, 0);

    expect(input.accounts.map((section) => section.providerAccountId)).toEqual([CODEX, CLAUDE]);
    expect(readModels(input)).toEqual([["gpt-6"], ["sonnet", "opus", "haiku"]]);
  });

  it("moves a pending section too", () => {
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [SONNET]),
      buildProfileSection(OPENAI_IDENTITY, "pending"),
    ]);

    const input = moveModelProfileAccount(profile, CODEX, 0);

    expect(input.accounts).toEqual([
      { providerAccountId: CODEX, harnessId: null },
      {
        providerAccountId: CLAUDE,
        harnessId: null,
        entries: [stored(ANTHROPIC_IDENTITY, "sonnet")],
      },
    ]);
  });

  it("changes nothing for an account the profile does not hold", () => {
    expect(
      moveModelProfileAccount(PROFILE, ZAI, 0).accounts.map((section) => section.providerAccountId),
    ).toEqual([CLAUDE, CODEX]);
  });
});

describe("makeDefaultModelProfileEntry", () => {
  it("makes the entry the default and changes nothing else", () => {
    const input = makeDefaultModelProfileEntry(PROFILE, stored(OPENAI_IDENTITY, "gpt-6"));

    expect(input.defaultEntry).toEqual(stored(OPENAI_IDENTITY, "gpt-6"));
    expect(input.accounts).toEqual(moveModelProfileAccount(PROFILE, CLAUDE, 0).accounts);
  });

  it("stores only the three fields of the entry, even when it is given a resolved entry", () => {
    expect(makeDefaultModelProfileEntry(PROFILE, GPT).defaultEntry).toEqual({
      providerAccountId: CODEX,
      model: "gpt-6",
      harnessId: null,
    });
  });

  it("keeps the default when the entry is not one the profile holds", () => {
    expect(
      makeDefaultModelProfileEntry(PROFILE, stored(ANTHROPIC_IDENTITY, "gone")).defaultEntry,
    ).toEqual(stored(ANTHROPIC_IDENTITY, "sonnet"));
  });
});

describe("takeOutModelProfileEntry", () => {
  it("removes the entry from its section and adds the model to the dismissed models", () => {
    const input = takeOutModelProfileEntry(PROFILE, stored(ANTHROPIC_IDENTITY, "opus"));

    expect(readModels(input)).toEqual([["sonnet", "haiku"], ["gpt-6"]]);
    expect(input.dismissedNewModels).toEqual([
      { providerAccountId: CODEX, model: "gpt-5" },
      { providerAccountId: CLAUDE, model: "opus" },
    ]);
    expect(input.defaultEntry).toEqual(stored(ANTHROPIC_IDENTITY, "sonnet"));
  });

  it("makes the first entry left the default when the default is taken out", () => {
    const input = takeOutModelProfileEntry(PROFILE, stored(ANTHROPIC_IDENTITY, "sonnet"));

    expect(input.defaultEntry).toEqual(stored(ANTHROPIC_IDENTITY, "opus"));
  });

  it("looks for the next default across sections, in menu order, when the section is empty", () => {
    const profile = buildModelProfile(
      [
        buildProfileSection(ANTHROPIC_IDENTITY, [SONNET]),
        buildProfileSection(OPENAI_IDENTITY, [GPT]),
      ],
      { defaultEntry: stored(ANTHROPIC_IDENTITY, "sonnet") },
    );

    expect(
      takeOutModelProfileEntry(profile, stored(ANTHROPIC_IDENTITY, "sonnet")).defaultEntry,
    ).toEqual(stored(OPENAI_IDENTITY, "gpt-6"));
  });

  it("leaves no default when no entry is left", () => {
    const profile = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [SONNET])], {
      defaultEntry: stored(ANTHROPIC_IDENTITY, "sonnet"),
    });

    const input = takeOutModelProfileEntry(profile, stored(ANTHROPIC_IDENTITY, "sonnet"));

    expect(input.defaultEntry).toBeNull();
    expect(input.accounts[0]?.entries).toEqual([]);
  });

  it("takes out only the entry of the harness given, and keeps the default when another entry of the model was the default", () => {
    const profile = buildModelProfile(
      [buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, SONNET_IN_PI])],
      { defaultEntry: stored(ANTHROPIC_IDENTITY, "sonnet") },
    );

    const input = takeOutModelProfileEntry(profile, stored(ANTHROPIC_IDENTITY, "sonnet", "pi/pi"));

    expect(input.accounts[0]?.entries).toEqual([stored(ANTHROPIC_IDENTITY, "sonnet")]);
    expect(input.defaultEntry).toEqual(stored(ANTHROPIC_IDENTITY, "sonnet"));
  });

  it("does not list a model twice among the dismissed ones", () => {
    const profile = {
      ...PROFILE,
      dismissedNewModels: [{ providerAccountId: CLAUDE, model: "opus" }],
    };

    expect(
      takeOutModelProfileEntry(profile, stored(ANTHROPIC_IDENTITY, "opus")).dismissedNewModels,
    ).toEqual([{ providerAccountId: CLAUDE, model: "opus" }]);
  });

  it("changes nothing for an entry the profile does not hold", () => {
    const input = takeOutModelProfileEntry(PROFILE, stored(ANTHROPIC_IDENTITY, "gone"));

    expect(input.dismissedNewModels).toEqual(PROFILE.dismissedNewModels);
    expect(readModels(input)).toEqual([["sonnet", "opus", "haiku"], ["gpt-6"]]);
  });
});

describe("addModelProfileEntries", () => {
  it("appends the models to the end of the account's section, as entries that follow its harness", () => {
    const input = addModelProfileEntries(PROFILE, CLAUDE, ["fable", "mythos"]);

    expect(input.accounts[0]?.entries).toEqual([
      stored(ANTHROPIC_IDENTITY, "sonnet"),
      stored(ANTHROPIC_IDENTITY, "opus"),
      stored(ANTHROPIC_IDENTITY, "haiku"),
      stored(ANTHROPIC_IDENTITY, "fable"),
      stored(ANTHROPIC_IDENTITY, "mythos"),
    ]);
    expect(input.accounts[1]).toEqual(moveModelProfileAccount(PROFILE, CLAUDE, 0).accounts[1]);
  });

  it("leaves out a model the section already holds, and a model named twice", () => {
    const input = addModelProfileEntries(PROFILE, CLAUDE, ["opus", "fable", "fable"]);

    expect(readModels(input)[0]).toEqual(["sonnet", "opus", "haiku", "fable"]);
  });

  it("adds a model that the section holds only in another harness", () => {
    const profile = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [SONNET_IN_PI])]);

    const input = addModelProfileEntries(profile, CLAUDE, ["sonnet"]);

    expect(input.accounts[0]?.entries?.map((entry) => [entry.model, entry.harnessId])).toEqual([
      ["sonnet", "pi/pi"],
      ["sonnet", null],
    ]);
  });

  it("leaves out a model the section holds as an entry that names the section's own harness", () => {
    const explicit = buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet", {
      harnessId: ANTHROPIC_IDENTITY.harnessId,
    });
    const profile = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [explicit])]);

    const input = addModelProfileEntries(profile, CLAUDE, ["sonnet", "opus"]);

    expect(input.accounts[0]?.entries?.map((entry) => [entry.model, entry.harnessId])).toEqual([
      ["sonnet", ANTHROPIC_IDENTITY.harnessId],
      ["opus", null],
    ]);
  });

  it("changes neither the default nor the dismissed models of a profile that has a default", () => {
    const input = addModelProfileEntries(PROFILE, CLAUDE, ["fable"]);

    expect(input.defaultEntry).toEqual(PROFILE.defaultEntry);
    expect(input.dismissedNewModels).toEqual(PROFILE.dismissedNewModels);
  });

  it("makes the first model added the default of a profile emptied of entries", () => {
    const only = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [SONNET])], {
      defaultEntry: stored(ANTHROPIC_IDENTITY, "sonnet"),
    });
    const emptied = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [])], {
      defaultEntry: null,
    });
    expect(takeOutModelProfileEntry(only, SONNET).defaultEntry).toBeNull();

    const input = addModelProfileEntries(emptied, CLAUDE, ["opus", "haiku"]);

    expect(input.defaultEntry).toEqual(stored(ANTHROPIC_IDENTITY, "opus"));
  });

  it("keeps a profile with no default as it is when nothing is added", () => {
    const emptied = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [])]);

    expect(addModelProfileEntries(emptied, CLAUDE, []).defaultEntry).toBeNull();
  });
});

describe("setModelProfileEntryIncluded", () => {
  const set = (profile: ModelProfile, model: string, included: boolean) =>
    setModelProfileEntryIncluded(profile, CLAUDE, model, included);

  it("adds a model the section does not run", () => {
    expect(readModels(set(PROFILE, "fable", true))[0]).toEqual([
      "sonnet",
      "opus",
      "haiku",
      "fable",
    ]);
  });

  it("takes out a model the section runs, and dismisses it", () => {
    const input = set(PROFILE, "opus", false);

    expect(readModels(input)[0]).toEqual(["sonnet", "haiku"]);
    expect(input.dismissedNewModels).toContainEqual({ providerAccountId: CLAUDE, model: "opus" });
  });

  it("takes out the entry that names the section's own harness outright, and keeps the others", () => {
    const explicit = buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet", {
      harnessId: ANTHROPIC_IDENTITY.harnessId,
    });
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [explicit, SONNET_IN_PI]),
    ]);

    const input = set(profile, "sonnet", false);

    expect(input.accounts[0]?.entries).toEqual([stored(ANTHROPIC_IDENTITY, "sonnet", "pi/pi")]);
  });

  it("adds a model the section holds only in another harness", () => {
    const profile = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [SONNET_IN_PI])]);

    expect(set(profile, "sonnet", true).accounts[0]?.entries).toHaveLength(2);
  });

  it("changes nothing when asked to add a model that is already held, or to remove one that is gone", () => {
    const unchanged = moveModelProfileAccount(PROFILE, CLAUDE, 0);

    expect(set(PROFILE, "opus", true)).toEqual(unchanged);
    expect(set(PROFILE, "gone", false)).toEqual(unchanged);
  });

  it("ends with the model held and not dismissed when two windows both add it and the second retries on the first's result", () => {
    // Window A adds fable and wins. Window B's click was "add" too; the retry applies it to A's profile.
    const added = set(PROFILE, "fable", true);
    const afterA: ModelProfile = {
      ...PROFILE,
      revision: 8,
      accounts: PROFILE.accounts.map((section) =>
        section.providerAccountId === CLAUDE
          ? {
              ...section,
              entries: [...section.entries, buildProfileEntry(ANTHROPIC_IDENTITY, "fable")],
            }
          : section,
      ),
    };

    const retried = set(afterA, "fable", true);

    expect(readModels(added)[0]).toContain("fable");
    expect(readModels(retried)[0]).toEqual(["sonnet", "opus", "haiku", "fable"]);
    expect(retried.dismissedNewModels).toEqual(PROFILE.dismissedNewModels);
  });
});

describe("addNewModelToProfile", () => {
  it("appends the model to the end of the account's section, as an entry that follows the section's harness", () => {
    const input = addNewModelToProfile(PROFILE, CLAUDE, "opus-5.6");

    expect(input.accounts[0]!.entries).toEqual([
      stored(ANTHROPIC_IDENTITY, "sonnet"),
      stored(ANTHROPIC_IDENTITY, "opus"),
      stored(ANTHROPIC_IDENTITY, "haiku"),
      stored(ANTHROPIC_IDENTITY, "opus-5.6"),
    ]);
    expect(input.defaultEntry).toEqual(PROFILE.defaultEntry);
  });

  it("makes the model the default of a profile with none", () => {
    const emptied = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [])]);

    expect(addNewModelToProfile(emptied, CLAUDE, "opus-5.6").defaultEntry).toEqual(
      stored(ANTHROPIC_IDENTITY, "opus-5.6"),
    );
  });

  it("changes nothing when the section holds the model, in any harness", () => {
    const held = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [SONNET_IN_PI])]);

    expect(addNewModelToProfile(held, CLAUDE, "sonnet").accounts[0]!.entries).toEqual([
      stored(ANTHROPIC_IDENTITY, "sonnet", "pi/pi"),
    ]);
  });

  it("changes nothing for an account the profile does not hold, or whose section is pending", () => {
    const pending = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, "pending")]);

    expect(readModels(addNewModelToProfile(PROFILE, ZAI, "glm-5.3"))).toEqual([
      ["sonnet", "opus", "haiku"],
      ["gpt-6"],
    ]);
    expect(addNewModelToProfile(pending, CLAUDE, "opus-5.6").accounts).toEqual([
      { providerAccountId: CLAUDE, harnessId: null },
    ]);
  });

  it("gives the intended result when applied again to a fresher profile that another window already added the model to", () => {
    const fresher = buildModelProfile(
      [
        buildProfileSection(ANTHROPIC_IDENTITY, [
          SONNET,
          buildProfileEntry(ANTHROPIC_IDENTITY, "opus-5.6"),
        ]),
      ],
      { revision: 8 },
    );

    const input = addNewModelToProfile(fresher, CLAUDE, "opus-5.6");

    expect(input.expectedRevision).toBe(8);
    expect(input.accounts[0]!.entries).toHaveLength(2);
  });
});

describe("dismissNewModel", () => {
  it("adds the account's model to the dismissed models, keeps the others, and changes nothing else", () => {
    const input = dismissNewModel(PROFILE, CLAUDE, "opus-5.6");

    expect(input.dismissedNewModels).toEqual([
      { providerAccountId: CODEX, model: "gpt-5" },
      { providerAccountId: CLAUDE, model: "opus-5.6" },
    ]);
    expect(input.expectedRevision).toBe(7);
    expect(input.defaultEntry).toEqual(PROFILE.defaultEntry);
    expect(readModels(input)).toEqual([["sonnet", "opus", "haiku"], ["gpt-6"]]);
  });

  it("does not list a model twice when applied again to a fresher profile that already dismisses it", () => {
    const once = dismissNewModel(PROFILE, CLAUDE, "opus-5.6");
    const fresher = buildModelProfile(PROFILE.accounts, {
      revision: 8,
      dismissedNewModels: once.dismissedNewModels,
    });

    expect(dismissNewModel(fresher, CLAUDE, "opus-5.6").dismissedNewModels).toEqual(
      once.dismissedNewModels,
    );
  });
});

describe("setModelProfileAccountHarness", () => {
  it("sets the harness of the section and leaves the stored harness of its entries alone", () => {
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, OPUS, SONNET_IN_PI]),
      buildProfileSection(OPENAI_IDENTITY, [GPT]),
    ]);

    const input = setModelProfileAccountHarness(profile, CLAUDE, "pi/pi");

    expect(input.accounts.map((section) => section.harnessId)).toEqual(["pi/pi", null]);
    expect(input.accounts[0]?.entries?.map((entry) => entry.harnessId)).toEqual([
      null,
      null,
      "pi/pi",
    ]);
  });

  it("keeps a pending section pending", () => {
    const profile = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, "pending")]);

    const [section] = setModelProfileAccountHarness(profile, CLAUDE, "pi/pi").accounts;

    expect(section).toEqual({ providerAccountId: CLAUDE, harnessId: "pi/pi" });
    expect(section).not.toHaveProperty("entries");
  });

  it("changes nothing for an account the profile does not hold", () => {
    expect(setModelProfileAccountHarness(PROFILE, ZAI, "pi/pi")).toEqual(
      moveModelProfileAccount(PROFILE, CLAUDE, 0),
    );
  });
});

describe("moveModelProfileEntryToHarness", () => {
  it("makes the entry name the harness, and leaves the other entries alone", () => {
    const input = moveModelProfileEntryToHarness(PROFILE, OPUS, "pi/pi");

    expect(input.accounts[0]?.entries).toEqual([
      stored(ANTHROPIC_IDENTITY, "sonnet"),
      stored(ANTHROPIC_IDENTITY, "opus", "pi/pi"),
      stored(ANTHROPIC_IDENTITY, "haiku"),
    ]);
    expect(input.accounts[1]).toEqual(moveModelProfileAccount(PROFILE, CLAUDE, 0).accounts[1]);
    expect(input.defaultEntry).toEqual(stored(ANTHROPIC_IDENTITY, "sonnet"));
  });

  it("moves the default entry with the entry", () => {
    const input = moveModelProfileEntryToHarness(PROFILE, SONNET, "pi/pi");

    expect(input.defaultEntry).toEqual(stored(ANTHROPIC_IDENTITY, "sonnet", "pi/pi"));
  });

  it("changes nothing for an entry the profile no longer holds, such as a retry after the move", () => {
    const moved = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [SONNET_IN_PI])], {
      revision: 8,
    });

    expect(moveModelProfileEntryToHarness(moved, SONNET, "pi/pi")).toEqual(
      moveModelProfileAccount(moved, CLAUDE, 0),
    );
  });
});

describe("offerModelProfileEntryIn", () => {
  it("adds the same model in the harness right after the entry", () => {
    const input = offerModelProfileEntryIn(PROFILE, SONNET, "pi/pi");

    expect(input.accounts[0]?.entries).toEqual([
      stored(ANTHROPIC_IDENTITY, "sonnet"),
      stored(ANTHROPIC_IDENTITY, "sonnet", "pi/pi"),
      stored(ANTHROPIC_IDENTITY, "opus"),
      stored(ANTHROPIC_IDENTITY, "haiku"),
    ]);
    expect(input.defaultEntry).toEqual(stored(ANTHROPIC_IDENTITY, "sonnet"));
  });

  it("adds it as the last entry when the entry is the last one", () => {
    expect(readModels(offerModelProfileEntryIn(PROFILE, HAIKU, "pi/pi"))[0]).toEqual([
      "sonnet",
      "opus",
      "haiku",
      "haiku",
    ]);
  });

  it("changes nothing for a harness the model is already held in, whether the held entry follows the section or names the harness", () => {
    const withSonnetInPi = buildModelProfile(
      [buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, SONNET_IN_PI, OPUS, HAIKU])],
      { revision: 8, defaultEntry: stored(ANTHROPIC_IDENTITY, "sonnet") },
    );

    expect(offerModelProfileEntryIn(PROFILE, SONNET, ANTHROPIC_IDENTITY.harnessId)).toEqual(
      moveModelProfileAccount(PROFILE, CLAUDE, 0),
    );
    expect(offerModelProfileEntryIn(withSonnetInPi, SONNET, "pi/pi")).toEqual(
      moveModelProfileAccount(withSonnetInPi, CLAUDE, 0),
    );
  });

  it("reads null as the harness of the section, not the account's", () => {
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [SONNET_IN_PI], { harnessId: "pi/pi" }),
    ]);

    expect(offerModelProfileEntryIn(profile, SONNET_IN_PI, null).accounts[0]?.entries).toHaveLength(
      1,
    );
  });

  it("changes nothing for an entry the profile does not hold", () => {
    expect(
      offerModelProfileEntryIn(PROFILE, buildProfileEntry(ZAI_IDENTITY, "glm"), "pi/pi"),
    ).toEqual(moveModelProfileAccount(PROFILE, CLAUDE, 0));
    expect(
      offerModelProfileEntryIn(PROFILE, buildProfileEntry(ANTHROPIC_IDENTITY, "gone"), "pi/pi"),
    ).toEqual(moveModelProfileAccount(PROFILE, CLAUDE, 0));
  });
});

describe("addModelProfileAccount", () => {
  it("appends the account as the last section, sent without entries so the controller applies its Default Selection", () => {
    const input = addModelProfileAccount(PROFILE, ZAI);

    expect(input.accounts.map((section) => section.providerAccountId)).toEqual([
      CLAUDE,
      CODEX,
      ZAI,
    ]);
    expect(input.accounts[2]).toEqual({ providerAccountId: ZAI, harnessId: null });
    expect(input.accounts[2]).not.toHaveProperty("entries");
  });

  it("does not add an account twice", () => {
    expect(addModelProfileAccount(PROFILE, CODEX).accounts).toHaveLength(2);
  });
});

describe("renameModelProfile", () => {
  it("sends the profile as read, with the revision it was read at, under the new name", () => {
    const renamed = renameModelProfile(PROFILE, "Client work");

    expect(renamed).toEqual({
      ...moveModelProfileAccount(PROFILE, CLAUDE, 0),
      name: "Client work",
    });
    expect(renamed.expectedRevision).toBe(7);
  });

  it("does not trim or check the name, so the controller's refusal is what the user reads", () => {
    expect(renameModelProfile(PROFILE, "  ").name).toBe("  ");
  });
});
