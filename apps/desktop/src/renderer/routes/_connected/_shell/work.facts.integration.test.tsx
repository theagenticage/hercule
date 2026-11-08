/**
 * Tests a card that moves by itself on the Work board, through the rendered
 * screen: a fact moves a card (its cause lands on the card first, the card
 * crosses, the place it left stays open as a dent, and the toolbar's line says
 * what happened), and the morning replay plays what changed since the board was
 * last drawn (or says so, with no motion). That a drag holds a fact until the
 * drop is tested where the wait is, in `use-held-changes.test.tsx`.
 *
 * A page with no stylesheet counts as Reduce motion, so a test that wants the
 * motion sets the `--dur-2` token the way the stylesheet does.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { buildBoard, buildCard } from "@hercule/client-core/work/testing";
import type { WorkBoard, WorkCard } from "@hercule/contract";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  setVisibility,
  SIDEBAR_FIXTURE,
  stubApi,
  stubIntersectionObserver,
} from "../../../app/testing";
import { buildBoardSnapshot } from "@hercule/client-core/work";
import { buildBoardSnapshotKey } from "../../../screens/work/board-snapshot-storage";

beforeEach(() => {
  stubIntersectionObserver();
});

afterEach(() => {
  setVisibility("visible");
  localStorage.clear();
  document.documentElement.style.removeProperty("--dur-2");
});

const WEBSHOP = SIDEBAR_FIXTURE.projects[0]!;
const buildTaskId = (n: number): string => `01a06d02-7e00-7000-8000-${String(n).padStart(12, "0")}`;
const MERGED = { factId: 4, ref: "github:pull-request:6221", text: "Pull request #6221 merged" };
const SNAPSHOT_KEY = buildBoardSnapshotKey(CONTROLLER_URL, SIDEBAR_FIXTURE.username);

const SLOTS = buildCard(buildTaskId(1), {
  title: "Cache delivery slot lookups",
  projectId: WEBSHOP.id,
  stage: "in-review",
  boardRank: "a",
});
const NEIGHBOUR = buildCard(buildTaskId(2), {
  title: "Order history hides cancelled items",
  projectId: WEBSHOP.id,
  stage: "in-review",
  boardRank: "b",
});
const BUILDING = buildCard(buildTaskId(3), {
  title: "Renew the payment gateway certificate",
  projectId: WEBSHOP.id,
  stage: "building",
  boardRank: "c",
});

/** Returns the card `card` as a pull request merging moved it to `stage`. */
const moveByFact = (card: WorkCard, stage: WorkCard["stage"]): WorkCard => ({
  ...card,
  stage,
  stageCause: MERGED,
  stageChangedAt: "2026-11-03T03:00:00.000Z",
});

/** Opens the app at Work. `board` is what the controller answers to each read. */
const openWork = async (board: () => WorkBoard) => {
  stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    "GET /api/v1/tasks/board": () => ({ body: board() }),
    "GET /api/v1/tasks": { body: { items: [] } },
    "GET /api/v1/controller": {
      body: {
        id: buildTaskId(7000),
        publicKey: "cHVibGljLWtleQ==",
        version: "0.4.2",
        defaultRunnerId: null,
        localRunnerId: null,
        textGeneration: { model: null, lastFailure: null, unavailableReason: null },
      },
    },
  });
  return renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }), {
    path: "/work",
  });
};

/** Returns the card named `title`: its button, which the screen reader names from its words. */
const getCard = (title: string): HTMLElement =>
  screen.getByRole("button", { name: new RegExp(`^${title}`) });

const queryCard = (title: string): HTMLElement | null =>
  screen.queryByRole("button", { name: new RegExp(`^${title}`) });

/** Returns the words of the toolbar's line. */
const readLine = (): string => document.querySelector(".work-toolbar-line")?.textContent ?? "";

