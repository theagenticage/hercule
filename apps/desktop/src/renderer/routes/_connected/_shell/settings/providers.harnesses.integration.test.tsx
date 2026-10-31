/**
 * Tests where the harness of a Model Profile's models is chosen in Settings >
 * Providers > Models, in one world: an Anthropic API key, which runs in Claude
 * Code and in pi (pi lists Opus and not Sonnet), and an OpenAI subscription,
 * which runs in Codex only.
 *
 * - The harness pill in the head of a section: its label, its popover with
 *   the struck choices, "Change it", and the one `modelProfile.update` that a
 *   pick sends.
 * - A row's "Runs in" and "Also offer in", each saved as one update.
 *
 * The tests read the request bodies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ANTHROPIC_API_KEY_IDENTITY as CLIENT_KEY,
  HARNESSES_WITH_ANTHROPIC_API_KEY,
  OPENAI_IDENTITY as CLIENT_OPENAI,
  PROVIDERS_WITH_ANTHROPIC_API_KEY,
  WITH_CLAUDE_AND_PI,
  buildErrorBody,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
  buildSnapshot,
} from "@hercule/client-core/testing";
import type {
  ModelProfile,
  ModelProfileEntry,
  ModelProfileUpdateInput,
  ResolvedModelProfileEntry,
  ResolvedModelProfileAccount,
  Runner,
} from "@hercule/contract";
import { forgetLastSettingsSection } from "../../../../app/last-settings-section";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  type Handler,
} from "../../../../app/testing";

vi.mock("../../../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

beforeEach(() => {
  stubElementSize(272, 800);
});
afterEach(forgetLastSettingsSection);

const PI = "pi/pi";
const PROFILE_ID = "01a06d02-8000-7000-8000-000000000b01";
const PROFILE_PATH = `/api/v1/model-profiles/${PROFILE_ID}`;
const KEY_IDENTITY = { ...CLIENT_KEY, id: "01a06d02-8000-7000-8000-000000000a01" };
const OPENAI_IDENTITY = { ...CLIENT_OPENAI, id: "01a06d02-8000-7000-8000-000000000a02" };
const IDENTITIES = [KEY_IDENTITY, OPENAI_IDENTITY];

/** A second machine with Codex only, so Claude Code and pi are "Not on beelink". */
const BEELINK: Runner = {
  ...WITH_CLAUDE_AND_PI,
  id: "01a06d02-8000-7000-8000-000000000c02",
  name: "beelink",
  facts: {
    ...WITH_CLAUDE_AND_PI.facts!,
    harnesses: [
      { name: "claude", present: false },
      { name: "codex", present: true, path: "/usr/local/bin/codex" },
      { name: "pi", present: false },
    ],
  },
};
/** The key's capability snapshot in pi: pi lists Opus, and not Sonnet. */
const PI_MODELS = buildSnapshot({
  harnessId: PI,
  models: [{ slug: "opus-5-5", name: "Opus 5.5", imageInput: { maxBytes: null }, options: [] }],
});

const OPUS = buildProfileEntry(KEY_IDENTITY, "opus-5-5", { name: "Opus 5.5" });
const SONNET = buildProfileEntry(KEY_IDENTITY, "sonnet-5-5", { name: "Sonnet 5.5" });
const GPT = buildProfileEntry(OPENAI_IDENTITY, "gpt-6", { name: "GPT-6" });

/** "Main": the key's section with `keyEntries`, and OpenAI's with GPT-6; Opus is the default entry. */
const buildMain = (
  keyEntries: ResolvedModelProfileEntry[],
  keySection: Partial<ResolvedModelProfileAccount> = {},
): ModelProfile =>
  buildModelProfile(
    [
      buildProfileSection(KEY_IDENTITY, keyEntries, keySection),
      buildProfileSection(OPENAI_IDENTITY, [GPT]),
    ],
    {
      id: PROFILE_ID,
      revision: 4,
      name: "Main",
      defaultEntry: { providerAccountId: KEY_IDENTITY.id, model: "opus-5-5", harnessId: null },
    },
  );
