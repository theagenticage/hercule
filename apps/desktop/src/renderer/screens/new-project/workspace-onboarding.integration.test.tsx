/** Exercises repository choices and recovery through the actual New project dialog. */
import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { queryKeys } from "@hercule/client-core";
import type { Project, Runner, Workspace } from "@hercule/contract";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_GITHUB_CONNECTION,
  FIXTURE_THREAD_IDS,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  type Call,
  type Handler,
} from "../../app/testing";

const RUNNER: Runner = {
  ...SIDEBAR_FIXTURE.runners[0]!,
  name: "studio",
  facts: {
    os: "darwin",
    arch: "arm64",
    totalMemoryBytes: 1024,
    docker: false,
    toolchains: [],
    providers: [],
    adapters: ["claude-code"],
    identityPort: 4939,
  },
};
const PROJECT: Project = {
  ...SIDEBAR_FIXTURE.projects[0]!,
  id: "01a06d02-7000-7000-8000-0000000000aa",
  name: "shop",
};
const RESOURCE = { ...SIDEBAR_FIXTURE.resources[0]!, projectIds: [PROJECT.id] };
const PATH = "/Users/fixture/source with spaces/shop";
const FOLDER = {
  _tag: "Repository" as const,
  name: "shop",
  remote: RESOURCE.remote ?? "https://github.com/fixture/shop.git",
  branch: "main",
  path: PATH,
};
const WORKSPACE: Workspace = {
  ...SIDEBAR_FIXTURE.workspaces[0]!,
  id: "01a06d02-7300-7000-8000-0000000000aa",
  runnerId: RUNNER.id,
  sessionIds: [],
  path: PATH,
  ownership: "adopted",
  status: "ready",
};

const readCalls = (calls: readonly Call[], method: string, path: string) =>
  calls.filter((call) => call.method === method && call.path === path);

/** Opens New project through the real thread picker with the requested identity evidence. */
const openProject = async ({
  identities = { 4939: RUNNER.id },
  runner = RUNNER,
  handlers = {},
  pick = () => Promise.resolve(FOLDER),
  probe,
}: {
  readonly identities?: Readonly<Record<number, string>>;
  readonly runner?: Runner;
  readonly handlers?: Readonly<Record<string, Handler>>;
  readonly pick?: () => Promise<typeof FOLDER>;
  readonly probe?: (port: number) => Promise<string | null>;
} = {}) => {
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, runners: [runner] }),
    "GET /api/v1/connections": { body: { items: [FIXTURE_GITHUB_CONNECTION] } },
    "POST /api/v1/projects": { body: PROJECT },
    "POST /api/v1/resources": { body: RESOURCE },
    [`PATCH /api/v1/resources/${RESOURCE.id}`]: { body: RESOURCE },
    "POST /api/v1/workspaces/attach": { body: WORKSPACE },
    "POST /api/v1/workspaces": { body: { ...WORKSPACE, ownership: "managed", path: null } },
    ...handlers,
  });
  const fake = createFakeBridge({
    controllerUrl: CONTROLLER_URL,
    token: "bearer",
    runnerIdentities: identities,
    pickFolder: pick,
  });
  const effectiveFake =
    probe === undefined
      ? fake
      : {
          ...fake,
          bridge: {
            ...fake.bridge,
            runnerIdentity: { read: ({ port }: { readonly port: number }) => probe(port) },
          },
        };
  const app = await renderApp(effectiveFake, { path: `/threads/${FIXTURE_THREAD_IDS.flaky}` });
  await userEvent.click(await screen.findByRole("button", { name: "New thread ⌘N" }));
  const picker = await screen.findByRole("dialog", { name: "New thread in" });
  await userEvent.click(within(picker).getByRole("button", { name: "New project" }));
  const dialog = await screen.findByRole<HTMLDialogElement>("dialog", { name: "New project" });
  return { calls, view: within(dialog), ...app };
};

const chooseFolder = async (view: Awaited<ReturnType<typeof openProject>>["view"]) => {
  await userEvent.click(await view.findByRole("button", { name: "Choose a folder…" }));
  await view.findByText("shop");
};

