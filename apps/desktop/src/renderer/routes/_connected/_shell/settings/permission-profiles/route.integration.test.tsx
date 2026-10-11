/**
 * Tests Settings > Permission profiles: the list and its order, New profile,
 * a profile's page with its name, its grants, who uses it and Delete, the
 * confirmation the unrestricted profile asks for, and a failed save that puts
 * the field back and shows why under its row, even when a later save was
 * already queued behind it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Agent, Profile } from "@hercule/contract";
import { forgetLastSettingsSection } from "../../../../../app/last-settings-section";
import {
  buildErrorBody,
  buildFixtureAssistant,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_THREAD_IDS,
  holdAnswer,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  type Answer,
  type Call,
  type Handler,
} from "../../../../../app/testing";

// The Office draws a 3D scene, which jsdom cannot, so a stub stands in for it.
vi.mock("../../../../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

// The sidebar's thread list draws only the rows that fit its height.
beforeEach(() => {
  stubElementSize(272, 800);
});

afterEach(forgetLastSettingsSection);

const LIST_PATH = "/settings/permission-profiles";

const buildProfile = (over: Partial<Profile> & Pick<Profile, "id" | "name">): Profile => ({
  grants: [],
  shipped: false,
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-01T09:00:00.000Z",
  ...over,
});

const STANDARD = buildProfile({
  id: "01a06d02-7500-7000-8000-000000000001",
  name: "standard",
  shipped: true,
  grants: ["task.read", "task.update"],
});
const UNRESTRICTED = buildProfile({
  id: "01a06d02-7500-7000-8000-000000000002",
  name: "unrestricted",
  shipped: true,
  grants: ["task.read", "task.delete", "workflow.read"],
});
/** A profile of the user's own that nothing uses. */
const TRIAGE = buildProfile({
  id: "01a06d02-7500-7000-8000-000000000003",
  name: "Triage",
  grants: ["task.read"],
});
/** A profile of the user's own that two agents use. */
const BUSY = buildProfile({
  id: "01a06d02-7500-7000-8000-000000000004",
  name: "Busy",
});
/** What New profile creates in these tests. */
const CREATED_ID = "01a06d02-7500-7000-8000-000000000005";

const ADA = buildFixtureAssistant({
  id: "01a06d02-7700-7000-8000-000000000001",
  name: "Ada",
  mainConversationId: "01a06d02-7800-7000-8000-000000000001",
  permissionProfileId: STANDARD.id,
});
const MILO = buildFixtureAssistant({
  id: "01a06d02-7700-7000-8000-000000000002",
  name: "Milo",
  mainConversationId: "01a06d02-7800-7000-8000-000000000002",
  permissionProfileId: UNRESTRICTED.id,
});

const buildAgent = (id: string, name: string, permissionProfileId: string): Agent => ({
  id,
  name,
  systemPrompt: `You are ${name}.`,
  instanceId: ADA.instanceId,
  permissionProfileId,
  accessMode: "full-access",
  model: null,
  disallowedTools: [],
  unenforced: [],
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-01T09:00:00.000Z",
});
const AGENTS = [
  buildAgent("01a06d02-7900-7000-8000-000000000001", "pr-review", BUSY.id),
  buildAgent("01a06d02-7900-7000-8000-000000000002", "nightly", BUSY.id),
];

/**
 * Returns handlers that play the controller's profiles on one stored list:
 * listing and reading them, creating one, updating any and deleting any. A read after a
 * change answers with what the change stored, as the controller's does.
 */
const storeProfiles = (
  initial: ReadonlyArray<Profile>,
): Readonly<Record<string, (call: Call) => Answer>> => {
  let stored = [...initial];
  const handlers: Record<string, (call: Call) => Answer> = {
    "GET /api/v1/profiles": () => ({ body: { items: stored } }),
    "POST /api/v1/profiles": (call) => {
      const created = buildProfile({ id: CREATED_ID, ...(call.body as Pick<Profile, "name">) });
      stored = [...stored, created];
      return { body: created };
    },
  };
  for (const { id } of [...initial, { id: CREATED_ID }]) {
    // A save reads the profile again before it writes (see useSavedProfileField).
    handlers[`GET /api/v1/profiles/${id}`] = () => ({
      body: stored.find((each) => each.id === id)!,
    });
    handlers[`PATCH /api/v1/profiles/${id}`] = (call) => {
      const updated = { ...stored.find((each) => each.id === id)!, ...(call.body as object) };
      stored = stored.map((each) => (each.id === id ? updated : each));
      return { body: updated };
    };
    handlers[`DELETE /api/v1/profiles/${id}`] = () => {
      stored = stored.filter((each) => each.id !== id);
      return { body: {} };
    };
  }
  return handlers;
};