/** Returns the cell of the webshop lane that holds `stage`. */
const getWebshopCell = (stage: string): HTMLElement =>
  within(screen.getByRole("heading", { name: /webshop/ }).closest("section")!).getByRole("group", {
    name: new RegExp(`^${stage}`, "i"),
  });

describe("a card that a fact moves", () => {
  it("shows its cause on the card, then crosses to the new cell, and the toolbar's line says why", async () => {
    document.documentElement.style.setProperty("--dur-2", "200ms");
    let hasMerged = false;
    const { live } = await openWork(() =>
      buildBoard(
        ...(hasMerged
          ? [NEIGHBOUR, BUILDING, moveByFact(SLOTS, "building")]
          : [SLOTS, NEIGHBOUR, BUILDING]),
      ),
    );
    await screen.findByRole("button", { name: /^Cache delivery slot lookups/ });
    await live.waitForFirstPushes();

    hasMerged = true;
    live.pushInvalidation("task", [SLOTS.id]);

    // The cause lands first, on the card, where it still stands.
    await waitFor(() => {
      expect(getCard("Cache delivery slot lookups").querySelector(".card-cause")?.textContent).toBe(
        "Pull request #6221 merged",
      );
    });
    expect(getCard("Cache delivery slot lookups").dataset["stage"]).toBe("in-review");
    expect(readLine()).toBe("");

    // Then the card crosses to the end of Building, wearing the cause until it arrives.
    await waitFor(() => {
      expect(getCard("Cache delivery slot lookups").dataset["stage"]).toBe("building");
    });
    const building = getWebshopCell("Building");
    expect(
      [...building.querySelectorAll<HTMLElement>("[data-card-id]")].map(
        (card) => card.dataset["cardId"],
      ),
    ).toEqual([BUILDING.id, SLOTS.id]);
    expect(getCard("Cache delivery slot lookups").querySelector(".card-cause")).not.toBeNull();
    expect(readLine()).toBe("Pull request #6221 merged");
  });

  it("keeps the place it left open as a dent, so nothing below it jumps, and closes it later", async () => {
    let hasMerged = false;
    const { live } = await openWork(() =>
      buildBoard(
        ...(hasMerged
          ? [NEIGHBOUR, BUILDING, moveByFact(SLOTS, "building")]
          : [SLOTS, NEIGHBOUR, BUILDING]),
      ),
    );
    await screen.findByRole("button", { name: /^Cache delivery slot lookups/ });
    await live.waitForFirstPushes();

    hasMerged = true;
    live.pushInvalidation("task", [SLOTS.id]);

    await waitFor(() => {
      expect(getWebshopCell("In review").querySelector(".desk-dent")).not.toBeNull();
    });
    // The dent stands where the card stood: before the card that was under it.
    const inReview = [...getWebshopCell("In review").children];
    expect(inReview[0]?.classList.contains("desk-dent")).toBe(true);
    expect(inReview[1]).toBe(getCard("Order history hides cancelled items"));

    await waitFor(
      () => {
        expect(getWebshopCell("In review").querySelector(".desk-dent")).toBeNull();
      },
      { timeout: 4_000 },
    );
  });

  it("moves a card into Landed into the line that counts what landed, and says why", async () => {
    let hasMerged = false;
    const { live } = await openWork(() =>
      buildBoard(...(hasMerged ? [NEIGHBOUR, moveByFact(SLOTS, "landed")] : [SLOTS, NEIGHBOUR])),
    );
    await screen.findByRole("button", { name: /^Cache delivery slot lookups/ });
    await live.waitForFirstPushes();

    hasMerged = true;
    live.pushInvalidation("task", [SLOTS.id]);

    expect(await screen.findByRole("button", { name: "1 landed" })).toBeTruthy();
    expect(queryCard("Cache delivery slot lookups")).toBeNull();
    expect(readLine()).toBe("Pull request #6221 merged");
  });

  it("shows the label and then the card in its new place under Reduce motion", async () => {
    let hasMerged = false;
    const { live } = await openWork(() =>
      buildBoard(
        ...(hasMerged
          ? [NEIGHBOUR, BUILDING, moveByFact(SLOTS, "building")]
          : [SLOTS, NEIGHBOUR, BUILDING]),
      ),
    );
    await screen.findByRole("button", { name: /^Cache delivery slot lookups/ });
    await live.waitForFirstPushes();

    hasMerged = true;
    live.pushInvalidation("task", [SLOTS.id]);

    await waitFor(() => {
      expect(document.querySelector(".card-cause")?.textContent).toBe("Pull request #6221 merged");
    });
    await waitFor(() => {
      expect(getCard("Cache delivery slot lookups").dataset["stage"]).toBe("building");
    });
    expect(readLine()).toBe("Pull request #6221 merged");
  });

  it("says only the cause on the line for a card that lies past what its cell shows", async () => {
    const crowded = Array.from({ length: 6 }, (_, index) =>
      buildCard(buildTaskId(100 + index), {
        title: `Crowded card ${String(index)}`,
        projectId: WEBSHOP.id,
        stage: "building",
        boardRank: `c${String(index)}`,
      }),
    );
    let hasMerged = false;
    const { live } = await openWork(() =>
      buildBoard(
        ...(hasMerged ? [...crowded, moveByFact(SLOTS, "building")] : [SLOTS, ...crowded]),
      ),
    );
    await screen.findByRole("button", { name: /^Cache delivery slot lookups/ });
    await live.waitForFirstPushes();

    hasMerged = true;
    live.pushInvalidation("task", [SLOTS.id]);

    expect(await screen.findByRole("button", { name: "3 more" })).toBeTruthy();
    expect(queryCard("Cache delivery slot lookups")).toBeNull();
    expect(readLine()).toBe("Pull request #6221 merged");
  });
});

