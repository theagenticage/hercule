/**
 * Tests the open Model Profile's menu on Settings > Providers > Models beyond
 * its sections: how accounts get into the profile, and the preview of the
 * composer's menu. Accounts get in through the dashed "Add an account to <profile>" row, which lists only the
 * accounts the profile does not hold and joins one with its Default
 * Selection, says when the profile has every account, and opens the
 * add-account sheet; and the empty profile, which teaches in three steps and
 * joins an account from a tile. The preview shows the open profile unfolded,
 * does nothing when a row is picked, and lights the same lane as the section
 * the pointer is on, and the section of the lane the pointer is on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
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
import type { ModelProfile, ModelProfileUpdateInput, ProviderAccount } from "@hercule/contract";
import { forgetLastSettingsSection } from "../../../../app/last-settings-section";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
} from "../../../../app/testing";

vi.mock("../../../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

beforeEach(() => {
  stubElementSize(272, 800);
});
afterEach(forgetLastSettingsSection);

const PROFILE_ID = "01a06d02-8000-7000-8000-000000000b01";
const ANTHROPIC_IDENTITY = { ...CLIENT_ANTHROPIC, id: "01a06d02-8000-7000-8000-000000000a01" };
const OPENAI_IDENTITY = { ...CLIENT_OPENAI, id: "01a06d02-8000-7000-8000-000000000a02" };
const ZAI_IDENTITY = { ...CLIENT_ZAI, id: "01a06d02-8000-7000-8000-000000000a03" };
const IDENTITIES = [ANTHROPIC_IDENTITY, OPENAI_IDENTITY, ZAI_IDENTITY];

const buildAccount = (identity: ProviderAccountIdentity): ProviderAccount => ({
  ...buildProviderAccount(identity),
  modelCount: 2,
  catalogReadAt: "2026-09-10T08:00:00.000Z",
});

/** "Main" holding Anthropic with one model. */
const MAIN: ModelProfile = buildModelProfile(
  [
    buildProfileSection(ANTHROPIC_IDENTITY, [
      buildProfileEntry(ANTHROPIC_IDENTITY, "opus-5-5", { name: "Opus 5.5" }),
    ]),
  ],
  { id: PROFILE_ID, name: "Main", revision: 3 },
);

/** "Main" holding every account. */
const FULL: ModelProfile = buildModelProfile(
  IDENTITIES.map((identity) =>
    buildProfileSection(identity, [buildProfileEntry(identity, "model", { name: "Model" })]),
  ),
  { id: PROFILE_ID, name: "Main", revision: 3 },
);

/** "Main" holding nothing. */
const EMPTY: ModelProfile = buildModelProfile([], { id: PROFILE_ID, name: "Main", revision: 3 });

/**
 * Opens Settings > Providers over the three accounts and the profile
 * `profile`. The controller answers `modelProfile.update` as it does for an
 * account sent without entries: the section comes back filled with the
 * provider's Default Selection, here one model called "Default".
 */
const openModels = async (profile: ModelProfile, others: ModelProfile[] = []) => {
  let stored = profile;
  const calls = stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      accounts: IDENTITIES.map(buildAccount),
      modelProfiles: [profile, ...others],
    }),
    "GET /api/v1/model-profiles": () => ({ body: [stored, ...others] }),
    // The add-account sheet reads which machine runs the controller.
    "GET /api/v1/controller": {
      body: {
        id: "01a06d02-7800-7000-8000-000000000001",
        publicKey: "controller-key",
        version: "0.4.2",
        defaultRunnerId: null,
        localRunnerId: SIDEBAR_FIXTURE.runners[0]!.id,
        textGeneration: { model: null, lastFailure: null, unavailableReason: null },
      },
    },
    [`PATCH /api/v1/model-profiles/${PROFILE_ID}`]: (call) => {
      const input = call.body as ModelProfileUpdateInput;
      stored = {
        ...stored,
        revision: stored.revision + 1,
        accounts: input.accounts.map(
          ({ providerAccountId }) =>
            stored.accounts.find((held) => held.providerAccountId === providerAccountId) ??
            buildProfileSection(
              IDENTITIES.find(({ id }) => id === providerAccountId)!,
              [
                buildProfileEntry(
                  IDENTITIES.find(({ id }) => id === providerAccountId)!,
                  "default",
                  {
                    name: "Default",
                  },
                ),
              ],
            ),
        ),
      };
      return { body: stored };
    },
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path: "/settings/providers" });
  await screen.findByRole("heading", { level: 2, name: "Models" });
  return { calls, ...app };
};