const ALL_PROFILES = [TRIAGE, UNRESTRICTED, BUSY, STANDARD];

/** Opens the app at `path`, with the profiles, Ada, Milo and the two agents, and `handlers` on top. */
const openAt = async (
  path: string,
  handlers: Readonly<Record<string, Handler>> = {},
  profiles: ReadonlyArray<Profile> = ALL_PROFILES,
) => {
  const calls = stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      assistants: [
        { assistant: ADA, session: null },
        { assistant: MILO, session: null },
      ],
    }),
    "GET /api/v1/agents": { body: { items: AGENTS } },
    ...storeProfiles(profiles),
    ...handlers,
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path });
  return { calls, fake, ...app };
};

const openList = async (handlers: Readonly<Record<string, Handler>> = {}) => {
  const app = await openAt(LIST_PATH, handlers);
  await screen.findByRole("heading", { level: 1, name: "Permission profiles" });
  return app;
};

/** Opens the page of `profile` and waits for its heading. */
const openProfile = async (profile: Profile, handlers: Readonly<Record<string, Handler>> = {}) => {
  const app = await openAt(`${LIST_PATH}/${profile.id}`, handlers);
  await screen.findByRole("heading", { level: 1, name: profile.name });
  return app;
};

/** Returns the bodies of the calls among `calls` that update the profile `id`, oldest first. */
const listUpdates = (calls: readonly Call[], id: string): unknown[] =>
  calls
    .filter((call) => call.method === "PATCH" && call.path === `/api/v1/profiles/${id}`)
    .map((call) => call.body);

/** Returns the verb button named `verb` in the row of the grant family named `family`. */
const findVerb = (family: string, verb: string): HTMLElement =>
  within(screen.getByRole("group", { name: family })).getByRole("button", { name: verb });

/**
 * Returns the rows of the profile list, top to bottom. Each row is a link to
 * a profile's page, and its text is its cells run together: the name, who
 * made it, the grants held, and who uses it.
 */
const listProfileRows = (): HTMLElement[] =>
  screen
    .getAllByRole("link")
    .filter((link) => link.getAttribute("href")?.startsWith(`${LIST_PATH}/`));

