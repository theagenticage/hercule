/**
 * Tests the Model Profile tabs of Settings > Providers > Models: no tabs with
 * one profile and the lead's link to the New profile dialog, the tabs with
 * two or more, the profile the URL names, creating a profile from nothing and
 * as a copy, renaming in the tab, Duplicate, Delete naming the projects that
 * use the profile, the refusal to delete the last profile, and the add-account
 * sheet's Done joining the open profile, and the account cards' faces and
 * "Use in <profile>".
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
  holdAnswer,
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
const playProfiles = (
  initial: ModelProfile[],
  initialProjects: Project[] = [],
  holdFirstCreate?: Promise<void>,
) => {
  let stored = initial;
  let creates = 0;
  let projects = initialProjects;
  const newIds = [...NEW_IDS];
  const patch =
    (id: string): Handler =>
    (call) => {
      const input = call.body as { name: string; expectedRevision: number };
      if (stored.some((each) => each.id !== id && each.name === input.name)) {
        return { status: 400, body: buildErrorBody("validation", "A profile called that exists.") };
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
    "POST /api/v1/model-profiles": async (call) => {
      // The first create answers only when the test lets it, so a second
      // click can come while it is on its way.
      if (creates++ === 0) await holdFirstCreate;
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
  accounts = IDENTITIES.map(buildAccount),
  path = "/settings/providers",
  handlers = {},
  holdFirstCreate,
}: {
  readonly profiles: ModelProfile[];
  readonly projects?: Project[];
  readonly accounts?: ProviderAccount[];
  readonly path?: string;
  readonly handlers?: Record<string, Handler>;
  readonly holdFirstCreate?: Promise<void>;
}) => {
  const controller = playProfiles(profiles, projects, holdFirstCreate);
  const calls = stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      accounts,
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

  it("shows the tabs and the teaching state of the profiles when there is no account yet", async () => {
    const empty = buildModelProfile([], { id: MAIN_ID, name: "Main", revision: 3 });
    const work = buildModelProfile([], { id: WORK_ID, name: "Work", revision: 5 });
    await openModels({ profiles: [empty, work], accounts: [] });

    expect(screen.getByText("No accounts yet. Add one to give your agents models.")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Accounts" })).toBeNull();
    expect(listTabNames()).toEqual(["Main", "Work"]);
    expect(screen.getByRole("button", { name: "New profile" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Build Main's model menu" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Or add a new account" })).toBeTruthy();
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

    it("keeps the field read-only while its save runs, so a letter typed then is not lost", async () => {
      const save = holdAnswer();
      await openModels({
        profiles: [MAIN, WORK],
        handlers: { [`PATCH /api/v1/model-profiles/${MAIN_ID}`]: save.handler },
      });
      await chooseTabMenuItem("Main", "Rename");
      const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Name of Main" });
      await userEvent.clear(field);
      await userEvent.type(field, "Daily{Enter}");
      await waitFor(() => {
        expect(field.readOnly).toBe(true);
      });

      await userEvent.type(field, "xyz");

      expect(field.value).toBe("Daily");
      save.answer({
        status: 400,
        body: buildErrorBody("validation", "A profile called that exists."),
      });
      expect((await screen.findByRole("alert")).textContent).toBe("A profile called that exists.");
      expect(field.readOnly).toBe(false);
      await userEvent.type(field, "xyz");
      expect(field.value).toBe("Dailyxyz");
    });

    it("keeps the rename the user has started on another tab when an earlier save answers", async () => {
      const save = holdAnswer();
      await openModels({
        profiles: [MAIN, WORK],
        handlers: { [`PATCH /api/v1/model-profiles/${MAIN_ID}`]: save.handler },
      });
      await chooseTabMenuItem("Main", "Rename");
      const field = screen.getByRole("textbox", { name: "Name of Main" });
      await userEvent.clear(field);
      await userEvent.type(field, "Daily{Enter}");
      await userEvent.click(screen.getByRole("tab", { name: /^Work/, selected: false }));
      await chooseTabMenuItem("Work", "Rename");
      const other = screen.getByRole("textbox", { name: "Name of Work" });
      await userEvent.clear(other);
      await userEvent.type(other, "Jobs");

      save.answer({ body: { ...MAIN, name: "Daily", revision: MAIN.revision + 1 } });

      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /^Daily/ })).toBeTruthy();
      });
      expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Name of Work" }).value).toBe(
        "Jobs",
      );
    });

    it("names the profile when its rename is refused after the user left it, and leaves the other rename alone", async () => {
      const save = holdAnswer();
      await openModels({
        profiles: [MAIN, WORK],
        handlers: { [`PATCH /api/v1/model-profiles/${MAIN_ID}`]: save.handler },
      });
      await chooseTabMenuItem("Main", "Rename");
      const field = screen.getByRole("textbox", { name: "Name of Main" });
      await userEvent.clear(field);
      await userEvent.type(field, "Work{Enter}");
      await userEvent.click(screen.getByRole("tab", { name: /^Work/, selected: false }));
      await chooseTabMenuItem("Work", "Rename");
      await userEvent.type(screen.getByRole("textbox", { name: "Name of Work" }), "s");

      save.answer({
        status: 400,
        body: buildErrorBody("validation", "A profile called that exists."),
      });

      expect((await screen.findByRole("alert")).textContent).toBe(
        "Main was not renamed: A profile called that exists.",
      );
      expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Name of Work" }).value).toBe(
        "Works",
      );
      expect(screen.getByRole("tab", { name: /^Main/ })).toBeTruthy();
    });

    it("refuses a blank name in plain words without asking the controller, and keeps the field", async () => {
      const { calls, read } = await openModels({ profiles: [MAIN, WORK] });

      await chooseTabMenuItem("Main", "Rename");
      await userEvent.clear(screen.getByRole("textbox"));
      await userEvent.keyboard("{Enter}");

      expect((await screen.findByRole("alert")).textContent).toBe("A profile needs a name.");
      expect(screen.getByRole("textbox")).toBeTruthy();
      expect(getCalls(calls, "PATCH", `/api/v1/model-profiles/${MAIN_ID}`)).toEqual([]);
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

  describe("Duplicate, quickly", () => {
    it("names the copies from the profiles the page holds when each save starts", async () => {
      let release: () => void = () => undefined;
      const { calls } = await openModels({
        profiles: [MAIN, WORK],
        holdFirstCreate: new Promise<void>((resolve) => {
          release = resolve;
        }),
      });

      await chooseTabMenuItem("Main", "Duplicate");
      await chooseTabMenuItem("Main", "Duplicate");
      release();

      await waitFor(() => {
        expect(listTabNames()).toEqual(["Main", "Work", "Main copy", "Main copy 2"]);
      });
      expect(screen.queryByRole("alert")).toBeNull();
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

  describe("the account cards", () => {
    /** Returns the card of the account called `name`. */
    const getCard = (name: string): HTMLElement =>
      document.querySelector<HTMLElement>(`button[title="Open ${name}"]`)!.closest(".pa-card")!;

    /** "Shared": Work holds OpenAI and Anthropic, so Anthropic is in both profiles. */
    const SHARED: ModelProfile = buildModelProfile(
      [
        buildProfileSection(OPENAI_IDENTITY, [
          buildProfileEntry(OPENAI_IDENTITY, "gpt-6", { name: "GPT-6" }),
        ]),
        buildProfileSection(ANTHROPIC_IDENTITY, [
          buildProfileEntry(ANTHROPIC_IDENTITY, "opus-5-5", { name: "Opus 5.5" }),
        ]),
      ],
      { id: WORK_ID, name: "Work", revision: 5, createdAt: "2026-09-06T09:00:00.000Z" },
    );

    /** Plays `modelProfile.update` as the controller does: the account is added as a section filled with its Default Selection. */
    const playUpdate = (
      profile: ModelProfile,
      identity: ProviderAccountIdentity,
    ): Record<string, Handler> => ({
      [`PATCH /api/v1/model-profiles/${profile.id}`]: () => ({
        body: {
          ...profile,
          revision: profile.revision + 1,
          accounts: [
            ...profile.accounts,
            buildProfileSection(identity, [
              buildProfileEntry(identity, "gpt-6", { name: "GPT-6" }),
            ]),
          ],
        },
      }),
    });

    it("lists the faces of the profiles that hold an account, in the profiles' order", async () => {
      await openModels({ profiles: [MAIN, SHARED] });

      const anthropic = within(getCard("Anthropic")).getByRole("img", {
        name: "Used in Main, Work",
      });
      expect(anthropic.textContent).toBe("MW");
      const openai = within(getCard("OpenAI")).getByRole("img", { name: "Used in Work" });
      expect(openai.textContent).toBe("W");
    });

    it("says an account is in the open profile, and dims the ones it is not in", async () => {
      await openModels({ profiles: [MAIN, WORK] });

      const anthropic = getCard("Anthropic");
      expect(anthropic.classList.contains("is-member")).toBe(true);
      expect(within(anthropic).getByText("In Main")).toBeTruthy();
      expect(within(anthropic).queryByRole("button", { name: /^Use/ })).toBeNull();
      const openai = getCard("OpenAI");
      expect(openai.classList.contains("is-out")).toBe(true);
      expect(within(openai).getByRole("button", { name: "Use in Main" })).toBeTruthy();
    });

    it("follows the open tab", async () => {
      await openModels({ profiles: [MAIN, WORK] });

      await userEvent.click(getTabs()[1]!);

      expect(await within(getCard("OpenAI")).findByText("In Work")).toBeTruthy();
      expect(
        within(getCard("Anthropic")).getByRole("button", { name: "Use in Work" }),
      ).toBeTruthy();
    });

    it("adds the account to the open profile only, sending no entries, and does not open its sheet", async () => {
      const { calls } = await openModels({
        profiles: [MAIN, WORK],
        handlers: playUpdate(MAIN, OPENAI_IDENTITY),
      });

      await userEvent.click(within(getCard("OpenAI")).getByRole("button", { name: "Use in Main" }));

      expect(await within(getCard("OpenAI")).findByText("In Main")).toBeTruthy();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(getCalls(calls, "PATCH", `/api/v1/model-profiles/${WORK_ID}`)).toHaveLength(0);
      const [update] = getCalls(calls, "PATCH", `/api/v1/model-profiles/${MAIN_ID}`);
      expect(update!.body).toMatchObject({
        accounts: [
          { providerAccountId: ANTHROPIC_IDENTITY.id },
          { providerAccountId: OPENAI_IDENTITY.id, harnessId: null },
        ],
      });
      const sent = (update!.body as { accounts: Array<{ entries?: unknown }> }).accounts[1]!;
      expect(sent.entries).toBeUndefined();
      // The Models section shows the new section from the answer.
      expect(await screen.findByRole("region", { name: "OpenAI" })).toBeTruthy();
    });

    it("shows the controller's message when it refuses, and offers the button again", async () => {
      await openModels({
        profiles: [MAIN, WORK],
        handlers: {
          [`PATCH /api/v1/model-profiles/${MAIN_ID}`]: () => ({
            status: 400,
            body: buildErrorBody("validation", "OpenAI has no models yet."),
          }),
        },
      });

      await userEvent.click(within(getCard("OpenAI")).getByRole("button", { name: "Use in Main" }));

      const alert = await within(getCard("OpenAI")).findByRole("alert");
      expect(alert.textContent).toBe("OpenAI was not added to Main. OpenAI has no models yet.");
      expect(within(getCard("OpenAI")).getByRole("button", { name: "Use in Main" })).toBeTruthy();
    });

    it("draws no faces with one profile, and says only the account left out is not in the menu", async () => {
      await openModels({ profiles: [MAIN] });

      const anthropic = getCard("Anthropic");
      expect(anthropic.querySelector(".pa-card-profiles")).toBeNull();
      const openai = getCard("OpenAI");
      expect(openai.querySelector(".pa-card-faces")).toBeNull();
      expect(within(openai).getByText("Not in the menu")).toBeTruthy();
      expect(within(openai).getByRole("button", { name: "Use" })).toBeTruthy();
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
