import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import type { Workspace } from "@hercule/contract";
import { buildSessionTapTopic } from "@hercule/contract";
import {
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_INSTANCE,
  renderApp,
  RUNNING_ITEM_ID,
  SIDEBAR_FIXTURE,
  stubApi,
  THREAD_FIXTURES,
  type Call,
  type ThreadRecords,
} from "../../app/testing";

const BASE_COMMIT = "abcd".repeat(10);
const HEAD_COMMIT = "1234".repeat(10);
const original = SIDEBAR_FIXTURE.workspaces[0]!;
const retained: Workspace = {
  ...original,
  kind: "ephemeral",
  ownership: "managed",
  retentionPolicy: "manual",
  sessionIds: [],
  keptUntil: null,
  observedAt: "2026-09-10T08:00:00.000Z",
  checkouts: original.checkouts.map((checkout) => ({
    ...checkout,
    form: "worktree",
    branch: "fresh-local-branch",
    startingRevision: { kind: "local", branch: "unpublished-source" },
    baseCommit: BASE_COMMIT,
    headCommit: HEAD_COMMIT,
  })),
};
const stopped: ThreadRecords = {
  ...THREAD_FIXTURES.finished,
  session: {
    ...THREAD_FIXTURES.finished.session,
    workspaceId: retained.id,
    status: "exited",
    resumable: true,
    resumeHeld: false,
    exitedAt: "2026-09-10T09:00:00.000Z",
  },
};
const callsTo = (calls: readonly Call[], method: string, path: string) =>
  calls.filter((call) => call.method === method && call.path === path);

/** Opens the shipping route with a retained record and real derived HTTP clients. */
const openDetails = async (workspace: Workspace = retained, thread: ThreadRecords = stopped) => {
  let current = workspace;
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, providers: [FIXTURE_INSTANCE] }),
    ...buildThreadHandlers(thread),
    "GET /api/v1/workspaces": () => ({
      body: {
        items: [current, ...SIDEBAR_FIXTURE.workspaces.filter((each) => each.id !== current.id)],
      },
    }),
    [`GET /api/v1/workspaces/${workspace.id}`]: () => ({ body: current }),
    [`POST /api/v1/workspaces/${workspace.id}/inspect`]: () => ({ body: current }),
    [`DELETE /api/v1/workspaces/${workspace.id}`]: () => {
      current = { ...current, status: "disposing" };
      return { body: {} };
    },
    [`POST /api/v1/workspaces/${workspace.id}/detach`]: () => {
      current = { ...current, status: "disposing" };
      return { body: {} };
    },
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: `/threads/${thread.session.id}` },
  );
  await userEvent.click(
    await screen.findByRole("button", { name: /workspace.*details|details.*workspace/i }),
  );
  await screen.findByRole("dialog", { name: "Workspace details" });
  return {
    ...app,
    calls,
    replace: (next: Workspace) => {
      current = next;
    },
  };
};

it("shows actual branch, starting revision, immutable base commit, runner and manual retention", async () => {
  await openDetails();
  const details = within(screen.getByRole("dialog", { name: "Workspace details" }));
  expect(await details.findByText(/base commit/i)).toBeTruthy();
  expect(await details.findByText(new RegExp(BASE_COMMIT.slice(0, 8)))).toBeTruthy();
  expect(details.getAllByText(/fresh-local-branch/).length).toBeGreaterThan(0);
  expect(details.getByText(/unpublished-source/)).toBeTruthy();
  expect(details.getByText(/^Runner$/i)).toBeTruthy();
  expect(details.getByText(/manual retention|kept until.*(discard|remove)/i)).toBeTruthy();
  expect(details.getByRole("button", { name: /^Refresh$/ })).toBeTruthy();
});

it("shows the deadline of automatic retention", async () => {
  await openDetails({
    ...retained,
    retentionPolicy: "automatic",
    keptUntil: "2030-04-09T11:12:13.000Z",
    message: null,
  });
  expect(screen.getByText(/9 Apr|Apr 9|2030-04-09|9 April|April 9/)).toBeTruthy();
});

