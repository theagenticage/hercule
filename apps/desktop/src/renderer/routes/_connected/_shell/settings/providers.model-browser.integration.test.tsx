/**
 * Tests the model browser of Settings > Providers: "Browse <n> models" in
 * place of "Add a model" for an account with a large Model Catalog, and
 * "Browse all <n>" in the picker of a small one. The browser reads the
 * catalog once when it opens and nothing before, filters it on the page,
 * collects picks in a tray and saves them as one `modelProfile.update`, and
 * ignores a read that answers after it closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ANTHROPIC_IDENTITY as CLIENT_ANTHROPIC,
  OPENAI_IDENTITY as CLIENT_OPENAI,
  buildModelCatalogItem,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
  type ProviderAccountIdentity,
} from "@hercule/client-core/testing";
import type {
  ModelCatalog,
  ModelProfile,
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
  holdAnswer,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  type Answer,
  type Handler,
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
const CATALOG_PATH = (identity: ProviderAccountIdentity): string =>
  `/api/v1/provider-accounts/${identity.id}/catalog`;

const MAKERS = ["Alpha", "Beta", "Gamma"];

/**
 * OpenAI's catalog: 60 models. "GPT-6" is the one the profile holds. Model
 * `n` is by maker `n` mod 3 and takes tools when `n` is even, and the models
 * come out one a day, so "newest first" lists them in the order of `n`.
 */
const buildBigCatalog = (count = 60): ModelCatalog => ({
  providerAccountId: OPENAI_IDENTITY.id,
  readAt: "2026-09-10T08:00:00.000Z",
  error: null,
  models: Array.from({ length: count }, (_, n) =>
    buildModelCatalogItem(n === 0 ? "gpt-6" : `model-${String(n)}`, {
      name: n === 0 ? "GPT-6" : `Model ${String(n)} ${MAKERS[n % 3]!}`,
      maker: n === 0 ? "OpenAI" : MAKERS[n % 3]!,
      contextWindow: 128_000,
      inputPrice: n % 5 === 0 ? 0 : n,
      outputPrice: n % 5 === 0 ? 0 : n * 2,
      tools: n % 2 === 0,
      releasedAt: new Date(Date.UTC(2026, 8, 1) - n * 86_400_000).toISOString(),
    }),
  ),
});

const ANTHROPIC_CATALOG: ModelCatalog = {
  providerAccountId: ANTHROPIC_IDENTITY.id,
  readAt: "2026-09-10T08:00:00.000Z",
  error: null,
  models: ["opus-5-5", "sonnet-5-5", "haiku-5-5", "opus-4-8"].map((slug) =>
    buildModelCatalogItem(slug, { name: slug }),
  ),
};

/** Anthropic with a small catalog (the picker, with "Browse all 4") and OpenAI with 60 models (the browser). */
const buildAccounts = (catalogError: string | null = null): ProviderAccount[] => [
  {
    ...buildProviderAccount(ANTHROPIC_IDENTITY),
    modelCount: 4,
    catalogReadAt: "2026-09-10T08:00:00.000Z",
  },
  {
    ...buildProviderAccount(OPENAI_IDENTITY),
    modelCount: 60,
    catalogReadAt: "2026-09-10T08:00:00.000Z",
    catalogError,
  },
];

const GPT = buildProfileEntry(OPENAI_IDENTITY, "gpt-6", { name: "GPT-6" });
const MAIN: ModelProfile = buildModelProfile(
  [
    buildProfileSection(ANTHROPIC_IDENTITY, [
      buildProfileEntry(ANTHROPIC_IDENTITY, "opus-5-5", { name: "opus-5-5" }),
    ]),
    buildProfileSection(OPENAI_IDENTITY, [GPT]),
  ],
  {
    id: PROFILE_ID,
    revision: 4,
    defaultEntry: { providerAccountId: ANTHROPIC_IDENTITY.id, model: "opus-5-5", harnessId: null },
  },
);

