/**
 * Tests the Models section of Settings > Providers in its one-profile form:
 * a section for each account in the profile's order, the entries of each with
 * "default" and "in pi", and every change saved as one `modelProfile.update`
 * that carries the revision that was read: Alt+arrows and a drag move a row
 * or a section, "Make it Main's default", "Take out of the menu", and a model
 * picked from the picker over the account's Model Catalog. A conflict is
 * answered by reading the profile again and applying the same change, and a
 * refused save says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createEvent, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ANTHROPIC_IDENTITY as CLIENT_ANTHROPIC,
  OPENAI_IDENTITY as CLIENT_OPENAI,
  ZAI_IDENTITY as CLIENT_ZAI,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
  type ProviderAccountIdentity,
} from "@hercule/client-core/testing";
import type {
  ModelCatalog,
  ModelProfile,
  ModelProfileEntry,
  ModelProfileUpdateInput,
  ProviderAccount,
  ResolvedModelProfileEntry,
} from "@hercule/contract";
import { forgetLastSettingsSection } from "../../../../app/last-settings-section";
import {
  buildErrorBody,
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

/** The controller sends ids that are UUIDs, which the client checks, so the accounts and the profile have them. */
const PROFILE_ID = "01a06d02-8000-7000-8000-000000000b01";
const PROFILE_PATH = `/api/v1/model-profiles/${PROFILE_ID}`;
const ANTHROPIC_IDENTITY = { ...CLIENT_ANTHROPIC, id: "01a06d02-8000-7000-8000-000000000a01" };
const OPENAI_IDENTITY = { ...CLIENT_OPENAI, id: "01a06d02-8000-7000-8000-000000000a02" };
const ZAI_IDENTITY = { ...CLIENT_ZAI, id: "01a06d02-8000-7000-8000-000000000a03" };
const IDENTITIES = [ANTHROPIC_IDENTITY, OPENAI_IDENTITY, ZAI_IDENTITY];

/** The account `identity`, with a catalog that was read at 08:00. */
const buildAccount = (identity: ProviderAccountIdentity): ProviderAccount => ({
  ...buildProviderAccount(identity),
  modelCount: 4,
  catalogReadAt: "2026-09-10T08:00:00.000Z",
});

const OPUS = buildProfileEntry(ANTHROPIC_IDENTITY, "opus-5-5", { name: "Opus 5.5" });
const SONNET = buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet-5-5", { name: "Sonnet 5.5" });
const HAIKU = buildProfileEntry(ANTHROPIC_IDENTITY, "haiku-5-5", { name: "Haiku 5.5" });
const SONNET_IN_PI = buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet-5-5", {
  name: "Sonnet 5.5",
  harnessId: "pi/pi",
  resolvedHarnessId: "pi/pi",
});
const GPT = buildProfileEntry(OPENAI_IDENTITY, "gpt-6", { name: "GPT-6" });

/**
 * "Main" at revision 4: Anthropic with Opus (the default), Sonnet, Haiku and
 * Sonnet again in pi; then OpenAI with GPT-6; then Z.ai, which waits for its
 * first read.
 */
const MAIN: ModelProfile = buildModelProfile(
  [
    buildProfileSection(ANTHROPIC_IDENTITY, [OPUS, SONNET, HAIKU, SONNET_IN_PI]),
    buildProfileSection(OPENAI_IDENTITY, [GPT]),
    buildProfileSection(ZAI_IDENTITY, "pending"),
  ],
  {
    id: PROFILE_ID,
    revision: 4,
    defaultEntry: { providerAccountId: ANTHROPIC_IDENTITY.id, model: "opus-5-5", harnessId: null },
  },
);

const CATALOG: ModelCatalog = {
  providerAccountId: ANTHROPIC_IDENTITY.id,
  readAt: "2026-09-10T08:00:00.000Z",
  error: null,
  models: [
    ["opus-5-5", "Opus 5.5"],
    ["sonnet-5-5", "Sonnet 5.5"],
    ["haiku-5-5", "Haiku 5.5"],
    ["opus-4-8", "Opus 4.8"],
  ].map(([slug, name]) => ({
    slug: slug!,
    name: name!,
    ...(slug === "opus-4-8" ? { isLegacy: true } : {}),
    imageInput: null,
    options: [],
    firstSeenAt: "2026-09-01T09:00:00.000Z",
  })),
};

