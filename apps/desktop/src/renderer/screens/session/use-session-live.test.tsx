/**
 * Tests `useSessionLive` against a fake live connection: rows merged into the
 * cached transcript, the paragraph being written painted once per frame, the
 * finished paragraphs drawn as markdown, the tap dropped while the window is
 * hidden, the open items skipped wherever taps were lost, and a subagent's
 * page following the subagent's topics alone. Animation frames are faked,
 * so a test runs each frame when it chooses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { JSX } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { queryKeys, type Live } from "@hercule/client-core";
import {
  buildSessionStreamTopic,
  buildSessionTapTopic,
  buildSubagentStreamTopic,
  buildSubagentTapTopic,
  type TapItem,
  type TranscriptRow,
} from "@hercule/contract";
import { buildNextRows, setVisibility, THREAD_FIXTURES, type EventBody } from "../../app/testing";
import { buildLook } from "../../faces";
import { holdAnimationFrames, type HeldFrames } from "../thread/testing";
import { AgentMessage } from "../thread/blocks";
import { useSessionLive } from "./use-session-live";

/** A thread whose turn has finished, so no item is open when the hook mounts. */
const THREAD = THREAD_FIXTURES.finished;
const SESSION_ID = THREAD.session.id;
const STREAM_TOPIC = buildSessionStreamTopic(SESSION_ID);
const TAP_TOPIC = buildSessionTapTopic(SESSION_ID);
/** The subagent whose page a test mounts. */
const SUBAGENT_ID = "agent-1";
/** The item the agent starts writing after the hook mounts. */
const NEW_ITEM_ID = "turn-2-answer";

/** One delivery on a subscription, as the live connection hands it to a handler. */
interface Delivery {
  readonly cursor: string | null;
  readonly items: readonly unknown[];
  readonly reset: boolean;
  readonly replay: boolean;
  readonly gone: boolean;
}

/**
 * Creates a live connection whose controller end the test plays. It holds one
 * subscription per topic, which is all the hook makes.
 */
const createFakeLive = () => {
  const subscriptions = new Map<
    string,
    { readonly handler: (delivery: Delivery) => void; readonly cursor: string | undefined }
  >();
  const live = {
    start: () => {},
    stop: () => Promise.resolve(),
    subscribe: (topic: string, handler: (delivery: Delivery) => void, cursor?: string) => {
      const subscription = { handler, cursor };
      subscriptions.set(topic, subscription);
      return () => {
        if (subscriptions.get(topic) === subscription) subscriptions.delete(topic);
      };
    },
    serverVersion: null,
  };
  /** Hands `delivery` to the subscription to `topic`. Throws when nothing is subscribed. */
  const deliver = (topic: string, delivery: Partial<Delivery>): void => {
    const subscription = subscriptions.get(topic);
    if (subscription === undefined) throw new Error(`nothing is subscribed to ${topic}`);
    act(() => {
      subscription.handler({
        cursor: null,
        items: [],
        reset: false,
        replay: false,
        gone: false,
        ...delivery,
      });
    });
  };
  return {
    live: live as unknown as Live,
    /** Returns the topics subscribed now, each with the cursor it started from. */
    readSubscriptions: () => [...subscriptions].map(([topic, { cursor }]) => ({ topic, cursor })),
    pushRows: (rows: readonly TranscriptRow[]) => {
      deliver(STREAM_TOPIC, { items: rows });
    },
    pushTaps: (...deltas: readonly string[]) => {
      const taps: TapItem[] = deltas.map((delta) => ({
        turnId: "turn-2",
        itemId: NEW_ITEM_ID,
        streamKind: "assistant_text",
        delta,
      }));
      deliver(TAP_TOPIC, { items: taps });
    },
    deliver,
  };
};

/** The animation frames, held until a test runs them. */
let frames: HeldFrames;

/**
 * Waits for the cache to tell its readers about a change, and for the render
 * that follows. The cache tells them in a zero-delay timer, not at once.
 */
const settle = (): Promise<void> =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  frames = holdAnimationFrames();
});

afterEach(() => {
  setVisibility("visible");
});

const NEW_ITEM_STARTED: EventBody = {
  _tag: "item.started",
  turnId: "turn-2",
  itemId: NEW_ITEM_ID,
  kind: "assistant_message",
};

