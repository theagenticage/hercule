/**
 * Tests From a source in the Add to Work sheet through the rendered Work
 * screen: what the sheet opens on (a lane's context, a source of its own),
 * adding a thing and the undo line that offers to take it back, the refusal
 * of that undo, opening the Task of a thing that is on Work, and the offline
 * sheet. The sheet's own behaviour is tested in `screens/work/`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildBoard, buildCard, buildPlace } from "@hercule/client-core/work/testing";
import type { EntitySearchReply, PluginDetail, WorkBoard } from "@hercule/contract";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  setVisibility,
  SIDEBAR_FIXTURE,
  stubApi,
  stubIntersectionObserver,
  type Handler,
} from "../../../app/testing";

beforeEach(() => {
  stubIntersectionObserver();
});

afterEach(() => {
  setVisibility("visible");
});

const OPS = SIDEBAR_FIXTURE.projects[1]!;
const THREAD_ID = "01a06d02-7e00-7000-8000-000000000900";
const ENTITY_ID = "01a06d02-7e00-7000-8000-000000000a01";
const NEW_TASK_ID = "01a06d02-7e00-7000-8000-000000000b01";
const buildTaskId = (n: number): string => `01a06d02-7e00-7000-8000-${String(n).padStart(12, "0")}`;

const BASKET = buildPlace("relay:project:basket", "Basket rebuild", {
  kind: "relay/project",
  noun: "Project",
  caption: "Relay project",
});

/** An active plugin that declares one kind of thing, so the sheet offers it as a source. */
const RELAY: PluginDetail = {
  id: "relay",
  displayName: "Relay",
  hostApi: 8,
  capabilities: ["entities"],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [],
  intake: { eventKinds: [], signalKinds: [] },
  entityKinds: [
    {
      word: "relay/issue",
      noun: "Issue",
      card: "compact",
      refPrefix: "relay:issue:",
      pace: "fast",
      patience: 24,
      identifier: "#{number}",
      person: null,
      owner: null,
      status: null,
      facts: [],
      reasons: {},
    },
  ],
};

const RESULT: EntitySearchReply["results"][number] = {
  ref: "relay:issue:301",
  kind: "relay/issue",
  noun: "Issue",
  identifier: "WEB-301",
  title: "Gift message is cut off at 140 characters",
  location: "Gift cards",
  status: { shape: "dashed", tone: "quiet", label: "Backlog" },
  standing: "new",
};

const buildReply = (overrides: Partial<EntitySearchReply> = {}): EntitySearchReply => ({
  source: "relay",
  outcome: "results",
  results: [RESULT],
  incomplete: false,
  linkSources: [],
  ...overrides,
});

const ADDED = {
  id: ENTITY_ID,
  taskId: NEW_TASK_ID,
  created: true,
  stage: "exploring",
  followed: true,
};
const UNDO_PATH = `POST /api/v1/external-entities/${ENTITY_ID}/take-on/undo`;

/** A board whose card in the ops Project sits under the Basket rebuild project of Relay. */
const buildContextBoard = (): WorkBoard => ({
  ...buildBoard(
    buildCard(buildTaskId(1), {
      title: "Renew the payment gateway certificate",
      projectId: OPS.id,
      contextRefs: [BASKET.ref],
      openSessionId: THREAD_ID,
    }),
    buildCard(buildTaskId(2), { title: "Tidy the depot labels" }),
  ),
  places: [BASKET],
  groupings: [{ kind: "relay/project", caption: "Relay project" }],
});

/** Opens the app at Work with Relay installed, and returns what the app called. */
const openWork = async (handlers: Readonly<Record<string, Handler>> = {}) => {
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, plugins: [RELAY] }),
    "GET /api/v1/tasks/board": () => ({ body: buildContextBoard() }),
    "GET /api/v1/tasks": { body: { items: [] } },
    "GET /api/v1/external-entities/suggestions": {
      body: { suggestions: [], places: [], truncated: false },
    },
    "GET /api/v1/external-entities/search": () => ({ body: buildReply() }),
    "POST /api/v1/external-entities/add-to-work": { body: ADDED },
    ...handlers,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: "/work" },
  );
  return { calls, ...app };
};

/** Searches Relay for "gift" and waits for the result. */
const searchForGift = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  await user.type(await screen.findByRole("textbox", { name: /^Search Relay/ }), "gift");
  await screen.findByText("WEB-301");
};