/** Answers an update with the profile it describes, as the controller would. */
const applyUpdate = (input: ModelProfileUpdateInput): ModelProfile => ({
  ...MAIN,
  revision: input.expectedRevision + 1,
  accounts: input.accounts.map((section) => {
    const identity = [ANTHROPIC_IDENTITY, OPENAI_IDENTITY].find(
      ({ id }) => id === section.providerAccountId,
    )!;
    return buildProfileSection(
      identity,
      (section.entries ?? []).map((entry): ResolvedModelProfileEntry =>
        buildProfileEntry(identity, entry.model, { name: entry.model }),
      ),
    );
  }),
});

interface Options {
  readonly catalogError?: string | null;
  /** What the update answers, in place of the profile it describes. */
  readonly updateAnswer?: Handler;
  /** What OpenAI's catalog read answers, in place of the 60-model catalog. */
  readonly catalogAnswer?: Handler;
  readonly refreshedAt?: string;
}

/** Opens Settings > Providers with the two accounts, and returns the calls the page made. */
const openProviders = async (options: Options = {}) => {
  const accounts = buildAccounts(options.catalogError ?? null);
  const refreshed: ProviderAccount = {
    ...accounts[1]!,
    catalogReadAt: options.refreshedAt ?? "2026-09-10T11:00:00.000Z",
  };
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, accounts, modelProfiles: [MAIN] }),
    "GET /api/v1/model-profiles": { body: [MAIN] },
    [`GET ${PROFILE_PATH}`]: { body: MAIN },
    [`PATCH ${PROFILE_PATH}`]:
      options.updateAnswer ??
      ((call) => ({ body: applyUpdate(call.body as ModelProfileUpdateInput) })),
    [`GET ${CATALOG_PATH(OPENAI_IDENTITY)}`]: options.catalogAnswer ?? { body: buildBigCatalog() },
    [`GET ${CATALOG_PATH(ANTHROPIC_IDENTITY)}`]: { body: ANTHROPIC_CATALOG },
    [`POST /api/v1/provider-accounts/${OPENAI_IDENTITY.id}/refresh`]: { body: refreshed },
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  await renderApp(fake, { path: "/settings/providers" });
  await screen.findByRole("heading", { level: 2, name: "Models" });
  return calls;
};

const countReads = (
  calls: readonly { method: string; path: string }[],
  identity = OPENAI_IDENTITY,
): number =>
  calls.filter((call) => call.method === "GET" && call.path === CATALOG_PATH(identity)).length;

const listUpdates = (calls: readonly { method: string; path: string; body: unknown }[]) =>
  calls
    .filter((call) => call.method === "PATCH" && call.path === PROFILE_PATH)
    .map((call) => call.body as ModelProfileUpdateInput);

/** Presses "Browse 60 models" and returns the dialog once its rows are drawn. */
const openBrowser = async (): Promise<HTMLElement> => {
  await userEvent.click(screen.getByRole("button", { name: "Browse 60 models from OpenAI" }));
  const dialog = await screen.findByRole("dialog", { name: "Browse OpenAI models" });
  await within(dialog).findAllByRole("button", { name: /^GPT-6/ });
  return dialog;
};

