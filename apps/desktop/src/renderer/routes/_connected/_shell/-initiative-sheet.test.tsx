/**
 * Tests `useInitiativeSheet` with its sheet: what a save, a close and a delete
 * send to the controller, what they write into the cached list of open
 * Initiatives, what the undo line is told, and what a signed-out user's late
 * answer does. The sheet's own keys are in `initiative-sheet.test.tsx`.
 */
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { INITIATIVE_HUES, type Initiative, type Project } from "@hercule/contract";
import { openTestAccountScope } from "../../../app/testing-account-scope";
import type { Gesture } from "../../../app/undo-stack";
import type { CardMover } from "../../../app/card-mover";
import { projectsQuery } from "../../../app/queries";
import { initiativesQuery } from "./-work-board";
import { useInitiativeSheet, type InitiativeSheetControls } from "./-initiative-sheet";

const REFUNDS: Initiative = {
  id: "refunds",
  name: "Gift card refunds",
  intent: "Refund to the card",
  target: "Live by spring",
  hue: INITIATIVE_HUES[0],
  projectId: "web",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const buildProject = (id: string, name: string): Project => ({
  id,
  name,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const PROJECTS = [buildProject("web", "Storefront"), buildProject("api", "Platform")];

const setUp = (client: Partial<HerculeClient["initiative"]> = {}) => {
  let token: string | null = "token-1";
  const initiativeCalls = {
    create: vi.fn((): Promise<Initiative> =>
      Promise.resolve({
        ...REFUNDS,
        id: "new",
        name: "Returns page",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    ),
    update: vi.fn((): Promise<Initiative> => Promise.resolve(REFUNDS)),
    close: vi.fn((): Promise<Initiative> =>
      Promise.resolve({ ...REFUNDS, closedAt: "2026-02-01T00:00:00.000Z" }),
    ),
    reopen: vi.fn((): Promise<Initiative> => Promise.resolve(REFUNDS)),
    delete: vi.fn(() => Promise.resolve({})),
    ...client,
  };
  const herculeClient = {
    getToken: () => token,
    initiative: initiativeCalls,
  } as unknown as HerculeClient;
  const queryClient = new QueryClient();
  queryClient.setQueryData(initiativesQuery(herculeClient).queryKey, [REFUNDS]);
  queryClient.setQueryData(projectsQuery(herculeClient).queryKey, PROJECTS);
  const { scope } = openTestAccountScope(herculeClient, queryClient);
  const gestures: Gesture<CardMover>[] = [];
  const lines: string[] = [];
  const sayWithUndo = vi.fn((text: string, gesture: Gesture<CardMover>) => {
    lines.push(text);
    gestures.push(gesture);
    return () => undefined;
  });
  const sayWithoutUndo = vi.fn((text: string) => {
    lines.push(text);
  });
  let controls!: InitiativeSheetControls;
  function Harness() {
    controls = useInitiativeSheet({
      client: herculeClient,
      scope,
      sayWithUndo,
      sayWithoutUndo,
    });
    return controls.sheet;
  }
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
  return {
    calls: initiativeCalls,
    /** Plays another client changing the Initiative: the push reads the list again. */
    writeList: (list: readonly Initiative[]) => {
      act(() => {
        queryClient.setQueryData(initiativesQuery(herculeClient).queryKey, list);
      });
    },
    controls: () => controls,
    lines,
    gestures,
    sayWithoutUndo,
    readList: () =>
      queryClient.getQueryData<readonly Initiative[]>(initiativesQuery(herculeClient).queryKey),
    signOut: () => {
      token = null;
    },
  };
};

describe("useInitiativeSheet", () => {
  it("opens a new Initiative in the least used hue and the lane it came from, and creates it", async () => {
    const user = userEvent.setup();
    const { controls, calls, readList, lines } = setUp();

    act(() => {
      controls().openNew("api");
    });
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "  Returns page {Enter}");

    await waitFor(() => {
      expect(calls.create).toHaveBeenCalledExactlyOnceWith({
        payload: { name: "Returns page", hue: INITIATIVE_HUES[1], projectId: "api" },
      });
    });
    await waitFor(() => {
      expect(controls().sheet).toBeNull();
    });
    expect(readList()?.map((each) => each.id)).toEqual(["refunds", "new"]);
    expect(lines).toEqual(["Added the initiative Returns page."]);
  });

  it("sends null for a target that was emptied, and only that", async () => {
    const user = userEvent.setup();
    const { controls, calls } = setUp();

    act(() => {
      controls().openEdit("refunds");
    });
    expect(await screen.findByRole("heading", { name: "Gift card refunds" })).toBeTruthy();
    await user.clear(screen.getByRole("textbox", { name: "Target" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(calls.update).toHaveBeenCalledExactlyOnceWith({
        params: { id: "refunds" },
        payload: { target: null },
      });
    });
  });

  it("sends only what the user changed since opening, not what another client changed meanwhile", async () => {
    const user = userEvent.setup();
    const { controls, calls, writeList } = setUp();

    act(() => {
      controls().openEdit("refunds");
    });
    await user.type(await screen.findByRole("textbox", { name: "Name" }), " v2");
    // Another client writes an intent and the sheet's list is read again before the user saves.
    writeList([{ ...REFUNDS, intent: "Refund to the card, or to store credit" }]);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(calls.update).toHaveBeenCalledExactlyOnceWith({
        params: { id: "refunds" },
        payload: { name: "Gift card refunds v2" },
      });
    });
  });

  it("sends nothing for an edit that changed nothing, and closes the sheet", async () => {
    const user = userEvent.setup();
    const { controls, calls } = setUp();

    act(() => {
      controls().openEdit("refunds");
    });
    await user.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(controls().sheet).toBeNull();
    });
    expect(calls.update).not.toHaveBeenCalled();
  });

  it("opens only an Initiative that is listed", () => {
    const { controls } = setUp();

    act(() => {
      controls().openEdit("closed-one");
    });

    expect(controls().isOpen).toBe(false);
  });

  it("closes the Initiative, takes it off the list and offers an Undo that reopens it", async () => {
    const user = userEvent.setup();
    const { controls, calls, readList, lines, gestures } = setUp();

    act(() => {
      controls().openEdit("refunds");
    });
    await user.click(await screen.findByRole("button", { name: "Close initiative" }));

    await waitFor(() => {
      expect(readList()).toEqual([]);
    });
    expect(lines).toEqual(["Closed Gift card refunds."]);
    expect(controls().sheet).toBeNull();

    await act(async () => {
      await gestures[0]?.undo({} as CardMover);
    });

    expect(calls.reopen).toHaveBeenCalledExactlyOnceWith({ params: { id: "refunds" } });
    expect(readList()).toEqual([REFUNDS]);
  });

  it("deletes once confirmed, takes the Initiative off the list, and offers no Undo", async () => {
    const user = userEvent.setup();
    const { controls, calls, readList, lines, gestures } = setUp();

    act(() => {
      controls().openEdit("refunds");
    });
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(calls.delete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete initiative" }));

    await waitFor(() => {
      expect(calls.delete).toHaveBeenCalledExactlyOnceWith({ params: { id: "refunds" } });
    });
    await waitFor(() => {
      expect(readList()).toEqual([]);
    });
    expect(lines).toEqual(["Deleted Gift card refunds. Its Tasks stay, and leave it."]);
    expect(gestures).toHaveLength(0);
  });

  it("shows what the controller refused in the sheet, which stays open", async () => {
    const user = userEvent.setup();
    const { controls } = setUp({
      create: () => Promise.reject(new Error("That project does not exist.")),
    });

    act(() => {
      controls().openNew();
    });
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "Returns{Enter}");

    expect((await screen.findByRole("alert")).textContent).toBe("That project does not exist.");
    expect(controls().isOpen).toBe(true);
  });

  it("writes nothing and says nothing when the answer came after the user signed out", async () => {
    const user = userEvent.setup();
    let answer: (initiative: Initiative) => void = () => undefined;
    const { controls, readList, lines, signOut } = setUp({
      create: () =>
        new Promise<Initiative>((resolve) => {
          answer = resolve;
        }),
    });

    act(() => {
      controls().openNew();
    });
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "Returns{Enter}");
    signOut();
    await act(() => {
      answer({ ...REFUNDS, id: "late" });
      return Promise.resolve();
    });

    expect(readList()?.map((each) => each.id)).toEqual(["refunds"]);
    expect(lines).toEqual([]);
  });
});