/** The key's section follows the account, with Opus and Sonnet. pi cannot take the section: it lacks Sonnet. */
const MAIN = buildMain([OPUS, SONNET]);
/** The key's section follows the account, with Opus only, so pi can take the whole section. */
const OPUS_ONLY = buildMain([OPUS]);
/** The profile names pi for the key's section. */
const IN_PI = buildMain([{ ...OPUS, resolvedHarnessId: PI }], {
  harnessId: PI,
  resolvedHarnessId: PI,
});

/**
 * Plays the controller's `modelProfile.update` over `initial`: the entries it
 * receives come back resolved to the harness they name, or to their section's.
 * Returns the handlers.
 */
const playProfile = (initial: ModelProfile): Record<string, Handler> => {
  let stored = initial;
  const names = new Map(
    stored.accounts.flatMap(({ entries }) => entries.map(({ model, name }) => [model, name])),
  );
  return {
    "GET /api/v1/model-profiles": () => ({ body: [stored] }),
    [`GET ${PROFILE_PATH}`]: () => ({ body: stored }),
    [`PATCH ${PROFILE_PATH}`]: (call) => {
      const input = call.body as ModelProfileUpdateInput;
      if (input.expectedRevision !== stored.revision) {
        return { status: 409, body: buildErrorBody("conflict", "The profile changed.") };
      }
      stored = {
        ...stored,
        revision: stored.revision + 1,
        defaultEntry: input.defaultEntry,
        accounts: input.accounts.map((section) => {
          const identity = IDENTITIES.find(({ id }) => id === section.providerAccountId)!;
          const sectionHarnessId = section.harnessId ?? identity.harnessId;
          return {
            providerAccountId: section.providerAccountId,
            harnessId: section.harnessId,
            resolvedHarnessId: sectionHarnessId,
            selectionPending: false,
            entries: (section.entries ?? []).map(
              (entry: ModelProfileEntry): ResolvedModelProfileEntry =>
                buildProfileEntry(identity, entry.model, {
                  name: names.get(entry.model) ?? entry.model,
                  harnessId: entry.harnessId,
                  resolvedHarnessId: entry.harnessId ?? sectionHarnessId,
                }),
            ),
          };
        }),
      };
      return { body: stored };
    },
  };
};

/** Opens Settings > Providers over `profile`, whose updates the controller accepts as they come. */
const openModels = async (profile: ModelProfile = MAIN) => {
  const calls = stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      runners: [WITH_CLAUDE_AND_PI, BEELINK],
      accounts: [
        { ...buildProviderAccount(KEY_IDENTITY, [PI_MODELS]), modelCount: 2 },
        { ...buildProviderAccount(OPENAI_IDENTITY), modelCount: 1 },
      ],
      modelProfiles: [profile],
    }),
    "GET /api/v1/providers": { body: PROVIDERS_WITH_ANTHROPIC_API_KEY },
    "GET /api/v1/harnesses": { body: HARNESSES_WITH_ANTHROPIC_API_KEY },
    ...playProfile(profile),
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  await renderApp(fake, { path: "/settings/providers" });
  await screen.findByRole("heading", { level: 2, name: "Models" });
  return calls;
};

/** Returns the pill of the section of the account called `account`. */
const getPill = (account: string): HTMLElement =>
  within(screen.getByRole("region", { name: account })).getByTitle(
    `Where ${account}'s models run in Main`,
  );

/**
 * Presses a button that opens a popover and returns the popover. jsdom has no
 * popover API, so the popover is found by the button's `popovertarget` and its
 * items count as hidden.
 */
const openPopover = async (button: HTMLElement): Promise<HTMLElement> => {
  await userEvent.click(button);
  return document.getElementById(button.getAttribute("popovertarget")!)!;
};

/** Returns the row of the model called `name` in the section of the account called `account`; `nth` picks among rows of one name. */
const getRow = (account: string, name: string, nth = 0): HTMLElement =>
  within(screen.getByRole("region", { name: account }))
    .getAllByText(name, { selector: "b" })
    [nth]!.closest<HTMLElement>("li")!;

/** Presses the ⋯ button of the row and returns its menu. */
const openRowMenu = (row: HTMLElement): Promise<HTMLElement> =>
  openPopover(within(row).getByRole("button", { name: /^More for/ }));