describe("From a source on the Work screen", () => {
  it("opens from a Project lane's plus on the context most of its cards sit under", async () => {
    const user = userEvent.setup();
    const { calls } = await openWork();

    await user.click(await screen.findByRole("button", { name: "Add to ops" }));

    const scope = await screen.findByRole<HTMLSelectElement>("combobox", {
      name: "Narrow the search",
    });
    expect(scope.value).toBe(BASKET.ref);
    await waitFor(() => {
      expect(calls.some((call) => call.path === "/api/v1/external-entities/suggestions")).toBe(
        true,
      );
    });
    const read = calls.find((call) => call.path === "/api/v1/external-entities/suggestions");
    expect(read?.search).toBe(`?contextRef=${encodeURIComponent(BASKET.ref)}`);
  });

  it("opens from the Add button and from the A key on everything, with the search focused", async () => {
    const user = userEvent.setup();
    await openWork();

    await user.click(await screen.findByRole("button", { name: "Add" }));

    const search = await screen.findByRole("textbox", { name: "Search Relay, or paste a link" });
    expect(document.activeElement).toBe(search);
    expect(
      screen.getByRole<HTMLSelectElement>("combobox", { name: "Narrow the search" }).value,
    ).toBe("");

    await user.keyboard("{Escape}");
    await user.click(await screen.findByRole("button", { name: /^Tidy the depot labels/ }));
    await user.keyboard("a");

    expect(
      await screen.findByRole("textbox", { name: "Search Relay, or paste a link" }),
    ).toBeTruthy();
  });

  it("adds a thing, says where it went and that Hercule follows it, and takes it back with Undo", async () => {
    const user = userEvent.setup();
    const { calls } = await openWork({ [UNDO_PATH]: { body: { undone: true } } });
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await searchForGift(user);

    await user.click(screen.getByText("WEB-301"));

    expect(
      await screen.findByText("Added to Exploring. Hercule now follows WEB-301."),
    ).toBeTruthy();
    const added = calls.find((call) => call.path === "/api/v1/external-entities/add-to-work");
    expect(added?.body).toEqual({ ref: RESULT.ref });

    await user.click(screen.getByRole("button", { name: /^Undo/ }));

    expect(await screen.findByText("Put back: Added WEB-301 to Work.")).toBeTruthy();
    const undone = calls.find((call) => call.path.endsWith("/take-on/undo"));
    expect(undone?.body).toEqual({ taskId: NEW_TASK_ID });
  });

  it("says why Undo was refused, and leaves the Task", async () => {
    const user = userEvent.setup();
    await openWork({
      [UNDO_PATH]: { body: { undone: false, reason: "A Thread has started on this Task." } },
    });
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await searchForGift(user);
    await user.click(screen.getByText("WEB-301"));
    await screen.findByText("Added to Exploring. Hercule now follows WEB-301.");

    await user.click(screen.getByRole("button", { name: /^Undo/ }));

    expect(
      await screen.findByText(
        "Could not put back: Added WEB-301 to Work. A Thread has started on this Task.",
      ),
    ).toBeTruthy();
  });

  it("says when an add did not go through, on the line at the foot", async () => {
    const user = userEvent.setup();
    await openWork({
      "POST /api/v1/external-entities/add-to-work": {
        status: 409,
        body: buildErrorBody("conflict", "It changed while it was read. Try again."),
      },
    });
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await searchForGift(user);

    await user.click(screen.getByText("WEB-301"));

    expect(await screen.findByText(/^Could not add WEB-301: /)).toBeTruthy();
  });

  it("opens the Thread of the Task of a thing that is on Work", async () => {
    const user = userEvent.setup();
    const { router } = await openWork({
      "GET /api/v1/external-entities/search": () => ({
        body: buildReply({
          results: [{ ...RESULT, standing: "on-work", taskId: buildTaskId(1) }],
        }),
      }),
    });
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await searchForGift(user);

    await user.click(screen.getByText("WEB-301"));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${THREAD_ID}`);
    });
  });

  it("says the source cannot be searched while the controller cannot be reached", async () => {
    const user = userEvent.setup();
    const { live } = await openWork();
    await screen.findByRole("button", { name: /^Tidy the depot labels/ });
    await live.waitForFirstPushes();
    live.drop();
    await screen.findByText(/^Offline since/);

    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(
      await screen.findByText(
        "You are offline, so Relay cannot be searched. Typing only narrows the suggestions.",
      ),
    ).toBeTruthy();
  });
});