describe("repository onboarding", () => {
  it.each(["Use this checkout", "Create a separate checkout"])(
    "shows the same selected runner/path and Resource identity for %s",
    async (choice) => {
      const { calls, view } = await openProject();
      await chooseFolder(view);
      expect(await view.findByText(PATH, { exact: false })).toBeTruthy();
      expect(view.getByText(RUNNER.name, { exact: false })).toBeTruthy();
      await userEvent.click(await view.findByText(choice, { exact: true }));
      await userEvent.click(view.getByRole("button", { name: "Add project" }));
      const operation =
        choice === "Use this checkout" ? "/api/v1/workspaces/attach" : "/api/v1/workspaces";
      await waitFor(() => expect(readCalls(calls, "POST", operation)).toHaveLength(1));
      expect(readCalls(calls, "POST", operation)[0]?.body).toEqual({
        resourceId: RESOURCE.id,
        runnerId: RUNNER.id,
        ...(choice === "Use this checkout" ? { path: PATH } : {}),
      });
      expect(
        readCalls(
          calls,
          "POST",
          choice === "Use this checkout" ? "/api/v1/workspaces" : "/api/v1/workspaces/attach",
        ),
      ).toEqual([]);
    },
  );

  it.each([
    { identities: {} },
    { identities: { 4939: "01a06d02-7400-7000-8000-0000000000aa" } },
    { identities: { 4939: RUNNER.id }, runner: { ...RUNNER, connectivity: "offline" as const } },
  ])(
    "does not open a native folder picker without current positive local identity %j",
    async (fixture) => {
      let picks = 0;
      const { view, calls } = await openProject({
        ...fixture,
        pick: () => {
          picks++;
          return Promise.resolve(FOLDER);
        },
      });
      const choose = view.queryByRole<HTMLButtonElement>("button", { name: "Choose a folder…" });
      if (choose !== null && !choose.disabled) await userEvent.click(choose);
      expect(picks).toBe(0);
      expect(readCalls(calls, "POST", "/api/v1/workspaces/attach")).toEqual([]);
    },
  );

  it("retains project/Resource and retries the same attachment after a failed Workspace outcome", async () => {
    let refuse = true;
    const { calls, view } = await openProject({
      handlers: {
        "POST /api/v1/workspaces/attach": () => ({
          body: refuse
            ? {
                ...WORKSPACE,
                status: "failed",
                provisionedAt: null,
                message: "Restore the selected checkout before retrying.",
              }
            : WORKSPACE,
        }),
      },
    });
    await chooseFolder(view);
    await userEvent.click(await view.findByText("Use this checkout", { exact: true }));
    await userEvent.click(view.getByRole("button", { name: "Add project" }));
    expect((await view.findByRole("alert")).textContent).toContain("Restore the selected checkout");
    expect(readCalls(calls, "POST", "/api/v1/projects")).toHaveLength(1);
    expect(readCalls(calls, "POST", "/api/v1/workspaces")).toEqual([]);
    refuse = false;
    await userEvent.click(view.getByRole("button", { name: /retry/i }));
    await waitFor(() =>
      expect(readCalls(calls, "POST", "/api/v1/workspaces/attach")).toHaveLength(2),
    );
    expect(readCalls(calls, "POST", "/api/v1/workspaces/attach").map((call) => call.body)).toEqual([
      { resourceId: RESOURCE.id, runnerId: RUNNER.id, path: PATH },
      { resourceId: RESOURCE.id, runnerId: RUNNER.id, path: PATH },
    ]);
    expect(readCalls(calls, "POST", "/api/v1/projects")).toHaveLength(1);
    expect(readCalls(calls, "POST", "/api/v1/resources")).toHaveLength(0);
  });

  it("blocks attachment while a changed identity port awaits fresh positive evidence", async () => {
    let runner = RUNNER;
    let release!: () => void;
    const blocked = new Promise<string | null>((resolve) => {
      release = () => resolve(null);
    });
    const probed: number[] = [];
    const { calls, view, context } = await openProject({
      handlers: { "GET /api/v1/runners": () => ({ body: { items: [runner] } }) },
      probe: (port) => {
        probed.push(port);
        return port === 4939 ? Promise.resolve(RUNNER.id) : blocked;
      },
    });
    try {
      await chooseFolder(view);
      await userEvent.click(await view.findByText("Use this checkout", { exact: true }));
      runner = { ...RUNNER, facts: { ...RUNNER.facts!, identityPort: 4940 } };
      await context.queryClient.invalidateQueries({ queryKey: queryKeys.runners() });
      await waitFor(() => expect(probed).toContain(4940));
      const add = view.getByRole<HTMLButtonElement>("button", { name: "Add project" });
      if (!add.disabled) await userEvent.click(add);
      expect(readCalls(calls, "POST", "/api/v1/workspaces/attach")).toEqual([]);
    } finally {
      release();
    }
  });

  it("requires fresh local identity when the selected runner goes offline before submission", async () => {
    let runner = RUNNER;
    const { calls, view, context } = await openProject({
      handlers: { "GET /api/v1/runners": () => ({ body: { items: [runner] } }) },
    });
    await chooseFolder(view);
    await userEvent.click(await view.findByText("Use this checkout", { exact: true }));
    runner = { ...RUNNER, connectivity: "offline" };
    await context.queryClient.invalidateQueries({ queryKey: queryKeys.runners() });
    const add = view.getByRole<HTMLButtonElement>("button", { name: "Add project" });
    if (!add.disabled) await userEvent.click(add);
    expect(readCalls(calls, "POST", "/api/v1/workspaces/attach")).toEqual([]);
  });
  it.each([false, true])(
    "keeps a newly created Resource and retries only its attachment after failure (asynchronous=%s)",
    async (asynchronous) => {
      const remote = "https://github.com/fixture/new-api.git";
      const resource = {
        ...RESOURCE,
        id: "01a06d02-7500-7000-8000-0000000000aa",
        remote,
        canonicalRemote: "github.com/fixture/new-api",
      };
      const ready = {
        ...WORKSPACE,
        checkouts: WORKSPACE.checkouts.map((checkout) => ({
          ...checkout,
          resourceId: resource.id,
        })),
      };
      const failed: Workspace = {
        ...ready,
        status: "failed",
        provisionedAt: null,
        message: "Restore this checkout and retry the attachment.",
      };
      let current: Workspace = asynchronous
        ? { ...ready, status: "provisioning", provisionedAt: null, observedAt: null }
        : failed;
      let registered = false;
      let attached = false;
      let attempts = 0;
      const { calls, view, live } = await openProject({
        pick: () => Promise.resolve({ ...FOLDER, remote }),
        handlers: {
          "GET /api/v1/resources": () => ({
            body: {
              items: registered
                ? [...SIDEBAR_FIXTURE.resources, resource]
                : SIDEBAR_FIXTURE.resources,
            },
          }),
          "POST /api/v1/resources": () => {
            registered = true;
            return { body: resource };
          },
          [`GET /api/v1/resources/${resource.id}`]: { body: resource },
          "GET /api/v1/workspaces": () => ({
            body: {
              items: attached
                ? [...SIDEBAR_FIXTURE.workspaces, current]
                : SIDEBAR_FIXTURE.workspaces,
            },
          }),
          [`GET /api/v1/workspaces/${ready.id}`]: () => ({ body: current }),
          "POST /api/v1/workspaces/attach": () => {
            attached = true;
            attempts++;
            if (attempts > 1) current = ready;
            return { body: current };
          },
        },
      });
      await chooseFolder(view);
      await userEvent.click(await view.findByText("Use this checkout", { exact: true }));
      await userEvent.click(view.getByRole("button", { name: "Add project" }));
      await waitFor(() =>
        expect(readCalls(calls, "POST", "/api/v1/workspaces/attach")).toHaveLength(1),
      );
      if (asynchronous) {
        await live.waitForFirstPushes();
        current = failed;
        act(() => live.pushInvalidation("workspace", [ready.id]));
      }
      expect((await view.findByRole("alert")).textContent).toContain("Restore this checkout");
      expect(view.getByRole<HTMLInputElement>("textbox", { name: "Project name" }).value).toBe(
        PROJECT.name,
      );
      expect(view.getByRole<HTMLInputElement>("textbox", { name: "Project name" }).disabled).toBe(
        true,
      );
      expect(readCalls(calls, "POST", "/api/v1/projects")).toHaveLength(1);
      expect(readCalls(calls, "POST", "/api/v1/resources")).toHaveLength(1);
      await userEvent.click(view.getByRole("button", { name: /retry/i }));
      await waitFor(() =>
        expect(readCalls(calls, "POST", "/api/v1/workspaces/attach")).toHaveLength(2),
      );
      expect(
        readCalls(calls, "POST", "/api/v1/workspaces/attach").map((call) => call.body),
      ).toEqual([
        { resourceId: resource.id, runnerId: RUNNER.id, path: PATH },
        { resourceId: resource.id, runnerId: RUNNER.id, path: PATH },
      ]);
      expect(readCalls(calls, "POST", "/api/v1/projects")).toHaveLength(1);
      expect(readCalls(calls, "POST", "/api/v1/resources")).toHaveLength(1);
      expect(readCalls(calls, "POST", "/api/v1/workspaces")).toEqual([]);
    },
  );
});

