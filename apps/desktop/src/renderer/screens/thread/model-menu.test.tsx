/**
 * Tests the model menu's content: on a Draft Thread, Recent and one lane per
 * account with the entries that cannot run dimmed with their reason and a
 * Sign in link; with several Model Profiles, the heads of the accordion; on a
 * thread that has started, the flat list and its note; and the choice each
 * row makes.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  readThreadConfig,
  type NewModelRow,
  type RecentModel,
  type SignInTarget,
  type ThreadCatalogs,
  type ThreadChoice,
  type ThreadConfig,
  type ThreadKind,
} from "@hercule/client-core";
import type { ModelProfile, ProviderAccount, ResolvedModelProfileEntry } from "@hercule/contract";
import {
  ANTHROPIC_IDENTITY,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
  HARNESSES,
  OPENAI_IDENTITY,
  PROVIDERS,
} from "@hercule/client-core/testing";
import { SIDEBAR_FIXTURE, THREAD_FIXTURES } from "../../app/testing";
import { ModelMenu, type NewModelSaves } from "./model-menu";

const MOSS = SIDEBAR_FIXTURE.runners[0]!;

const CLAUDE = buildProviderAccount(ANTHROPIC_IDENTITY, [], [{ runnerId: MOSS.id }]);
/** Codex is not signed in on moss, so its entries cannot run there. */
const CODEX = buildProviderAccount(
  OPENAI_IDENTITY,
  [],
  [{ runnerId: MOSS.id, state: "not-signed-in" }],
);

/** Returns a Claude Code entry of the Anthropic account named after its model. */
const claudeEntry = (
  model: string,
  name: string,
  fields: Partial<ResolvedModelProfileEntry> = {},
): ResolvedModelProfileEntry => buildProfileEntry(ANTHROPIC_IDENTITY, model, { name, ...fields });

const SONNET = claudeEntry("claude-sonnet-5", "Claude Sonnet 5");
const OPUS = claudeEntry("claude-opus-5", "Claude Opus 5");
const OPUS_IN_PI = claudeEntry("claude-opus-5", "Claude Opus 5", {
  harnessId: "pi/pi",
  resolvedHarnessId: "pi/pi",
});
const GPT = buildProfileEntry(OPENAI_IDENTITY, "gpt-5.4", {
  name: "GPT-5.4",
  resolvedHarnessId: "codex/codex",
  problem: { reason: "not-signed-in", message: "Not signed in to Codex." },
});

/** The profile "Main": Claude's two models, then Codex's one, with Sonnet as the default. */
const MAIN: ModelProfile = buildModelProfile(
  [
    buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, OPUS]),
    buildProfileSection(OPENAI_IDENTITY, [GPT]),
  ],
  { defaultEntry: { providerAccountId: CLAUDE.id, model: SONNET.model, harnessId: null } },
);

/** The idle fixture thread's config, moved to the Anthropic account and its Sonnet. */
const CONFIG: ThreadConfig = {
  ...readThreadConfig({ kind: "active", session: THREAD_FIXTURES.finished.session }),
  providerAccountId: CLAUDE.id,
  harnessId: null,
  model: SONNET.model,
  runnerId: MOSS.id,
};

/** Returns the recent entry for `entry`. */
const recentOf = (entry: ResolvedModelProfileEntry): RecentModel => ({
  providerAccountId: entry.providerAccountId,
  harnessId: entry.resolvedHarnessId,
  model: entry.model,
});