describe("the morning replay", () => {
  /** Stores `board` as the board that was last drawn. */
  const rememberBoard = (board: WorkBoard): void => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(buildBoardSnapshot(board)));
  };

  it("starts from how the board was left, plays what changed, and leaves a line with a button to see it again", async () => {
    document.documentElement.style.setProperty("--dur-2", "200ms");
    rememberBoard(buildBoard(SLOTS, NEIGHBOUR, BUILDING));
    await openWork(() => buildBoard(NEIGHBOUR, BUILDING, moveByFact(SLOTS, "building")));

    // The first picture is the board as it was left.
    expect(
      await screen.findByRole("button", { name: /^Cache delivery slot lookups/ }),
    ).toBeTruthy();
    expect(getCard("Cache delivery slot lookups").dataset["stage"]).toBe("in-review");
    expect(readLine()).toBe("");

    // Then the change plays in turn: the cause first, then the card in Building.
    await waitFor(
      () => {
        expect(getCard("Cache delivery slot lookups").dataset["stage"]).toBe("building");
      },
      { timeout: 4_000 },
    );
    expect(readLine()).toBe("Pull request #6221 merged");

    // One quiet line stays afterwards.
    const replay = await screen.findByRole(
      "button",
      { name: "Replay what changed" },
      { timeout: 4_000 },
    );
    expect(readLine()).toBe("Since you last looked: one moved");

    // The button plays it again from how the board was left.
    fireEvent.click(replay);
    expect(getCard("Cache delivery slot lookups").dataset["stage"]).toBe("in-review");
    expect(readLine()).toBe("");
    await waitFor(
      () => {
        expect(getCard("Cache delivery slot lookups").dataset["stage"]).toBe("building");
      },
      { timeout: 4_000 },
    );
  });

  it("plays a Task that arrived in the night by rising it in, and counts it as new", async () => {
    document.documentElement.style.setProperty("--dur-2", "200ms");
    const arrival = buildCard(buildTaskId(60), {
      title: "Refund emails show the wrong currency",
      projectId: WEBSHOP.id,
      createdAt: "2026-11-03T02:00:00.000Z",
    });
    rememberBoard(buildBoard(SLOTS, NEIGHBOUR));
    await openWork(() => buildBoard(SLOTS, NEIGHBOUR, arrival));

    await screen.findByRole("button", { name: /^Cache delivery slot lookups/ });
    expect(queryCard("Refund emails show the wrong currency")).toBeNull();

    expect(
      await screen.findByRole(
        "button",
        { name: /^Refund emails show the wrong currency/ },
        { timeout: 4_000 },
      ),
    ).toBeTruthy();
    await screen.findByRole("button", { name: "Replay what changed" }, { timeout: 4_000 });
    expect(readLine()).toBe("Since you last looked: one new");
  });

  it("plays nothing under Reduce motion: the board is drawn as it is, and the line says what changed", async () => {
    rememberBoard(buildBoard(SLOTS, NEIGHBOUR, BUILDING));
    await openWork(() => buildBoard(NEIGHBOUR, BUILDING, moveByFact(SLOTS, "building")));

    await screen.findByRole("button", { name: /^Cache delivery slot lookups/ });

    expect(getCard("Cache delivery slot lookups").dataset["stage"]).toBe("building");
    expect(readLine()).toBe("Since you last looked: one moved");
    expect(screen.queryByRole("button", { name: "Replay what changed" })).toBeNull();
    expect(document.querySelector(".card-cause")).toBeNull();
  });

  it("plays nothing, and stores the first read, when there is no snapshot", async () => {
    document.documentElement.style.setProperty("--dur-2", "200ms");
    await openWork(() => buildBoard(NEIGHBOUR, BUILDING, moveByFact(SLOTS, "building")));

    await screen.findByRole("button", { name: /^Cache delivery slot lookups/ });

    expect(getCard("Cache delivery slot lookups").dataset["stage"]).toBe("building");
    expect(readLine()).toBe("");
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "null") as {
        cards: { id: string; stage: string }[];
      } | null;
      expect(stored?.cards.map((card) => [card.id, card.stage])).toEqual([
        [NEIGHBOUR.id, "in-review"],
        [BUILDING.id, "building"],
        [SLOTS.id, "building"],
      ]);
    });
  });

  it("plays nothing, and says nothing, when the board is as it was left", async () => {
    document.documentElement.style.setProperty("--dur-2", "200ms");
    const board = buildBoard(SLOTS, NEIGHBOUR, BUILDING);
    rememberBoard(board);
    await openWork(() => board);

    await screen.findByRole("button", { name: /^Cache delivery slot lookups/ });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    expect(readLine()).toBe("");
    expect(screen.queryByRole("button", { name: "Replay what changed" })).toBeNull();
  });

  it("stores the first board at once, and the board as last drawn when the window is hidden", async () => {
    let hasMoved = false;
    const { live } = await openWork(() =>
      buildBoard(hasMoved ? { ...SLOTS, stage: "building" } : SLOTS, NEIGHBOUR),
    );
    await screen.findByRole("button", { name: /^Cache delivery slot lookups/ });
    await live.waitForFirstPushes();
    const stageOf = (id: string): string | undefined =>
      (
        JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "null") as {
          cards: { id: string; stage: string }[];
        } | null
      )?.cards.find((card) => card.id === id)?.stage;
    expect(stageOf(SLOTS.id)).toBe("in-review");

    // A move from another client shows at once, and is not stored until the window leaves.
    hasMoved = true;
    live.pushInvalidation("task", [SLOTS.id]);
    await waitFor(() => {
      expect(getCard("Cache delivery slot lookups").dataset["stage"]).toBe("building");
    });
    expect(stageOf(SLOTS.id)).toBe("in-review");

    setVisibility("hidden");

    expect(stageOf(SLOTS.id)).toBe("building");
  });
});
