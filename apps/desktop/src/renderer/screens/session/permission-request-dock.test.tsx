/**
 * Tests the Requests dock of a thread's main agent page while it shows the
 * session's Permission Requests, against the stubbed controller: what it
 * shows, the three answers and their keys, that "Add to profile" waits for
 * the profile's name and reads the profiles once more when the cached list
 * lacks it, that an agent Request comes first, and how the pager
 * pages between several Permission Requests.
 */
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@hercule/client-core";
import type { PermissionRequest, Profile } from "@hercule/contract";
import {
  buildErrorBody,
  holdAnswer,
  THREAD_FIXTURES,
  type Call,
  type Handler,
  type ThreadRecords,
} from "../../app/testing";
import { AgentRequestDock } from "../thread/agent-request-dock";
import { renderThreadPart } from "../thread/testing";

/** An idle thread, which waits on no agent Request. */
const IDLE = THREAD_FIXTURES.finished;

/** The profile the fixture threads run on. */
const PROFILE: Profile = {
  id: IDLE.session.permissionProfileId,
  name: "worker",
  grants: [],
  shipped: false,
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-01T09:00:00.000Z",
};

/** A profile the fixture threads do not run on. */
const OTHER_PROFILE: Profile = {
  ...PROFILE,
  id: "01a06d02-9e00-7000-8000-0000000000ff",
  name: "reviewer",
};

const DELETE_TASK: PermissionRequest = {
  id: "01a06d02-9e00-7000-8000-000000000001",
  grant: "task.delete",
  reason: "The task duplicates another one.",
  operation: { op: "task.delete", input: { id: "task-7" } },
  createdAt: "2026-09-10T09:30:00.000Z",
};

const START_RUN: PermissionRequest = {
  id: "01a06d02-9e00-7000-8000-000000000002",
  grant: "run.start",
  reason: "The fix needs the release workflow.",
  createdAt: "2026-09-10T09:31:00.000Z",
};

/** Returns `thread` with `openPermissionRequests` open on its session. */
const withPermissionRequests = (
  thread: ThreadRecords,
  openPermissionRequests: readonly PermissionRequest[],
): ThreadRecords => ({ ...thread, session: { ...thread.session, openPermissionRequests } });

/** The path of `permission.decide` for `request`. */
const decidePath = (request: PermissionRequest): string =>
  `POST /api/v1/permissions/requests/${request.id}/decide`;

/**
 * Renders the main agent page's dock of `thread`, with a controller that
 * accepts every answer and reads `PROFILE`. `profiles` replaces the answer
 * to the profiles read.
 */
const renderDock = (thread: ThreadRecords, profiles: Handler = { body: { items: [PROFILE] } }) =>
  renderThreadPart(
    ({ sessionId }) => <AgentRequestDock sessionId={sessionId} pageSubagentId={undefined} />,
    {
      thread,
      handlers: {
        "GET /api/v1/profiles": profiles,
        [decidePath(DELETE_TASK)]: { body: {} },
        [decidePath(START_RUN)]: { body: {} },
      },
    },
  );

/**
 * Opens `request` on the idle thread's session, as the live `session` push
 * does. The thread then opened with no Permission Request, so its loader
 * did not read the profiles, and the dock reads them itself.
 */
const openPermissionRequest = (queryClient: QueryClient, request: PermissionRequest): void => {
  act(() => {
    queryClient.setQueryData(
      queryKeys.session(IDLE.session.id),
      withPermissionRequests(IDLE, [request]).session,
    );
  });
};

/** Returns the dock's "Add to profile" answer. */
const readAddToProfile = (): HTMLElement =>
  within(readDock()).getByRole("button", { name: "Add to profile" });

/** Returns the outcomes the dock sent, oldest first, by the request each decides. */
const readOutcomes = (calls: readonly Call[]): readonly (readonly [string, unknown])[] =>
  calls
    .filter((call) => call.method === "POST" && call.path.endsWith("/decide"))
    .map((call) => [call.path, (call.body as { readonly outcome: unknown }).outcome] as const);

/** Returns the reads of the permission profiles among `calls`. */
const readProfileReads = (calls: readonly Call[]): readonly Call[] =>
  calls.filter((call) => call.path === "/api/v1/profiles");

/** Returns the dock, which is a group named by its title. */
const readDock = (): HTMLElement => screen.getByRole("group", { name: "Grant this permission?" });