/** Renders the menu and returns the functions that received each choice and each sign-in. */
const renderMenu = ({
  accounts = [CLAUDE, CODEX],
  profiles = [MAIN],
  config = CONFIG,
  kind = "draft",
  recent = [],
  lastOpenProfileId = null,
  newModelSaves,
}: {
  readonly accounts?: readonly ProviderAccount[];
  readonly profiles?: readonly ModelProfile[];
  readonly config?: ThreadConfig;
  readonly kind?: ThreadKind;
  readonly recent?: readonly RecentModel[];
  readonly lastOpenProfileId?: string | null;
  readonly newModelSaves?: NewModelSaves;
} = {}) => {
  const buildCatalogs = (modelProfiles: readonly ModelProfile[]): ThreadCatalogs => ({
    accounts,
    providers: PROVIDERS,
    harnesses: HARNESSES,
    modelProfiles,
    runners: SIDEBAR_FIXTURE.runners,
    thisMacRunnerId: null,
  });
  const onChoose = vi.fn<(choice: ThreadChoice) => void>();
  const onSignIn = vi.fn<(target: SignInTarget) => void>();
  const rememberOpenProfile = vi.fn<(profileId: string) => void>();
  const draw = (modelProfiles: readonly ModelProfile[]) => (
    <ModelMenu
      catalogs={buildCatalogs(modelProfiles)}
      plugins={[]}
      config={config}
      kind={kind}
      runnerId={null}
      timezone="UTC"
      readRecent={() => recent}
      readLastOpenProfileId={() => lastOpenProfileId}
      rememberOpenProfile={rememberOpenProfile}
      onChoose={onChoose}
      onSignIn={onSignIn}
      newModelSaves={newModelSaves}
    />
  );
  const { rerender } = render(draw(profiles));
  /** Draws the menu again with other profiles, as the app does when the controller changes them. */
  const showProfiles = (next: readonly ModelProfile[]): void => {
    rerender(draw(next));
  };
  return { onChoose, onSignIn, rememberOpenProfile, showProfiles };
};

/** Returns the words of a row, without the words a Provider's mark draws as its fallback initial. */
const readWords = (row: Element): string => {
  const copy = row.cloneNode(true) as Element;
  for (const mark of copy.querySelectorAll("svg")) mark.remove();
  return copy.textContent;
};

/** Returns the text of each row of each section, in order. A section's label is its first row. */
const readSections = (): readonly (readonly string[])[] =>
  [...document.querySelectorAll(".pop-sec")].map((section) => [...section.children].map(readWords));

describe("the model menu of a Draft Thread", () => {
  it("lists Recent, then a lane per account named after it, with the entries in the profile's order", () => {
    renderMenu({ recent: [recentOf(OPUS), recentOf(SONNET)] });

    expect(readSections()).toEqual([
      ["Recent", "Claude Opus 5", "Claude Sonnet 5"],
      ["Anthropic", "Claude Sonnet 5", "Claude Opus 5"],
      ["OpenAI", "GPT-5.4not signed in on mossSign in"],
    ]);
    // Three entries are too few to need a filter.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("checks the entry in use and marks the profile's default entry when it is another", () => {
    renderMenu({ config: { ...CONFIG, model: OPUS.model } });

    expect(screen.getByRole("button", { current: true }).textContent).toBe("Claude Opus 5");
    expect(screen.getByRole("button", { name: "Claude Sonnet 5 · default" })).toBeTruthy();
  });

  it("names the other harness of an entry that runs in one, and keeps both entries of one model", () => {
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, OPUS, OPUS_IN_PI]),
    ]);
    renderMenu({ profiles: [profile] });

    expect(readSections()[0]).toEqual([
      "Anthropic",
      "Claude Sonnet 5",
      "Claude Opus 5",
      "Claude Opus 5 · in pi",
    ]);
  });

  it("dims an entry that cannot run with its reason, and signs in from the row", async () => {
    const user = userEvent.setup();
    const { onChoose, onSignIn } = renderMenu();

    // The row is not a button to pick, but its Sign in link is a button.
    expect(screen.queryByRole("button", { name: /GPT-5.4/ })).toBeNull();
    const row = screen.getByText("GPT-5.4").closest(".line")!;
    expect(row.classList.contains("line--dimmed")).toBe(true);
    expect(within(row as HTMLElement).getByText("not signed in on moss")).toBeTruthy();
    await user.click(within(row as HTMLElement).getByRole("button", { name: "Sign in" }));

    expect(onSignIn.mock.calls).toEqual([
      [expect.objectContaining({ providerAccountId: CODEX.id, runnerId: MOSS.id })],
    ]);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("shows a note in the lane of an account whose models are still being read", () => {
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [SONNET]),
      buildProfileSection(OPENAI_IDENTITY, "pending"),
    ]);
    renderMenu({ profiles: [profile] });

    expect(readSections()[1]).toEqual(["OpenAI", "Reading models…"]);
  });

  it("hands the account, the harness and the model of the picked row to onChoose", async () => {
    const user = userEvent.setup();
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, OPUS_IN_PI]),
    ]);
    const { onChoose } = renderMenu({ profiles: [profile] });

    await user.click(screen.getByRole("button", { name: "Claude Opus 5 · in pi" }));

    expect(onChoose.mock.calls).toEqual([
      [{ kind: "model", providerAccountId: CLAUDE.id, harnessId: "pi/pi", model: OPUS.model }],
    ]);
  });

  it("offers a focused filter once the profile holds more than eight entries, which narrows every lane", async () => {
    const user = userEvent.setup();
    const many = ["1", "2", "3", "4", "5", "6", "7", "8"].map((version) =>
      claudeEntry(`claude-haiku-${version}`, `Claude Haiku ${version}`),
    );
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, ...many]),
      buildProfileSection(OPENAI_IDENTITY, [GPT]),
    ]);
    renderMenu({ profiles: [profile] });

    const filter = screen.getByRole("textbox", { name: "Filter models" });
    expect(document.activeElement).toBe(filter);
    await user.type(filter, "haiku 3");

    expect(readSections().slice(1)).toEqual([["Anthropic", "Claude Haiku 3"]]);
    await user.clear(filter);
    await user.type(filter, "zzz");
    expect(screen.getByText("No model matches.")).toBeTruthy();
  });

  it("says so when the user has no model in the menu yet", () => {
    renderMenu({ profiles: [buildModelProfile([])] });

    expect(screen.getByText("No models in this profile yet.")).toBeTruthy();
  });
});

