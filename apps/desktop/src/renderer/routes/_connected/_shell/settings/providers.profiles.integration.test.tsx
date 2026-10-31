/**
 * Tests the Model Profile tabs of Settings > Providers > Models: no tabs with
 * one profile and the lead's link to the New profile dialog, the tabs with
 * two or more, the profile the URL names, creating a profile from nothing and
 * as a copy, renaming in the tab, Duplicate, Delete naming the projects that
 * use the profile, the refusal to delete the last profile, and the add-account
 * sheet's Done joining the open profile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ANTHROPIC_IDENTITY as CLIENT_ANTHROPIC,
  OPENAI_IDENTITY as CLIENT_OPENAI,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
  type ProviderAccountIdentity,
} from "@hercule/client-core/testing";
import type { ModelProfile, Project, ProviderAccount } from "@hercule/contract";
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

const MAIN_ID = "01a06d02-8000-7000-8000-000000000b01";
const WORK_ID = "01a06d02-8000-7000-8000-000000000b02";
/** The ids the controller gives the profiles the tests create, in order. */
const NEW_IDS = ["01a06d02-8000-7000-8000-000000000b03", "01a06d02-8000-7000-8000-000000000b04"];
const ANTHROPIC_IDENTITY = { ...CLIENT_ANTHROPIC, id: "01a06d02-8000-7000-8000-000000000a01" };
const OPENAI_IDENTITY = { ...CLIENT_OPENAI, id: "01a06d02-8000-7000-8000-000000000a02" };
const IDENTITIES = [ANTHROPIC_IDENTITY, OPENAI_IDENTITY];

const buildAccount = (identity: ProviderAccountIdentity): ProviderAccount => ({
  ...buildProviderAccount(identity),
  modelCount: 2,
  catalogReadAt: "2026-09-10T08:00:00.000Z",
});

/** "Main": Anthropic with two models. */
const MAIN: ModelProfile = buildModelProfile(
  [
    buildProfileSection(ANTHROPIC_IDENTITY, [
      buildProfileEntry(ANTHROPIC_IDENTITY, "opus-5-5", { name: "Opus 5.5" }),
      buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet-5-5", { name: "Sonnet 5.5" }),
    ]),
  ],
  { id: MAIN_ID, name: "Main", revision: 3 },
);
/** "Work": OpenAI with one model. */
const WORK: ModelProfile = buildModelProfile(
  [
    buildProfileSection(OPENAI_IDENTITY, [
      buildProfileEntry(OPENAI_IDENTITY, "gpt-6", { name: "GPT-6" }),
    ]),
  ],
  { id: WORK_ID, name: "Work", revision: 5, createdAt: "2026-09-06T09:00:00.000Z" },
);

const buildProject = (id: string, name: string, modelProfileId?: string): Project => ({
  id: `01a06d02-8000-7000-8000-0000000000${id}`,
  name,
  ...(modelProfileId === undefined ? {} : { modelProfileId }),
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
});

/**
 * Plays the controller's `modelProfile` operations and its projects over the
 * profiles `initial`. A create is refused `validation` for a name another
 * profile has, a delete is refused `invalid_state` for the last profile, and
 * a delete clears the choice of the projects that named the profile.
 * `read` and `readProjects` return what is stored.
 */
