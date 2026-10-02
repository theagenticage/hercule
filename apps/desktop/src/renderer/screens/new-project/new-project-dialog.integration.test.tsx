/**
 * Tests the New project dialog as the project picker's last row opens it:
 * the folder the user picks, the requests that create the project and its
 * repository, the draft it opens, and what it says when there is no GitHub
 * Connection, no remote, no repository, or a repository the controller
 * refused.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { REMOTE_REFUSAL } from "@hercule/client-core";
import { GITHUB_CONNECTION_TYPE, type Connection, type Project } from "@hercule/contract";
import type { FolderPickOutcome } from "../../../ipc/contract";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_THREAD_IDS,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  type Call,
  type Handler,
} from "../../app/testing";

const [WEBSHOP] = SIDEBAR_FIXTURE.projects;
const [WEBSHOP_REPO] = SIDEBAR_FIXTURE.resources;

const GITHUB: Connection = {
  id: "01a06d02-7700-7000-8000-000000000001",
  type: GITHUB_CONNECTION_TYPE,
  label: "rogier",
  displayName: "rogier",
  status: "connected",
  labels: [],
  config: {},
  credentials: [],
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
};

/** The project the controller creates. */
const SHOP: Project = { ...WEBSHOP!, id: "01a06d02-7000-7000-8000-0000000000aa", name: "shop" };

const REMOTE = "git@github.com:rogier/shop.git";

const REPOSITORY: FolderPickOutcome = {
  _tag: "Repository",
  name: "shop",
  remote: REMOTE,
  branch: "main",
};

/** Returns the requests sent to `path` with `method`. */
const readCalls = (calls: readonly Call[], method: string, path: string): readonly Call[] =>
  calls.filter((call) => call.method === method && call.path === path);

/** Returns the writes among `calls`: every POST but the live connection's ticket. */
const readWrites = (calls: readonly Call[]): readonly Call[] =>
  calls.filter((call) => call.method === "POST" && call.path !== "/api/v1/auth/ws-ticket");

/**
 * Opens the app at a thread with `connections`, opens the New project
 * dialog from the picker, and picks the folder `folder` describes. The
 * project list grows by the project once `POST /projects` answers, as the
 * controller's would. Returns the dialog with the app.
 */
const pickFolder = async ({
  folder,
  connections = [GITHUB],
  handlers = {},
}: {
  readonly folder: FolderPickOutcome;
  readonly connections?: readonly Connection[];
  readonly handlers?: Readonly<Record<string, Handler>>;
}) => {
  let projects = SIDEBAR_FIXTURE.projects;
  const calls = stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    "GET /api/v1/connections": { body: { items: connections } },
    "GET /api/v1/projects": () => ({ body: { items: projects } }),
    "POST /api/v1/projects": () => {
      projects = [...projects, SHOP];
      return { body: SHOP };
    },
    "POST /api/v1/resources": { body: { ...WEBSHOP_REPO!, projectIds: [SHOP.id] } },
    ...handlers,
  });
  const fake = createFakeBridge({
    controllerUrl: CONTROLLER_URL,
    token: "bearer",
    pickFolder: () => Promise.resolve(folder),
  });
  const app = await renderApp(fake, { path: `/threads/${FIXTURE_THREAD_IDS.flaky}` });
  await userEvent.click(await screen.findByRole("button", { name: "New thread ⌘N" }));
  const picker = await screen.findByRole("dialog", { name: "New thread in" });
  await userEvent.click(within(picker).getByRole("button", { name: "New project" }));
  const dialog = await screen.findByRole<HTMLDialogElement>("dialog", { name: "New project" });
  await userEvent.click(await within(dialog).findByRole("button", { name: "Choose a folder…" }));
  await within(dialog).findByText(folder._tag === "Cancelled" ? "Choose a folder…" : folder.name);
  return { calls, dialog, view: within(dialog), ...app };
};

/** Waits until the draft in the new project is open and the dialog has closed. */
const expectDraftInShop = async (router: { readonly state: { location: { href: string } } }) => {
  await waitFor(() => {
    expect(router.state.location.href).toBe(`/?project=${SHOP.id}`);
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" }));
  });
};