/** Returns whether two stored entries are the same entry. */
const isSame = (a: ModelProfileEntry, b: ModelProfileEntry): boolean =>
  a.providerAccountId === b.providerAccountId && a.model === b.model && a.harnessId === b.harnessId;

/**
 * Plays the controller's `modelProfile` operations over `stored`. An update is
 * refused with `conflict` when it carries another revision than the stored
 * one, and `conflicts` makes that many updates fail first as if someone else
 * had written between the read and the write. `refusal` makes every update
 * fail with that message. Returns the handlers and a function that reads the
 * stored profile.
 */
const playProfile = (
  initial: ModelProfile,
  { conflicts = 0, refusal }: { conflicts?: number; refusal?: string } = {},
) => {
  let stored = initial;
  let toConflict = conflicts;
  const applyUpdate = (input: ModelProfileUpdateInput): ModelProfile => {
    const known = stored.accounts.flatMap(({ entries }) => entries);
    return {
      ...stored,
      revision: stored.revision + 1,
      defaultEntry: input.defaultEntry,
      dismissedNewModels: input.dismissedNewModels,
      accounts: input.accounts.map((section) => {
        const identity = IDENTITIES.find(({ id }) => id === section.providerAccountId)!;
        return {
          providerAccountId: section.providerAccountId,
          harnessId: section.harnessId,
          resolvedHarnessId: section.harnessId ?? identity.harnessId,
          selectionPending: section.entries === undefined,
          entries: (section.entries ?? []).map(
            (entry): ResolvedModelProfileEntry =>
              known.find((each) => isSame(each, entry)) ??
              buildProfileEntry(identity, entry.model, { name: entry.model }),
          ),
        };
      }),
    };
  };
  const handlers: Record<string, Handler> = {
    "GET /api/v1/model-profiles": () => ({ body: [stored] }),
    [`GET ${PROFILE_PATH}`]: () => ({ body: stored }),
    [`PATCH ${PROFILE_PATH}`]: (call) => {
      const input = call.body as ModelProfileUpdateInput;
      if (refusal !== undefined)
        return { status: 400, body: buildErrorBody("validation", refusal) };
      if (toConflict > 0) {
        toConflict -= 1;
        stored = { ...stored, revision: stored.revision + 1 };
      }
      if (input.expectedRevision !== stored.revision) {
        return { status: 409, body: buildErrorBody("conflict", "The profile changed.") };
      }
      stored = applyUpdate(input);
      return { body: stored };
    },
  };
  return { handlers, read: () => stored };
};

/** Opens Settings > Providers over `profile`, with three accounts and the catalog of Anthropic. */
const openModels = async (
  options: { conflicts?: number; refusal?: string; profile?: ModelProfile } = {},
) => {
  const { profile = MAIN, ...playing } = options;
  const controller = playProfile(profile, playing);
  const calls = stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      accounts: IDENTITIES.map(buildAccount),
      modelProfiles: [profile],
    }),
    ...controller.handlers,
    [`GET /api/v1/provider-accounts/${ANTHROPIC_IDENTITY.id}/catalog`]: { body: CATALOG },
    [`POST /api/v1/provider-accounts/${ANTHROPIC_IDENTITY.id}/refresh`]: {
      body: buildAccount(ANTHROPIC_IDENTITY),
    },
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  await renderApp(fake, { path: "/settings/providers" });
  await screen.findByRole("heading", { level: 2, name: "Models" });
  return { calls, ...controller };
};

/** Returns the section of the account called `name`. */
const getSection = (name: string): HTMLElement => screen.getByRole("region", { name });

/** Returns the row of the model called `name` in `section`; `nth` picks among rows of the same name. */
const getRow = (section: HTMLElement, name: string, nth = 0): HTMLElement =>
  within(section).getAllByText(name, { selector: "b" })[nth]!.closest<HTMLElement>("li")!;

/** Returns the model names of `section`, in order. */
const listModels = (section: HTMLElement): string[] =>
  [...section.querySelectorAll(".pm-row > b")].map((name) => name.textContent ?? "");

/** Returns the names of the models of `section` that are marked "default". */
const listDefaults = (section: HTMLElement): string[] =>
  [...section.querySelectorAll(".pm-row")]
    .filter((row) => row.querySelector(".pm-default") !== null)
    .map((row) => row.querySelector("b")?.textContent ?? "");