/** Returns the body of the stored row that holds `delta` of the new item's text. */
const buildTextRow = (delta: string): EventBody => ({
  _tag: "content.delta",
  turnId: "turn-2",
  itemId: NEW_ITEM_ID,
  streamKind: "assistant_text",
  delta,
});

/** Returns the transcript `queryClient` holds for the thread, or for its subagent `subagentId`. */
const readHeldRows = (queryClient: QueryClient, subagentId?: string) =>
  queryClient.getQueryData<readonly TranscriptRow[]>(
    queryKeys.transcript(SESSION_ID, subagentId),
  ) ?? [];

/** Returns the new item's stored text: the text of its rows in `rows`, joined. */
const readStoredText = (rows: readonly TranscriptRow[]): string =>
  rows
    .map(({ event }) =>
      event._tag === "content.delta" && event.itemId === NEW_ITEM_ID ? event.delta : "",
    )
    .join("");

/**
 * Renders an agent's page the way `AgentPage` does, reduced to the new
 * item's message: the hook reads the agent's transcript from the cache, and
 * the message is drawn open, as the agent writes it, once its first row is
 * held.
 */
function Page({
  live,
  queryClient,
  subagentId,
  readTranscript,
}: {
  readonly live: Live;
  readonly queryClient: QueryClient;
  readonly subagentId: string | undefined;
  readonly readTranscript: () => Promise<readonly TranscriptRow[]>;
}): JSX.Element | null {
  const { data } = useQuery({
    queryKey: queryKeys.transcript(SESSION_ID, subagentId),
    queryFn: readTranscript,
    staleTime: Infinity,
  });
  const rows = data ?? [];
  const attachOpenParagraph = useSessionLive({
    live,
    queryClient,
    sessionId: SESSION_ID,
    subagentId,
    rowsKey: queryKeys.transcript(SESSION_ID, subagentId),
    rows,
  });
  const started = rows.some(
    ({ event }) => event._tag === "item.started" && event.itemId === NEW_ITEM_ID,
  );
  if (!started) return null;
  return (
    <AgentMessage
      look={buildLook(SESSION_ID)}
      itemId={NEW_ITEM_ID}
      agent="Sonnet 5"
      text={readStoredText(rows)}
      startedAt={rows.at(-1)!.at}
      timezone="UTC"
      today={0}
      pose="idle"
      open
      attachOpenParagraph={attachOpenParagraph}
    />
  );
}

/**
 * Mounts the hook the way `AgentPage` does, for the session's own agent or
 * for the subagent `subagentId`, reading the agent's transcript from the
 * cache, which holds the fixture's rows. Returns the fake live connection,
 * the cache, the function that reads the transcript again, and functions
 * that read the new item's message as drawn.
 */
const mountHook = (subagentId?: string) => {
  const fake = createFakeLive();
  const queryClient = new QueryClient();
  queryClient.setQueryData(queryKeys.transcript(SESSION_ID, subagentId), THREAD.transcript);
  // Reading the transcript again returns what the cache holds, as a
  // controller that has lost no rows would.
  const readTranscript = vi.fn(() => Promise.resolve(readHeldRows(queryClient, subagentId)));
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <Page
        live={fake.live}
        queryClient={queryClient}
        subagentId={subagentId}
        readTranscript={readTranscript}
      />
    </QueryClientProvider>,
  );
  // The tap's first subscription paints once; start each test with no frame due.
  frames.run();
  return {
    fake,
    queryClient,
    readTranscript,
    /** Returns the paragraph being written, or `null` while the message is not drawn. */
    findOpenParagraph: () => container.querySelector(".streaming"),
    /** Returns the text of each block the message draws as markdown, in order. */
    readFinishedBlocks: () =>
      [...(container.querySelector(".msg-body")?.children ?? [])]
        .filter((element) => !element.matches(".msg-meta, .streaming"))
        .map((element) => element.textContent),
  };
};

