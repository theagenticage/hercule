/**
 * Tests the "New" rows of Settings > Providers > Models: the models the
 * controller announces for an account's section. Each row sits at the top of
 * its section, above the entries, with the model's name and when it arrived.
 * "Add" and "Not now" are each one `modelProfile.update`, the row goes once
 * the profile answers, and the focus moves on. A refusal shows above the
 * sections and leaves the row where it is.
 *
 * The tests read the request bodies. The controller's side is played: after
 * an update it announces again every model that the section does not hold and
 * the profile has not dismissed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ANTHROPIC_IDENTITY as CLIENT_ANTHROPIC,
  OPENAI_IDENTITY as CLIENT_OPENAI,
  buildErrorBody,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
  type ProviderAccountIdentity,
} from "@hercule/client-core/testing";
import type {
  ModelProfile,
  ModelProfileUpdateInput,
  NewModel,
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
  // The dates of the rows say "arrived 26 Oct" in the year of "now", and with
  // the year in any other.
  vi.setSystemTime(new Date("2026-10-31T12:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  forgetLastSettingsSection();
});

const PROFILE_ID = "01a06d02-8000-7000-8000-000000000b01";
const PROFILE_PATH = `/api/v1/model-profiles/${PROFILE_ID}`;
const ANTHROPIC_IDENTITY = { ...CLIENT_ANTHROPIC, id: "01a06d02-8000-7000-8000-000000000a01" };
const OPENAI_IDENTITY = { ...CLIENT_OPENAI, id: "01a06d02-8000-7000-8000-000000000a02" };
const IDENTITIES = [ANTHROPIC_IDENTITY, OPENAI_IDENTITY];

const OPUS_56: NewModel = {
  model: "opus-5-6",
  name: "Opus 5.6",
  firstSeenAt: "2026-10-26T12:00:00.000Z",
};
const HAIKU_56: NewModel = {
  model: "haiku-5-6",
  name: "Haiku 5.6",
  firstSeenAt: "2025-12-02T12:00:00.000Z",
};
const OPUS_55 = buildProfileEntry(ANTHROPIC_IDENTITY, "opus-5-5", { name: "Opus 5.5" });
const SONNET_55 = buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet-5-5", { name: "Sonnet 5.5" });
const GPT = buildProfileEntry(OPENAI_IDENTITY, "gpt-6", { name: "GPT-6" });

/** "Main": Anthropic's section holds two models and is offered two more as new; OpenAI's holds one and is offered none. */
const MAIN: ModelProfile = buildModelProfile(
  [
    buildProfileSection(ANTHROPIC_IDENTITY, [OPUS_55, SONNET_55], {
      newModels: [OPUS_56, HAIKU_56],
    }),
    buildProfileSection(OPENAI_IDENTITY, [GPT]),
  ],
  { id: PROFILE_ID, revision: 4, name: "Main" },
);

const buildAccount = (identity: ProviderAccountIdentity) => ({
  ...buildProviderAccount(identity),
  modelCount: 2,
  catalogReadAt: "2026-09-10T08:00:00.000Z",
});

/**
 * Plays the controller's `modelProfile.update` over `initial`, whose "New"
 * models are the ones it announces for as long as the section lacks them and
 * the profile has not dismissed them. `refusal`
 * refuses every update with that message. With `hold`, each update waits
 * until the test calls `release`, which answers the oldest one waiting, so the
 * screen can be looked at while updates are saved.
 */
const playProfile = (
  initial: ModelProfile,
  { refusal, hold = false }: { refusal?: string; hold?: boolean } = {},
) => {
  let stored = initial;
  const waiting: Array<() => void> = [];
  const release = async (): Promise<void> => {
    await waitFor(() => {
      expect(waiting).not.toHaveLength(0);
    });
    waiting.shift()!();
  };
  const announced = new Map(
    initial.accounts.map((section) => [section.providerAccountId, section.newModels] as const),
  );
  const names = new Map(
    [...announced.values()].flat().map(({ model, name }) => [model, name] as const),
  );
  const handlers: Record<string, Handler> = {
    "GET /api/v1/model-profiles": () => ({ body: [stored] }),
    [`GET ${PROFILE_PATH}`]: () => ({ body: stored }),
    [`PATCH ${PROFILE_PATH}`]: async (call) => {
      const input = call.body as ModelProfileUpdateInput;
      if (hold) {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
        });
      }
      if (refusal !== undefined) {
        return { status: 400, body: buildErrorBody("validation", refusal) };
      }
      const known = stored.accounts.flatMap(({ entries }) => entries);
      stored = {
        ...stored,
        revision: stored.revision + 1,
        defaultEntry: input.defaultEntry,
        dismissedNewModels: input.dismissedNewModels,
        accounts: input.accounts.map((section) => {
          const identity = IDENTITIES.find(({ id }) => id === section.providerAccountId)!;
          const entries = (section.entries ?? []).map(
            (entry): ResolvedModelProfileEntry =>
              known.find(
                (each) =>
                  each.providerAccountId === entry.providerAccountId && each.model === entry.model,
              ) ??
              buildProfileEntry(identity, entry.model, {
                name: names.get(entry.model) ?? entry.model,
              }),
          );
          return buildProfileSection(identity, entries, {
            newModels: (announced.get(identity.id) ?? []).filter(
              ({ model }) =>
                !entries.some((entry) => entry.model === model) &&
                !input.dismissedNewModels.some(
                  (each) => each.providerAccountId === identity.id && each.model === model,
                ),
            ),
          });
        }),
      };
      return { body: stored };
    },
  };
  return { handlers, release };
};