describe("the dock for a Permission Request", () => {
  it("shows the grant, the reason and the operation, with the three answers and their keys", async () => {
    await renderDock(withPermissionRequests(IDLE, [DELETE_TASK]));

    const dock = readDock();
    expect(dock.querySelector(".dock-q code")?.textContent).toBe("task.delete");
    expect(dock.querySelector(".dock-permission")?.textContent).toBe(
      "The task duplicates another one.Wants to call task.delete",
    );
    const answers: readonly (readonly [string, string, string])[] = [
      ["This session only", "Lets this session use task.delete; other sessions still ask.", "↩"],
      [
        "Add to profile",
        "Adds task.delete to the profile worker; every session on it gains the grant.",
        "⌥↩",
      ],
      ["Deny", "Refuses task.delete; the agent is told and continues.", "esc"],
    ];
    for (const [label, description, key] of answers) {
      const answer = within(dock).getByRole("button", { name: label, description });
      expect(answer.querySelector("kbd")?.textContent).toBe(key);
    }
    // No pager line for a lone request.
    expect(document.querySelector(".request-pager")).toBeNull();
  });

  it.each([
    ["This session only", "session"],
    ["Add to profile", "profile"],
    ["Deny", "deny"],
  ])("sends %s as the outcome %s with permission.decide", async (label, outcome) => {
    const user = userEvent.setup();
    const { calls } = await renderDock(withPermissionRequests(IDLE, [DELETE_TASK]));

    await user.click(within(readDock()).getByRole("button", { name: label }));

    await waitFor(() => {
      expect(readOutcomes(calls)).toEqual([[decidePath(DELETE_TASK).slice(5), outcome]]);
    });
  });

  it.each<readonly [string, { key: string; altKey?: boolean }, string]>([
    ["↩", { key: "Enter" }, "session"],
    ["⌥↩", { key: "Enter", altKey: true }, "profile"],
    ["esc", { key: "Escape" }, "deny"],
  ])("answers on %s while the dock has the focus", async (_name, key, outcome) => {
    const { calls } = await renderDock(withPermissionRequests(IDLE, [DELETE_TASK]));
    const dock = readDock();
    act(() => {
      dock.focus();
    });

    fireEvent.keyDown(dock, key);

    await waitFor(() => {
      expect(readOutcomes(calls)).toEqual([[decidePath(DELETE_TASK).slice(5), outcome]]);
    });
  });

  it("locks every answer once one is sent", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(withPermissionRequests(IDLE, [DELETE_TASK]));

    await user.click(within(readDock()).getByRole("button", { name: "Deny" }));
    await waitFor(() => {
      expect(readOutcomes(calls)).toHaveLength(1);
    });
    fireEvent.keyDown(readDock(), { key: "Enter" });
    await user.click(within(readDock()).getByRole("button", { name: "Add to profile" }));

    expect(readOutcomes(calls)).toEqual([[decidePath(DELETE_TASK).slice(5), "deny"]]);
    expect(
      within(readDock())
        .getAllByRole("button")
        .every((answer) => answer.getAttribute("aria-disabled") === "true"),
    ).toBe(true);
  });

  it("keeps Add to profile faded and unanswerable until the profile's name is read", async () => {
    const user = userEvent.setup();
    const profiles = holdAnswer();
    const { calls, queryClient } = await renderDock(IDLE, profiles.handler);
    openPermissionRequest(queryClient, DELETE_TASK);
    await screen.findByRole("group", { name: "Grant this permission?" });

    expect(readAddToProfile().getAttribute("aria-disabled")).toBe("true");
    expect(readAddToProfile().querySelector(".btn")?.hasAttribute("data-unready")).toBe(true);
    expect(readAddToProfile().querySelector(".ans-desc")?.textContent).toBe("");
    await user.click(readAddToProfile());
    act(() => {
      readDock().focus();
    });
    fireEvent.keyDown(readDock(), { key: "Enter", altKey: true });
    expect(readOutcomes(calls)).toEqual([]);
    // The other two answers name no profile, so they can be given meanwhile.
    expect(
      within(readDock())
        .getByRole("button", { name: "This session only" })
        .hasAttribute("aria-disabled"),
    ).toBe(false);

    profiles.answer({ body: { items: [PROFILE] } });

    await waitFor(() => {
      expect(readAddToProfile().hasAttribute("aria-disabled")).toBe(false);
    });
    expect(readAddToProfile().querySelector(".btn")?.hasAttribute("data-unready")).toBe(false);
    fireEvent.keyDown(readDock(), { key: "Enter", altKey: true });
    await waitFor(() => {
      expect(readOutcomes(calls)).toEqual([[decidePath(DELETE_TASK).slice(5), "profile"]]);
    });
  });

  it("keeps Add to profile unanswerable when the profiles cannot be read, and still answers the rest", async () => {
    const user = userEvent.setup();
    const { calls, queryClient } = await renderDock(IDLE, {
      status: 403,
      body: buildErrorBody("forbidden", "You may not read the permission profiles."),
    });
    // Query retries a failed read three times, seconds apart, by default;
    // the retries are not what this test is about.
    queryClient.setQueryDefaults(queryKeys.profiles(), { retry: false });
    openPermissionRequest(queryClient, DELETE_TASK);
    await waitFor(() => {
      expect(queryClient.getQueryState(queryKeys.profiles())?.status).toBe("error");
    });

    expect(readAddToProfile().getAttribute("aria-disabled")).toBe("true");
    await user.click(readAddToProfile());
    act(() => {
      readDock().focus();
    });
    fireEvent.keyDown(readDock(), { key: "Enter", altKey: true });
    expect(readOutcomes(calls)).toEqual([]);

    fireEvent.keyDown(readDock(), { key: "Escape" });
    await waitFor(() => {
      expect(readOutcomes(calls)).toEqual([[decidePath(DELETE_TASK).slice(5), "deny"]]);
    });
  });

  it("gives way to an agent Request, which blocks the agent", async () => {
    await renderDock(withPermissionRequests(THREAD_FIXTURES.waiting, [DELETE_TASK]));

    expect(screen.getByRole("group", { name: "Run this command?" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Grant this permission?" })).toBeNull();
  });

  it("pages between several Permission Requests, oldest first", async () => {
    const user = userEvent.setup();
    await renderDock(withPermissionRequests(IDLE, [DELETE_TASK, START_RUN]));
    const pager = document.querySelector<HTMLElement>(".request-pager")!;
    expect(pager.textContent).toBe("1 of 2");
    expect(readDock().querySelector(".dock-q code")?.textContent).toBe("task.delete");

    await user.click(within(pager).getByRole("button", { name: "Next Request" }));

    expect(pager.textContent).toBe("2 of 2");
    expect(readDock().querySelector(".dock-q code")?.textContent).toBe("run.start");
    // A request with no operation shows only its reason.
    expect(readDock().querySelector(".dock-permission")?.textContent).toBe(
      "The fix needs the release workflow.",
    );
  });

  it("reads the permission profiles only while a Permission Request is open", async () => {
    const { calls } = await renderDock(IDLE);

    expect(calls.some((call) => call.path === "/api/v1/profiles")).toBe(false);
  });

  it("reads the profiles once more when the cached list lacks the session's profile", async () => {
    const { calls, queryClient } = await renderDock(IDLE);
    // The list was read before another client created the session's profile.
    queryClient.setQueryData(queryKeys.profiles(), [OTHER_PROFILE]);
    openPermissionRequest(queryClient, DELETE_TASK);

    await waitFor(() => {
      expect(readAddToProfile().hasAttribute("aria-disabled")).toBe(false);
    });
    expect(readAddToProfile().querySelector(".ans-desc")?.textContent).toBe(
      "Adds task.delete to the profile worker; every session on it gains the grant.",
    );
    expect(readProfileReads(calls)).toHaveLength(1);
  });

  it("reads the profiles only once when the session's profile is still missing", async () => {
    const { calls, queryClient } = await renderDock(IDLE, {
      body: { items: [OTHER_PROFILE] },
    });
    queryClient.setQueryData(queryKeys.profiles(), [OTHER_PROFILE]);
    const listReadBefore = queryClient.getQueryState(queryKeys.profiles())!.dataUpdateCount;
    openPermissionRequest(queryClient, DELETE_TASK);

    await waitFor(() => {
      expect(queryClient.getQueryState(queryKeys.profiles())?.dataUpdateCount).toBe(
        listReadBefore + 1,
      );
    });
    // Gives a second read, were one asked for, the time to start.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

    expect(readProfileReads(calls)).toHaveLength(1);
    expect(readAddToProfile().getAttribute("aria-disabled")).toBe("true");
  });

  it("does not read the profiles again when its own read lacks the session's profile", async () => {
    const { calls, queryClient } = await renderDock(IDLE, {
      body: { items: [OTHER_PROFILE] },
    });
    openPermissionRequest(queryClient, DELETE_TASK);

    await waitFor(() => {
      expect(queryClient.getQueryState(queryKeys.profiles())?.status).toBe("success");
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

    expect(readProfileReads(calls)).toHaveLength(1);
    expect(readAddToProfile().getAttribute("aria-disabled")).toBe("true");
  });

  it("names the profile at the first paint when a Permission Request is open as the thread opens", async () => {
    const { calls } = await renderDock(withPermissionRequests(IDLE, [DELETE_TASK]));

    expect(readProfileReads(calls)).toHaveLength(1);
  });

  it("is not shown on a subagent's page, since a Permission Request is the session's own", async () => {
    await renderThreadPart(
      ({ sessionId }) => <AgentRequestDock sessionId={sessionId} pageSubagentId="sub-1" />,
      { thread: withPermissionRequests(IDLE, [DELETE_TASK]) },
    );

    expect(screen.queryByRole("group")).toBeNull();
  });
});
