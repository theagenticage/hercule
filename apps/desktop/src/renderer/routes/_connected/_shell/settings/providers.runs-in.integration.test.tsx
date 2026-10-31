/**
 * Tests the "Runs in" part of a model row's ⋯ menu in Settings > Providers >
 * Models: one radio per harness the account can run the model in, the
 * section's harness first as "like the account"; a harness that cannot be
 * picked, with its reason; "Also offer in <harness>"; and an account that can
 * run in one harness only, whose rows have none of it. Each choice is saved as
 * one `modelProfile.update`, and the tests read the request bodies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  HARNESSES,
  OPENAI_IDENTITY as CLIENT_OPENAI,
  PROVIDERS,
  WITH_CLAUDE,
  buildErrorBody,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
  buildSnapshot,
  type ProviderAccountIdentity,
} from "@hercule/client-core/testing";
import type {
  ModelProfile,
  ModelProfileEntry,
  ModelProfileUpdateInput,
  ResolvedModelProfileEntry,
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

const CLAUDE = "claude-code/claude-code";
const PI = "pi/pi";
const PROFILE_ID = "01a06d02-8000-7000-8000-000000000b01";
const PROFILE_PATH = `/api/v1/model-profiles/${PROFILE_ID}`;

/** An Anthropic API key, which can run in Claude Code and in pi. */
const KEY_IDENTITY: ProviderAccountIdentity = {
  id: "01a06d02-8000-7000-8000-000000000a01",
  providerId: "anthropic/anthropic",
  kind: "api-key",
  harnessId: CLAUDE,
  label: null,
};
/** An OpenAI subscription, which runs in Codex only. */
const OPENAI_IDENTITY = { ...CLIENT_OPENAI, id: "01a06d02-8000-7000-8000-000000000a02" };
const IDENTITIES = [KEY_IDENTITY, OPENAI_IDENTITY];

const KEY_PROVIDERS = PROVIDERS.map((provider) =>
  provider.id === KEY_IDENTITY.providerId
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
          providerId: KEY_IDENTITY.providerId,
          kinds: [{ kind: "api-key", modelArgument: "anthropic/{model}" }],
          models: "own-list" as const,
        },
      ],
    };
  }
  return harness;
});
/** A machine with Claude Code and pi installed. */
const MACHINE = {
  ...WITH_CLAUDE,
  facts: {
    ...WITH_CLAUDE.facts!,
    harnesses: WITH_CLAUDE.facts!.harnesses.map((binary) =>
      binary.name === "pi" ? { ...binary, present: true } : binary,
    ),
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

/** "Main": the key's section with Opus (the default) and Sonnet, and OpenAI's with GPT-6. */
const MAIN: ModelProfile = buildModelProfile(
  [buildProfileSection(KEY_IDENTITY, [OPUS, SONNET]), buildProfileSection(OPENAI_IDENTITY, [GPT])],
  {
    id: PROFILE_ID,
    revision: 4,
    name: "Main",
    defaultEntry: { providerAccountId: KEY_IDENTITY.id, model: "opus-5-5", harnessId: null },
  },
);

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

/** Opens Settings > Providers over `profile`, with the key that runs in two harnesses and an OpenAI account. */
const openModels = async (profile: ModelProfile = MAIN) => {
  const calls = stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      runners: [MACHINE],
      accounts: [
        { ...buildProviderAccount(KEY_IDENTITY, [PI_MODELS]), modelCount: 2 },
        { ...buildProviderAccount(OPENAI_IDENTITY), modelCount: 1 },
      ],
      modelProfiles: [profile],
    }),
    "GET /api/v1/providers": { body: KEY_PROVIDERS },
    "GET /api/v1/harnesses": { body: KEY_HARNESSES },
    ...playProfile(profile),
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  await renderApp(fake, { path: "/settings/providers" });
  await screen.findByRole("heading", { level: 2, name: "Models" });
  return calls;
};

/** Returns the row of the model called `name` in the section of the account called `account`; `nth` picks among rows of one name. */
const getRow = (account: string, name: string, nth = 0): HTMLElement =>
  within(screen.getByRole("region", { name: account }))
    .getAllByText(name, { selector: "b" })
    [nth]!.closest<HTMLElement>("li")!;

/**
 * Presses the ⋯ button of the row and returns its menu. jsdom has no popover
 * API, so the menu is found by the button's `popovertarget` and counts as
 * hidden.
 */
const openRowMenu = async (row: HTMLElement): Promise<HTMLElement> => {
  const button = within(row).getByRole("button", { name: /^More for/ });
  await userEvent.click(button);
  return document.getElementById(button.getAttribute("popovertarget")!)!;
};