/** Opens Settings > Providers over `profile`. */
const openModels = async (
  options: { refusal?: string; hold?: boolean; profile?: ModelProfile } = {},
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
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  await renderApp(fake, { path: "/settings/providers" });
  await screen.findByRole("heading", { level: 2, name: "Models" });
  return { calls, release: controller.release };
};

/** Returns the section of the account called `name`. */
const getSection = (name: string): HTMLElement => screen.getByRole("region", { name });

/** Returns the "New" row of the model called `name` in the section of `account`. */
const getNewRow = (account: string, name: string): HTMLElement =>
  within(getSection(account)).getByRole("group", { name: `New: ${name}` });

/** Returns the "New" rows of a section, top to bottom. */
const findNewRows = (account: string): HTMLElement[] =>
  within(getSection(account)).queryAllByRole("group", { name: /^New: / });

/** Lists the names of the "New" rows of a section, such as "Opus 5.6". */
const listNewRows = (account: string): string[] =>
  findNewRows(account).map((row) => row.getAttribute("aria-label")!.replace("New: ", ""));

/** Lists the model names in the entries of a section, in order. */
const listEntries = (account: string): string[] =>
  within(getSection(account))
    .getAllByRole("listitem")
    .map((row) => row.querySelector("b")!.textContent);

/** Returns the updates the page sent, oldest first. */
const listUpdates = (calls: readonly { method: string; path: string; body: unknown }[]) =>
  calls
    .filter((call) => call.method === "PATCH" && call.path === PROFILE_PATH)
    .map((call) => call.body as ModelProfileUpdateInput);

/** Lists the entries of Anthropic's section in an update, as "model" or "model@harness". */
const listAnthropicEntries = (update: ModelProfileUpdateInput): string[] =>
  update.accounts
    .find((section) => section.providerAccountId === ANTHROPIC_IDENTITY.id)!
    .entries!.map(({ model, harnessId }) => (harnessId === null ? model : `${model}@${harnessId}`));