/** The profile "Work": Claude's Haiku, and Codex's GPT, which cannot run on moss. */
const HAIKU = claudeEntry("claude-haiku-5", "Claude Haiku 5");
const WORK: ModelProfile = buildModelProfile(
  [buildProfileSection(ANTHROPIC_IDENTITY, [HAIKU]), buildProfileSection(OPENAI_IDENTITY, [GPT])],
  { id: "profile-work", name: "Work" },
);

/** Returns the heads of the accordion, in order. */
const readHeads = (): readonly HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>("button[aria-expanded]"),
];

describe("the model menu of a Draft Thread with several Model Profiles", () => {
  it("has a head per profile, with the profile that holds the current entry unfolded", () => {
    renderMenu({ profiles: [MAIN, WORK] });

    // Each head is named by the profile's name and its number of entries. The
    // face beside the name is decoration, so it is not part of the name.
    const heads = readHeads();
    expect(heads).toEqual([
      screen.getByRole("button", { name: /^Main\s?3$/ }),
      screen.getByRole("button", { name: /^Work\s?2$/ }),
    ]);
    expect(heads.map((head) => head.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
    // Only the unfolded profile's lanes are drawn.
    expect(screen.queryByText("Claude Haiku 5")).toBeNull();
    expect(screen.getByText("Claude Opus 5")).toBeTruthy();
  });

  it("has no heads when the user has one profile", () => {
    renderMenu({ profiles: [MAIN] });

    expect(readHeads()).toEqual([]);
  });

  it("unfolds a clicked head and folds the other, without changing the draft's model, and remembers it", async () => {
    const user = userEvent.setup();
    const { onChoose, rememberOpenProfile } = renderMenu({ profiles: [MAIN, WORK] });

    await user.click(screen.getByRole("button", { name: /^Work/ }));

    expect(readHeads().map((head) => head.getAttribute("aria-expanded"))).toEqual([
      "false",
      "true",
    ]);
    expect(screen.getByText("Claude Haiku 5")).toBeTruthy();
    expect(screen.queryByText("Claude Opus 5")).toBeNull();
    expect(rememberOpenProfile.mock.calls).toEqual([["profile-work"]]);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("opens on the profile open last when the current entry is in neither", () => {
    const elsewhere: ThreadConfig = { ...CONFIG, model: "claude-unlisted" };
    renderMenu({ profiles: [MAIN, WORK], config: elsewhere, lastOpenProfileId: "profile-work" });

    expect(readHeads().map((head) => head.getAttribute("aria-expanded"))).toEqual([
      "false",
      "true",
    ]);
  });

  it("shows each profile's own Recent entries under its head", async () => {
    const user = userEvent.setup();
    renderMenu({ profiles: [MAIN, WORK], recent: [recentOf(HAIKU), recentOf(OPUS)] });

    expect(readSections()[0]).toEqual(["Recent", "Claude Opus 5"]);
    await user.click(screen.getByRole("button", { name: /^Work/ }));
    expect(readSections()[0]).toEqual(["Recent", "Claude Haiku 5"]);
  });

  it("dims an entry of the unfolded profile with its reason", () => {
    renderMenu({
      profiles: [MAIN, WORK],
      lastOpenProfileId: "profile-work",
      config: { ...CONFIG, model: HAIKU.model },
    });

    const row = screen.getByText("GPT-5.4").closest(".line")!;
    expect(row.classList.contains("line--dimmed")).toBe(true);
    expect(within(row as HTMLElement).getByText("not signed in on moss")).toBeTruthy();
  });

  it("unfolds every profile with a match while filtering, and leaves out the others", async () => {
    const user = userEvent.setup();
    const many = ["1", "2", "3", "4", "5", "6", "7", "8"].map((version) =>
      claudeEntry(`claude-haiku-${version}`, `Claude Haiku ${version}`),
    );
    const big = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, many)], {
      id: "profile-big",
      name: "Big",
    });
    renderMenu({ profiles: [MAIN, WORK, big] });

    await user.type(screen.getByRole("textbox", { name: "Filter models" }), "haiku");

    // Main holds no Haiku, so its head is gone; Work and Big are both unfolded.
    expect(readHeads()).toEqual([
      screen.getByRole("button", { name: /^Work\s?2$/, expanded: true }),
      screen.getByRole("button", { name: /^Big\s?8$/, expanded: true }),
    ]);
    await user.clear(screen.getByRole("textbox", { name: "Filter models" }));
    await user.type(screen.getByRole("textbox", { name: "Filter models" }), "zzz");
    expect(screen.getByText("No model matches.")).toBeTruthy();
    expect(readHeads()).toEqual([]);
  });

  it("reaches every head and row with the Tab key, and a head opens with Enter", async () => {
    const user = userEvent.setup();
    renderMenu({ profiles: [MAIN, WORK] });

    const stops: (Element | null)[] = [];
    for (let stop = 0; stop < 5; stop += 1) {
      await user.tab();
      stops.push(document.activeElement);
    }

    // The first head, the unfolded profile's two entries and the Sign in on
    // the third, then the second head.
    expect(stops).toEqual([
      screen.getByRole("button", { name: /^Main\s?3$/ }),
      screen.getByRole("button", { name: /Claude Sonnet 5/ }),
      screen.getByRole("button", { name: /Claude Opus 5/ }),
      screen.getByText("Sign in"),
      screen.getByRole("button", { name: /^Work\s?2$/ }),
    ]);
    await user.keyboard("{Enter}");
    expect(document.activeElement?.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Claude Haiku 5")).toBeTruthy();
  });
});

describe("the model menu of a thread that has started", () => {
  it("lists the models of its account and harness as one flat list, with the note under it", () => {
    renderMenu({ kind: "active", recent: [recentOf(OPUS)] });

    // No Recent, no lane label, and no entry of another account.
    expect(readSections()).toEqual([["Claude Sonnet 5", "Claude Opus 5"]]);
    expect(screen.getByText("Other models start a new thread.")).toBeTruthy();
  });

  it("hands the picked model to onChoose with the thread's account and harness", async () => {
    const user = userEvent.setup();
    const { onChoose } = renderMenu({ kind: "active" });

    await user.click(screen.getByRole("button", { name: "Claude Opus 5" }));

    expect(onChoose.mock.calls).toEqual([
      [
        {
          kind: "model",
          providerAccountId: CLAUDE.id,
          harnessId: ANTHROPIC_IDENTITY.harnessId,
          model: OPUS.model,
        },
      ],
    ]);
  });
});

/** An announced model of the Anthropic account, which arrived on 26 Oct of the year the test runs in. */
const OPUS_5_6 = {
  model: "claude-opus-5-6",
  name: "Claude Opus 5.6",
  firstSeenAt: `${String(new Date().getUTCFullYear())}-10-26T12:00:00.000Z`,
};

/** The profile "Main" whose Anthropic section announces `OPUS_5_6`. */
const WITH_NEW_MODEL: ModelProfile = buildModelProfile([
  buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, OPUS], { newModels: [OPUS_5_6] }),
  buildProfileSection(OPENAI_IDENTITY, [GPT]),
]);