describe("Settings > Permission profiles, the list", () => {
  it("draws the lead and one row per profile, shipped profiles first", async () => {
    await openList();

    expect(screen.getByText(/A profile bounds what a session may do/)).toBeTruthy();
    expect(listProfileRows().map((row) => row.textContent)).toEqual([
      "standardShipped with Hercule2 of 44Ada",
      "unrestrictedShipped with Hercule3 of 44Milo",
      "BusyMade by you0 of 44nightly, pr-review",
      "TriageMade by you1 of 44Nothing",
    ]);
  });

  it("stacks at most three faces for a profile that many agents use, and counts the rest", async () => {
    const crowd = ["pr-review", "nightly", "triage", "lint", "deploy"].map((name, index) =>
      buildAgent(`01a06d02-7900-7000-8000-00000000010${index}`, name, BUSY.id),
    );
    await openList({ "GET /api/v1/agents": { body: { items: crowd } } });

    const busy = screen.getByRole("link", { name: /Busy/ });
    expect(busy.querySelectorAll(".profile-faces > *")).toHaveLength(3);
    expect(within(busy).getByText("deploy, lint and 3 more")).toBeTruthy();
  });

  it("opens a profile's page from its row", async () => {
    const { router } = await openList();

    await userEvent.click(screen.getByRole("link", { name: /Triage/ }));

    expect(await screen.findByRole("heading", { level: 1, name: "Triage" })).toBeTruthy();
    expect(router.state.location.pathname).toBe(`${LIST_PATH}/${TRIAGE.id}`);
  });

  it("marks the Settings list's row on the list and on a profile's page", async () => {
    await openList();
    const list = await screen.findByRole("navigation", { name: "Settings" });
    const row = within(list).getByRole("link", { name: "Permission profiles" });
    expect(row.classList.contains("is-on")).toBe(true);

    await userEvent.click(screen.getByRole("link", { name: /Triage/ }));

    await screen.findByRole("heading", { level: 1, name: "Triage" });
    expect(row.classList.contains("is-on")).toBe(true);
  });

  it("opens the list again when Settings is opened after leaving a profile's page", async () => {
    const { fake, router } = await openProfile(TRIAGE);

    await userEvent.click(screen.getByRole("link", { name: /Fix flaky webhook tests/ }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${FIXTURE_THREAD_IDS.flaky}`);
    });
    fake.sendMenuCommand("openSettings");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Permission profiles" }),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe(LIST_PATH);
  });

  it("creates a profile with no grants from the header's button and opens it", async () => {
    const { calls, router } = await openList();

    await userEvent.click(screen.getByRole("button", { name: "New profile" }));

    expect(await screen.findByRole("heading", { level: 1, name: "New profile" })).toBeTruthy();
    expect(router.state.location.pathname).toBe(`${LIST_PATH}/${CREATED_ID}`);
    expect(
      calls.filter((call) => call.method === "POST" && call.path === "/api/v1/profiles"),
    ).toEqual([expect.objectContaining({ body: { name: "New profile", grants: [] } })]);
  });

  it("names a new profile 'New profile 2' while 'New profile' is taken", async () => {
    const { calls } = await openAt(LIST_PATH, {}, [
      ...ALL_PROFILES,
      buildProfile({ id: "01a06d02-7500-7000-8000-000000000006", name: "New profile" }),
    ]);
    await screen.findByRole("heading", { level: 1, name: "Permission profiles" });

    await userEvent.click(screen.getByRole("button", { name: "New profile" }));

    expect(await screen.findByRole("heading", { level: 1, name: "New profile 2" })).toBeTruthy();
    expect(
      calls.find((call) => call.method === "POST" && call.path === "/api/v1/profiles")?.body,
    ).toEqual({
      name: "New profile 2",
      grants: [],
    });
  });

  it("shows why the profile could not be created, and stays on the list", async () => {
    const { router } = await openList({
      "POST /api/v1/profiles": {
        status: 409,
        body: buildErrorBody("conflict", "A profile named New profile exists."),
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "New profile" }));

    const error = await screen.findByRole("alert");
    expect(error.textContent).toBe(
      "Could not create the profile: A profile named New profile exists.",
    );
    expect(router.state.location.pathname).toBe(LIST_PATH);
  });

  it("picks a fresh name when a retry follows a conflict with a profile the list did not show", async () => {
    const takenBehindOurBack = buildProfile({
      id: "01a06d02-7500-7000-8000-000000000006",
      name: "New profile",
    });
    let listed = ALL_PROFILES;
    let creates = 0;
    const { calls } = await openList({
      "GET /api/v1/profiles": () => ({ body: { items: listed } }),
      "POST /api/v1/profiles": (call) => {
        if (++creates === 1) {
          listed = [...ALL_PROFILES, takenBehindOurBack];
          return {
            status: 409,
            body: buildErrorBody("conflict", "A profile named New profile exists."),
          };
        }
        const created = buildProfile({ id: CREATED_ID, ...(call.body as Pick<Profile, "name">) });
        listed = [...listed, created];
        return { body: created };
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "New profile" }));
    await screen.findByRole("alert");
    // The list is read again after the refusal, and now shows the profile that was taken.
    await screen.findByRole("link", { name: /New profile/ });
    await userEvent.click(screen.getByRole("button", { name: "New profile" }));

    expect(await screen.findByRole("heading", { level: 1, name: "New profile 2" })).toBeTruthy();
    expect(
      calls
        .filter((call) => call.method === "POST" && call.path === "/api/v1/profiles")
        .map((call) => call.body),
    ).toEqual([
      { name: "New profile", grants: [] },
      { name: "New profile 2", grants: [] },
    ]);
  });

  it("goes back to the list from an id that names no profile", async () => {
    const { router } = await openAt(`${LIST_PATH}/01a06d02-7500-7000-8000-0000000000ff`);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Permission profiles" }),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe(LIST_PATH);
  });
});

describe("Settings > Permission profiles, a profile's page", () => {
  it("names the profile in the header, with the list linked", async () => {
    const { router } = await openProfile(TRIAGE);

    const crumb = within(screen.getByRole("banner")).getByRole("link", {
      name: "Permission profiles",
    });
    await userEvent.click(crumb);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(LIST_PATH);
    });
  });

  it("counts the grants held, and presses the verbs the profile holds", async () => {
    await openProfile(UNRESTRICTED);

    const heading = screen.getByRole("heading", { level: 2, name: /^Grants/ });
    expect(heading.textContent).toBe("Grants3 of 44");
    expect(findVerb("Tasks", "Read").getAttribute("aria-pressed")).toBe("true");
    expect(findVerb("Tasks", "Create").getAttribute("aria-pressed")).toBe("false");
    expect(findVerb("Tasks", "Delete").getAttribute("aria-pressed")).toBe("true");
    expect(findVerb("Workflows", "Read").getAttribute("aria-pressed")).toBe("true");
  });

  it("saves the whole grant list, in the contract's order, at each press", async () => {
    const { calls } = await openProfile(TRIAGE);

    await userEvent.click(findVerb("Tasks", "Delete"));
    await userEvent.click(findVerb("Sessions", "Spawn"));
    await userEvent.click(findVerb("Tasks", "Read"));

    await waitFor(() => {
      expect(listUpdates(calls, TRIAGE.id)).toEqual([
        { grants: ["task.read", "task.delete"] },
        { grants: ["task.read", "task.delete", "session.spawn"] },
        { grants: ["task.delete", "session.spawn"] },
      ]);
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2, name: /^Grants/ }).textContent).toBe(
        "Grants2 of 44",
      );
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("puts a toggle back and shows why under its row when the save fails", async () => {
    await openProfile(TRIAGE, {
      [`PATCH /api/v1/profiles/${TRIAGE.id}`]: {
        status: 500,
        body: buildErrorBody("internal", "The database is locked."),
      },
    });
    const verb = findVerb("Tasks", "Delete");

    await userEvent.click(verb);

    const error = await screen.findByRole("alert");
    expect(error.textContent).toBe("Could not save: The database is locked.");
    expect(verb.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("heading", { level: 2, name: /^Grants/ }).textContent).toBe(
      "Grants1 of 44",
    );
    // The error sits right under the row of the grant that was pressed.
    expect(error.previousElementSibling?.contains(verb)).toBe(true);
  });

  it("shows a failed save under its row while a later save is queued, and keeps only the later change", async () => {
    const store = storeProfiles(ALL_PROFILES);
    const update = store[`PATCH /api/v1/profiles/${TRIAGE.id}`]!;
    const first = holdAnswer();
    let updates = 0;
    // The first update is held, and fails without storing anything.
    const { calls } = await openProfile(TRIAGE, {
      ...store,
      [`PATCH /api/v1/profiles/${TRIAGE.id}`]: (call) =>
        ++updates === 1 ? first.handler() : update(call),
    });
    const tasksDelete = findVerb("Tasks", "Delete");

    await userEvent.click(tasksDelete);
    // The save reads the profile first, so the update is sent a moment later.
    await waitFor(() => {
      expect(listUpdates(calls, TRIAGE.id)).toHaveLength(1);
    });
    await userEvent.click(findVerb("Sessions", "Spawn"));
    first.answer({ status: 500, body: buildErrorBody("internal", "The database is locked.") });

    const error = await screen.findByRole("alert");
    expect(error.textContent).toBe("Could not save: The database is locked.");
    // The error sits under the row of the failed change, not the queued one.
    expect(error.previousElementSibling?.contains(tasksDelete)).toBe(true);
    await waitFor(() => {
      expect(listUpdates(calls, TRIAGE.id)).toEqual([
        { grants: ["task.read", "task.delete"] },
        { grants: ["task.read", "session.spawn"] },
      ]);
    });
    expect(tasksDelete.getAttribute("aria-pressed")).toBe("false");
    expect(findVerb("Sessions", "Spawn").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("heading", { level: 2, name: /^Grants/ }).textContent).toBe(
      "Grants2 of 44",
    );
  });

  it("saves a new name, and the header follows it", async () => {
    const { calls } = await openProfile(TRIAGE);
    const name = screen.getByRole("textbox", { name: "Name" });

    await userEvent.clear(name);
    await userEvent.type(name, "Triage 2{Enter}");

    expect(await screen.findByRole("heading", { level: 1, name: "Triage 2" })).toBeTruthy();
    await waitFor(() => {
      expect(listUpdates(calls, TRIAGE.id)).toEqual([{ name: "Triage 2" }]);
    });
  });

  it("puts the name back and shows why under its row when the save fails", async () => {
    await openProfile(TRIAGE, {
      [`PATCH /api/v1/profiles/${TRIAGE.id}`]: {
        status: 409,
        body: buildErrorBody("conflict", "A profile named Busy exists."),
      },
    });
    const name = screen.getByRole("textbox", { name: "Name" });

    await userEvent.clear(name);
    await userEvent.type(name, "Busy{Enter}");

    const error = await screen.findByRole("alert");
    expect(error.textContent).toBe("Could not save: A profile named Busy exists.");
    expect(name).toHaveProperty("value", "Triage");
    expect(screen.getByRole("heading", { level: 1, name: "Triage" })).toBeTruthy();
  });

  it("saves nothing for a name that is empty or only spaces, and shows the saved name again", async () => {
    const { calls } = await openProfile(TRIAGE);
    const name = screen.getByRole("textbox", { name: "Name" });

    await userEvent.clear(name);
    await userEvent.type(name, "   {Enter}");

    expect(name).toHaveProperty("value", "Triage");
    expect(screen.getByRole("heading", { level: 1, name: "Triage" })).toBeTruthy();
    expect(listUpdates(calls, TRIAGE.id)).toEqual([]);
  });

  it("lists the assistants and agents that use the profile, and links to Assistants", async () => {
    await openProfile(BUSY);

    const heading = screen.getByRole("heading", { level: 2, name: "Used by" });
    const section = heading.parentElement!;
    expect(
      within(section)
        .getAllByText(/^(nightly|pr-review)$/)
        .map((each) => each.textContent),
    ).toEqual(["nightly", "pr-review"]);
    expect(within(section).getAllByText("Agent")).toHaveLength(2);
    expect(within(section).getByRole("link", { name: "Assistants" }).getAttribute("href")).toBe(
      "/settings/assistants",
    );
  });

  it("says that nothing uses a profile nobody carries", async () => {
    await openProfile(TRIAGE);

    expect(screen.getByText("No agent or assistant uses Triage.")).toBeTruthy();
  });

  it("names an assistant that uses the profile", async () => {
    await openProfile(STANDARD);

    const section = screen.getByRole("heading", { level: 2, name: "Used by" }).parentElement!;
    expect(within(section).getByText("Ada")).toBeTruthy();
    expect(within(section).getByText("Assistant")).toBeTruthy();
  });
});

describe("Settings > Permission profiles, the unrestricted profile", () => {
  it("warns above its grants, and no other profile does", async () => {
    await openProfile(UNRESTRICTED);
    expect(screen.getByText(/Unrestricted is meant to hold every grant/)).toBeTruthy();

    await userEvent.click(
      within(screen.getByRole("banner")).getByRole("link", { name: "Permission profiles" }),
    );
    await userEvent.click(await screen.findByRole("link", { name: /Triage/ }));
    await screen.findByRole("heading", { level: 1, name: "Triage" });

    expect(screen.queryByText(/Unrestricted is meant to hold every grant/)).toBeNull();
  });

  it("asks before taking a grant away, and saves nothing on Cancel", async () => {
    const { calls } = await openProfile(UNRESTRICTED);

    await userEvent.click(findVerb("Tasks", "Delete"));
    const dialog = await screen.findByRole("dialog", { name: "Change unrestricted?" });
    expect(
      within(dialog).getByText("This takes Delete on Tasks away from unrestricted."),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/Threads run on unrestricted unless you pick another profile/),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(listUpdates(calls, UNRESTRICTED.id)).toEqual([]);
    expect(findVerb("Tasks", "Delete").getAttribute("aria-pressed")).toBe("true");
  });

  it("takes the grant away on Change", async () => {
    const { calls } = await openProfile(UNRESTRICTED);

    await userEvent.click(findVerb("Tasks", "Delete"));
    const dialog = await screen.findByRole("dialog", { name: "Change unrestricted?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Change" }));

    await waitFor(() => {
      expect(listUpdates(calls, UNRESTRICTED.id)).toEqual([
        { grants: ["task.read", "workflow.read"] },
      ]);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(findVerb("Tasks", "Delete").getAttribute("aria-pressed")).toBe("false");
  });

  it("asks before giving a grant back, with its own words", async () => {
    const { calls } = await openProfile(UNRESTRICTED);

    await userEvent.click(findVerb("Tasks", "Create"));
    const dialog = await screen.findByRole("dialog", { name: "Change unrestricted?" });
    expect(
      within(dialog).getByText("This gives Create on Tasks back to unrestricted."),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Change" }));

    await waitFor(() => {
      expect(listUpdates(calls, UNRESTRICTED.id)).toEqual([
        { grants: ["task.read", "task.create", "task.delete", "workflow.read"] },
      ]);
    });
  });
});

describe("Settings > Permission profiles, Delete", () => {
  it("has no button on a shipped profile, only the line that says why", async () => {
    await openProfile(STANDARD);

    expect(screen.getByRole("heading", { level: 2, name: "Delete standard" })).toBeTruthy();
    expect(
      screen.getByText(
        "standard is shipped with Hercule, so it cannot be deleted. Edit its grants instead.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete profile" })).toBeNull();
  });

  it("disables the button of a profile that is in use, and names the agents in the hint", async () => {
    const { calls } = await openProfile(BUSY);

    const button = screen.getByRole("button", { name: "Delete profile" });
    expect(button).toHaveProperty("disabled", true);
    expect(
      screen.getByText("nightly and pr-review use it. Move them to another profile first."),
    ).toBeTruthy();
    await userEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("deletes a profile only once the dialog confirms it, then goes back to the list", async () => {
    const { calls, router } = await openProfile(TRIAGE);

    expect(screen.getByText("Removes it and its grants.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Delete profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Triage?" });
    expect(
      within(dialog).getByText("This removes Triage and its grants. This cannot be undone."),
    ).toBeTruthy();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(LIST_PATH);
    });
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      `/api/v1/profiles/${TRIAGE.id}`,
    ]);
    await screen.findByRole("heading", { level: 1, name: "Permission profiles" });
    expect(listProfileRows().map((row) => row.textContent)).toEqual([
      "standardShipped with Hercule2 of 44Ada",
      "unrestrictedShipped with Hercule3 of 44Milo",
      "BusyMade by you0 of 44nightly, pr-review",
    ]);
  });

  it("deletes nothing when the dialog is cancelled", async () => {
    const { calls, router } = await openProfile(TRIAGE);

    await userEvent.click(screen.getByRole("button", { name: "Delete profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Triage?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(router.state.location.pathname).toBe(`${LIST_PATH}/${TRIAGE.id}`);
  });

  it("shows the controller's refusal in the dialog, which stays open", async () => {
    const { router } = await openProfile(TRIAGE, {
      [`DELETE /api/v1/profiles/${TRIAGE.id}`]: {
        status: 409,
        body: buildErrorBody("invalid_state", "A live session still uses Triage."),
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "Delete profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Triage?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    const error = await within(dialog).findByRole("alert");
    expect(error.textContent).toBe("Could not delete: A live session still uses Triage.");
    expect(router.state.location.pathname).toBe(`${LIST_PATH}/${TRIAGE.id}`);
    // The refusal clears when the user asks again.
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete profile" }));
    expect(
      within(await screen.findByRole("dialog", { name: "Delete Triage?" })).queryByRole("alert"),
    ).toBeNull();
  });
});