describe("Settings > Providers > Models > a section's New rows", () => {
  it("draws a row for each announced model above the entries, with its name and when it arrived", async () => {
    await openModels();

    const section = getSection("Anthropic");
    const rows = findNewRows("Anthropic");
    expect(rows.map((row) => row.textContent)).toEqual([
      "NewOpus 5.6arrived 26 OctAddNot now",
      "NewHaiku 5.6arrived 2 Dec 2025AddNot now",
    ]);
    // Under the head, and before the first entry.
    const head = section.querySelector(".pm-head")!;
    const firstEntry = within(section).getAllByRole("listitem")[0]!;
    expect(head.compareDocumentPosition(rows[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      rows[1]!.compareDocumentPosition(firstEntry) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // They are not entries: no draggable item, and the entries stay as they were.
    expect(rows.some((row) => row.closest("li") !== null || row.draggable)).toBe(false);
    expect(listEntries("Anthropic")).toEqual(["Opus 5.5", "Sonnet 5.5"]);
    expect(
      within(getNewRow("Anthropic", "Opus 5.6")).getByRole("button", { name: "Add Opus 5.6" }),
    ).toBeTruthy();
    expect(
      within(getNewRow("Anthropic", "Opus 5.6")).getByRole("button", {
        name: "Not now: Opus 5.6",
      }),
    ).toBeTruthy();
  });

  it("draws nothing extra in a section that has no new model", async () => {
    await openModels();

    expect(listNewRows("OpenAI")).toEqual([]);
    expect(listEntries("OpenAI")).toEqual(["GPT-6"]);
  });

  it("gives buttons to the section's rows only, not to the composer's preview beside them", async () => {
    await openModels();

    expect(screen.getAllByRole("button", { name: "Add Opus 5.6" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Not now: Opus 5.6" })).toHaveLength(1);
  });

  it("sends one update that adds the model at the end of the section, and the row goes with the focus on the new entry", async () => {
    const { calls } = await openModels();

    await userEvent.click(screen.getByRole("button", { name: "Add Opus 5.6" }));

    await waitFor(() => {
      expect(listNewRows("Anthropic")).toEqual(["Haiku 5.6"]);
    });
    const updates = listUpdates(calls);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.expectedRevision).toBe(4);
    expect(listAnthropicEntries(updates[0]!)).toEqual(["opus-5-5", "sonnet-5-5", "opus-5-6"]);
    expect(updates[0]!.dismissedNewModels).toEqual([]);
    expect(listEntries("Anthropic")).toEqual(["Opus 5.5", "Sonnet 5.5", "Opus 5.6"]);
    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(getSection("Anthropic")).getAllByRole("listitem")[2],
      );
    });
  });

  it("sends one update that dismisses the model and keeps the entries, with the focus on the next row's Add", async () => {
    const { calls } = await openModels();

    await userEvent.click(screen.getByRole("button", { name: "Not now: Opus 5.6" }));

    await waitFor(() => {
      expect(listNewRows("Anthropic")).toEqual(["Haiku 5.6"]);
    });
    const updates = listUpdates(calls);
    expect(updates).toHaveLength(1);
    expect(listAnthropicEntries(updates[0]!)).toEqual(["opus-5-5", "sonnet-5-5"]);
    expect(updates[0]!.dismissedNewModels).toEqual([
      { providerAccountId: ANTHROPIC_IDENTITY.id, model: "opus-5-6" },
    ]);
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add Haiku 5.6" }));
    });
  });

  it("moves the focus to the section's first entry when the last row is dismissed", async () => {
    await openModels();

    await userEvent.click(screen.getByRole("button", { name: "Not now: Opus 5.6" }));
    await waitFor(() => {
      expect(listNewRows("Anthropic")).toEqual(["Haiku 5.6"]);
    });
    await userEvent.click(screen.getByRole("button", { name: "Not now: Haiku 5.6" }));

    await waitFor(() => {
      expect(listNewRows("Anthropic")).toEqual([]);
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(getSection("Anthropic")).getAllByRole("listitem")[0],
      );
    });
  });

  it("moves the focus to the head when the section has no entry", async () => {
    await openModels({
      profile: buildModelProfile(
        [buildProfileSection(ANTHROPIC_IDENTITY, [], { newModels: [OPUS_56] })],
        { id: PROFILE_ID, revision: 4, name: "Main" },
      ),
    });

    await userEvent.click(screen.getByRole("button", { name: "Not now: Opus 5.6" }));

    await waitFor(() => {
      expect(listNewRows("Anthropic")).toEqual([]);
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(getSection("Anthropic").querySelector(".pm-head"));
    });
  });

  it("holds both buttons of the row while its save runs, without taking the focus off the pressed one", async () => {
    const { calls, release } = await openModels({ hold: true });

    const add = screen.getByRole("button", { name: "Add Opus 5.6" });
    await userEvent.click(add);

    const notNow = screen.getByRole("button", { name: "Not now: Opus 5.6" });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(notNow.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(add);
    // The other row is not waiting.
    expect(
      screen.getByRole("button", { name: "Add Haiku 5.6" }).getAttribute("aria-disabled"),
    ).toBeNull();
    // A second press while the save runs sends nothing more.
    await userEvent.click(notNow, { pointerEventsCheck: 0 });
    await waitFor(() => {
      expect(listUpdates(calls)).toHaveLength(1);
    });

    await release();

    await waitFor(() => {
      expect(listNewRows("Anthropic")).toEqual(["Haiku 5.6"]);
    });
    expect(listUpdates(calls)).toHaveLength(1);
  });

  it("keeps the focus request of a row while an earlier save of another row is answered", async () => {
    const { release } = await openModels({ hold: true });

    await userEvent.click(screen.getByRole("button", { name: "Not now: Opus 5.6" }));
    await userEvent.click(screen.getByRole("button", { name: "Not now: Haiku 5.6" }));
    const haikuNotNow = screen.getByRole("button", { name: "Not now: Haiku 5.6" });
    expect(document.activeElement).toBe(haikuNotNow);

    // The first save is answered: its row goes, and the second row is still there.
    await release();
    await waitFor(() => {
      expect(listNewRows("Anthropic")).toEqual(["Haiku 5.6"]);
    });
    expect(document.activeElement).toBe(haikuNotNow);

    await release();
    await waitFor(() => {
      expect(listNewRows("Anthropic")).toEqual([]);
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(getSection("Anthropic")).getAllByRole("listitem")[0],
      );
    });
  });

  it("shows a refusal above the sections, keeps the row, and gives its buttons back", async () => {
    const { calls } = await openModels({ refusal: "Opus 5.6 left the account's catalog." });

    await userEvent.click(screen.getByRole("button", { name: "Add Opus 5.6" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "The change was not saved. Opus 5.6 left the account's catalog.",
    );
    expect(listNewRows("Anthropic")).toEqual(["Opus 5.6", "Haiku 5.6"]);
    expect(listEntries("Anthropic")).toEqual(["Opus 5.5", "Sonnet 5.5"]);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Add Opus 5.6" }).getAttribute("aria-disabled"),
      ).toBeNull();
    });
    expect(
      screen.getByRole("button", { name: "Not now: Opus 5.6" }).getAttribute("aria-disabled"),
    ).toBeNull();
    expect(listUpdates(calls)).toHaveLength(1);
    // The focus stays on the pressed button: nothing waits to move it.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add Opus 5.6" }));
  });
});
