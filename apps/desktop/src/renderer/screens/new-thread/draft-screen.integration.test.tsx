/**
 * Tests the new-thread screen as the app opens it at `/`: the question and
 * the lead, a draft that cannot start, starting a thread with ⏎, a start the
 * controller refuses, a start made once when the user comes back while it
 * runs, the draft kept per place, the start cards, and the picks a start
 * carries.
 *
 * The menus are the browser's popovers, which jsdom does not implement, so
 * their content is tested on its own. Here a pick is written into the
 * pending submissions, where a menu writes it.
 */
import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProviderInstance, Runner, Task } from "@hercule/contract";
import { buildRunner } from "@hercule/client-core/threads/testing";
import { buildDraftKey } from "../../app/pending-submissions";
import {
  buildErrorBody,
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_INSTANCE,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  THREAD_FIXTURES,
  type Call,
  type Handler,
} from "../../app/testing";

const [WEBSHOP, OPS] = SIDEBAR_FIXTURE.projects as [
  (typeof SIDEBAR_FIXTURE.projects)[number],
  (typeof SIDEBAR_FIXTURE.projects)[number],
];

/** The thread the stubbed controller starts: "Bump the Bun pin". */
const STARTED = THREAD_FIXTURES.finished;

/** An open task of webshop, as the start cards read it. */
const CART_TASK: Task = {
  id: "01a06d02-7700-7000-8000-000000000001",
  title: "Cart total rounding on discounts",
  description: "Totals are off by a cent.",
  status: "open",
  priority: "high",
  labels: [],
  projectId: WEBSHOP.id,
  provenance: [],
  createdAt: "2026-09-10T08:00:00.000Z",
  updatedAt: "2026-09-10T08:00:00.000Z",
  statusChangedAt: "2026-09-10T08:00:00.000Z",
};

/**
 * Opens the app signed in at `path`, with the sidebar fixture and the
 * provider instance, and returns the app once the draft's message field
 * shows. The controller starts every thread as `STARTED` and has no open
 * task, unless `handlers` say otherwise.
 */
const openDraft = async (path: string, handlers: Readonly<Record<string, Handler>> = {}) => {
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, providers: [FIXTURE_INSTANCE] }),
    ...buildThreadHandlers(STARTED),
    "POST /api/v1/sessions": { body: STARTED.session },
    ...handlers,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path },
  );
  const field = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
  return { calls, field, ...app };
};

/** Returns the requests that started a thread. */
const readSpawns = (calls: readonly Call[]): readonly Call[] =>
  calls.filter((call) => call.method === "POST" && call.path === "/api/v1/sessions");

/** Returns the text of the lip: the workspace, the branch and the machine. */
const readLip = (): string | null => document.querySelector(".lip")?.textContent ?? null;