/** Returns the updates the page sent, oldest first. */
const listUpdates = (calls: readonly { method: string; path: string; body: unknown }[]) =>
  calls
    .filter((call) => call.method === "PATCH" && call.path === PROFILE_PATH)
    .map((call) => call.body as ModelProfileUpdateInput);

/** Lists the models of the entries of the section `providerAccountId` in an update. */
const listUpdatedModels = (update: ModelProfileUpdateInput, providerAccountId: string): string[] =>
  update.accounts
    .find((section) => section.providerAccountId === providerAccountId)!
    .entries!.map(({ model, harnessId }) => (harnessId === null ? model : `${model}@${harnessId}`));

/** Presses Alt and an arrow key on the focused element. */
const pressAlt = async (key: "ArrowUp" | "ArrowDown"): Promise<void> => {
  await userEvent.keyboard(`{Alt>}{${key}}{/Alt}`);
};

/**
 * Presses the ⋯ button of the row and returns the item `item` of its menu.
 * jsdom has no popover API, so the menu is found by the button's
 * `popovertarget` and counts as hidden.
 */
const openRowMenuItem = async (row: HTMLElement, item: string): Promise<HTMLElement> => {
  const button = within(row).getByRole("button", { name: /^More for/ });
  await userEvent.click(button);
  const menu = document.getElementById(button.getAttribute("popovertarget")!)!;
  return within(menu).getByRole("menuitem", { name: item, hidden: true });
};

/** Presses an enabled menu item, which jsdom counts as hidden. */
const chooseItem = (item: HTMLElement): Promise<void> =>
  userEvent.click(item, { pointerEventsCheck: 0 });

/**
 * A drag from `source` to `target`, dropped on its upper half (`before`) or
 * its lower half (`after`). jsdom has no layout, so `target` is 0 pixels tall
 * and its middle is at 0.
 */
const drag = (source: HTMLElement, target: HTMLElement, side: "before" | "after"): void => {
  const dataTransfer = { setData: () => undefined, effectAllowed: "" };
  const clientY = side === "before" ? -1 : 1;
  const at = (event: Event): Event => Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent(target, at(createEvent.dragOver(target, { dataTransfer })));
  fireEvent(target, at(createEvent.drop(target, { dataTransfer })));
  fireEvent.dragEnd(source, { dataTransfer });
};

/** Opens the picker of the account called `name`, as the browser does when its button is pressed, and returns it. */
const openPicker = async (name: string): Promise<HTMLElement> => {
  const button = screen.getByRole("button", { name: `Add a model from ${name}` });
  await userEvent.click(button);
  const popover = document.getElementById(button.getAttribute("popovertarget")!)!;
  // jsdom has no popover API, so the browser's `toggle` event is played by hand.
  const toggle = (newState: "open" | "closed"): void => {
    const event = new Event("toggle");
    Object.assign(event, { newState });
    act(() => {
      popover.dispatchEvent(event);
    });
  };
  toggle("open");
  await within(popover).findByRole("button", { name: "Opus 5.5", hidden: true });
  closePicker = () => {
    toggle("closed");
  };
  return popover;
};
let closePicker = (): void => undefined;

