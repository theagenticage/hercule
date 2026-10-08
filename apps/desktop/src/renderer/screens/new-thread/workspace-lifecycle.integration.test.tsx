import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StartingRevision, ThreadWorkspace } from "@hercule/contract";
import { buildDraftKey } from "../../app/pending-submissions";
import {
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_INSTANCE,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  THREAD_FIXTURES,
  type Call,
} from "../../app/testing";

beforeEach(() => stubElementSize(272, 800));
afterEach(() => vi.restoreAllMocks());

const project = SIDEBAR_FIXTURE.projects[0]!;
const resource = SIDEBAR_FIXTURE.resources[0]!;
const main = SIDEBAR_FIXTURE.workspaces[0]!;
const started = THREAD_FIXTURES.finished;
const spawns = (calls: readonly Call[]) =>
  calls.filter((call) => call.method === "POST" && call.path === "/api/v1/sessions");

const openDraft = async (
  saved: ThreadWorkspace | null = null,
  path = `/?project=${project.id}`,
) => {
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, providers: [FIXTURE_INSTANCE] }),
    ...buildThreadHandlers(started),
    "POST /api/v1/sessions": { body: started.session },
    "GET /api/v1/settings": {
      body: { controller: {}, user: saved === null ? {} : { "thread.workspace": saved } },
    },
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path },
  );
  await screen.findByRole("textbox", { name: "Message" });
  return { ...app, calls };
};

it.each([null, "primary", "ephemeral"] as const)(
  "opens a coding project with stored workspace default %s and sends the displayed file choice",
  async (saved) => {
    const { calls } = await openDraft(saved);
    if (saved === "primary")
      expect(document.querySelector(".lip")?.textContent).toMatch(/main workspace/i);
    else expect(document.querySelector(".lip")?.textContent).toMatch(/New workspace/);
    const field = await screen.findByRole("textbox", { name: "Message" });
    await userEvent.type(field, "Use the displayed files{Enter}");
    await waitFor(() => expect(spawns(calls)).toHaveLength(1));
    expect(spawns(calls)[0]?.body).toMatchObject({
      workspace:
        saved === "primary"
          ? { kind: "primary", resourceId: resource.id }
          : { kind: "ephemeral", checkouts: [{ resourceId: resource.id }] },
    });
    const body = spawns(calls)[0]?.body as { workspace: { branch?: string } };
    expect(body.workspace.branch).toBeUndefined();
  },
);

it("uses the thread header's + as explicit sharing of its workspace even when the project default is separate files", async () => {
  const { calls, router } = await openDraft("ephemeral", `/threads/${started.session.id}`);
  await userEvent.click(await screen.findByRole("link", { name: "New thread in this workspace" }));
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ project: project.id, workspace: main.id }),
  );
  expect(screen.getByText(/joins.*(edits|branch)|share.*files/i)).toBeTruthy();
  await userEvent.type(
    await screen.findByRole("textbox", { name: "Message" }),
    "Share these existing files{Enter}",
  );
  await waitFor(() => expect(spawns(calls)).toHaveLength(1));
  expect(spawns(calls)[0]?.body).toMatchObject({
    workspace: { kind: "existing", workspaceId: main.id },
  });
  const body = spawns(calls)[0]?.body as { workspace: { branch?: string } };
  expect(body.workspace.branch).toBeUndefined();
});

it.each<StartingRevision>([
  { kind: "current" },
  { kind: "local", branch: "unpublished-source" },
  { kind: "remote", branch: "release" },
])(
  "carries the composer's explicit %j through the real derived HTTP client",
  async (startingRevision) => {
    const { calls, context } = await openDraft();
    act(() =>
      context.controller!.pendingSubmissions.writePicks(buildDraftKey(project.id, null), {
        workspace: {
          kind: "ephemeral",
          checkouts: [{ resourceId: resource.id, startingRevision }],
        },
      }),
    );
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Message" }),
      "Use exactly this revision{Enter}",
    );
    await waitFor(() => expect(spawns(calls)).toHaveLength(1));
    expect(spawns(calls)[0]?.body).toMatchObject({
      workspace: { kind: "ephemeral", checkouts: [{ resourceId: resource.id, startingRevision }] },
    });
  },
);
