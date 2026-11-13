/** Tests that "Link to..." shows what the Inbox offers, reads again only for typed text, and reports a pick. */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import { buildInboxThing } from "@hercule/client-core/inbox/testing";
import { InboxLinkToPart } from "./-inbox-link-to-part";

afterEach(() => {
  vi.useRealTimers();
});

type Thing = ReturnType<typeof buildInboxThing>;

/** One reply of the controller: the things of a page. */
interface Page {
  readonly things: ReadonlyArray<Thing>;
}

/** Renders the part over a row, with a controller that answers `pages` in turn, one to each read. */
const renderPart = (list: ReadonlyArray<Page>) => {
  let next = 0;
  const queryInbox = vi.fn<
    (query: { payload: { mode: string; text?: string } }, options: unknown) => Promise<unknown>
  >((query) => {
    const page = list[Math.min(next, list.length - 1)]!;
    next += 1;
    return Promise.resolve({
      mode: query.payload.mode,
      things: page.things,
      groups: [],
      offerSets: {},
      total: page.things.length,
    });
  });
  const client = {
    externalEntity: { queryInbox },
    plugin: { query: () => Promise.resolve([]) },
  } as unknown as HerculeClient;
  const onLink = vi.fn<(fromRef: string, to: { ref: string }) => void>();
  const onClose = vi.fn<() => void>();
  const row = document.createElement("div");
  document.body.append(row);
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <InboxLinkToPart
        client={client}
        anchor={row}
        fromRef="acme:ticket:from"
        fromLabel="ACME-from"
        excludedRefs={["acme:ticket:member"]}
        onLink={onLink}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { queryInbox, onLink, onClose, queryClient };
};

describe("InboxLinkToPart", () => {
  it("shows what Everything offers, without the thing and its group", async () => {
    renderPart([
      {
        things: [
          buildInboxThing("from", { ref: "acme:ticket:from" }),
          buildInboxThing("member", { ref: "acme:ticket:member" }),
          buildInboxThing("1"),
          buildInboxThing("2"),
        ],
      },
    ]);
    await waitFor(() => {
      expect(screen.getAllByRole("option", { hidden: true })).toHaveLength(2);
    });
    expect(screen.getByText("Ticket 1")).toBeTruthy();
    expect(screen.queryByText("Ticket from")).toBeNull();
    expect(screen.queryByText("Ticket member")).toBeNull();
  });

  it("does not read again when the Inbox changes while the popover is open", async () => {
    const { queryInbox, queryClient } = renderPart([{ things: [buildInboxThing("1")] }]);
    await screen.findByRole("option", { hidden: true });

    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.inbox() }));

    expect(queryInbox).toHaveBeenCalledTimes(1);
  });

  it("reads again with the typed text after a quiet, not on every key", async () => {
    const { queryInbox } = renderPart([{ things: [buildInboxThing("1")] }]);
    await screen.findByRole("option", { hidden: true });
    await userEvent.keyboard("ab");
    await waitFor(() => {
      expect(queryInbox).toHaveBeenCalledTimes(2);
    });
    expect(queryInbox.mock.calls[1]?.[0].payload.text).toBe("ab");
  });

  it("links from the thing to the picked one, then closes", async () => {
    const { onLink, onClose } = renderPart([
      { things: [buildInboxThing("1"), buildInboxThing("2")] },
    ]);
    await screen.findAllByRole("option", { hidden: true });
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onLink).toHaveBeenCalledWith(
      "acme:ticket:from",
      expect.objectContaining({ ref: "acme:ticket:2" }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("does no work while nothing is typed: no second read, however long it waits", async () => {
    vi.useFakeTimers();
    const { queryInbox } = renderPart([{ things: [buildInboxThing("1")] }]);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const timers = vi.getTimerCount();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(queryInbox).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timers);
  });
});