it("shows the actionable reason automatic cleanup retained a workspace", async () => {
  const message =
    "Ignored files remain. Preserve them or explicitly discard changes. Automatic cleanup will not retry.";
  await openDetails({
    ...retained,
    retentionPolicy: "automatic",
    keptUntil: null,
    message,
  });
  expect(screen.getByText(/Ignored files remain/)).toBeTruthy();
  expect(screen.queryByText(/deleted shortly/i)).toBeNull();
});

it("explains dirty-file loss and sends an explicit managed discard choice", async () => {
  const { calls } = await openDetails();
  expect(callsTo(calls, "DELETE", `/api/v1/workspaces/${retained.id}`)).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: /^Discard workspace$/ }));
  expect(
    screen.getByText(/uncommitted.*(lost|deleted|removed)|changes.*(lost|deleted|removed)/i),
  ).toBeTruthy();
  const confirmation = screen.queryByRole("dialog", { name: /discard/i });
  if (confirmation !== null) {
    expect(callsTo(calls, "DELETE", `/api/v1/workspaces/${retained.id}`)).toHaveLength(0);
    await userEvent.click(
      within(confirmation).getByRole("button", { name: /^Discard( workspace| changes)?$/ }),
    );
  }
  await waitFor(() =>
    expect(callsTo(calls, "DELETE", `/api/v1/workspaces/${retained.id}`)).toHaveLength(1),
  );
  expect(callsTo(calls, "DELETE", `/api/v1/workspaces/${retained.id}`)[0]?.body).toEqual({
    discardChanges: true,
  });
  expect(callsTo(calls, "POST", `/api/v1/workspaces/${retained.id}/detach`)).toHaveLength(0);
});

it("explains that detachment keeps files and never sends disposal for an attached checkout", async () => {
  const attached = {
    ...retained,
    kind: "primary" as const,
    ownership: "adopted" as const,
    path: "/human/selected checkout",
  };
  const { calls } = await openDetails(attached);
  expect(screen.getByText(/files.*(stay|remain|kept)|keep.*files/i)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Discard workspace$/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /^Detach existing checkout$/ }));
  const confirmation = screen.queryByRole("dialog", { name: /detach/i });
  if (confirmation !== null) {
    expect(callsTo(calls, "POST", `/api/v1/workspaces/${retained.id}/detach`)).toHaveLength(0);
    await userEvent.click(
      within(confirmation).getByRole("button", { name: /^Detach( existing checkout| checkout)?$/ }),
    );
  }
  await waitFor(() =>
    expect(callsTo(calls, "POST", `/api/v1/workspaces/${retained.id}/detach`)).toHaveLength(1),
  );
  expect(callsTo(calls, "DELETE", `/api/v1/workspaces/${retained.id}`)).toHaveLength(0);
});

it("updates the label through workspace pushes without inspection per token or session push", async () => {
  const busy = {
    ...THREAD_FIXTURES.running,
    session: { ...THREAD_FIXTURES.running.session, workspaceId: retained.id },
  };
  const { calls, live, replace } = await openDetails(retained, busy);
  const operation = `/api/v1/workspaces/${retained.id}/inspect`;
  const initialInspections = callsTo(calls, "POST", operation).length;
  replace({
    ...retained,
    observedAt: "2026-10-07T14:00:00.000Z",
    checkouts: retained.checkouts.map((checkout) => ({
      ...checkout,
      branch: "externally-renamed",
    })),
  });
  act(() => live.pushInvalidation("workspace", [retained.id]));
  await screen.findAllByText(/externally-renamed/);
  expect(callsTo(calls, "POST", operation)).toHaveLength(initialInspections);
  await waitFor(() => expect(live.readTopics()).toContain(buildSessionTapTopic(busy.session.id)));
  act(() => {
    for (let token = 0; token < 20; token++)
      live.pushTaps(busy.session.id, [
        {
          turnId: "turn-1",
          itemId: RUNNING_ITEM_ID,
          streamKind: "assistant_text",
          delta: ` token-${token}`,
        },
      ]);
    live.pushInvalidation("session", [busy.session.id]);
  });
  await waitFor(() => expect(screen.getAllByText(/externally-renamed/).length).toBeGreaterThan(0));
  expect(callsTo(calls, "POST", operation)).toHaveLength(initialInspections);
});