it("creates a project manually without a repository or a positively identified local runner", async () => {
  let picks = 0;
  const { calls, view } = await openProject({
    identities: {},
    pick: () => {
      picks++;
      return Promise.resolve(FOLDER);
    },
  });
  await userEvent.type(
    await view.findByRole("textbox", { name: "Project name" }),
    "Manual project",
  );
  await userEvent.click(view.getByRole("button", { name: /(?:add|create).*without.*repository/i }));
  await waitFor(() => expect(readCalls(calls, "POST", "/api/v1/projects")).toHaveLength(1));
  expect(readCalls(calls, "POST", "/api/v1/projects")[0]?.body).toMatchObject({
    name: "Manual project",
  });
  expect(readCalls(calls, "POST", "/api/v1/resources")).toEqual([]);
  expect(readCalls(calls, "POST", "/api/v1/workspaces/attach")).toEqual([]);
  expect(readCalls(calls, "POST", "/api/v1/workspaces")).toEqual([]);
  expect(picks).toBe(0);
});

it("creates a repository project from a remote URL without native folder access or implicit local placement", async () => {
  let picks = 0;
  const { calls, view } = await openProject({
    identities: {},
    pick: () => {
      picks++;
      return Promise.resolve(FOLDER);
    },
  });
  const remote = "https://github.com/fixture/manual-remote.git";
  await userEvent.type(
    await view.findByRole("textbox", { name: "Project name" }),
    "Remote project",
  );
  await userEvent.type(view.getByRole("textbox", { name: "Remote URL" }), remote);
  await userEvent.click(view.getByRole("button", { name: "Add project" }));
  await waitFor(() => expect(readCalls(calls, "POST", "/api/v1/resources")).toHaveLength(1));
  expect(readCalls(calls, "POST", "/api/v1/projects")).toHaveLength(1);
  expect(readCalls(calls, "POST", "/api/v1/resources")[0]?.body).toMatchObject({ remote });
  expect(readCalls(calls, "POST", "/api/v1/workspaces/attach")).toEqual([]);
  expect(readCalls(calls, "POST", "/api/v1/workspaces")).toEqual([]);
  expect(picks).toBe(0);
});

it("requires an affirmative checkout ownership choice after picking a folder", async () => {
  const { calls, view } = await openProject();
  await chooseFolder(view);
  const choices = view.getAllByRole<HTMLInputElement>("radio");
  expect(choices).toHaveLength(2);
  expect(choices.every((choice) => !choice.checked)).toBe(true);
  expect(view.getByRole<HTMLButtonElement>("button", { name: "Add project" }).disabled).toBe(true);
  await userEvent.type(view.getByRole("textbox", { name: "Project name" }), "{Enter}");
  expect(readCalls(calls, "POST", "/api/v1/projects")).toEqual([]);
  expect(readCalls(calls, "POST", "/api/v1/workspaces/attach")).toEqual([]);
  expect(readCalls(calls, "POST", "/api/v1/workspaces")).toEqual([]);
});
