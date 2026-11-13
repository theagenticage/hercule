/** Tests that "Link to..." reads the Inbox's Everything list, leaves out what cannot be linked, and reports a pick. */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HerculeClient } from "@hercule/client-core";
import { buildInboxThing } from "@hercule/client-core/inbox/testing";
import { InboxLinkToPart } from "./-inbox-link-to-part";

afterEach(() => {
  vi.useRealTimers();
});

/** Renders the part over a row, with a controller that answers `things` to every read. */
const renderPart = (things: ReadonlyArray<ReturnType<typeof buildInboxThing>>) => {
  const queryInbox = vi.fn<
    (query: { payload: { text?: string } }, options: unknown) => Promise<unknown>
  >(() => Promise.resolve({ mode: "first", things, offerSets: {}, total: things.length }));
  const client = {
    externalEntity: { queryInbox },
    plugin: { query: () => Promise.resolve([]) },
  } as unknown as HerculeClient;
  const onLink = vi.fn<(fromRef: string, to: { ref: string }) => void>();
  const onClose = vi.fn<() => void>();
  const row = document.createElement("div");
  document.body.append(row);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <InboxLinkToPart
        client={client}
        anchor={row}
        fromRef="acme:ticket:from"
        fromLabel="ACME-from"
        memberRefs={["acme:ticket:member"]}
        onLink={onLink}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { queryInbox, onLink, onClose };
};

describe("InboxLinkToPart", () => {
  it("reads Everything, shows at most six things, and leaves out the thing and its group", async () => {
    const things = [
      buildInboxThing("from", { ref: "acme:ticket:from" }),
      buildInboxThing("member", { ref: "acme:ticket:member" }),
      ...Array.from({ length: 10 }, (_, index) => buildInboxThing(`t${String(index)}`)),
    ];
    const { queryInbox } = renderPart(things);
    await waitFor(() => {
      expect(screen.getAllByRole("option", { hidden: true })).toHaveLength(6);
    });
    expect(screen.queryByText("Ticket from")).toBeNull();
    expect(screen.queryByText("Ticket member")).toBeNull();
    expect(queryInbox).toHaveBeenCalledTimes(1);
    expect(queryInbox.mock.calls[0]?.[0]).toEqual({
      payload: { mode: "first", list: { savedQuery: "everything" } },
    });
  });

  it("reads again with the typed text after a quiet, not on every key", async () => {
    const { queryInbox } = renderPart([buildInboxThing("1")]);
    await screen.findByRole("option", { hidden: true });
    await userEvent.keyboard("ab");
    await waitFor(() => {
      expect(queryInbox).toHaveBeenCalledTimes(2);
    });
    expect(queryInbox.mock.calls[1]?.[0].payload.text).toBe("ab");
  });

  it("links from the thing to the picked one, then closes", async () => {
    const { onLink, onClose } = renderPart([buildInboxThing("1"), buildInboxThing("2")]);
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
    const { queryInbox } = renderPart([buildInboxThing("1")]);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const timers = vi.getTimerCount();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(queryInbox).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timers);
  });
});