describe("useSessionLive", () => {
  it("subscribes to the stream after the last held row, and merges the rows it delivers", async () => {
    const { fake, queryClient } = mountHook();
    expect(fake.readSubscriptions()).toEqual([
      { topic: STREAM_TOPIC, cursor: String(THREAD.transcript.at(-1)!.position) },
      { topic: TAP_TOPIC, cursor: undefined },
    ]);

    const rows = buildNextRows(THREAD.session.id, THREAD.transcript, NEW_ITEM_STARTED);
    fake.pushRows(rows);
    await settle();
    expect(readHeldRows(queryClient)).toEqual([...THREAD.transcript, ...rows]);
  });

  it("paints the open item's taps at most once per frame, however many arrive", async () => {
    const { fake, findOpenParagraph } = mountHook();
    fake.pushRows(buildNextRows(THREAD.session.id, THREAD.transcript, NEW_ITEM_STARTED));
    await settle();
    const requestedBefore = frames.countRequested();

    fake.pushTaps("The fix ", "is to ");
    fake.pushTaps("await the ");
    fake.pushTaps("delivery.");
    expect(frames.countRequested() - requestedBefore).toBe(1);
    const paragraph = findOpenParagraph()!;
    expect(paragraph.textContent).toBe("");

    frames.run();
    expect(paragraph.textContent).toBe("The fix is to await the delivery.");
    expect(paragraph.childNodes).toHaveLength(1);

    // A tap within a paragraph renders nothing: the same text node is written again.
    const node = paragraph.firstChild;
    fake.pushTaps(" Then retry.");
    frames.run();
    expect(paragraph.textContent).toBe("The fix is to await the delivery. Then retry.");
    expect(paragraph.firstChild).toBe(node);
  });

  it("keeps taps that arrive before their item's first row, and paints them once it starts", async () => {
    const { fake, findOpenParagraph } = mountHook();
    fake.pushTaps("Early ");
    frames.run();
    expect(findOpenParagraph()).toBeNull();

    fake.pushRows(buildNextRows(THREAD.session.id, THREAD.transcript, NEW_ITEM_STARTED));
    await settle();
    expect(findOpenParagraph()?.textContent).toBe("Early ");
  });

  it("draws each finished paragraph as markdown, and the paragraph being written as plain text", async () => {
    const { fake, findOpenParagraph, readFinishedBlocks } = mountHook();
    fake.pushRows(buildNextRows(THREAD.session.id, THREAD.transcript, NEW_ITEM_STARTED));
    await settle();
    fake.pushTaps("The **fix** is ");
    frames.run();
    expect(readFinishedBlocks()).toEqual([]);
    expect(findOpenParagraph()?.textContent).toBe("The **fix** is ");

    fake.pushTaps("to await.\n\nThen ", "**retry**");
    frames.run();
    expect(readFinishedBlocks()).toEqual(["The fix is to await."]);
    expect(findOpenParagraph()?.previousElementSibling?.innerHTML).toBe(
      "The <strong>fix</strong> is to await.",
    );
    expect(findOpenParagraph()?.textContent).toBe("Then **retry**");
  });

  it("keeps a code block being written as plain text until it closes", async () => {
    const { fake, findOpenParagraph, readFinishedBlocks } = mountHook();
    fake.pushRows(buildNextRows(THREAD.session.id, THREAD.transcript, NEW_ITEM_STARTED));
    await settle();
    // A blank line inside a code block does not end a paragraph.
    fake.pushTaps("```ts\nawait retry();\n\nreturn");
    frames.run();
    expect(readFinishedBlocks()).toEqual([]);
    expect(findOpenParagraph()?.textContent).toBe("```ts\nawait retry();\n\nreturn");

    fake.pushTaps(";\n```\n\nDone");
    frames.run();
    expect(readFinishedBlocks()).toEqual(["await retry();\n\nreturn;\n"]);
    expect(findOpenParagraph()?.textContent).toBe("Done");
  });

  it("joins a landed row's text to the tail in the render that shows the row", async () => {
    const { fake, findOpenParagraph } = mountHook();
    // The row ends inside a word, as the rows' 4 KB cut can.
    const [started, stored] = buildNextRows(
      THREAD.session.id,
      THREAD.transcript,
      NEW_ITEM_STARTED,
      buildTextRow("The f"),
    );
    fake.pushRows([started!]);
    await settle();
    fake.pushTaps("The fix ", "is to ");
    frames.run();
    expect(findOpenParagraph()?.textContent).toBe("The fix is to ");

    // A tap's frame comes after the row landed and before the row shows. It
    // must not paint the paragraph without the row's text, which would make
    // that text vanish for a frame.
    fake.pushTaps("await");
    fake.pushRows([stored!]);
    frames.run();
    expect(findOpenParagraph()?.textContent).toBe("The fix is to ");
    await settle();
    expect(findOpenParagraph()?.textContent).toBe("The fix is to await");
  });

  it("leaves the paragraph as it is when a delivery repeats rows already held", async () => {
    const { fake, queryClient, findOpenParagraph } = mountHook();
    const [started, stored] = buildNextRows(
      THREAD.session.id,
      THREAD.transcript,
      NEW_ITEM_STARTED,
      buildTextRow("The fix "),
    );
    fake.pushRows([started!]);
    await settle();
    fake.pushTaps("The fix ", "is to ");
    fake.pushRows([stored!]);
    await settle();
    frames.run();
    expect(findOpenParagraph()?.textContent).toBe("The fix is to ");
    const heldBefore = readHeldRows(queryClient);

    // Applying the stored row a second time would look for "The fix " at the
    // start of the tail, "is to ", and skip the item when it is not there.
    fake.pushRows([started!, stored!]);
    await settle();
    frames.run();
    expect(readHeldRows(queryClient)).toBe(heldBefore);
    expect(findOpenParagraph()?.textContent).toBe("The fix is to ");
  });

  it("reads the transcript again on a reset, and clears the open item's tail", async () => {
    const { fake, findOpenParagraph, readTranscript } = mountHook();
    fake.pushRows(buildNextRows(THREAD.session.id, THREAD.transcript, NEW_ITEM_STARTED));
    await settle();
    fake.pushTaps("The fix ");
    frames.run();
    expect(findOpenParagraph()?.textContent).toBe("The fix ");

    fake.deliver(STREAM_TOPIC, { reset: true });
    await settle();
    expect(readTranscript).toHaveBeenCalledOnce();
    frames.run();
    expect(findOpenParagraph()?.textContent).toBe("");
    // Rows may have been missed, so the item's taps can no longer be lined up
    // with its rows.
    fake.pushTaps("await");
    frames.run();
    expect(findOpenParagraph()?.textContent).toBe("");
  });

  it("draws fewer finished paragraphs when the tail is dropped", async () => {
    const { fake, findOpenParagraph, readFinishedBlocks } = mountHook();
    const [started, stored] = buildNextRows(
      THREAD.session.id,
      THREAD.transcript,
      NEW_ITEM_STARTED,
      buildTextRow("First.\n\n"),
    );
    fake.pushRows([started!]);
    await settle();
    fake.pushTaps("First.\n\n", "Second.\n\nThird");
    fake.pushRows([stored!]);
    await settle();
    frames.run();
    expect(readFinishedBlocks()).toEqual(["First.", "Second."]);
    expect(findOpenParagraph()?.textContent).toBe("Third");

    // The connection dropped, and the tail was dropped with it. What is left
    // is the stored text.
    fake.deliver(TAP_TOPIC, { reset: true });
    frames.run();
    expect(readFinishedBlocks()).toEqual(["First."]);
    expect(findOpenParagraph()?.textContent).toBe("");
  });

  it("drops the tap while the window is hidden, keeps the stream, and skips the open item on show", async () => {
    const { fake, findOpenParagraph } = mountHook();
    fake.pushRows(buildNextRows(THREAD.session.id, THREAD.transcript, NEW_ITEM_STARTED));
    await settle();
    fake.pushTaps("The fix ");
    frames.run();

    setVisibility("hidden");
    expect(fake.readSubscriptions().map(({ topic }) => topic)).toEqual([STREAM_TOPIC]);

    setVisibility("visible");
    expect(fake.readSubscriptions().map(({ topic }) => topic)).toEqual([STREAM_TOPIC, TAP_TOPIC]);
    // Taps sent while hidden are lost, so the item's text now comes only in
    // its rows.
    fake.pushTaps("await");
    frames.run();
    expect(findOpenParagraph()?.textContent).toBe("");
  });

  it("skips the open item when the live connection tells the tap to reset", async () => {
    const { fake, findOpenParagraph } = mountHook();
    fake.pushRows(buildNextRows(THREAD.session.id, THREAD.transcript, NEW_ITEM_STARTED));
    await settle();
    fake.pushTaps("The fix ");
    frames.run();
    expect(findOpenParagraph()?.textContent).toBe("The fix ");

    // The connection dropped and the tap was subscribed again.
    fake.deliver(TAP_TOPIC, { reset: true });
    fake.pushTaps("await");
    frames.run();
    expect(findOpenParagraph()?.textContent).toBe("");
  });

  it.each([
    ["before", true],
    ["after", false],
  ])(
    "skips an item that started in the stream's replay, with the new taps arriving %s it",
    async (_, tapsFirst) => {
      // The agent started writing while the connection was down, and the taps
      // sent then are lost. Painting the ones that follow would show the
      // message with its start missing.
      const { fake, findOpenParagraph } = mountHook();
      fake.deliver(TAP_TOPIC, { reset: true });
      if (tapsFirst) fake.pushTaps("is 42.");
      fake.deliver(STREAM_TOPIC, {
        items: buildNextRows(THREAD.session.id, THREAD.transcript, NEW_ITEM_STARTED),
        replay: true,
      });
      await settle();
      if (!tapsFirst) fake.pushTaps("is 42.");
      frames.run();
      expect(findOpenParagraph()?.textContent).toBe("");
    },
  );

  it("keeps the open item's tail when the replay holds no row it did not have", async () => {
    const { fake, findOpenParagraph } = mountHook();
    const rows = buildNextRows(THREAD.session.id, THREAD.transcript, NEW_ITEM_STARTED);
    fake.pushRows(rows);
    await settle();
    fake.pushTaps("The fix ");

    // The stream was subscribed again while the tap stayed subscribed, and
    // nothing was written in between.
    fake.deliver(STREAM_TOPIC, { items: rows, replay: true });
    await settle();
    frames.run();
    expect(findOpenParagraph()?.textContent).toBe("The fix ");
  });

  it("follows a subagent through its own topics alone, and merges its rows into its own transcript", async () => {
    const stream = buildSubagentStreamTopic(SESSION_ID, SUBAGENT_ID);
    const tap = buildSubagentTapTopic(SESSION_ID, SUBAGENT_ID);
    const { fake, queryClient, findOpenParagraph } = mountHook(SUBAGENT_ID);
    expect(fake.readSubscriptions()).toEqual([
      { topic: stream, cursor: String(THREAD.transcript.at(-1)!.position) },
      { topic: tap, cursor: undefined },
    ]);

    const rows = buildNextRows(THREAD.session.id, THREAD.transcript, NEW_ITEM_STARTED);
    fake.deliver(stream, { items: rows });
    await settle();
    expect(readHeldRows(queryClient, SUBAGENT_ID)).toEqual([...THREAD.transcript, ...rows]);
    expect(readHeldRows(queryClient)).toEqual([]);

    fake.deliver(tap, {
      items: [
        { turnId: "turn-2", itemId: NEW_ITEM_ID, streamKind: "assistant_text", delta: "On it" },
      ],
    });
    frames.run();
    expect(findOpenParagraph()?.textContent).toBe("On it");
  });

  it("drops a subagent's tap while the window is hidden, and keeps its stream", () => {
    const stream = buildSubagentStreamTopic(SESSION_ID, SUBAGENT_ID);
    const tap = buildSubagentTapTopic(SESSION_ID, SUBAGENT_ID);
    const { fake } = mountHook(SUBAGENT_ID);

    setVisibility("hidden");
    expect(fake.readSubscriptions().map(({ topic }) => topic)).toEqual([stream]);

    setVisibility("visible");
    expect(fake.readSubscriptions().map(({ topic }) => topic)).toEqual([stream, tap]);
  });

  it("ends a subscription whose session is gone", () => {
    const { fake } = mountHook();
    fake.deliver(STREAM_TOPIC, { gone: true });
    fake.deliver(TAP_TOPIC, { gone: true });
    expect(fake.readSubscriptions()).toEqual([]);
  });
});
