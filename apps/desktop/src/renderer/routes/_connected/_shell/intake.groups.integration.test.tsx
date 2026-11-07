/**
 * Tests the groups on Intake's To do list: the header over the signals about
 * one outside thing, the keys that walk past it, and the `entity` param that
 * scrolls the list to a group.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PluginDetail, Signal, SignalEntity } from "@hercule/contract";
import {
  answerSignalQuery,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  type Handler,
} from "../../../app/testing";

// The Office draws a 3D scene, which jsdom cannot, so a stub stands in for it.
vi.mock("../../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

beforeEach(() => {
  stubElementSize(1168, 800);
  // jsdom lays nothing out, so it has no `scrollIntoView`.
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  localStorage.clear();
  // The tests that scroll define these on the prototype.
  Reflect.deleteProperty(Element.prototype, "scrollTo");
  Reflect.deleteProperty(Element.prototype, "scrollHeight");
});

const GITHUB: PluginDetail = {
  id: "github",
  displayName: "GitHub",
  mark: { paths: ["M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0z"] },
  hostApi: 2,
  capabilities: [],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [],
  intake: { eventKinds: [], signalKinds: [] },
  entityKinds: [],
};

const CONNECTION_ID = "01a06d02-7200-7000-8000-0000000000c1";

const PULL_REQUEST: SignalEntity = {
  id: "01a06d02-7e00-7000-8000-000000000001",
  kind: "github/pull-request",
  identifier: "#87",
  title: "Retry webhooks with backoff",
};

/** Builds the id of the `index`th signal. */
const buildSignalId = (index: number): string =>
  `01a06d02-7a00-7000-8000-${String(index).padStart(12, "0")}`;

/** Builds an open signal created at minute `index` of the day, about `entity` when it is given. */
const buildSignal = (index: number, entity?: SignalEntity): Signal => ({
  id: buildSignalId(index),
  kind: "github/review-requested",
  origin: {
    type: "event",
    eventId: index,
    connectionId: CONNECTION_ID,
    threadRef: `acme/webshop#${String(index)}`,
  },
  title: `Signal ${String(index)}`,
  priority: "normal",
  blocks: [],
  actions: [],
  match: {},
  status: "open",
  createdAt: `2026-10-10T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`,
  ...(entity === undefined ? {} : { entity }),
});

const openIntake = async (signals: ReadonlyArray<Signal>, path = "/intake") => {
  const handlers: Record<string, Handler> = {
    "GET /api/v1/signals": (call) => answerSignalQuery(signals, call),
    "GET /api/v1/plugins": { body: [GITHUB] },
  };
  stubApi({ ...buildSidebarHandlers(SIDEBAR_FIXTURE), ...handlers });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path },
  );
  await screen.findByRole("heading", { level: 1, name: "Intake" });
  return app;
};

const getList = () => screen.getByRole("region", { name: "Signals" });
const getRow = (signal: Signal) =>
  getList().querySelector<HTMLElement>(`[data-signal-id="${signal.id}"]`);
/** Returns the headers of the groups, each as its text, in the order drawn. */
const readGroupHeaders = () =>
  [...getList().querySelectorAll(".asks-group")].map((header) => header.textContent);

describe("a group on Intake's To do list", () => {
  it("draws one header before the signals about a thing, which stay together in the order they had", async () => {
    const first = buildSignal(1, PULL_REQUEST);
    const other = buildSignal(2);
    const second = buildSignal(3, PULL_REQUEST);
    await openIntake([first, other, second]);

    expect(readGroupHeaders()).toEqual(["Retry webhooks with backoff #87"]);
    const header = getList().querySelector(".asks-group")!;
    // The mark is the plugin's, hidden from assistive technology like every source mark.
    expect(header.querySelector(".asks-group-mark svg")).not.toBeNull();
    const rows = [...getList().querySelectorAll("[data-signal-id]")].map((row) =>
      row.getAttribute("data-signal-id"),
    );
    expect(rows).toEqual([first.id, second.id, other.id]);
    expect(header.nextElementSibling?.contains(getRow(first))).toBe(true);
  });

  it("leaves a signal with no entity as a row of its own, with no header", async () => {
    await openIntake([buildSignal(1), buildSignal(2)]);

    expect(readGroupHeaders()).toEqual([]);
    expect(getList().querySelectorAll("[data-signal-id]")).toHaveLength(2);
  });

  it("is passed over by J and K, which walk the rows alone", async () => {
    const lone = buildSignal(1);
    const first = buildSignal(2, PULL_REQUEST);
    const second = buildSignal(3, PULL_REQUEST);
    const { router } = await openIntake([lone, first, second]);

    await userEvent.click(getRow(lone)!);
    await userEvent.keyboard("j");
    expect(router.state.location.search).toMatchObject({ signal: first.id });
    await userEvent.keyboard("j");
    expect(router.state.location.search).toMatchObject({ signal: second.id });
    await userEvent.keyboard("k");
    await userEvent.keyboard("k");
    expect(router.state.location.search).toMatchObject({ signal: lone.id });
  });

  it("is a heading for the rows under it, with no button or checkbox of its own", async () => {
    await openIntake([buildSignal(1, PULL_REQUEST)]);

    const header = within(getList()).getByRole("heading", {
      level: 3,
      name: "Retry webhooks with backoff #87",
    });
    expect(within(header).queryByRole("button")).toBeNull();
    expect(within(header).queryByRole("checkbox")).toBeNull();
  });
});

describe("the entity param", () => {
  /** Sixty signals about nothing in particular, older than the one group at the end of the list. */
  const buildLongList = () => [
    ...Array.from({ length: 60 }, (_, index) => buildSignal(index + 1)),
    buildSignal(100, PULL_REQUEST),
    buildSignal(101, PULL_REQUEST),
  ];

  it("leaves a group far down the list undrawn when the list opens as usual", async () => {
    await openIntake(buildLongList());

    expect(readGroupHeaders()).toEqual([]);
  });

  it("scrolls the list to that thing's group, to the top of the view", async () => {
    // jsdom has no `Element.scrollTo`, which the list's virtualizer scrolls with, and it lays out
    // nothing, so the scroll area's height is a stub too: tall enough to scroll to the group's top.
    Object.defineProperty(Element.prototype, "scrollHeight", { configurable: true, value: 10_000 });
    const scrolledTo: number[] = [];
    Element.prototype.scrollTo = function scrollTo(
      this: Element,
      options?: ScrollToOptions | number,
    ) {
      const top = typeof options === "object" ? (options.top ?? 0) : 0;
      scrolledTo.push(top);
      this.scrollTop = top;
      // The browser delivers the scroll event after the effect that scrolled.
      queueMicrotask(() => {
        act(() => {
          fireEvent.scroll(this);
        });
      });
    } as Element["scrollTo"];

    await openIntake(buildLongList(), `/intake?entity=${PULL_REQUEST.id}`);

    await waitFor(() => {
      expect(readGroupHeaders()).toEqual(["Retry webhooks with backoff #87"]);
    });
    // The Signals heading (40px) and the sixty rows (52px and a 2px gap) come before the header.
    expect(scrolledTo).toContain(40 + 60 * 54);
  });

  it("opens the list as usual when no group is about the thing", async () => {
    await openIntake(buildLongList(), "/intake?entity=01a06d02-7e00-7000-8000-0000000000ff");

    expect(readGroupHeaders()).toEqual([]);
    expect(getRow(buildSignal(1))).not.toBeNull();
  });
});