/** Returns the "New" row of the menu. */
const findNewRow = (): HTMLElement => document.querySelector<HTMLElement>(".line--new")!;

/** Returns the New row of `WITH_NEW_MODEL` as a pair of saves that both work at once. */
const SAVES_AT_ONCE: NewModelSaves = {
  add: () => Promise.resolve(),
  dismiss: () => Promise.resolve(),
};

describe("the New rows of a Draft Thread's menu", () => {
  it("draws the row first in its lane, with the date, and no pick on its body", async () => {
    const user = userEvent.setup();
    const { onChoose } = renderMenu({
      profiles: [WITH_NEW_MODEL],
      newModelSaves: SAVES_AT_ONCE,
    });

    expect(readSections()[0]).toEqual([
      "Anthropic",
      "NewClaude Opus 5.6 · arrived 26 OctAdd",
      "Claude Sonnet 5",
      "Claude Opus 5",
    ]);
    await user.click(screen.getByText("Claude Opus 5.6"));
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("draws the row without buttons when the screen gives no way to act on it", () => {
    renderMenu({ profiles: [WITH_NEW_MODEL] });

    expect(findNewRow().textContent).toBe("NewClaude Opus 5.6 · arrived 26 Oct");
    expect(within(findNewRow()).queryAllByRole("button")).toEqual([]);
  });

  it("names the model on both buttons and hands the profile and the row to the saves", async () => {
    const user = userEvent.setup();
    const added = vi.fn<(profileId: string, row: NewModelRow) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const dismissed = vi.fn<(profileId: string, row: NewModelRow) => Promise<void>>(() =>
      Promise.resolve(),
    );
    renderMenu({
      profiles: [WITH_NEW_MODEL],
      newModelSaves: { add: added, dismiss: dismissed },
    });

    await user.click(screen.getByRole("button", { name: "Add Claude Opus 5.6" }));
    const dismiss = screen.getByRole("button", { name: "Not now: Claude Opus 5.6" });
    expect(dismiss.getAttribute("title")).toBe("Not now");
    await user.click(dismiss);

    const row: unknown = expect.objectContaining({
      providerAccountId: CLAUDE.id,
      model: OPUS_5_6.model,
    });
    expect(added.mock.calls).toEqual([[WITH_NEW_MODEL.id, row]]);
    expect(dismissed.mock.calls).toEqual([[WITH_NEW_MODEL.id, row]]);
  });

  it("keeps the buttons of a row focusable but inert while its save runs, and shows a refusal under the lane", async () => {
    const user = userEvent.setup();
    const add = vi.fn<NewModelSaves["add"]>();
    let refuse: (error: Error) => void = () => undefined;
    add.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject;
        }),
    );
    renderMenu({
      profiles: [WITH_NEW_MODEL],
      newModelSaves: { add, dismiss: () => Promise.resolve() },
    });

    await user.click(screen.getByRole("button", { name: "Add Claude Opus 5.6" }));
    const addButton = screen.getByRole("button", { name: "Add Claude Opus 5.6" });
    const dismissButton = screen.getByRole("button", { name: "Not now: Claude Opus 5.6" });
    for (const button of [addButton, dismissButton]) {
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.hasAttribute("data-unready")).toBe(true);
    }
    // The pressed button keeps the focus, and pressing it again does nothing.
    expect(document.activeElement).toBe(addButton);
    await user.keyboard("{Enter}");
    expect(add).toHaveBeenCalledTimes(1);

    refuse(new Error("pi does not list Claude Opus 5.6."));

    const lane = findNewRow().closest(".pop-sec")!;
    await waitFor(() => {
      expect(within(lane as HTMLElement).getByRole("alert").textContent).toBe(
        "The change was not saved. pi does not list Claude Opus 5.6.",
      );
    });
    // The row stays, with its buttons ready for another try.
    expect(addButton.hasAttribute("aria-disabled")).toBe(false);
    expect(document.activeElement).toBe(addButton);
  });

  it("draws no New row in the menu of a thread that has started", () => {
    renderMenu({ profiles: [WITH_NEW_MODEL], kind: "active" });

    expect(findNewRow()).toBeNull();
  });
});

