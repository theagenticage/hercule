/**
 * Tests linking a thing to a Task by hand from the Work details pane,
 * through the rendered screen: Link something with a search and with a pasted
 * link, removing a link, the Undo of each, a refusal, and that a removed link
 * stays removed after the board is read again. What the controller does with
 * a removed link (a scan does not bring it back) is tested in the controller.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildBoard, buildCard, buildPlace } from "@hercule/client-core/work/testing";
import type {
  EntityPlace,
  EntitySearchReply,
  PluginDetail,
  Task,
  TaskDetail,
} from "@hercule/contract";
import {
  buildErrorBody,
  holdAnswer,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  setVisibility,
  SIDEBAR_FIXTURE,
  stubApi,
  stubIntersectionObserver,
  type Call,
} from "../../../app/testing";

beforeEach(() => {
  stubIntersectionObserver();
});

afterEach(() => {
  setVisibility("visible");
  localStorage.clear();
});

const buildTaskId = (n: number): string => `01a06d02-7e00-7000-8000-${String(n).padStart(12, "0")}`;

const CARD = buildCard(buildTaskId(1), {
  title: "Print depot pick lists",
  projectId: SIDEBAR_FIXTURE.projects[0]!.id,
});
const TASK_PATH = `/api/v1/tasks/${CARD.id}`;
const LINK_PATH = `POST ${TASK_PATH}/entities/link`;
const UNLINK_PATH = `POST ${TASK_PATH}/entities/unlink`;
const SEARCH_PATH = "GET /api/v1/external-entities/search";

/** Returns an active plugin that declares one kind of thing, so the pane's search offers it as a source. */
const buildSource = (id: string, displayName: string): PluginDetail => ({
  id,
  displayName,
  hostApi: 8,
  capabilities: ["entities"],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [],
  intake: { eventKinds: [], signalKinds: [] },
  entityKinds: [
    {
      word: `${id}/issue`,
      noun: "Issue",
      card: "compact",
      refPrefix: `${id}:issue:`,
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
});

const buildIssue = (number: number, title: string, overrides: Partial<EntityPlace> = {}) =>
  buildPlace(`relay:issue:${String(number)}`, title, {
    kind: "relay/issue",
    noun: "Issue",
    caption: "Relay issue",
    identifier: `#${String(number)}`,
    ...overrides,
  });

const BASKET_BUG = buildIssue(412, "Basket is empty after signing in again", {
  status: { shape: "ring", tone: "active", label: "In progress" },
  latestChange: {
    reason: "reassigned",
    sentence: { say: "Now with Tessa", tone: "plain" },
    at: "2026-11-05T09:00:00.000Z",
  },
});
const GIFT_BUG = buildIssue(301, "Gift message is cut off at 140 characters");

/** The reply of the search: the gift issue, the basket issue already linked, and a thing from a pasted link. */
const buildReply = (source: string): EntitySearchReply => ({
  source,
  outcome: "results",
  results: [
    {
      ref: GIFT_BUG.ref,
      kind: GIFT_BUG.kind,
      noun: "Issue",
      identifier: "#301",
      title: GIFT_BUG.title!,
      location: "Gift cards",
      status: { shape: "dashed", tone: "quiet", label: "Backlog" },
      standing: "new",
    },
    {
      ref: BASKET_BUG.ref,
      kind: BASKET_BUG.kind,
      noun: "Issue",
      identifier: "#412",
      title: BASKET_BUG.title!,
      location: "Basket",
      standing: "new",
    },
  ],
  incomplete: false,
  linkSources: [],
});

const buildTask = (): Task => ({
  id: CARD.id,
  title: CARD.title,
  description: "",
  status: "open",
  stage: CARD.stage,
  priority: "normal",
  labels: [],
  provenance: [],
  createdAt: "2026-11-02T09:00:00.000Z",
  updatedAt: "2026-11-02T09:00:00.000Z",
  statusChangedAt: "2026-11-02T09:00:00.000Z",
  stageChangedAt: "2026-11-02T09:00:00.000Z",
});

/** Lists the bodies sent to `path`, oldest first. */
const readBodies = (calls: readonly Call[], path: string): unknown[] =>
  calls.filter((call) => `${call.method} ${call.path}` === path).map((call) => call.body);

/**
 * Opens the pane of a Task that links `initial`. The controller keeps the
 * Task's links as state: a link or an unlink changes what the next details
 * read answers, as the real one does, and says whether it changed anything.
 *
 * - `refusal` is what every link call answers instead.
 * - `alsoLinked` is a thing the controller has linked already but the first
 *   details read does not show, as when another client linked it a moment ago.
 * - `onlyShown` is a thing the first details read shows but the controller no
 *   longer has linked, as when another client removed it a moment ago.
 * - `heldLink` and `heldUnlink` hold the answer to the link call or the unlink
 *   call, so a test can act meanwhile. The test answers with the call's reply.
 */
const openPane = async ({
  initial = [BASKET_BUG],
  refusal,
  alsoLinked,
  onlyShown,
  heldLink,
  heldUnlink,
}: {
  readonly initial?: readonly EntityPlace[];
  readonly refusal?: { readonly status: number; readonly body: unknown };
  readonly alsoLinked?: EntityPlace;
  readonly onlyShown?: EntityPlace;
  readonly heldLink?: ReturnType<typeof holdAnswer>;
  readonly heldUnlink?: ReturnType<typeof holdAnswer>;
} = {}) => {
  let linked = [...initial, ...(alsoLinked === undefined ? [] : [alsoLinked])];
  // True until the first link or unlink: the details read then shows what the user last saw.
  let isStale = alsoLinked !== undefined || onlyShown !== undefined;
  const handlers = {
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    "GET /api/v1/tasks/board": () => ({ body: buildBoard(CARD) }),
    "GET /api/v1/tasks": { body: { items: [] } },
    "GET /api/v1/plugins": { body: [buildSource("relay", "Relay"), buildSource("acme", "Acme")] },
    [SEARCH_PATH]: (call: Call) => ({
      body: buildReply(new URLSearchParams(call.search).get("source") ?? "relay"),
    }),
    [`GET ${TASK_PATH}/detail`]: (): { body: TaskDetail } => {
      const shown = isStale
        ? [
            ...linked.filter((each) => each !== alsoLinked),
            ...(onlyShown === undefined ? [] : [onlyShown]),
          ]
        : linked;
      return {
        body: {
          task: buildTask(),
          card: CARD,
          sessions: [],
          sessionCount: 0,
          runs: [],
          runCount: 0,
          entities: shown,
          places: shown,
          edges: [],
        },
      };
    },
    [`POST ${TASK_PATH}/move`]: { body: buildTask() },
    [LINK_PATH]: async (call: Call) => {
      if (refusal !== undefined) return refusal;
      const ref = (call.body as { ref: string }).ref;
      const thing = [GIFT_BUG, BASKET_BUG].find((each) => each.ref === ref);
      const changed = thing !== undefined && !linked.includes(thing);
      if (changed) linked = [...linked, thing];
      isStale = false;
      if (heldLink !== undefined) return heldLink.handler();
      return { body: { task: buildTask(), changed } };
    },
    [UNLINK_PATH]: (call: Call) => {
      const ref = (call.body as { ref: string }).ref;
      const changed = linked.some((each) => each.ref === ref);
      linked = linked.filter((each) => each.ref !== ref);
      isStale = false;
      if (heldUnlink !== undefined) return heldUnlink.handler();
      return { body: { task: buildTask(), changed } };
    },
  };
  const calls = stubApi(handlers);
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    {
      path: "/work",
    },
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^Print depot pick lists/ }));
  const pane = await screen.findByRole("dialog", { name: "Print depot pick lists" });
  return { calls, user, pane, ...app };
};

