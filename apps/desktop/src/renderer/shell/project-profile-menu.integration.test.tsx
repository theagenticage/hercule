/**
 * Tests a project's context menu in the sidebar: it opens on a right-click
 * of the project's heading, checks the project's Model Profile (None for a
 * profile that was deleted), and writes `project.update` when a choice is
 * taken.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ModelProfile, Project } from "@hercule/contract";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_MODEL_PROFILE,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  type Call,
  type Handler,
} from "../app/testing";

beforeEach(() => {
  stubElementSize(272, 800);
});

const MAIN: ModelProfile = FIXTURE_MODEL_PROFILE;
const QUICK: ModelProfile = {
  ...FIXTURE_MODEL_PROFILE,
  id: "01a06d02-7800-7000-8000-000000000002",
  name: "Quick fixes",
};

const [WEBSHOP] = SIDEBAR_FIXTURE.projects;

/** Returns the requests sent to `PATCH /projects/:id` for the webshop project. */
const readUpdates = (calls: readonly Call[]): readonly Call[] =>
  calls.filter(
    (call) => call.method === "PATCH" && call.path === `/api/v1/projects/${WEBSHOP!.id}`,
  );

/**
 * Starts the app with the controller holding `profiles` and the webshop
 * project as `project`, and returns the sidebar's list. `update` answers
 * `PATCH /projects/:id`.
 */
const startApp = async ({
  project = WEBSHOP!,
  profiles = [MAIN, QUICK],
  update = (): { body: Project } => ({ body: project }),
}: {
  readonly project?: Project;
  readonly profiles?: readonly ModelProfile[];
  readonly update?: Handler;
} = {}) => {
  const calls = stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      projects: [project, ...SIDEBAR_FIXTURE.projects.slice(1)],
      modelProfiles: profiles,
    }),
    [`PATCH /api/v1/projects/${project.id}`]: update,
  });
  await renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }));
  const nav = await screen.findByRole("navigation", { name: "Threads" });
  return { calls, nav };
};

/** Returns the heading in `nav` whose text starts with `text`. */
const getHeading = (nav: HTMLElement, text: string): HTMLElement =>
  within(nav)
    .getAllByRole("heading")
    .find((each) => each.textContent?.startsWith(text))!;

/** Starts the app as `startApp` does, right-clicks the webshop heading, and returns the menu it opens. */
const openMenu = async (options: Parameters<typeof startApp>[0] = {}) => {
  const { calls, nav } = await startApp(options);
  fireEvent.contextMenu(getHeading(nav, "webshop"), { clientX: 40, clientY: 90 });
  await waitFor(() => {
    expect(findMenu()).not.toBeNull();
  });
  const menu = findMenu()!;
  expect(menu.getAttribute("aria-label")).toBe("webshop");
  return { calls, nav, menu };
};

// jsdom hides a popover until it matches `:popover-open`, which its
// `showPopover` stub never sets. So the menu's queries pass `hidden: true`, and
// find the menu and its choices without a `name`, because an element jsdom
// hides has no accessible name.

/**
 * Returns the project menu, or `null` when none is mounted. The draft's own
 * menus are in the page too, so the role `menu` does not name this one.
 */
const findMenu = (): HTMLElement | null => document.querySelector<HTMLElement>(".project-menu");

/** Returns the choice in `menu` named `name`. */
const getChoice = (menu: HTMLElement, name: string): HTMLElement =>
  within(menu)
    .getAllByRole("menuitemradio", { hidden: true })
    .find((item) => item.textContent === name)!;

/** Returns the names of the choices in `menu` that are checked. */
const readChecked = (menu: HTMLElement): readonly string[] =>
  within(menu)
    .getAllByRole("menuitemradio", { checked: true, hidden: true })
    .map((item) => item.textContent ?? "");

describe("a project's context menu", () => {
  it("lists each profile and None under Model profile, with None checked for a project that names none", async () => {
    const { menu } = await openMenu();

    expect(within(menu).getByRole("group", { hidden: true }).getAttribute("aria-labelledby")).toBe(
      within(menu).getByText("Model profile").id,
    );
    expect(
      within(menu)
        .getAllByRole("menuitemradio", { hidden: true })
        .map((item) => item.textContent),
    ).toEqual(["Main", "Quick fixes", "None"]);
    expect(readChecked(menu)).toEqual(["None"]);
  });

  it("checks the profile the project names", async () => {
    const { menu } = await openMenu({ project: { ...WEBSHOP!, modelProfileId: QUICK.id } });

    expect(readChecked(menu)).toEqual(["Quick fixes"]);
  });

  it("checks None for a project that names a profile that no longer exists", async () => {
    const { menu } = await openMenu({
      project: { ...WEBSHOP!, modelProfileId: "01a06d02-7800-7000-8000-0000000000ff" },
    });

    expect(readChecked(menu)).toEqual(["None"]);
  });

  it("opens with only one profile, as the user can still choose None", async () => {
    const { menu } = await openMenu({ profiles: [MAIN] });

    expect(
      within(menu)
        .getAllByRole("menuitemradio", { hidden: true })
        .map((item) => item.textContent),
    ).toEqual(["Main", "None"]);
  });

  it("writes the profile taken, closes the menu, and reads the projects again", async () => {
    const { calls, menu } = await openMenu();
    const countReads = (): number =>
      calls.filter((call) => call.method === "GET" && call.path === "/api/v1/projects").length;
    const readsBefore = countReads();

    await userEvent.click(getChoice(menu, "Quick fixes"));

    await waitFor(() => {
      expect(readUpdates(calls).map((call) => call.body)).toEqual([{ modelProfileId: QUICK.id }]);
    });
    expect(findMenu()).toBeNull();
    await waitFor(() => {
      expect(countReads()).toBeGreaterThan(readsBefore);
    });
  });

  it("clears the project's profile with None", async () => {
    const { calls, menu } = await openMenu({ project: { ...WEBSHOP!, modelProfileId: MAIN.id } });

    await userEvent.click(getChoice(menu, "None"));

    await waitFor(() => {
      expect(readUpdates(calls).map((call) => call.body)).toEqual([{ modelProfileId: null }]);
    });
  });

  it("writes nothing when the choice taken is the one already checked", async () => {
    const { calls, menu } = await openMenu({ project: { ...WEBSHOP!, modelProfileId: MAIN.id } });

    await userEvent.click(getChoice(menu, "Main"));

    expect(findMenu()).toBeNull();
    expect(readUpdates(calls)).toEqual([]);
  });

  it("shows the controller's error in the toast when the write fails", async () => {
    const { menu } = await openMenu({
      update: () => ({
        status: 400,
        body: buildErrorBody("validation", "That profile does not exist."),
      }),
    });

    await userEvent.click(getChoice(menu, "Quick fixes"));

    const failure = await screen.findByText(
      "Couldn't set the model profile: That profile does not exist.",
    );
    expect(failure.closest("[role=alert]")).not.toBeNull();
  });

  it("opens no menu on the heading of the threads in no project", async () => {
    const { nav } = await startApp();

    // The heading takes the event over, and so cancels it, only for a project.
    const notCancelled = fireEvent.contextMenu(getHeading(nav, "No project"), {
      clientX: 40,
      clientY: 400,
    });

    expect(notCancelled).toBe(true);
    expect(findMenu()).toBeNull();
  });
});