describe("the New project dialog", () => {
  it("creates the project and its repository through the GitHub Connection, then opens a draft in it", async () => {
    const { calls, view, router } = await pickFolder({ folder: REPOSITORY });

    expect(view.getByText("rogier/shop · main", { exact: false })).toBeTruthy();
    await userEvent.type(view.getByRole("textbox", { name: /^Setup command/ }), " pnpm install ");
    await userEvent.click(view.getByRole("button", { name: "Add project" }));

    await expectDraftInShop(router);
    expect(readCalls(calls, "POST", "/api/v1/projects").map((call) => call.body)).toEqual([
      { name: "shop" },
    ]);
    expect(readCalls(calls, "POST", "/api/v1/resources").map((call) => call.body)).toEqual([
      {
        kind: "repo",
        remote: REMOTE,
        connectionId: GITHUB.id,
        setupCommand: "pnpm install",
        projectIds: [SHOP.id],
      },
    ]);
  });

  it("creates the project without its repository when there is no GitHub Connection, and says so", async () => {
    const { calls, view, router } = await pickFolder({ folder: REPOSITORY, connections: [] });

    expect(view.getByText("shop starts without its repository.").parentElement?.textContent).toBe(
      "shop starts without its repository. Runners clone it through a GitHub Connection, and there is none yet. Connect GitHub in the web app, then add shop’s repository there.",
    );
    expect(view.queryByRole("button", { name: "Connect GitHub now" })).toBeNull();
    expect(view.queryByRole("textbox", { name: /^Setup command/ })).toBeNull();
    await userEvent.click(view.getByRole("button", { name: "Add project without a repository" }));

    await expectDraftInShop(router);
    expect(readCalls(calls, "POST", "/api/v1/projects")).toHaveLength(1);
    expect(readCalls(calls, "POST", "/api/v1/resources")).toHaveLength(0);
  });

  it("offers to create the project without a repository from a folder that is not one", async () => {
    const { calls, view, router } = await pickFolder({ folder: { _tag: "NotGit", name: "shop" } });

    expect(view.getByText("Not a git repository")).toBeTruthy();
    await userEvent.click(view.getByRole("button", { name: "Create shop without a repository" }));

    await expectDraftInShop(router);
    expect(readCalls(calls, "POST", "/api/v1/resources")).toHaveLength(0);
  });

  it("names git's error when git could not read the folder", async () => {
    const { view } = await pickFolder({
      folder: { _tag: "GitFailed", name: "shop", line: "fatal: detected dubious ownership" },
    });

    expect(view.getByText("Git could not read this folder.").parentElement?.textContent).toContain(
      "It stopped with “fatal: detected dubious ownership”.",
    );
    expect(view.getByRole("button", { name: "Create shop without a repository" })).toBeTruthy();
  });

  it("asks for the remote of a repository with none, and refuses one runners cannot clone before sending", async () => {
    const { calls, view, router } = await pickFolder({
      folder: { _tag: "NoRemote", name: "shop", branch: "main" },
    });

    expect(view.getByText("git · main · no remote")).toBeTruthy();
    const add = view.getByRole<HTMLButtonElement>("button", { name: "Add project" });
    expect(add.disabled).toBe(true);
    const remote = view.getByRole("textbox", { name: "Remote URL" });

    await userEvent.type(remote, "/Users/rogier/code/shop{Enter}");
    expect((await view.findByRole("alert")).textContent).toBe(REMOTE_REFUSAL);
    expect(readWrites(calls)).toHaveLength(0);

    await userEvent.clear(remote);
    await userEvent.type(remote, REMOTE);
    await userEvent.click(add);

    await expectDraftInShop(router);
    expect(readCalls(calls, "POST", "/api/v1/resources").map((call) => call.body)).toEqual([
      { kind: "repo", remote: REMOTE, connectionId: GITHUB.id, projectIds: [SHOP.id] },
    ]);
  });

  it("asks for a remote when the folder's remote is a path runners cannot clone", async () => {
    const { view } = await pickFolder({
      folder: { ...REPOSITORY, remote: "/Volumes/backup/shop.git" },
    });

    expect(view.getByText("Runners can’t clone from this remote.")).toBeTruthy();
    expect(view.getByRole<HTMLInputElement>("textbox", { name: "Remote URL" }).value).toBe(
      "/Volumes/backup/shop.git",
    );
  });

  it("says when the repository was refused, and sends only the repository again", async () => {
    let refuse = true;
    const { calls, view, router } = await pickFolder({
      folder: REPOSITORY,
      handlers: {
        "POST /api/v1/resources": () =>
          refuse
            ? {
                status: 409,
                body: {
                  error: { code: "conflict", message: "That remote is already a resource." },
                },
              }
            : { body: { ...WEBSHOP_REPO!, projectIds: [SHOP.id] } },
      },
    });

    await userEvent.click(view.getByRole("button", { name: "Add project" }));

    expect((await view.findByRole("alert")).textContent).toBe(
      "shop was added, but its repository wasn’t: That remote is already a resource.",
    );
    expect(view.getByRole<HTMLInputElement>("textbox", { name: "Project name" }).disabled).toBe(
      true,
    );
    expect(view.queryByRole("button", { name: "Change" })).toBeNull();
    expect(view.getByRole("button", { name: "Continue without the repository" })).toBeTruthy();

    refuse = false;
    await userEvent.click(view.getByRole("button", { name: "Add project" }));

    await expectDraftInShop(router);
    expect(readCalls(calls, "POST", "/api/v1/projects")).toHaveLength(1);
    expect(readCalls(calls, "POST", "/api/v1/resources")).toHaveLength(2);
  });

  it("opens the draft in the project as it is when the user continues without the repository", async () => {
    const { calls, view, router } = await pickFolder({
      folder: REPOSITORY,
      handlers: {
        "POST /api/v1/resources": {
          status: 409,
          body: { error: { code: "conflict", message: "That remote is already a resource." } },
        },
      },
    });

    await userEvent.click(view.getByRole("button", { name: "Add project" }));
    await userEvent.click(
      await view.findByRole("button", { name: "Continue without the repository" }),
    );

    await expectDraftInShop(router);
    expect(readCalls(calls, "POST", "/api/v1/resources")).toHaveLength(1);
  });

  it("keeps the folder button when the user cancels the folder dialog, and closes on Esc", async () => {
    const { calls, view, router } = await pickFolder({ folder: { _tag: "Cancelled" } });

    expect(view.getByRole("button", { name: "Choose a folder…" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(router.state.location.pathname).toBe(`/threads/${FIXTURE_THREAD_IDS.flaky}`);
    expect(readWrites(calls)).toHaveLength(0);
  });
});