const playProfiles = (initial: ModelProfile[], initialProjects: Project[] = []) => {
  let stored = initial;
  let projects = initialProjects;
  const newIds = [...NEW_IDS];
  const patch =
    (id: string): Handler =>
    (call) => {
      const input = call.body as { name: string; expectedRevision: number };
      if (stored.some((each) => each.id !== id && each.name === input.name)) {
        return { status: 400, body: buildErrorBody("validation", "A profile called that exists.") };
      }
      if (input.name.trim() === "") {
        return { status: 400, body: buildErrorBody("validation", "Name must not be blank.") };
      }
      const current = stored.find((each) => each.id === id)!;
      const saved = { ...current, name: input.name, revision: current.revision + 1 };
      stored = stored.map((each) => (each.id === id ? saved : each));
      return { body: saved };
    };
  const remove =
    (id: string): Handler =>
    () => {
      if (stored.length === 1) {
        return { status: 409, body: buildErrorBody("invalid_state", "Keep at least one profile.") };
      }
      stored = stored.filter((each) => each.id !== id);
      projects = projects.map(({ modelProfileId, ...rest }) =>
        modelProfileId === id ? rest : { ...rest, modelProfileId },
      ) as Project[];
      return { body: {} };
    };
  const handlers: Record<string, Handler> = {
    "GET /api/v1/model-profiles": () => ({ body: stored }),
    "GET /api/v1/projects": () => ({ body: { items: projects } }),
    "POST /api/v1/model-profiles": (call) => {
      const input = call.body as { name: string; copyFromId?: string };
      if (stored.some((each) => each.name === input.name)) {
        return {
          status: 400,
          body: buildErrorBody("validation", "A profile called that exists."),
        };
      }
      const source = stored.find((each) => each.id === input.copyFromId);
      const created: ModelProfile = {
        ...(source ?? buildModelProfile([])),
        id: newIds.shift()!,
        name: input.name,
        revision: 1,
        createdAt: "2026-09-07T09:00:00.000Z",
      };
      stored = [...stored, created];
      return { body: created };
    },
  };
  for (const id of [MAIN_ID, WORK_ID, ...NEW_IDS]) {
    handlers[`PATCH /api/v1/model-profiles/${id}`] = patch(id);
    handlers[`DELETE /api/v1/model-profiles/${id}`] = remove(id);
  }
  return { handlers, read: () => stored, readProjects: () => projects };
};

/** Opens Settings > Providers at `path`, over the profiles and projects given. */
const openModels = async ({
  profiles,
  projects = [],
  path = "/settings/providers",
  handlers = {},
}: {
  readonly profiles: ModelProfile[];
  readonly projects?: Project[];
  readonly path?: string;
  readonly handlers?: Record<string, Handler>;
}) => {
  const controller = playProfiles(profiles, projects);
  const calls = stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      accounts: IDENTITIES.map(buildAccount),
      modelProfiles: profiles,
    }),
    ...controller.handlers,
    ...handlers,
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path });
  await screen.findByRole("heading", { level: 2, name: "Models" });
  return { calls, ...app, ...controller };
};

const getTabs = (): HTMLElement[] =>
  within(screen.getByRole("tablist", { name: "Profiles" })).getAllByRole("tab");

/** Returns the names of the tabs, without the model counts. */
const listTabNames = (): string[] =>
  getTabs().map((tab) => tab.firstChild?.nextSibling?.textContent ?? "");

/** Presses an enabled menu item, which jsdom counts as hidden. */
const chooseItem = (item: HTMLElement): Promise<void> =>
  userEvent.click(item, { pointerEventsCheck: 0 });

/** Opens the open tab's ⌄ menu and presses its item `item`. jsdom has no popover API, so the menu is found by the button's `popovertarget`. */
const chooseTabMenuItem = async (profileName: string, item: string): Promise<void> => {
  const button = screen.getByRole("button", { name: `Options for ${profileName}` });
  await userEvent.click(button);
  const menu = document.getElementById(button.getAttribute("popovertarget")!)!;
  await chooseItem(within(menu).getByRole("menuitem", { name: item, hidden: true }));
};

const getCalls = (
  calls: readonly { method: string; path: string; body: unknown }[],
  method: string,
  path: string,
) => calls.filter((call) => call.method === method && call.path === path);