describe("the new-thread screen", () => {
  it("asks what the agent should do in the project, says where it will work, and has the focus in the message field", async () => {
    const { field } = await openDraft(`/?project=${WEBSHOP.id}`);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "What should the agent do in webshop?",
    );
    expect(
      screen.getByText(
        "It works in the main workspace of webshop on moss, on main. You and the agent share the files.",
      ),
    ).toBeTruthy();
    expect(readLip()).toBe("Main workspace" + "main" + "moss");
    expect(document.activeElement).toBe(field);
  });

  it("asks without a place in a draft with no project, which works without a checkout", async () => {
    await openDraft("/");

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What should the agent do?");
    expect(screen.getByText("It works without a checkout.")).toBeTruthy();
    expect(readLip()).toBe("No workspace" + "moss");
    // A draft with no project has no tasks to start from.
    expect(screen.queryByRole("heading", { name: "Start from Intake" })).toBeNull();
  });

  it("names a main workspace it joins as the thread's lip does, on the machine the workspace is on", async () => {
    const [primary] = SIDEBAR_FIXTURE.workspaces;
    await openDraft(`/?project=${WEBSHOP.id}&workspace=${primary!.id}`);

    expect(readLip()).toBe("Main workspace" + "moss");
    expect(screen.getByTitle("The workspace it joins decides the machine").textContent).toBe(
      "moss",
    );
  });

  it("runs on the runner main finds on this Mac, rather than on the first one", async () => {
    const [moss] = SIDEBAR_FIXTURE.runners as [Runner];
    const withPort = (runner: Runner, identityPort: number): Runner => ({
      ...runner,
      facts: {
        os: "darwin",
        arch: "arm64",
        totalMemoryBytes: 1024,
        docker: false,
        toolchains: [],
        providers: [],
        adapters: ["claude-code"],
        identityPort,
      },
    });
    const studio = withPort(buildRunner("01a06d02-7700-7000-8000-0000000000ab", "studio"), 4940);
    const [snapshot] = FIXTURE_INSTANCE.snapshots;
    stubApi({
      ...buildSidebarHandlers({
        ...SIDEBAR_FIXTURE,
        runners: [withPort(moss, 4939), studio],
        providers: [
          {
            ...FIXTURE_INSTANCE,
            snapshots: [...FIXTURE_INSTANCE.snapshots, { ...snapshot!, runnerId: studio.id }],
          },
        ],
      }),
    });
    await renderApp(
      createFakeBridge({
        controllerUrl: CONTROLLER_URL,
        token: "bearer",
        runnerIdentities: { 4940: studio.id },
      }),
      { path: "/" },
    );

    await screen.findByRole("textbox", { name: "Message" });
    expect(readLip()).toBe("No workspace" + "studio");
  });

  it("says why the draft cannot start, sends nothing, and starts once the reason is gone", async () => {
    let providers: readonly ProviderInstance[] = [];
    const { calls, field, live } = await openDraft(`/?project=${WEBSHOP.id}`, {
      "GET /api/v1/providers": () => ({ body: providers }),
    });

    expect(screen.getByText("Can't start yet.").parentElement?.textContent).toBe(
      "Can't start yet. No provider instance is set up.",
    );
    const send = screen.getByRole("button", { name: "Start thread" });
    expect(send.getAttribute("aria-disabled")).toBe("true");
    await userEvent.type(field, "Fix the cart{Enter}");
    await userEvent.click(send);
    expect(field.value).toBe("Fix the cart");

    // A provider is set up elsewhere, and the draft can start. The one start
    // the controller receives is this one, so neither key above sent any.
    providers = [FIXTURE_INSTANCE];
    live.pushInvalidation("provider");
    await waitFor(() => {
      expect(send.getAttribute("aria-disabled")).toBeNull();
    });
    await userEvent.type(field, "{Enter}");
    await waitFor(() => {
      expect(readSpawns(calls)).toHaveLength(1);
    });
  });

  it("starts the thread with ⏎ and what the composer shows, then opens it and empties the draft", async () => {
    const { calls, field, router } = await openDraft(`/?project=${WEBSHOP.id}`);

    await userEvent.type(field, "Fix the cart{Enter}");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${STARTED.session.id}`);
    });
    expect(readSpawns(calls).map((call) => call.body)).toEqual([
      {
        prompt: "Fix the cart",
        instanceId: FIXTURE_INSTANCE.id,
        model: "claude-sonnet-5",
        options: {},
        accessMode: "approval-required",
        runnerId: SIDEBAR_FIXTURE.runners[0]!.id,
        projectId: WEBSHOP.id,
        workspace: { kind: "primary", resourceId: SIDEBAR_FIXTURE.resources[0]!.id },
      },
    ]);

    await act(() => router.navigate({ to: "/", search: { project: WEBSHOP.id } }));
    expect(
      (await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Message" })).value,
    ).toBe("");
  });

  it("keeps the draft and shows why when the controller refuses the start", async () => {
    const { calls, field, router } = await openDraft(`/?project=${WEBSHOP.id}`, {
      "POST /api/v1/sessions": {
        status: 409,
        body: buildErrorBody("invalid_state", "moss is at its limit of 4 sessions."),
      },
    });

    await userEvent.type(field, "Fix the cart{Enter}");

    expect((await screen.findByRole("alert")).textContent).toBe(
      "moss is at its limit of 4 sessions.",
    );
    expect(readSpawns(calls)).toHaveLength(1);
    expect(field.value).toBe("Fix the cart");
    expect(router.state.location.pathname).toBe("/");
  });

  it("shows why the start failed when the user left while it ran and came back", async () => {
    let answer = (): void => {};
    const { field, router } = await openDraft(`/?project=${WEBSHOP.id}`, {
      "POST /api/v1/sessions": () =>
        new Promise((resolve) => {
          answer = () => {
            resolve({
              status: 409,
              body: buildErrorBody("invalid_state", "moss is at its limit of 4 sessions."),
            });
          };
        }),
    });
    await userEvent.type(field, "Fix the cart{Enter}");

    await act(() =>
      router.navigate({ to: "/threads/$sessionId", params: { sessionId: STARTED.session.id } }),
    );
    await act(async () => {
      answer();
      await Promise.resolve();
    });
    await act(() => router.navigate({ to: "/", search: { project: WEBSHOP.id } }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "moss is at its limit of 4 sessions.",
    );
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" }).value).toBe(
      "Fix the cart",
    );
  });

  it("keeps what the user typed while the thread started, for the next draft", async () => {
    let answer = (): void => {};
    const { field, router } = await openDraft(`/?project=${WEBSHOP.id}`, {
      "POST /api/v1/sessions": () =>
        new Promise((resolve) => {
          answer = () => {
            resolve({ body: STARTED.session });
          };
        }),
    });
    await userEvent.type(field, "Fix the cart{Enter}");
    await userEvent.type(field, ", and the tests");

    act(answer);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${STARTED.session.id}`);
    });
    await act(() => router.navigate({ to: "/", search: { project: WEBSHOP.id } }));

    expect(
      (await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Message" })).value,
    ).toBe("Fix the cart, and the tests");
  });

  it("does not start the thread twice when the user leaves and comes back while it starts", async () => {
    let answer = (): void => {};
    const { calls, field, router } = await openDraft(`/?project=${WEBSHOP.id}`, {
      "POST /api/v1/sessions": () =>
        new Promise((resolve) => {
          answer = () => {
            resolve({ body: STARTED.session });
          };
        }),
    });
    await userEvent.type(field, "Fix the cart{Enter}");
    await waitFor(() => {
      expect(readSpawns(calls)).toHaveLength(1);
    });

    await act(() =>
      router.navigate({ to: "/threads/$sessionId", params: { sessionId: STARTED.session.id } }),
    );
    await act(() => router.navigate({ to: "/", search: { project: WEBSHOP.id } }));
    const again = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    expect(again.value).toBe("Fix the cart");
    expect(screen.getByTitle("Start thread").getAttribute("aria-disabled")).toBe("true");
    await userEvent.type(again, "{Enter}");
    expect(readSpawns(calls)).toHaveLength(1);

    act(answer);
    await waitFor(() => {
      expect(again.value).toBe("");
    });
    expect(readSpawns(calls)).toHaveLength(1);
  });

  it("reads the settings and the profiles once each time it opens", async () => {
    const calls = stubApi({
      ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, providers: [FIXTURE_INSTANCE] }),
      ...buildThreadHandlers(STARTED),
    });
    const { router, context } = await renderApp(
      createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
      { path: `/threads/${STARTED.session.id}` },
    );
    /** Opens the draft, and returns how often each read has been sent once nothing is loading. */
    const openAndCountReads = async (): Promise<readonly number[]> => {
      await act(() => router.navigate({ to: "/", search: { project: WEBSHOP.id } }));
      await screen.findByRole("textbox", { name: "Message" });
      // The sidebar reads the settings and the profiles too, for its draft row.
      await waitFor(() => {
        expect(context.queryClient.isFetching()).toBe(0);
      });
      return ["/api/v1/settings", "/api/v1/profiles"].map(
        (path) => calls.filter((call) => call.path === path).length,
      );
    };

    expect(await openAndCountReads()).toEqual([1, 1]);
    await act(() =>
      router.navigate({ to: "/threads/$sessionId", params: { sessionId: STARTED.session.id } }),
    );
    expect(await openAndCountReads()).toEqual([2, 2]);
  });

  it("keeps each place's draft while the user is elsewhere", async () => {
    const { field, router } = await openDraft(`/?project=${WEBSHOP.id}`);
    await userEvent.type(field, "Half a thought");

    await act(() =>
      router.navigate({ to: "/threads/$sessionId", params: { sessionId: STARTED.session.id } }),
    );
    await act(() => router.navigate({ to: "/", search: { project: OPS.id } }));
    expect(
      (await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Message" })).value,
    ).toBe("");

    await act(() => router.navigate({ to: "/", search: { project: WEBSHOP.id } }));
    await waitFor(() => {
      expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" }).value).toBe(
        "Half a thought",
      );
    });
  });

  it("adds a start card's task to the message, after what the user typed", async () => {
    const { calls, field } = await openDraft(`/?project=${WEBSHOP.id}`, {
      "GET /api/v1/tasks": { body: { items: [CART_TASK] } },
    });
    await userEvent.type(field, "Look at checkout");

    const cards = screen.getByRole("region", { name: "Start from Intake" });
    const card = await within(cards).findByRole("button", { name: /Cart total rounding/ });
    expect(card.textContent).toBe("Task" + "Cart total rounding on discounts");
    expect(within(card).getByRole("img").getAttribute("aria-label")).toBe("high priority");
    await userEvent.click(card);

    expect(field.value).toBe(
      "Look at checkout\n\nCart total rounding on discounts\n\nTotals are off by a cent.",
    );
    expect(document.activeElement).toBe(field);
    // The cards ask for the project's most urgent open tasks.
    expect(calls.find((call) => call.path === "/api/v1/tasks")?.query).toMatchObject({
      projectId: WEBSHOP.id,
    });
  });

  it("shows the picks in the lip and the lead, and starts the thread with them", async () => {
    const { calls, context, field } = await openDraft(`/?project=${WEBSHOP.id}`);
    const { pendingSubmissions } = context.controller!;
    const key = buildDraftKey(WEBSHOP.id, null);

    act(() => {
      pendingSubmissions.write(key, {
        ...pendingSubmissions.read(key),
        picks: {
          workspace: {
            kind: "ephemeral",
            checkouts: [{ resourceId: SIDEBAR_FIXTURE.resources[0]!.id }],
          },
          accessMode: "full-access",
        },
      });
    });
    expect(readLip()).toMatch(/^New workspace/);
    expect(
      screen.getByText("It gets its own worktree of webshop, on a new branch from", {
        exact: false,
      }).textContent,
    ).toBe("It gets its own worktree of webshop, on a new branch from main.");
    expect(screen.getByRole("button", { name: "Full access" }).getAttribute("aria-haspopup")).toBe(
      "dialog",
    );

    await userEvent.type(field, "Fix the cart{Enter}");
    await waitFor(() => {
      expect(readSpawns(calls)).toHaveLength(1);
    });
    expect(readSpawns(calls)[0]?.body).toMatchObject({
      accessMode: "full-access",
      workspace: {
        kind: "ephemeral",
        checkouts: [{ resourceId: SIDEBAR_FIXTURE.resources[0]!.id }],
      },
    });
  });
});