/** Opens the menu of "Add an account to Main". jsdom has no popover API, so the menu is found by the button's `popovertarget`. */
const openAddMenu = async (): Promise<HTMLElement> => {
  const button = screen.getByRole("button", { name: "Add an account to Main" });
  await userEvent.click(button);
  return document.getElementById(button.getAttribute("popovertarget")!)!;
};

const getUpdates = (calls: readonly { method: string; path: string; body: unknown }[]) =>
  calls.filter(
    (call) => call.method === "PATCH" && call.path === `/api/v1/model-profiles/${PROFILE_ID}`,
  );

describe("Settings > Providers > Models, getting accounts into a profile", () => {
  describe("Add an account to <profile>", () => {
    it("lists the accounts the profile does not hold, and joins one with its Default Selection", async () => {
      const { calls } = await openModels(MAIN);
      const menu = await openAddMenu();

      expect(
        within(menu).getByRole("group", { name: "Your accounts not in Main", hidden: true }),
      ).toBeTruthy();
      const items = within(menu).getAllByRole("menuitem", { hidden: true });
      expect(items.map((item) => item.textContent)).toEqual([
        expect.stringContaining("OpenAI"),
        expect.stringContaining("Z.ai"),
        "New account…",
      ]);

      await userEvent.click(items[0]!, { pointerEventsCheck: 0 });

      await waitFor(() => {
        expect(getUpdates(calls)).toHaveLength(1);
      });
      const [update] = getUpdates(calls);
      expect(update!.body).toEqual({
        expectedRevision: 3,
        name: "Main",
        accounts: [
          {
            providerAccountId: ANTHROPIC_IDENTITY.id,
            harnessId: null,
            entries: [
              { providerAccountId: ANTHROPIC_IDENTITY.id, model: "opus-5-5", harnessId: null },
            ],
          },
          // Sent without entries, so the controller fills it with the Default Selection.
          { providerAccountId: OPENAI_IDENTITY.id, harnessId: null },
        ],
        defaultEntry: null,
        dismissedNewModels: [],
      });
      const section = await screen.findByRole("region", { name: "OpenAI" });
      expect(section.classList.contains("is-fresh")).toBe(true);
      expect(within(section).getByText("Default")).toBeTruthy();
    });

    it("says the profile already uses every account you have", async () => {
      await openModels(FULL);
      const menu = await openAddMenu();

      expect(within(menu).getByText("Main already uses every account you have.")).toBeTruthy();
      expect(within(menu).queryByRole("group", { hidden: true })).toBeNull();
      expect(
        within(menu).getByRole("menuitem", { name: "New account…", hidden: true }),
      ).toBeTruthy();
    });

    it("opens the add-account sheet from New account…", async () => {
      await openModels(MAIN);
      const menu = await openAddMenu();

      await userEvent.click(
        within(menu).getByRole("menuitem", { name: "New account…", hidden: true }),
        {
          pointerEventsCheck: 0,
        },
      );

      expect(await screen.findByRole("dialog", { name: "Add an account" })).toBeTruthy();
    });
  });

  describe("an empty profile", () => {
    it("teaches in three steps, with a tile for each account and a faint preview", async () => {
      await openModels(EMPTY);

      expect(
        screen.getByRole("heading", { level: 3, name: "Build Main's model menu" }),
      ).toBeTruthy();
      const steps = screen.getAllByRole("listitem").filter((item) => item.closest("ol"));
      expect(steps.map((step) => step.textContent)).toEqual([
        "1Pick an accountAny of yours. It stays in its other profiles too.",
        "2Pick its modelsThe newest come first; older ones are a search away.",
        "3In the composerOpen Main in the composer's menu.",
      ]);
      expect(screen.getAllByTitle(/^Add .* to Main$/).map((tile) => tile.title)).toEqual([
        "Add Anthropic to Main",
        "Add OpenAI to Main",
        "Add Z.ai to Main",
      ]);
      expect(document.body.textContent).toContain("Your models will appear here, under Main.");
      // The old one-line placeholder is gone, and there is no "Add an account" row yet.
      expect(screen.queryByText(/has no accounts yet/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Add an account to Main" })).toBeNull();
    });

    it("joins an account with its Default Selection from its tile, and then shows its section", async () => {
      const { calls } = await openModels(EMPTY);

      await userEvent.click(screen.getByTitle("Add OpenAI to Main"));

      await waitFor(() => {
        expect(getUpdates(calls)).toHaveLength(1);
      });
      expect(getUpdates(calls)[0]!.body).toMatchObject({
        accounts: [{ providerAccountId: OPENAI_IDENTITY.id, harnessId: null }],
      });
      const section = await screen.findByRole("region", { name: "OpenAI" });
      expect(section.classList.contains("is-fresh")).toBe(true);
      expect(
        screen.queryByRole("heading", { level: 3, name: "Build Main's model menu" }),
      ).toBeNull();
      expect(screen.getByRole("button", { name: "Add an account to Main" })).toBeTruthy();
    });

    it("opens the add-account sheet from 'Or add a new account'", async () => {
      await openModels(EMPTY);

      await userEvent.click(screen.getByRole("button", { name: "Or add a new account" }));

      expect(await screen.findByRole("dialog", { name: "Add an account" })).toBeTruthy();
    });
  });

  describe("the preview of the composer's menu", () => {
    /** "Work": OpenAI with one model, as a second profile. */
    const WORK: ModelProfile = buildModelProfile(
      [
        buildProfileSection(OPENAI_IDENTITY, [
          buildProfileEntry(OPENAI_IDENTITY, "gpt-6", { name: "GPT-6" }),
        ]),
      ],
      {
        id: "01a06d02-8000-7000-8000-000000000b02",
        name: "Work",
        revision: 1,
        createdAt: "2026-09-06T09:00:00.000Z",
      },
    );

    const getPreview = (): HTMLElement => document.querySelector<HTMLElement>(".pm-preview")!;
    const getLane = (name: string): HTMLElement =>
      within(getPreview()).getByText(name, { selector: ".q-h" }).closest<HTMLElement>(".pop-sec")!;

    it("shows the open profile's lanes for every thread when it is the only profile", async () => {
      await openModels(MAIN);

      const preview = getPreview();
      expect(within(preview).getByText("In the composer")).toBeTruthy();
      expect(within(preview).getByText("every thread")).toBeTruthy();
      expect(within(getLane("Anthropic")).getByText("Opus 5.5")).toBeTruthy();
      expect(within(preview).queryByText("One profile open at a time.")).toBeNull();
    });

    it("unfolds the open profile with the others as closed heads", async () => {
      await openModels(MAIN, [WORK]);

      const preview = getPreview();
      expect(within(preview).getByText("a thread using Main")).toBeTruthy();
      expect(within(preview).getByText("One profile open at a time.")).toBeTruthy();
      expect(within(getLane("Anthropic")).getByText("Opus 5.5")).toBeTruthy();
      const work = within(preview).getByRole("button", { name: /Work/ });
      expect(work.getAttribute("aria-expanded")).toBe("false");
      // The other profile's lane is not drawn.
      expect(within(preview).queryByText("GPT-6")).toBeNull();
    });

    it("does nothing when a row or a head is picked", async () => {
      const { calls } = await openModels(MAIN, [WORK]);
      const preview = getPreview();

      await userEvent.click(within(preview).getByText("Opus 5.5"));
      await userEvent.click(within(preview).getByRole("button", { name: /Work/ }));

      // The live connection's ticket is the only write the page makes.
      expect(
        calls.filter((call) => call.method !== "GET" && call.path !== "/api/v1/auth/ws-ticket"),
      ).toEqual([]);
      expect(within(preview).queryByText("GPT-6")).toBeNull();
    });

    it("lights the lane of the section the pointer is on, and the section of the lane", async () => {
      await openModels(FULL);
      const section = screen.getByRole("region", { name: "OpenAI" });

      await userEvent.hover(within(section).getByText("Model"));

      expect(getLane("OpenAI").classList.contains("is-lit")).toBe(true);
      expect(getLane("Anthropic").classList.contains("is-lit")).toBe(false);
      expect(section.hasAttribute("data-lit")).toBe(true);

      await userEvent.unhover(within(section).getByText("Model"));
      expect(getLane("OpenAI").classList.contains("is-lit")).toBe(false);
      expect(section.hasAttribute("data-lit")).toBe(false);

      await userEvent.hover(getLane("Anthropic"));
      expect(screen.getByRole("region", { name: "Anthropic" }).hasAttribute("data-lit")).toBe(true);
      expect(section.hasAttribute("data-lit")).toBe(false);

      await userEvent.unhover(getLane("Anthropic"));
      expect(getLane("Anthropic").classList.contains("is-lit")).toBe(false);
      expect(screen.getByRole("region", { name: "Anthropic" }).hasAttribute("data-lit")).toBe(
        false,
      );
    });
  });
});
