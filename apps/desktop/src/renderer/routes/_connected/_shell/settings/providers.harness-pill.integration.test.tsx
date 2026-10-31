/**
 * Tests the harness pill in the head of an account's section on Settings >
 * Providers > Models: what it reads while the section follows the account and
 * while the profile names a harness, the popover with its options (a struck
 * one shows its reason), the one `modelProfile.update` that picking an option
 * sends, "Change it" opening the account's sheet, and a fixed pill that still
 * opens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ANTHROPIC_IDENTITY as CLIENT_ANTHROPIC,
  OPENAI_IDENTITY as CLIENT_OPENAI,
  ZAI_IDENTITY as CLIENT_ZAI,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
  HARNESSES,
  PROVIDERS,
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
const PROFILE_PATH = `/api/v1/model-profiles/${PROFILE_ID}`;
const ANTHROPIC_IDENTITY = { ...CLIENT_ANTHROPIC, id: "01a06d02-8000-7000-8000-000000000a01" };
const OPENAI_IDENTITY = { ...CLIENT_OPENAI, id: "01a06d02-8000-7000-8000-000000000a02" };
const ZAI_IDENTITY = { ...CLIENT_ZAI, id: "01a06d02-8000-7000-8000-000000000a03" };
const IDENTITIES = [ANTHROPIC_IDENTITY, OPENAI_IDENTITY, ZAI_IDENTITY];

const buildAccount = (identity: ProviderAccountIdentity): ProviderAccount => ({
  ...buildProviderAccount(identity),
  modelCount: 2,
  catalogReadAt: "2026-09-10T08:00:00.000Z",
});

/** The shipped providers and harnesses, except that OpenAI's subscription may also run in pi, so OpenAI has a second harness to pick. */
const OPENAI_IN_PI_PROVIDERS = PROVIDERS.map((provider) =>
  provider.id === "openai/openai"
    ? {
        ...provider,
        kinds: provider.kinds.map((kind) => ({ ...kind, harnesses: ["codex/codex", "pi/pi"] })),
      }
    : provider,
);
const OPENAI_IN_PI_HARNESSES = HARNESSES.map((harness) =>
  harness.id === "pi/pi"
    ? {
        ...harness,
        runs: [
          ...harness.runs,
          {
            providerId: "openai/openai",
            kinds: [{ kind: "subscription-per-machine", modelArgument: "openai/{model}" }],
            models: "own-list" as const,
          },
        ],
      }
    : harness,
);

/** The fixture's machines, with pi installed on each, so no harness is struck through for being on no machine. */
const RUNNERS_WITH_PI = SIDEBAR_FIXTURE.runners.map((runner) => ({
  ...runner,
  facts: {
    ...runner.facts!,
    harnesses: [
      ...runner.facts!.harnesses.filter(({ name }) => name !== "pi"),
      { name: "pi", present: true, path: "/usr/local/bin/pi" },
    ],
  },
}));

/**
 * "Main": Anthropic follows its account (Claude Code, the only harness its
 * subscription allows); OpenAI's models run in pi when `openAiHarnessId` names
 * it, else in the account's Codex; Z.ai runs only in pi, so nothing else can
 * be picked there.
 */
const buildMain = (openAiHarnessId: "pi/pi" | null): ModelProfile =>
  buildModelProfile(
    [
      buildProfileSection(ANTHROPIC_IDENTITY, [
        buildProfileEntry(ANTHROPIC_IDENTITY, "opus-5-5", { name: "Opus 5.5" }),
      ]),
      buildProfileSection(
        OPENAI_IDENTITY,
        [buildProfileEntry(OPENAI_IDENTITY, "gpt-6", { name: "GPT-6" })],
        openAiHarnessId === null
          ? {}
          : { harnessId: openAiHarnessId, resolvedHarnessId: openAiHarnessId },
      ),
      buildProfileSection(ZAI_IDENTITY, [
        buildProfileEntry(ZAI_IDENTITY, "glm-5", { name: "GLM-5" }),
      ]),
    ],
    { id: PROFILE_ID, name: "Main", revision: 4 },
  );

/** Opens Settings > Providers over the profile `main`, whose updates the controller accepts as they come. */
const openModels = async (
  main: ModelProfile = buildMain("pi/pi"),
  runners: typeof RUNNERS_WITH_PI = RUNNERS_WITH_PI,
) => {
  const calls = stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      accounts: IDENTITIES.map(buildAccount),
      runners,
      modelProfiles: [main],
    }),
    "GET /api/v1/providers": { body: OPENAI_IN_PI_PROVIDERS },
    "GET /api/v1/harnesses": { body: OPENAI_IN_PI_HARNESSES },
    [`PATCH ${PROFILE_PATH}`]: { body: { ...main, revision: main.revision + 1 } },
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
 * Presses the pill and returns its popover. jsdom has no popover API, so the
 * popover is found by the pill's `popovertarget` and its items count as hidden.
 */
const openPopover = async (account: string): Promise<HTMLElement> => {
  const pill = getPill(account);
  await userEvent.click(pill);
  return document.getElementById(pill.getAttribute("popovertarget")!)!;
};

/** Returns the option of the popover called `name`. */
const getOption = (popover: HTMLElement, name: string | RegExp): HTMLElement =>
  within(popover).getByRole("menuitemradio", { name, hidden: true });