describe("Settings > Providers > Models, profiles", () => {
  it("has no tabs with one profile, and the lead's link opens the New profile dialog", async () => {
    await openModels({ profiles: [MAIN] });

    expect(screen.queryByRole("tablist", { name: "Profiles" })).toBeNull();
    expect(screen.getByText(/You can also/).textContent).toBe(
      "The models you can use in Hercule, in the order the composer shows them. You can also create several profiles, each with its own set.",
    );
    await userEvent.click(screen.getByRole("button", { name: "create several profiles" }));

    const dialog = await screen.findByRole("dialog", { name: "New profile" });
    expect(within(dialog).getByText(/A profile is your own model menu/)).toBeTruthy();
  });

  it("shows a tab for each profile in order with its model count, and the first one open", async () => {
    await openModels({ profiles: [MAIN, WORK] });

    expect(
      screen.getByText(/Each profile is its own set; you can create as many as you like\./),
    ).toBeTruthy();
    expect(listTabNames()).toEqual(["Main", "Work"]);
    expect(getTabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(getTabs().map((tab) => tab.querySelector("small")?.textContent)).toEqual(["2", "1"]);
    expect(screen.getByRole("region", { name: "Anthropic" })).toBeTruthy();
    // Only the open tab has a ⌄ menu.
    expect(screen.getAllByRole("button", { name: /^Options for/ })).toHaveLength(1);
  });

  it("opens the profile the URL names, and falls back to the first for an id that is gone", async () => {
    const { router } = await openModels({
      profiles: [MAIN, WORK],
      path: `/settings/providers?profile=${WORK_ID}`,
    });

    expect(getTabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(screen.getByRole("region", { name: "OpenAI" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Anthropic" })).toBeNull();

    await userEvent.click(getTabs()[0]!);

    expect(router.state.location.search).toEqual({ profile: MAIN_ID });
    expect(await screen.findByRole("region", { name: "Anthropic" })).toBeTruthy();
  });

  it("opens the first profile when the URL names a profile that does not exist", async () => {
    await openModels({
      profiles: [MAIN, WORK],
      path: "/settings/providers?profile=01a06d02-8000-7000-8000-000000000bff",
    });

    expect(getTabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false"]);
  });

  it("moves between tabs with the arrow keys", async () => {
    const { router } = await openModels({ profiles: [MAIN, WORK] });

    getTabs()[0]!.focus();
    await userEvent.keyboard("{ArrowRight}");

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ profile: WORK_ID });
    });
    expect(document.activeElement).toBe(getTabs()[1]);
  });

  describe("New profile", () => {
    it("creates an empty profile named from a chip, and opens its tab", async () => {
      const { calls, router } = await openModels({ profiles: [MAIN, WORK] });
      await userEvent.click(screen.getByRole("button", { name: "New profile" }));
      const dialog = await screen.findByRole("dialog", { name: "New profile" });

      const create = within(dialog).getByRole<HTMLButtonElement>("button", {
        name: "Create profile",
      });
      expect(create.disabled).toBe(true);
      expect(
        within(dialog).getByPlaceholderText("Client work, Experiments, Cheap and fast…"),
      ).toBeTruthy();
      await userEvent.click(within(dialog).getByRole("button", { name: "Experiments" }));
      expect(within(dialog).getByRole<HTMLInputElement>("textbox").value).toBe("Experiments");
      await userEvent.click(create);

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(getCalls(calls, "POST", "/api/v1/model-profiles").map((call) => call.body)).toEqual([
        { name: "Experiments" },
      ]);
      expect(router.state.location.search).toEqual({ profile: NEW_IDS[0] });
      await waitFor(() => {
        expect(listTabNames()).toEqual(["Main", "Work", "Experiments"]);
      });
      expect(getTabs()[2]!.getAttribute("aria-selected")).toBe("true");
    });

    it("creates a copy of the open profile", async () => {
      const { calls } = await openModels({ profiles: [MAIN, WORK] });
      await userEvent.click(screen.getByRole("button", { name: "New profile" }));
      const dialog = await screen.findByRole("dialog", { name: "New profile" });

      expect(
        within(dialog).getByText("Pick its accounts and models yourself. The page shows how."),
      ).toBeTruthy();
      expect(
        within(dialog).getByText(
          "Its accounts and menu, to change from there. The original stays as it is.",
        ),
      ).toBeTruthy();
      await userEvent.type(within(dialog).getByRole("textbox"), "Client work");
      await userEvent.click(within(dialog).getByRole("radio", { name: /A copy of Main/ }));
      await userEvent.click(within(dialog).getByRole("button", { name: "Create profile" }));

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(getCalls(calls, "POST", "/api/v1/model-profiles").map((call) => call.body)).toEqual([
        { name: "Client work", copyFromId: MAIN_ID },
      ]);
      // The copy holds Main's account.
      expect(await screen.findByRole("region", { name: "Anthropic" })).toBeTruthy();
    });

    it("shows the controller's refusal in the dialog and keeps what was typed", async () => {
      await openModels({ profiles: [MAIN, WORK] });
      await userEvent.click(screen.getByRole("button", { name: "New profile" }));
      const dialog = await screen.findByRole("dialog", { name: "New profile" });

      await userEvent.type(within(dialog).getByRole("textbox"), "Work");
      await userEvent.click(within(dialog).getByRole("button", { name: "Create profile" }));

      expect((await within(dialog).findByRole("alert")).textContent).toBe(
        "A profile called that exists.",
      );
      expect(within(dialog).getByRole<HTMLInputElement>("textbox").value).toBe("Work");
      expect(listTabNames()).toEqual(["Main", "Work"]);
    });
  });

  describe("Rename", () => {
    it("edits the name in the tab and saves it on Enter, keeping the profile's menu", async () => {
      const { calls, read } = await openModels({ profiles: [MAIN, WORK] });

      await chooseTabMenuItem("Main", "Rename");
      const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Name of Main" });
      expect(document.activeElement).toBe(field);
      await userEvent.clear(field);
      await userEvent.type(field, "Daily{Enter}");

      await waitFor(() => {
        expect(listTabNames()).toEqual(["Daily", "Work"]);
      });
      expect(screen.queryByRole("textbox")).toBeNull();
      const [update] = getCalls(calls, "PATCH", `/api/v1/model-profiles/${MAIN_ID}`);
      expect(update!.body).toMatchObject({ name: "Daily", expectedRevision: 3 });
      expect((update!.body as { accounts: unknown[] }).accounts).toHaveLength(1);
      expect(read()[0]!.name).toBe("Daily");
    });

    it("drops the edit on Esc and sends nothing", async () => {
      const { calls } = await openModels({ profiles: [MAIN, WORK] });

      await chooseTabMenuItem("Main", "Rename");
      await userEvent.type(screen.getByRole("textbox"), "Daily{Escape}");

      expect(screen.queryByRole("textbox")).toBeNull();
      expect(listTabNames()).toEqual(["Main", "Work"]);
      expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
    });

    it("shows the controller's message for a taken name and keeps the field", async () => {
      await openModels({ profiles: [MAIN, WORK] });

      await chooseTabMenuItem("Main", "Rename");
      const field = screen.getByRole("textbox");
      await userEvent.clear(field);
      await userEvent.type(field, "Work{Enter}");

      expect((await screen.findByRole("alert")).textContent).toBe("A profile called that exists.");
      expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe("Work");

      await userEvent.keyboard("{Escape}");

      expect(screen.queryByRole("alert")).toBeNull();
      expect(listTabNames()).toEqual(["Main", "Work"]);
    });

    it("refuses a blank name with a message and keeps the field", async () => {
      const { read } = await openModels({ profiles: [MAIN, WORK] });

      await chooseTabMenuItem("Main", "Rename");
      await userEvent.clear(screen.getByRole("textbox"));
      await userEvent.keyboard("{Enter}");

      expect((await screen.findByRole("alert")).textContent).not.toBe("");
      expect(screen.getByRole("textbox")).toBeTruthy();
      expect(read()[0]!.name).toBe("Main");
    });
  });

  describe("Duplicate", () => {
    it("creates a copy named '<name> copy', or the next free variant, and opens its tab", async () => {
      const { calls } = await openModels({ profiles: [MAIN, WORK] });

      await chooseTabMenuItem("Main", "Duplicate");
      await waitFor(() => {
        expect(listTabNames()).toEqual(["Main", "Work", "Main copy"]);
      });
      expect(getTabs()[2]!.getAttribute("aria-selected")).toBe("true");

      await userEvent.click(getTabs()[0]!);
      await chooseTabMenuItem("Main", "Duplicate");
      await waitFor(() => {
        expect(listTabNames()).toEqual(["Main", "Work", "Main copy", "Main copy 2"]);
      });
      expect(getCalls(calls, "POST", "/api/v1/model-profiles").map((call) => call.body)).toEqual([
        { name: "Main copy", copyFromId: MAIN_ID },
        { name: "Main copy 2", copyFromId: MAIN_ID },
      ]);
    });
  });

  describe("Delete", () => {
    it("names the projects that use the profile, deletes it, reads the projects again and opens the first profile", async () => {
      const projects = [
        buildProject("01", "payments-api", WORK_ID),
        buildProject("02", "site", MAIN_ID),
        buildProject("03", "docs", WORK_ID),
      ];
      const { calls, router, readProjects } = await openModels({
        profiles: [MAIN, WORK],
        projects,
        path: `/settings/providers?profile=${WORK_ID}`,
      });

      await chooseTabMenuItem("Work", "Delete…");
      const dialog = await screen.findByRole("dialog", { name: "Delete Work?" });
      expect(
        within(dialog).getByText("Its menu goes. Your accounts and the other profiles stay."),
      ).toBeTruthy();
      expect(
        within(dialog).getByText(
          "payments-api and docs use it, and then start on the thread default.",
        ),
      ).toBeTruthy();
      const projectReads = getCalls(calls, "GET", "/api/v1/projects").length;
      await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(getCalls(calls, "DELETE", `/api/v1/model-profiles/${WORK_ID}`)).toHaveLength(1);
      expect(router.state.location.search).toEqual({ profile: MAIN_ID });
      await waitFor(() => {
        expect(getCalls(calls, "GET", "/api/v1/projects").length).toBeGreaterThan(projectReads);
      });
      expect(readProjects().map((project) => project.modelProfileId)).toEqual([
        undefined,
        MAIN_ID,
        undefined,
      ]);
      // One profile is left, so the tabs go.
      await waitFor(() => {
        expect(screen.queryByRole("tablist", { name: "Profiles" })).toBeNull();
      });
      expect(screen.getByRole("region", { name: "Anthropic" })).toBeTruthy();
    });

    it("names no project for a profile no project uses, and Keep it leaves everything as it was", async () => {
      const { calls } = await openModels({
        profiles: [MAIN, WORK],
        projects: [buildProject("02", "site", MAIN_ID)],
        path: `/settings/providers?profile=${WORK_ID}`,
      });

      await chooseTabMenuItem("Work", "Delete…");
      const dialog = await screen.findByRole("dialog", { name: "Delete Work?" });
      expect(within(dialog).queryByText(/then start/)).toBeNull();
      await userEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
      expect(listTabNames()).toEqual(["Main", "Work"]);
    });

    it("shows the controller's refusal to delete the last profile, with only Cancel left", async () => {
      // The tabs are showing, but the controller holds one profile: another
      // client deleted the other.
      const { calls } = await openModels({
        profiles: [MAIN, WORK],
        handlers: {
          [`DELETE /api/v1/model-profiles/${MAIN_ID}`]: {
            status: 409,
            body: buildErrorBody("invalid_state", "Keep at least one profile."),
          },
        },
      });

      await chooseTabMenuItem("Main", "Delete…");
      const dialog = await screen.findByRole("dialog", { name: "Delete Main?" });
      await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

      expect((await within(dialog).findByRole("alert")).textContent).toBe(
        "Keep at least one profile.",
      );
      expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeNull();
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
      expect(getCalls(calls, "DELETE", `/api/v1/model-profiles/${MAIN_ID}`)).toHaveLength(1);
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    });
  });

  describe("the add-account sheet", () => {
    it("joins the account to the open profile with Done", async () => {
      const stored: ProviderAccount[] = IDENTITIES.map(buildAccount);
      const created = {
        ...buildAccount({ ...CLIENT_OPENAI, id: "01a06d02-8000-7000-8000-000000000a09" }),
        providerId: "zai/zai",
        kind: "api-key",
        label: null,
        defaultHarnessId: "pi/pi",
        modelCount: 0,
        catalogReadAt: null,
      } satisfies ProviderAccount;
      const { calls } = await openModels({
        profiles: [MAIN, WORK],
        path: `/settings/providers?profile=${WORK_ID}`,
        handlers: {
          "GET /api/v1/provider-accounts": () => ({ body: stored }),
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
          "POST /api/v1/provider-accounts": () => {
            stored.push(created);
            return { body: created };
          },
        },
      });

      await userEvent.click(screen.getByRole("button", { name: "Add an account" }));
      const sheet = await screen.findByRole("dialog", { name: "Add an account" });
      await userEvent.click(within(sheet).getByRole("button", { name: "Z.ai" }));
      const keyStep = await screen.findByRole("dialog", { name: "Add Z.ai" });
      await userEvent.type(within(keyStep).getByLabelText("API key"), "zai-key-123");
      await userEvent.click(within(keyStep).getByRole("button", { name: "Done" }));

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(getCalls(calls, "PATCH", `/api/v1/model-profiles/${MAIN_ID}`)).toHaveLength(0);
      const [update] = getCalls(calls, "PATCH", `/api/v1/model-profiles/${WORK_ID}`);
      expect(
        (update!.body as { accounts: Array<{ providerAccountId: string }> }).accounts.map(
          ({ providerAccountId }) => providerAccountId,
        ),
      ).toEqual([OPENAI_IDENTITY.id, created.id]);
    });
  });
});