/** Returns the radio of a popover or a menu called `name`. */
const getRadio = (popover: HTMLElement, name: string | RegExp): HTMLElement =>
  within(popover).getByRole("menuitemradio", { name, hidden: true });

/** Presses an item of a popover, which jsdom counts as hidden. */
const choose = (item: HTMLElement): Promise<void> =>
  userEvent.click(item, { pointerEventsCheck: 0 });

/** Returns the updates the page sent, oldest first. */
const listUpdates = (calls: readonly { method: string; path: string; body: unknown }[]) =>
  calls
    .filter((call) => call.method === "PATCH" && call.path === PROFILE_PATH)
    .map((call) => call.body as ModelProfileUpdateInput);

/** Returns the key's section in an update. */
const readKeySection = (update: ModelProfileUpdateInput) =>
  update.accounts.find((section) => section.providerAccountId === KEY_IDENTITY.id)!;

/** Lists the entries of the key's section in an update, as "model" or "model@harness". */
const listKeyEntries = (update: ModelProfileUpdateInput): string[] =>
  readKeySection(update).entries!.map(({ model, harnessId }) =>
    harnessId === null ? model : `${model}@${harnessId}`,
  );

describe("Settings > Providers > Models > the harness pill", () => {
  it("reads 'Same as the account' with the default harness while a section follows the account, and the harness's name once the profile names one", async () => {
    await openModels(IN_PI);

    expect(
      within(screen.getByRole("region", { name: "OpenAI" })).getByRole("button", {
        name: "Same as the account · Codex",
      }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Anthropic" })).getByRole("button", {
        name: "pi",
      }),
    ).toBeTruthy();
  });

  it("shows the follow choice's two lines, and a struck harness with its reason that cannot be picked", async () => {
    const calls = await openModels();

    const popover = await openPopover(getPill("Anthropic"));

    expect(within(popover).getByText("Anthropic's models in Main run in")).toBeTruthy();
    const follow = getRadio(popover, /^Same as the account · Claude Code/);
    expect(follow.getAttribute("aria-checked")).toBe("true");
    expect(follow.textContent).toContain("The account's default harness.");
    expect(follow.textContent).toContain("Not on beelink");
    const pi = getRadio(popover, /^pi/);
    expect(pi.getAttribute("aria-disabled")).toBe("true");
    expect(pi.textContent).toContain("pi doesn't know Sonnet 5.5");

    await choose(pi);

    expect(listUpdates(calls)).toEqual([]);
  });

  it("sends one update that names pi for the section when pi is picked", async () => {
    const calls = await openModels(OPUS_ONLY);

    await choose(getRadio(await openPopover(getPill("Anthropic")), /^pi/));

    const updates = listUpdates(calls);
    expect(updates).toHaveLength(1);
    expect(readKeySection(updates[0]!).harnessId).toBe(PI);
  });

  it("sends null for the section when 'Same as the account' is picked", async () => {
    const calls = await openModels(IN_PI);

    await choose(getRadio(await openPopover(getPill("Anthropic")), /^Same as the account/));

    const updates = listUpdates(calls);
    expect(updates).toHaveLength(1);
    expect(readKeySection(updates[0]!).harnessId).toBeNull();
  });

  it("sends nothing when the choice that is already chosen is picked", async () => {
    const calls = await openModels(IN_PI);

    await choose(getRadio(await openPopover(getPill("Anthropic")), /^pi/));

    expect(listUpdates(calls)).toEqual([]);
  });

  it("opens the account's sheet from 'Change it'", async () => {
    await openModels();

    const popover = await openPopover(getPill("Anthropic"));
    await choose(within(popover).getByRole("menuitem", { name: "Change it", hidden: true }));

    expect(await screen.findByRole("dialog", { name: "Anthropic" })).toBeTruthy();
  });

  it("opens the popover of a pill that is fixed, because Codex is all OpenAI's subscription can run in", async () => {
    await openModels();

    const popover = await openPopover(getPill("OpenAI"));

    expect(within(popover).getByText("OpenAI's models in Main run in")).toBeTruthy();
    expect(getRadio(popover, /^Same as the account · Codex/).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(getRadio(popover, /^pi/).getAttribute("aria-disabled")).toBe("true");
  });
});