/** Answers a read that is still pending, and waits long enough for the page to have used the answer. */
const answerLate = (answer: (reply: Answer) => void, reply: Answer): Promise<void> =>
  act(async () => {
    answer(reply);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

/** Returns the names of the models the table lists, in order. */
const listRows = (dialog: HTMLElement): string[] =>
  [...dialog.querySelectorAll(".mb-row b")].map((name) => name.textContent ?? "");

/** Returns the row of the model called `name`. A row's name starts with the model's, and jsdom draws no space after it. */
const getRow = (dialog: HTMLElement, name: string): HTMLElement =>
  within(dialog).getByRole("button", { name: new RegExp(`^${name}`) });

/** Returns the count the table's head shows, such as "60 models". */
const readCount = (dialog: HTMLElement): string => within(dialog).getByRole("status").textContent;

describe("The model browser", () => {
  it("replaces 'Add a model' with 'Browse <n> models' for a large catalog, and reads nothing before it opens", async () => {
    const calls = await openProviders();

    expect(screen.getByRole("button", { name: "Browse 60 models from OpenAI" }).textContent).toBe(
      "Browse 60 models",
    );
    expect(screen.queryByRole("button", { name: "Add a model from OpenAI" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add a model from Anthropic" })).toBeTruthy();
    expect(countReads(calls)).toBe(0);
    expect(screen.queryByRole("dialog", { name: "Browse OpenAI models" })).toBeNull();
  });

  it("reads the catalog once, focuses the search, marks what the profile has, and filters on the page", async () => {
    const calls = await openProviders();
    const dialog = await openBrowser();

    expect(countReads(calls)).toBe(1);
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Search models"));
    expect(readCount(dialog)).toBe("60 models");
    // Newest first. The model the profile has is no toggle: it cannot be picked, and says why.
    expect(listRows(dialog).slice(0, 3)).toEqual(["GPT-6", "Model 1 Beta", "Model 2 Gamma"]);
    const held = getRow(dialog, "GPT-6");
    expect(held.hasAttribute("aria-pressed")).toBe(false);
    expect(held.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(held.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Already in Main",
    );
    expect(getRow(dialog, "Model 1 Beta").getAttribute("aria-pressed")).toBe("false");

    await userEvent.type(within(dialog).getByLabelText("Search models"), "beta");
    expect(readCount(dialog)).toBe("20 models");
    await userEvent.clear(within(dialog).getByLabelText("Search models"));
    expect(readCount(dialog)).toBe("60 models");

    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Use tools" }));
    expect(readCount(dialog)).toBe("30 models");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /^Gamma/ }));
    expect(readCount(dialog)).toBe("10 models");
    await userEvent.click(within(dialog).getByRole("button", { name: "Clear filters" }));
    expect(readCount(dialog)).toBe("60 models");
    expect(within(dialog).queryByRole("button", { name: "Clear filters" })).toBeNull();

    await userEvent.type(within(dialog).getByLabelText("Search models"), "nothing like this");
    expect(within(dialog).getByText("No model matches")).toBeTruthy();
    // Filtering never asks the controller for anything.
    expect(countReads(calls)).toBe(1);
  });

  it("saves the three picks as one update that puts them at the end of the section, and closes", async () => {
    const calls = await openProviders();
    const dialog = await openBrowser();
    const add = within(dialog).getByRole("button", { name: "Add" });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(add);

    await userEvent.click(getRow(dialog, "Model 1 Beta"));
    await userEvent.click(getRow(dialog, "Model 2 Gamma"));
    await userEvent.click(getRow(dialog, "Model 3 Alpha"));
    // A pick can be put back from its row or from the tray.
    await userEvent.click(within(dialog).getByRole("button", { name: "Do not add Model 2 Gamma" }));
    await userEvent.click(getRow(dialog, "Model 2 Gamma"));

    await userEvent.click(within(dialog).getByRole("button", { name: "Add 3 to Main" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Browse OpenAI models" })).toBeNull();
    });
    const updates = listUpdates(calls);
    expect(updates).toHaveLength(1);
    const section = updates[0]!.accounts.find(
      ({ providerAccountId }) => providerAccountId === OPENAI_IDENTITY.id,
    )!;
    expect(section.entries!.map(({ model }) => model)).toEqual([
      "gpt-6",
      "model-1",
      "model-3",
      "model-2",
    ]);
    expect(updates[0]!.expectedRevision).toBe(4);
  });

  it("keeps the picks and shows the controller's message when the save is refused", async () => {
    await openProviders({
      updateAnswer: { status: 400, body: buildErrorBody("validation", "OpenAI cannot run it.") },
    });
    const dialog = await openBrowser();
    await userEvent.click(getRow(dialog, "Model 1 Beta"));

    await userEvent.click(within(dialog).getByRole("button", { name: "Add 1 to Main" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "OpenAI cannot run it.",
    );
    expect(within(dialog).getByRole("button", { name: "Add 1 to Main" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Browse OpenAI models" })).toBe(dialog);
  });

  it("keeps the focus on the Add button and closes nothing while the save runs", async () => {
    const update = holdAnswer();
    await openProviders({ updateAnswer: update.handler });
    const dialog = await openBrowser();
    await userEvent.click(getRow(dialog, "Model 1 Beta"));
    const add = within(dialog).getByRole("button", { name: "Add 1 to Main" });
    add.focus();

    await userEvent.click(add);

    await waitFor(() => {
      expect(add.getAttribute("aria-disabled")).toBe("true");
    });
    expect(document.activeElement).toBe(add);
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Browse OpenAI models" })).toBe(dialog);

    update.answer({ body: { ...MAIN, revision: 5 } });
  });

  it("lets the picks change only when no save runs: a held save saves exactly what was picked at the press", async () => {
    const update = holdAnswer();
    const calls = await openProviders({ updateAnswer: update.handler });
    const dialog = await openBrowser();
    await userEvent.click(getRow(dialog, "Model 1 Beta"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add 1 to Main" }));
    const tray = within(dialog).getByRole("list", { name: "Models to add" });
    await waitFor(() => {
      expect(getRow(dialog, "Model 2 Gamma").getAttribute("aria-disabled")).toBe("true");
    });

    // A new pick and a removal are both ignored, from the row and from the tray.
    await userEvent.click(getRow(dialog, "Model 2 Gamma"));
    await userEvent.click(getRow(dialog, "Model 1 Beta"));
    await userEvent.click(within(tray).getByRole("button", { name: "Do not add Model 1 Beta" }));
    expect(getRow(dialog, "Model 2 Gamma").getAttribute("aria-pressed")).toBe("false");
    expect(getRow(dialog, "Model 1 Beta").getAttribute("aria-pressed")).toBe("true");
    expect(within(tray).getAllByRole("listitem")).toHaveLength(1);

    update.answer({ body: { ...MAIN, revision: 5 } });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Browse OpenAI models" })).toBeNull();
    });
    const updates = listUpdates(calls);
    expect(updates).toHaveLength(1);
    const section = updates[0]!.accounts.find(
      ({ providerAccountId }) => providerAccountId === OPENAI_IDENTITY.id,
    )!;
    expect(section.entries!.map(({ model }) => model)).toEqual(["gpt-6", "model-1"]);
  });

  it("lets the picks change again after the save is refused", async () => {
    const update = holdAnswer();
    await openProviders({ updateAnswer: update.handler });
    const dialog = await openBrowser();
    await userEvent.click(getRow(dialog, "Model 1 Beta"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add 1 to Main" }));
    await waitFor(() => {
      expect(getRow(dialog, "Model 2 Gamma").getAttribute("aria-disabled")).toBe("true");
    });

    update.answer({ status: 400, body: buildErrorBody("validation", "OpenAI cannot run it.") });
    await within(dialog).findByRole("alert");
    await userEvent.click(getRow(dialog, "Model 2 Gamma"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Do not add Model 1 Beta" }));

    expect(getRow(dialog, "Model 2 Gamma").getAttribute("aria-pressed")).toBe("true");
    expect(getRow(dialog, "Model 1 Beta").getAttribute("aria-pressed")).toBe("false");
    expect(within(dialog).getByRole("button", { name: "Add 1 to Main" })).toBeTruthy();
  });

  it("moves the focus to the next chip when a chip is taken out, else the previous one, else Add", async () => {
    await openProviders();
    const dialog = await openBrowser();
    for (const name of ["Model 1 Beta", "Model 2 Gamma", "Model 3 Alpha"]) {
      await userEvent.click(getRow(dialog, name));
    }
    const tray = within(dialog).getByRole("list", { name: "Models to add" });
    const takeOut = (name: string): HTMLElement =>
      within(tray).getByRole("button", { name: `Do not add ${name}` });

    await userEvent.click(takeOut("Model 2 Gamma"));
    expect(document.activeElement).toBe(takeOut("Model 3 Alpha"));
    await userEvent.click(takeOut("Model 3 Alpha"));
    expect(document.activeElement).toBe(takeOut("Model 1 Beta"));
    await userEvent.click(takeOut("Model 1 Beta"));
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Add" }));
  });

  it("moves the focus to the search field when Clear filters goes away", async () => {
    await openProviders();
    const dialog = await openBrowser();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Use tools" }));

    await userEvent.click(within(dialog).getByRole("button", { name: "Clear filters" }));

    expect(within(dialog).queryByRole("button", { name: "Clear filters" })).toBeNull();
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Search models"));
  });

  it("drops the catalog on close and reads it again on reopening, and a read that answers after the close changes nothing", async () => {
    // Every read waits for the test to answer it.
    const pending: ((answer: Answer) => void)[] = [];
    const calls = await openProviders({
      catalogAnswer: () => new Promise<Answer>((resolve) => pending.push(resolve)),
    });
    await userEvent.click(screen.getByRole("button", { name: "Browse 60 models from OpenAI" }));
    const first = await screen.findByRole("dialog", { name: "Browse OpenAI models" });
    expect(within(first).getByText("Reading models…")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Browse OpenAI models" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Browse 60 models from OpenAI" }));
    const second = await screen.findByRole("dialog", { name: "Browse OpenAI models" });
    await waitFor(() => {
      expect(pending).toHaveLength(2);
    });
    expect(countReads(calls)).toBe(2);
    // The second read answers first, then the first one answers with another catalog.
    act(() => {
      pending[1]!({ body: buildBigCatalog() });
    });
    await within(second).findAllByRole("button", { name: /^GPT-6/ });
    await answerLate(pending[0]!, { body: buildBigCatalog(1) });

    expect(readCount(second)).toBe("60 models");
    expect(countReads(calls)).toBe(2);
  });

  it("ignores a read that answers after a newer read has", async () => {
    const pending: ((answer: Answer) => void)[] = [];
    const calls = await openProviders({
      catalogAnswer: () => new Promise<Answer>((resolve) => pending.push(resolve)),
    });
    await userEvent.click(screen.getByRole("button", { name: "Browse 60 models from OpenAI" }));
    const dialog = await screen.findByRole("dialog", { name: "Browse OpenAI models" });
    await waitFor(() => {
      expect(pending).toHaveLength(1);
    });
    // Refresh changes the account's `catalogReadAt`, which starts the second read while the first is pending.
    await userEvent.click(within(dialog).getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(pending).toHaveLength(2);
    });

    act(() => {
      pending[1]!({ body: buildBigCatalog() });
    });
    await within(dialog).findAllByRole("button", { name: /^GPT-6/ });
    await answerLate(pending[0]!, { body: buildBigCatalog(1) });

    expect(readCount(dialog)).toBe("60 models");
    expect(countReads(calls)).toBe(2);
  });

  it("shows the reason the last read failed, and Refresh reads the catalog again when its time changes", async () => {
    const calls = await openProviders({
      catalogError: "OpenAI lists 1,100 models; Hercule keeps the first 1,024.",
    });
    const dialog = await openBrowser();
    expect(within(dialog).getByText(/^Updated /)).toBeTruthy();
    expect(within(dialog).getByText(/OpenAI lists 1,100 models/)).toBeTruthy();

    await userEvent.click(within(dialog).getByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      expect(countReads(calls)).toBe(2);
    });
    expect(
      calls.filter(
        (call) =>
          call.method === "POST" &&
          call.path === `/api/v1/provider-accounts/${OPENAI_IDENTITY.id}/refresh`,
      ),
    ).toHaveLength(1);
  });

  it("says why when the first read fails", async () => {
    await openProviders({
      catalogAnswer: {
        status: 500,
        body: buildErrorBody("internal", "The controller could not read the catalog."),
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Browse 60 models from OpenAI" }));
    const dialog = await screen.findByRole("dialog", { name: "Browse OpenAI models" });

    expect(await within(dialog).findByText(/could not read the catalog/)).toBeTruthy();
  });

  it("opens from 'Browse all <n>' in the picker of a small catalog", async () => {
    await openProviders();
    const button = screen.getByRole("button", { name: "Add a model from Anthropic" });
    await userEvent.click(button);
    const popover = document.getElementById(button.getAttribute("popovertarget")!)!;
    // jsdom has no popover API, so the browser's `toggle` event is played by hand.
    const toggle = new Event("toggle");
    Object.assign(toggle, { newState: "open" });
    act(() => {
      popover.dispatchEvent(toggle);
    });

    await userEvent.click(
      within(popover).getByRole("button", { name: "Browse all 4", hidden: true }),
    );

    const dialog = await screen.findByRole("dialog", { name: "Browse Anthropic models" });
    expect(await within(dialog).findByRole("button", { name: /^opus-4-8/ })).toBeTruthy();

    // The button that opened it is in a closed popover, so the focus goes to "Add a model".
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Browse Anthropic models" })).toBeNull();
    });
    expect(document.activeElement).toBe(button);
  });
});