/** Presses a menu item, which jsdom counts as hidden. */
const choose = (item: HTMLElement): Promise<void> =>
  userEvent.click(item, { pointerEventsCheck: 0 });

/** Returns the radios of the menu's "Runs in" group. */
const listRadios = (menu: HTMLElement): HTMLElement[] =>
  within(menu).queryAllByRole("menuitemradio", { hidden: true });

/** Returns the updates the page sent, oldest first. */
const listUpdates = (calls: readonly { method: string; path: string; body: unknown }[]) =>
  calls
    .filter((call) => call.method === "PATCH" && call.path === PROFILE_PATH)
    .map((call) => call.body as ModelProfileUpdateInput);

/** Lists the entries of the key's section in an update, as "model" or "model@harness". */
const listKeyEntries = (update: ModelProfileUpdateInput): string[] =>
  update.accounts
    .find((section) => section.providerAccountId === KEY_IDENTITY.id)!
    .entries!.map(({ model, harnessId }) => (harnessId === null ? model : `${model}@${harnessId}`));

describe("Settings > Providers > Models > a row's Runs in", () => {
  it("lists the section's harness first as 'like the account', checked, then the others", async () => {
    await openModels();

    const menu = await openRowMenu(getRow("Anthropic", "Opus 5.5"));

    expect(within(menu).getByText("Runs in")).toBeTruthy();
    const radios = listRadios(menu);
    expect(radios.map((radio) => radio.textContent)).toEqual([
      "Claude Code like the account",
      "pi",
    ]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("moves an entry to pi in one update, with the default entry following it, and back with null", async () => {
    const calls = await openModels();

    let menu = await openRowMenu(getRow("Anthropic", "Opus 5.5"));
    await choose(within(menu).getByRole("menuitemradio", { name: "pi", hidden: true }));

    await waitFor(() => {
      expect(listUpdates(calls)).toHaveLength(1);
    });
    const [toPi] = listUpdates(calls);
    expect(toPi!.expectedRevision).toBe(4);
    expect(listKeyEntries(toPi!)).toEqual(["opus-5-5@pi/pi", "sonnet-5-5"]);
    expect(toPi!.defaultEntry).toEqual({
      providerAccountId: KEY_IDENTITY.id,
      model: "opus-5-5",
      harnessId: PI,
    });
    await waitFor(() => {
      expect(getRow("Anthropic", "Opus 5.5").querySelector(".pm-inharness")).not.toBeNull();
    });

    menu = await openRowMenu(getRow("Anthropic", "Opus 5.5"));
    expect(listRadios(menu).map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
    ]);
    await choose(within(menu).getByRole("menuitemradio", { name: /^Claude Code/, hidden: true }));

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
    await choose(within(menu).getByRole("menuitemradio", { name: /^Claude Code/, hidden: true }));

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
      expect(getRow("Anthropic", "Opus 5.5", 1).querySelector(".pm-inharness")).not.toBeNull();
    });
    // Both entries now hold the model, so neither offers it again, and each strikes the other's harness.
    const secondMenu = await openRowMenu(getRow("Anthropic", "Opus 5.5", 1));
    expect(
      within(secondMenu).queryByRole("menuitem", { name: /^Also offer in/, hidden: true }),
    ).toBeNull();
    expect(within(secondMenu).getByText("Already in the menu in Claude Code")).toBeTruthy();
  });

  it("shows a harness that does not know the model struck, with its reason, and cannot be picked", async () => {
    const calls = await openModels();

    const menu = await openRowMenu(getRow("Anthropic", "Sonnet 5.5"));

    const [, pi] = listRadios(menu);
    expect(pi!.getAttribute("aria-disabled")).toBe("true");
    expect(within(pi!).getByText("pi doesn't know this model")).toBeTruthy();
    expect(
      within(menu).queryByRole("menuitem", { name: /^Also offer in/, hidden: true }),
    ).toBeNull();

    await choose(pi!);

    expect(listUpdates(calls)).toEqual([]);
  });

  it("has no Runs in for an account that runs in one harness only", async () => {
    await openModels();

    const menu = await openRowMenu(getRow("OpenAI", "GPT-6"));

    expect(within(menu).queryByText("Runs in")).toBeNull();
    expect(listRadios(menu)).toEqual([]);
    expect(
      within(menu).queryByRole("menuitem", { name: /^Also offer in/, hidden: true }),
    ).toBeNull();
    expect(
      within(menu).getByRole("menuitem", { name: "Take out of the menu", hidden: true }),
    ).toBeTruthy();
  });
});