/** Presses an item of a popover, which jsdom counts as hidden. */
const choose = (item: HTMLElement): Promise<void> =>
  userEvent.click(item, { pointerEventsCheck: 0 });

/** Returns the updates the page sent, oldest first. */
const listUpdates = (calls: readonly { method: string; path: string; body: unknown }[]) =>
  calls
    .filter((call) => call.method === "PATCH" && call.path === PROFILE_PATH)
    .map((call) => call.body as ModelProfileUpdateInput);

/** Returns the harness each section of an update names, by account id. */
const listSectionHarnesses = (update: ModelProfileUpdateInput): Record<string, string | null> =>
  Object.fromEntries(
    update.accounts.map(({ providerAccountId, harnessId }) => [providerAccountId, harnessId]),
  );

describe("Settings > Providers > Models > the harness pill", () => {
  it("reads 'Same as the account' while the section follows the account, and the harness's name once the profile names one", async () => {
    await openModels();

    const anthropic = screen.getByRole("region", { name: "Anthropic" });
    const openAi = screen.getByRole("region", { name: "OpenAI" });
    expect(
      within(anthropic).getByRole("button", { name: "Same as the account · Claude Code" }),
    ).toBeTruthy();
    expect(within(openAi).getByRole("button", { name: "pi" })).toBeTruthy();
    expect(getPill("Anthropic").classList.contains("is-set")).toBe(false);
    expect(getPill("OpenAI").classList.contains("is-set")).toBe(true);
  });

  it("lists the harnesses the account can run in, and shows why a struck one cannot be picked", async () => {
    await openModels();

    const popover = await openPopover("Anthropic");

    expect(within(popover).getByText("Anthropic's models in Main run in")).toBeTruthy();
    expect(
      getOption(popover, /^Same as the account · Claude Code/).getAttribute("aria-checked"),
    ).toBe("true");
    expect(getOption(popover, /^Claude Code/).getAttribute("aria-checked")).toBe("false");
    expect(within(popover).getByText("The account's default harness.")).toBeTruthy();
    // Anthropic's subscription runs only in Claude Code: the others are struck through, with the reason.
    const codex = getOption(popover, /^Codex/);
    expect(codex.getAttribute("aria-disabled")).toBe("true");
    expect(codex.textContent).toContain(
      "Anthropic allows a Claude subscription only in Claude Code",
    );
  });

  it("shows the account's default harness line and the machines it is not on, both under 'Same as the account'", async () => {
    const [moss] = RUNNERS_WITH_PI;
    const withCodex = (present: boolean) => [
      ...moss!.facts.harnesses.filter(({ name }) => name !== "codex"),
      { name: "codex", present },
    ];
    await openModels(buildMain(null), [
      { ...moss!, name: "moss", facts: { ...moss!.facts, harnesses: withCodex(true) } },
      {
        ...moss!,
        id: "01a06d02-8000-7000-8000-000000000c02",
        name: "beelink",
        facts: { ...moss!.facts, harnesses: withCodex(false) },
      },
    ]);

    const popover = await openPopover("OpenAI");

    const follow = getOption(popover, /^Same as the account · Codex/);
    expect(follow.textContent).toContain("The account's default harness.");
    expect(follow.textContent).toContain("Not on beelink");
  });

  it("sends one update that names pi for the section when pi is picked", async () => {
    const calls = await openModels(buildMain(null));

    const popover = await openPopover("OpenAI");
    await choose(getOption(popover, /^pi/));

    const updates = listUpdates(calls);
    expect(updates).toHaveLength(1);
    expect(listSectionHarnesses(updates[0]!)).toEqual({
      [ANTHROPIC_IDENTITY.id]: null,
      [OPENAI_IDENTITY.id]: "pi/pi",
      [ZAI_IDENTITY.id]: null,
    });
  });

  it("sends null for the section when 'Same as the account' is picked", async () => {
    const calls = await openModels();

    const popover = await openPopover("OpenAI");
    await choose(getOption(popover, /^Same as the account/));

    const updates = listUpdates(calls);
    expect(updates).toHaveLength(1);
    expect(listSectionHarnesses(updates[0]!)[OPENAI_IDENTITY.id]).toBeNull();
  });

  it("sends nothing when the option that is already chosen is picked", async () => {
    const calls = await openModels();

    const popover = await openPopover("OpenAI");
    await choose(getOption(popover, /^pi/));

    expect(listUpdates(calls)).toEqual([]);
  });

  it("opens the account's sheet from 'Change it'", async () => {
    await openModels();

    const popover = await openPopover("Anthropic");
    await choose(within(popover).getByRole("menuitem", { name: "Change it", hidden: true }));

    expect(await screen.findByRole("dialog", { name: "Anthropic" })).toBeTruthy();
  });

  it("opens the popover of a pill that is fixed, because nothing else can be picked", async () => {
    await openModels();

    expect(getPill("Z.ai").classList.contains("is-fixed")).toBe(true);
    const popover = await openPopover("Z.ai");

    expect(within(popover).getByText("Z.ai's models in Main run in")).toBeTruthy();
    expect(getOption(popover, /^Same as the account · pi/).getAttribute("aria-checked")).toBe(
      "true",
    );
  });
});