/** An announced model that follows `OPUS_5_6`. */
const OPUS_5_7 = { ...OPUS_5_6, model: "claude-opus-5-7", name: "Claude Opus 5.7" };

describe("the focus after a New row leaves the menu", () => {
  /** Returns the profile whose Anthropic section holds `entries` and announces `newModels`. */
  const buildProfile = (
    entries: readonly ResolvedModelProfileEntry[],
    newModels: readonly (typeof OPUS_5_6)[],
  ): ModelProfile =>
    buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, entries, { newModels }),
      buildProfileSection(OPENAI_IDENTITY, [GPT]),
    ]);

  it("moves to the row of the added entry after Add", async () => {
    const user = userEvent.setup();
    const opus56 = claudeEntry(OPUS_5_6.model, OPUS_5_6.name);
    let show: (profiles: readonly ModelProfile[]) => void = () => undefined;
    const menu = renderMenu({
      profiles: [buildProfile([SONNET, OPUS], [OPUS_5_6])],
      newModelSaves: {
        add: () => {
          show([buildProfile([SONNET, OPUS, opus56], [])]);
          return Promise.resolve();
        },
        dismiss: () => Promise.resolve(),
      },
    });
    show = menu.showProfiles;

    await user.click(screen.getByRole("button", { name: "Add Claude Opus 5.6" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Claude Opus 5.6" }));
    });
  });

  it("moves to the Add button of the next New row after Not now, else to the lane's first row", async () => {
    const user = userEvent.setup();
    let show: (profiles: readonly ModelProfile[]) => void = () => undefined;
    const menu = renderMenu({
      profiles: [buildProfile([SONNET, OPUS], [OPUS_5_6, OPUS_5_7])],
      newModelSaves: {
        add: () => Promise.resolve(),
        dismiss: (_profileId, row) => {
          show([buildProfile([SONNET, OPUS], row.model === OPUS_5_6.model ? [OPUS_5_7] : [])]);
          return Promise.resolve();
        },
      },
    });
    show = menu.showProfiles;

    await user.click(screen.getByRole("button", { name: "Not now: Claude Opus 5.6" }));
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Add Claude Opus 5.7" }),
      );
    });

    await user.click(screen.getByRole("button", { name: "Not now: Claude Opus 5.7" }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Claude Sonnet 5" }));
    });
  });

  it("leaves the focus alone after a refusal", async () => {
    const user = userEvent.setup();
    renderMenu({
      profiles: [WITH_NEW_MODEL],
      newModelSaves: {
        add: () => Promise.reject(new Error("Refused.")),
        dismiss: () => Promise.resolve(),
      },
    });

    await user.click(screen.getByRole("button", { name: "Add Claude Opus 5.6" }));

    await screen.findByRole("alert");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Add Claude Opus 5.6" }),
    );
  });
});