describe("Settings > Providers > Models", () => {
  it("draws a section for each account in the profile's order, with its entries, the default, and 'in pi'", async () => {
    await openModels();

    const sections = [...document.querySelectorAll<HTMLElement>(".pm-sec")];
    expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual([
      "Anthropic",
      "OpenAI",
      "Z.ai",
    ]);
    expect(listModels(getSection("Anthropic"))).toEqual([
      "Opus 5.5",
      "Sonnet 5.5",
      "Haiku 5.5",
      "Sonnet 5.5",
    ]);
    const anthropic = getSection("Anthropic");
    expect(listDefaults(anthropic)).toEqual(["Opus 5.5"]);
    expect(getRow(anthropic, "Sonnet 5.5").querySelector(".pm-inharness")).toBeNull();
    expect(
      getRow(anthropic, "Sonnet 5.5", 1).querySelector(".pm-inharness")?.textContent,
    ).toContain("in pi");
    // The account that waits for its first read says so, and offers no way to add.
    expect(within(getSection("Z.ai")).getByText("Reading models…")).toBeTruthy();
    expect(within(getSection("Z.ai")).queryByRole("button", { name: /Add a model/ })).toBeNull();
  });

  it("says so when an account has no entry in the profile yet", async () => {
    await openModels({
      profile: buildModelProfile([buildProfileSection(OPENAI_IDENTITY, [])], {
        id: PROFILE_ID,
      }),
    });

    expect(
      within(getSection("OpenAI")).getByText("No model from OpenAI in the menu yet."),
    ).toBeTruthy();
  });

  it("says under its row why a model cannot be offered, and says nothing of a machine's trouble", async () => {
    const gone = buildProfileEntry(ANTHROPIC_IDENTITY, "gone", {
      name: "Gone 1",
      problem: { reason: "model-left-catalog", message: "Anthropic no longer lists Gone 1." },
    });
    const signedOut = buildProfileEntry(ANTHROPIC_IDENTITY, "opus-5-5", {
      name: "Opus 5.5",
      problem: { reason: "not-signed-in", message: "Sign in to Claude Code." },
    });
    await openModels({
      profile: buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [gone, signedOut])], {
        id: PROFILE_ID,
      }),
    });

    expect(
      within(getRow(getSection("Anthropic"), "Gone 1")).getByText(
        "Anthropic no longer lists Gone 1.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Sign in to Claude Code.")).toBeNull();
  });

  it("moves the focused row with Alt+Down in one update, and the focus stays on the row", async () => {
    const { calls, read } = await openModels();
    const section = getSection("Anthropic");
    act(() => {
      getRow(section, "Opus 5.5").focus();
    });

    await pressAlt("ArrowDown");

    await waitFor(() => {
      expect(listModels(section)).toEqual(["Sonnet 5.5", "Opus 5.5", "Haiku 5.5", "Sonnet 5.5"]);
    });
    const updates = listUpdates(calls);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.expectedRevision).toBe(4);
    expect(listUpdatedModels(updates[0]!, ANTHROPIC_IDENTITY.id)).toEqual([
      "sonnet-5-5",
      "opus-5-5",
      "haiku-5-5",
      "sonnet-5-5@pi/pi",
    ]);
    expect(read().revision).toBe(5);
    await waitFor(() => {
      expect(document.activeElement).toBe(getRow(section, "Opus 5.5"));
    });
  });

  it("moves a row up with Alt+Up, and leaves the top row where it is", async () => {
    const { calls } = await openModels();
    const section = getSection("Anthropic");
    act(() => {
      getRow(section, "Opus 5.5").focus();
    });

    await pressAlt("ArrowUp");
    act(() => {
      getRow(section, "Haiku 5.5").focus();
    });
    await pressAlt("ArrowUp");

    await waitFor(() => {
      expect(listModels(section)).toEqual(["Opus 5.5", "Haiku 5.5", "Sonnet 5.5", "Sonnet 5.5"]);
    });
    // Opus was first, so the first press asked for nothing.
    expect(listUpdates(calls)).toHaveLength(1);
  });

  it("sends one update when a row is dropped, not while it is dragged", async () => {
    const { calls } = await openModels();
    const section = getSection("Anthropic");

    drag(getRow(section, "Haiku 5.5"), getRow(section, "Opus 5.5"), "before");

    // The new order shows at once.
    expect(listModels(section)).toEqual(["Haiku 5.5", "Opus 5.5", "Sonnet 5.5", "Sonnet 5.5"]);
    await waitFor(() => {
      expect(listUpdates(calls)).toHaveLength(1);
    });
    expect(listUpdatedModels(listUpdates(calls)[0]!, ANTHROPIC_IDENTITY.id)).toEqual([
      "haiku-5-5",
      "opus-5-5",
      "sonnet-5-5",
      "sonnet-5-5@pi/pi",
    ]);
  });

  it("reorders the accounts by dragging a head, and with Alt+Up on it", async () => {
    const { calls } = await openModels();
    const head = (name: string): HTMLElement =>
      getSection(name).querySelector<HTMLElement>(".pm-head")!;

    drag(head("OpenAI"), getSection("Anthropic"), "before");

    await waitFor(() => {
      expect(
        [...document.querySelectorAll(".pm-sec")].map((each) => each.getAttribute("aria-label")),
      ).toEqual(["OpenAI", "Anthropic", "Z.ai"]);
    });
    await waitFor(() => {
      expect(listUpdates(calls)).toHaveLength(1);
    });
    expect(
      listUpdates(calls)[0]!.accounts.map(({ providerAccountId }) => providerAccountId),
    ).toEqual([OPENAI_IDENTITY.id, ANTHROPIC_IDENTITY.id, ZAI_IDENTITY.id]);

    act(() => {
      head("Z.ai").focus();
    });
    await pressAlt("ArrowUp");
    await waitFor(() => {
      expect(listUpdates(calls)).toHaveLength(2);
    });
    expect(
      listUpdates(calls)[1]!.accounts.map(({ providerAccountId }) => providerAccountId),
    ).toEqual([OPENAI_IDENTITY.id, ZAI_IDENTITY.id, ANTHROPIC_IDENTITY.id]);
  });

  it("makes an entry the default from its menu, and offers that only on the others", async () => {
    const { calls } = await openModels();
    const section = getSection("Anthropic");
    expect(await openRowMenuItem(getRow(section, "Opus 5.5"), "Take out of the menu")).toBeTruthy();
    expect(
      within(getRow(section, "Opus 5.5")).queryByRole("menuitem", {
        name: "Make it Main's default",
        hidden: true,
      }),
    ).toBeNull();

    await chooseItem(await openRowMenuItem(getRow(section, "Haiku 5.5"), "Make it Main's default"));

    await waitFor(() => {
      expect(listDefaults(section)).toEqual(["Haiku 5.5"]);
    });
    expect(listUpdates(calls)).toHaveLength(1);
    expect(listUpdates(calls)[0]!.defaultEntry).toEqual({
      providerAccountId: ANTHROPIC_IDENTITY.id,
      model: "haiku-5-5",
      harnessId: null,
    });
  });

  it("takes the default out of the menu: the next entry becomes the default and the model is dismissed", async () => {
    const { calls } = await openModels();
    const section = getSection("Anthropic");

    await chooseItem(await openRowMenuItem(getRow(section, "Opus 5.5"), "Take out of the menu"));

    await waitFor(() => {
      expect(listModels(section)).toEqual(["Sonnet 5.5", "Haiku 5.5", "Sonnet 5.5"]);
    });
    const [update] = listUpdates(calls);
    expect(update!.defaultEntry).toEqual({
      providerAccountId: ANTHROPIC_IDENTITY.id,
      model: "sonnet-5-5",
      harnessId: null,
    });
    expect(update!.dismissedNewModels).toContainEqual({
      providerAccountId: ANTHROPIC_IDENTITY.id,
      model: "opus-5-5",
    });
    expect(listUpdates(calls)).toHaveLength(1);
  });

  it("opens the picker with the account's catalog read once, checks what the profile has, and adds a pick at the end of the section", async () => {
    const { calls } = await openModels();
    const catalogPath = `/api/v1/provider-accounts/${ANTHROPIC_IDENTITY.id}/catalog`;
    // Nothing is read until a picker opens.
    expect(calls.filter((call) => call.path === catalogPath)).toHaveLength(0);

    const picker = await openPicker("Anthropic");

    expect(calls.filter((call) => call.path === catalogPath)).toHaveLength(1);
    const pick = (name: string): HTMLElement =>
      within(picker).getByRole("button", { name, hidden: true });
    expect(pick("Opus 5.5").getAttribute("aria-pressed")).toBe("true");
    expect(pick("Sonnet 5.5").getAttribute("aria-pressed")).toBe("true");
    expect(pick("Opus 4.8 · older").getAttribute("aria-pressed")).toBe("false");
    // The older model comes last.
    expect(
      within(picker)
        .getAllByRole("button", { hidden: true })
        .map((button) => button.querySelector("b")?.textContent)
        .filter(Boolean),
    ).toEqual(["Opus 5.5", "Sonnet 5.5", "Haiku 5.5", "Opus 4.8"]);

    await userEvent.type(within(picker).getByLabelText("Search models"), "4.8");
    expect(within(picker).queryByRole("button", { name: "Opus 5.5", hidden: true })).toBeNull();
    await userEvent.click(pick("Opus 4.8 · older"));

    await waitFor(() => {
      expect(listModels(getSection("Anthropic"))).toEqual([
        "Opus 5.5",
        "Sonnet 5.5",
        "Haiku 5.5",
        "Sonnet 5.5",
        "opus-4-8",
      ]);
    });
    expect(listUpdatedModels(listUpdates(calls)[0]!, ANTHROPIC_IDENTITY.id)).toEqual([
      "opus-5-5",
      "sonnet-5-5",
      "haiku-5-5",
      "sonnet-5-5@pi/pi",
      "opus-4-8",
    ]);
    // The picker stays open, and shows the check.
    await waitFor(() => {
      expect(pick("Opus 4.8 · older").getAttribute("aria-pressed")).toBe("true");
    });

    // A pick that is checked takes the model out again.
    await userEvent.click(pick("Opus 4.8 · older"));
    await waitFor(() => {
      expect(listModels(getSection("Anthropic"))).not.toContain("opus-4-8");
    });
  });

  it("ends with the model out when the user toggles it twice before the first save is answered", async () => {
    const { calls, read } = await openModels();
    const picker = await openPicker("Anthropic");
    const pick = within(picker).getByRole("button", { name: "Opus 4.8 · older", hidden: true });

    // Both clicks land before the first update has an answer.
    fireEvent.click(pick);
    fireEvent.click(pick);

    await waitFor(() => {
      expect(listUpdates(calls)).toHaveLength(2);
    });
    expect(listUpdatedModels(listUpdates(calls)[0]!, ANTHROPIC_IDENTITY.id)).toContain("opus-4-8");
    expect(listUpdatedModels(listUpdates(calls)[1]!, ANTHROPIC_IDENTITY.id)).not.toContain(
      "opus-4-8",
    );
    expect(read().accounts[0]!.entries.map(({ model }) => model)).not.toContain("opus-4-8");
  });

  it("drops the catalog when the picker closes and reads it again when it opens again", async () => {
    const { calls } = await openModels();
    const catalogPath = `/api/v1/provider-accounts/${ANTHROPIC_IDENTITY.id}/catalog`;
    const picker = await openPicker("Anthropic");
    expect(calls.filter((call) => call.path === catalogPath)).toHaveLength(1);

    closePicker();
    expect(within(picker).queryByRole("button", { name: "Opus 5.5", hidden: true })).toBeNull();
    await openPicker("Anthropic");

    expect(calls.filter((call) => call.path === catalogPath)).toHaveLength(2);
  });

  it("says how old the catalog is and Refresh asks the controller to read it again", async () => {
    const { calls } = await openModels();
    const picker = await openPicker("Anthropic");

    expect(within(picker).getByText(/^Updated /)).toBeTruthy();
    await userEvent.click(within(picker).getByRole("button", { name: "Refresh", hidden: true }));

    await waitFor(() => {
      expect(
        calls.filter(
          (call) =>
            call.method === "POST" &&
            call.path === `/api/v1/provider-accounts/${ANTHROPIC_IDENTITY.id}/refresh`,
        ),
      ).toHaveLength(1);
    });
  });

  it("reads the profile again when the controller reports a conflict, and applies the same change to it", async () => {
    const { calls, read } = await openModels({ conflicts: 1 });
    const section = getSection("Anthropic");
    act(() => {
      getRow(section, "Opus 5.5").focus();
    });

    await pressAlt("ArrowDown");

    await waitFor(() => {
      expect(listModels(section)).toEqual(["Sonnet 5.5", "Opus 5.5", "Haiku 5.5", "Sonnet 5.5"]);
    });
    expect(listUpdates(calls).map(({ expectedRevision }) => expectedRevision)).toEqual([4, 5]);
    expect(
      calls.filter((call) => call.method === "GET" && call.path === PROFILE_PATH),
    ).toHaveLength(1);
    expect(read().revision).toBe(6);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says why when the controller refuses a change, and keeps the order it holds", async () => {
    await openModels({ refusal: "The default is not among the entries." });
    const section = getSection("Anthropic");
    act(() => {
      getRow(section, "Opus 5.5").focus();
    });

    await pressAlt("ArrowDown");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "The change was not saved. The default is not among the entries.",
    );
    await waitFor(() => {
      expect(listModels(section)).toEqual(["Opus 5.5", "Sonnet 5.5", "Haiku 5.5", "Sonnet 5.5"]);
    });
  });
});