/** Returns the Linked section of `pane`, once its details are read. */
const findLinked = (pane: HTMLElement): Promise<HTMLElement> =>
  within(pane).findByRole("region", { name: "Linked" });

describe("linking a thing to a Task from the details pane", () => {
  it("shows what each linked thing says about itself, and what changed at its source", async () => {
    const { pane } = await openPane();

    const linked = await findLinked(pane);

    expect(
      within(linked)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(["R#412 Basket is empty after signing in againNow with TessaIn progress"]);
  });

  it("links the thing a search finds, says so with Undo, and shows it as a row", async () => {
    const { calls, user, pane } = await openPane();
    const linked = await findLinked(pane);

    await user.click(within(linked).getByRole("button", { name: "Link something" }));
    await user.type(within(linked).getByRole("textbox", { name: "Link something" }), "gift");
    // The basket issue is linked already, so only the gift issue is offered.
    expect(
      await within(linked).findByRole("button", { name: /Gift message is cut off/ }),
    ).toBeTruthy();
    const found = linked.querySelector<HTMLElement>(".link-search-found")!;
    expect(within(found).getAllByRole("button")).toHaveLength(1);
    await user.click(within(linked).getByRole("button", { name: /Gift message is cut off/ }));

    expect(await screen.findByText("Linked #301 to Print depot pick lists.")).toBeTruthy();
    expect(readBodies(calls, LINK_PATH)).toEqual([{ ref: GIFT_BUG.ref }]);
    expect(await within(linked).findByText(/#301 Gift message is cut off/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Undo/ })).toBeTruthy();
    // Linking closed the search.
    expect(within(linked).getByRole("button", { name: "Link something" })).toBeTruthy();
  });

  it("links with Return the first thing found for a pasted link, on the source that reads it", async () => {
    const { calls, user, pane } = await openPane();
    const linked = await findLinked(pane);

    await user.click(within(linked).getByRole("button", { name: "Link something" }));
    await user.click(within(linked).getByRole("textbox", { name: "Link something" }));
    await user.paste("https://acme.example/shop/issues/301");
    await within(linked).findByRole("button", { name: /Gift message is cut off/ });
    expect(within(linked).getByRole("button", { name: "Acme", pressed: true })).toBeTruthy();
    await user.keyboard("{Enter}");

    expect(await screen.findByText("Linked #301 to Print depot pick lists.")).toBeTruthy();
    expect(readBodies(calls, LINK_PATH)).toEqual([{ ref: GIFT_BUG.ref }]);
  });

  it("closes the search with Esc and leaves the pane open", async () => {
    const { calls, user, pane } = await openPane();
    const linked = await findLinked(pane);
    await user.click(within(linked).getByRole("button", { name: "Link something" }));

    await user.keyboard("{Escape}");

    expect(within(linked).getByRole("button", { name: "Link something" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Print depot pick lists" })).toBeTruthy();
    expect(readBodies(calls, LINK_PATH)).toEqual([]);
  });

  it("removes a link, says so, and the row is gone once the details are read again", async () => {
    const { calls, user, pane } = await openPane();
    const linked = await findLinked(pane);

    await user.click(within(linked).getByRole("button", { name: /^Remove the link to #412/ }));

    expect(
      await screen.findByText(
        "Removed #412 from Print depot pick lists. It stays removed until you link it again.",
      ),
    ).toBeTruthy();
    expect(readBodies(calls, UNLINK_PATH)).toEqual([{ ref: BASKET_BUG.ref }]);
    await waitFor(() => {
      expect(within(pane).queryByText(/Basket is empty after signing in again/)).toBeNull();
    });
  });

  it("keeps a removed link removed when a push makes the board and the pane read again", async () => {
    const { user, pane, live } = await openPane();
    const linked = await findLinked(pane);
    await user.click(within(linked).getByRole("button", { name: /^Remove the link to #412/ }));
    await waitFor(() => {
      expect(within(pane).queryByText(/Basket is empty after signing in again/)).toBeNull();
    });
    await live.waitForFirstPushes();

    live.pushInvalidation("task", [CARD.id]);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(within(pane).queryByText(/Basket is empty after signing in again/)).toBeNull();
    expect(within(pane).getByRole("button", { name: "Link something" })).toBeTruthy();
  });

  it("puts a removed link back with Undo, and removes a new link with Undo", async () => {
    const { calls, user, pane } = await openPane();
    const linked = await findLinked(pane);

    await user.click(within(linked).getByRole("button", { name: /^Remove the link to #412/ }));
    await user.click(await screen.findByRole("button", { name: /^Undo/ }));

    expect(
      await screen.findByText("Put back: Removed the link from Print depot pick lists to #412."),
    ).toBeTruthy();
    expect(readBodies(calls, LINK_PATH)).toEqual([{ ref: BASKET_BUG.ref }]);
    expect(await within(pane).findByText(/Basket is empty after signing in again/)).toBeTruthy();

    await user.click(within(linked).getByRole("button", { name: "Link something" }));
    await user.type(within(linked).getByRole("textbox", { name: "Link something" }), "gift");
    // The basket issue is linked again, so only the gift issue is offered.
    await user.click(
      await within(linked).findByRole("button", { name: /Gift message is cut off/ }),
    );
    await screen.findByText("Linked #301 to Print depot pick lists.");
    await user.click(screen.getByRole("button", { name: /^Undo/ }));

    expect(
      await screen.findByText("Put back: Linked #301 to Print depot pick lists."),
    ).toBeTruthy();
    expect(readBodies(calls, UNLINK_PATH)).toEqual([
      { ref: BASKET_BUG.ref },
      { ref: GIFT_BUG.ref },
    ]);
  });

  it("says why a link was refused, with no Undo, and changes no row", async () => {
    const { user, pane } = await openPane({
      refusal: { status: 404, body: buildErrorBody("not_found", "That Task does not exist.") },
    });
    const linked = await findLinked(pane);

    await user.click(within(linked).getByRole("button", { name: "Link something" }));
    await user.type(within(linked).getByRole("textbox", { name: "Link something" }), "gift");
    await user.click(
      await within(linked).findByRole("button", { name: /Gift message is cut off/ }),
    );

    expect(
      await screen.findByText(
        "#301 was not linked to Print depot pick lists: That Task does not exist. Try again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    expect(within(linked).queryByText(/#301 Gift message/)).toBeNull();
  });

  it("sends one removal when the remove button is pressed again before the answer", async () => {
    const heldUnlink = holdAnswer();
    const { calls, user, pane } = await openPane({ heldUnlink });
    const linked = await findLinked(pane);
    const remove = within(linked).getByRole("button", { name: /^Remove the link to #412/ });

    await user.click(remove);
    await user.click(remove);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(readBodies(calls, UNLINK_PATH)).toEqual([{ ref: BASKET_BUG.ref }]);
    heldUnlink.answer({ body: { task: buildTask(), changed: true } });
  });

  it("offers no Undo for a link the Task had already, and Undo then changes nothing", async () => {
    const { calls, user, pane } = await openPane({ alsoLinked: GIFT_BUG });
    const linked = await findLinked(pane);
    await user.click(within(linked).getByRole("button", { name: "Link something" }));
    await user.type(within(linked).getByRole("textbox", { name: "Link something" }), "gift");
    await user.click(
      await within(linked).findByRole("button", { name: /Gift message is cut off/ }),
    );

    expect(
      await screen.findByText(
        "#301 was linked to Print depot pick lists already, so nothing changed.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    await user.keyboard("{Meta>}z{/Meta}");

    expect(await screen.findByText("Nothing to undo.")).toBeTruthy();
    expect(readBodies(calls, UNLINK_PATH)).toEqual([]);
  });

  it("offers no Undo for removing a link the Task no longer had, and Undo then changes nothing", async () => {
    const { calls, user, pane } = await openPane({ initial: [], onlyShown: GIFT_BUG });
    const linked = await findLinked(pane);

    await user.click(
      await within(linked).findByRole("button", { name: /^Remove the link to #301/ }),
    );

    expect(
      await screen.findByText(
        "#301 was not linked to Print depot pick lists, so nothing was removed.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    await user.keyboard("{Meta>}z{/Meta}");

    expect(await screen.findByText("Nothing to undo.")).toBeTruthy();
    expect(readBodies(calls, LINK_PATH)).toEqual([]);
  });

  it("keeps the undo line on the newest gesture when a slower answer comes after it", async () => {
    const heldLink = holdAnswer();
    const { calls, user, pane } = await openPane({ heldLink });
    const linked = await findLinked(pane);
    await user.click(within(linked).getByRole("button", { name: "Link something" }));
    await user.type(within(linked).getByRole("textbox", { name: "Link something" }), "gift");
    await user.click(
      await within(linked).findByRole("button", { name: /Gift message is cut off/ }),
    );
    await user.click(within(pane).getByRole("button", { name: "Planned" }));
    expect(await screen.findByText('Moved "Print depot pick lists" to Planned.')).toBeTruthy();

    heldLink.answer({ body: { task: buildTask(), changed: true } });
    await waitFor(() => {
      expect(readBodies(calls, LINK_PATH)).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The line still names the move, and Undo reverses the move: the link stays.
    expect(screen.getByText('Moved "Print depot pick lists" to Planned.')).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Undo/ }));
    expect(
      await screen.findByText('Put back: Moved "Print depot pick lists" to Planned.'),
    ).toBeTruthy();
    expect(readBodies(calls, UNLINK_PATH)).toEqual([]);
  });

  it("offers Link something on a Task that links nothing yet, under a Linked heading", async () => {
    const { pane } = await openPane({ initial: [] });

    const linked = await findLinked(pane);

    expect(within(linked).getByRole("button", { name: "Link something" })).toBeTruthy();
    expect(within(linked).queryByRole("list")).toBeNull();
  });
});