describe("Settings > Providers > Models > a row's Runs in", () => {
  it("lists the section's harness first as 'like the account', checked, then the others", async () => {
    await openModels();

    const menu = await openRowMenu(getRow("Anthropic", "Opus 5.5"));

    expect(within(menu).getByText("Runs in")).toBeTruthy();
    const radios = within(menu).getAllByRole("menuitemradio", { hidden: true });
    expect(radios.map((radio) => radio.textContent)).toEqual([
      "Claude Code like the account",
      "pi",
    ]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("moves an entry to pi in one update, with the default entry following it and the focus on the moved row, and back with null", async () => {
    const calls = await openModels();

    let menu = await openRowMenu(getRow("Anthropic", "Opus 5.5"));
    await choose(getRadio(menu, "pi"));

    await waitFor(() => {
      expect(listUpdates(calls)).toHaveLength(1);
    });
    const [toPi] = listUpdates(calls);
    expect(listKeyEntries(toPi!)).toEqual(["opus-5-5@pi/pi", "sonnet-5-5"]);
    expect(toPi!.defaultEntry).toEqual({
      providerAccountId: KEY_IDENTITY.id,
      model: "opus-5-5",
      harnessId: PI,
    });
    // The row is a new element in its new harness, and it has the focus.
    await waitFor(() => {
      expect(document.activeElement).toBe(getRow("Anthropic", "Opus 5.5"));
    });

    menu = await openRowMenu(getRow("Anthropic", "Opus 5.5"));
    expect(getRadio(menu, "pi").getAttribute("aria-checked")).toBe("true");
    await choose(getRadio(menu, /^Claude Code/));

    await waitFor(() => {
      expect(listUpdates(calls)).toHaveLength(2);
    });
    const [, back] = listUpdates(calls);
    expect(listKeyEntries(back!)).toEqual(["opus-5-5", "sonnet-5-5"]);
    expect(back!.defaultEntry).toEqual({
      providerAccountId: KEY_IDENTITY.id,
      model: "opus-5-5",
      harnessId: null,
    });
  });

  it("sends nothing when the harness the entry is in now is picked", async () => {
    const calls = await openModels();

    const menu = await openRowMenu(getRow("Anthropic", "Opus 5.5"));
    await choose(getRadio(menu, /^Claude Code/));

    expect(listUpdates(calls)).toEqual([]);
  });

  it("adds the same model in pi as a second entry right after, with 'Also offer in pi'", async () => {
    const calls = await openModels();

    const menu = await openRowMenu(getRow("Anthropic", "Opus 5.5"));
    await choose(within(menu).getByRole("menuitem", { name: "Also offer in pi", hidden: true }));

    await waitFor(() => {
      expect(listUpdates(calls)).toHaveLength(1);
    });
    expect(listKeyEntries(listUpdates(calls)[0]!)).toEqual([
      "opus-5-5",
      "opus-5-5@pi/pi",
      "sonnet-5-5",
    ]);
    await waitFor(() => {
      expect(
        within(screen.getByRole("region", { name: "Anthropic" })).getAllByText("Opus 5.5", {
          selector: "b",
        }),
      ).toHaveLength(2);
    });
  });

  it("shows a harness that does not know the model struck, with its reason, and cannot be picked", async () => {
    const calls = await openModels();

    const menu = await openRowMenu(getRow("Anthropic", "Sonnet 5.5"));

    const pi = getRadio(menu, /^pi/);
    expect(pi.getAttribute("aria-disabled")).toBe("true");
    expect(within(pi).getByText("pi doesn't know this model")).toBeTruthy();

    await choose(pi);

    expect(listUpdates(calls)).toEqual([]);
  });

  it("has no Runs in for an account that runs in one harness only", async () => {
    await openModels();

    const menu = await openRowMenu(getRow("OpenAI", "GPT-6"));

    expect(within(menu).queryByText("Runs in")).toBeNull();
    expect(
      within(menu).getByRole("menuitem", { name: "Take out of the menu", hidden: true }),
    ).toBeTruthy();
  });
});
