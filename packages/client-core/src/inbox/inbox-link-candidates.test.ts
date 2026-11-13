/** Tests what "Link to..." offers: which things of the Everything list, and how many pages it reads for them. */
import { describe, expect, it, vi } from "vitest";
import type { InboxThing } from "@hercule/contract";
import type { HerculeClient } from "../client";
import { buildInboxThing } from "./cards.testing";
import { readLinkCandidates } from "./inbox-link-candidates";

/** One reply of the controller: the things of a page, the groups it names, and the cursor of the page after. */
interface Page {
  readonly things: readonly InboxThing[];
  readonly groups?: ReadonlyArray<{
    readonly members: ReadonlyArray<{ readonly ref: string; readonly matches: boolean }>;
  }>;
  readonly nextCursor?: string;
}

/** Returns a client whose Inbox answers `pages` in turn, and the mock that records the reads. */
const answering = (pages: readonly Page[]) => {
  let next = 0;
  const queryInbox = vi.fn((query: { payload: { mode: string } }) => {
    const page = pages[Math.min(next, pages.length - 1)]!;
    next += 1;
    return Promise.resolve({ mode: query.payload.mode, groups: [], offerSets: {}, ...page });
  });
  const client = { externalEntity: { queryInbox } } as unknown as HerculeClient;
  return { client, queryInbox };
};

const read = (client: HerculeClient, text = "", excludedRefs: string[] = []) =>
  readLinkCandidates(
    client,
    { text, fromRef: "acme:ticket:from", excludedRefs },
    new AbortController().signal,
  );

const refsOf = (things: readonly InboxThing[]) => things.map((thing) => thing.ref);

describe("readLinkCandidates", () => {
  it("reads a small first page of Everything and offers at most six, without the thing and its group", async () => {
    const { client, queryInbox } = answering([
      {
        things: [
          buildInboxThing("from"),
          buildInboxThing("member"),
          ...Array.from({ length: 10 }, (_, n) => buildInboxThing(`t${String(n)}`)),
        ],
      },
    ]);
    const things = await read(client, "", ["acme:ticket:member"]);
    expect(refsOf(things)).toEqual([0, 1, 2, 3, 4, 5].map((n) => `acme:ticket:t${String(n)}`));
    expect(queryInbox).toHaveBeenCalledTimes(1);
    expect(queryInbox.mock.calls[0]?.[0]).toEqual({
      payload: { mode: "first", list: { savedQuery: "everything" }, limit: 12 },
    });
  });

  it("searches for the text it is given", async () => {
    const { client, queryInbox } = answering([{ things: [] }]);
    await read(client, "checkout");
    expect(queryInbox.mock.calls[0]?.[0].payload).toMatchObject({ text: "checkout" });
  });

  it("does not offer a member of a group that did not match the search, but offers one that did and a lone thing", async () => {
    const { client } = answering([
      {
        things: [buildInboxThing("matches"), buildInboxThing("quiet"), buildInboxThing("alone")],
        groups: [
          {
            members: [
              { ref: "acme:ticket:matches", matches: true },
              { ref: "acme:ticket:quiet", matches: false },
            ],
          },
        ],
      },
    ]);
    expect(refsOf(await read(client))).toEqual(["acme:ticket:matches", "acme:ticket:alone"]);
  });

  it("reads the next page while the pages so far held only things that cannot be offered", async () => {
    const { client, queryInbox } = answering([
      { things: [buildInboxThing("member")], nextCursor: "cursor-1" },
      { things: [buildInboxThing("later")] },
    ]);
    expect(refsOf(await read(client, "", ["acme:ticket:member"]))).toEqual(["acme:ticket:later"]);
    expect(queryInbox).toHaveBeenCalledTimes(2);
    expect(queryInbox.mock.calls[1]?.[0].payload).toMatchObject({
      mode: "next",
      after: "cursor-1",
    });
  });
});
