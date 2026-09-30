/**
 * Tests the thread screen as the app opens it: the transcript drawn from the
 * stubbed controller's records, the live changes pushed over the stubbed live
 * connection, and the work dividers that expand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildSessionStreamTopic, buildSessionTapTopic } from "@hercule/contract";
import type { TapItem } from "@hercule/contract";
import {
  buildNextRows,
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_INSTANCE,
  renderApp,
  RUNNING_ITEM_ID,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  THREAD_FIXTURES,
  type Handler,
  type ThreadRecords,
} from "../../app/testing";
import { holdAnimationFrames, type HeldFrames } from "./testing";

/** The time the tests run at: 25 minutes after the finished thread started. */
const NOW = new Date("2026-09-10T09:25:00.000Z");

/** The animation frames, held until a test runs them. The paragraph being written is painted in one. */
let frames: HeldFrames;

beforeEach(() => {
  // Times are drawn in the system time zone, which differs between machines.
  vi.stubEnv("TZ", "Europe/Amsterdam");
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  frames = holdAnimationFrames();
  stubElementSize(800, 800);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * Opens the app signed in at `thread`, with the sidebar fixture and the
 * provider instance, once the thread is subscribed to its live topics and its
 * stream has sent an empty replay, so the rows a test pushes are live rows.
 * `handlers` add or replace the stubbed controller's answers.
 */
const openThread = async (
  thread: ThreadRecords,
  handlers: Readonly<Record<string, Handler>> = {},
) => {
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, providers: [FIXTURE_INSTANCE] }),
    ...buildThreadHandlers(thread),
    ...handlers,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: `/threads/${thread.session.id}` },
  );
  await waitFor(() => {
    expect(app.live.readTopics()).toEqual(
      expect.arrayContaining([
        buildSessionStreamTopic(thread.session.id),
        buildSessionTapTopic(thread.session.id),
      ]),
    );
  });
  act(() => {
    app.live.pushEmptyReplay(thread.session.id);
  });
  return { ...app, calls };
};

/** Returns the transcript region. */
const findTranscript = (): HTMLElement => screen.getByRole("region", { name: "Transcript" });

/** Returns the text of each block the transcript draws, in order. */
const readBlocks = (): string[] =>
  [...findTranscript().querySelectorAll(".tx-item")].map((item) => item.textContent);

/** The message the running thread's agent starts once the thread is open, whose taps are painted. */
const NEXT_ITEM_ID = "turn-1-fix";

/**
 * Returns the rows the running thread's agent writes once the thread is open,
 * in the three steps the tests push them in:
 *
 * - `start` finishes the message that was open when the thread subscribed and
 *   starts the next one, `NEXT_ITEM_ID`;
 * - `text` stores `text` as the next message's words;
 * - `end` finishes the next message and ends the turn.
 *
 * The taps of a message already open when the thread subscribes are never
 * painted, because the taps it missed cannot be placed, so the tests stream
 * into a message that starts later.
 */
const buildNextMessageRows = (thread: ThreadRecords, text: string) => {
  const [finishOpen, startNext, storedText, finishNext, endTurn] = buildNextRows(
    thread,
    {
      _tag: "item.completed",
      turnId: "turn-1",
      itemId: RUNNING_ITEM_ID,
      kind: "assistant_message",
      status: "completed",
    },
    { _tag: "item.started", turnId: "turn-1", itemId: NEXT_ITEM_ID, kind: "assistant_message" },
    {
      _tag: "content.delta",
      turnId: "turn-1",
      itemId: NEXT_ITEM_ID,
      streamKind: "assistant_text",
      delta: text,
    },
    {
      _tag: "item.completed",
      turnId: "turn-1",
      itemId: NEXT_ITEM_ID,
      kind: "assistant_message",
      status: "completed",
    },
    { _tag: "turn.completed", turnId: "turn-1", state: "completed" },
  );
  return { start: [finishOpen!, startNext!], text: storedText!, end: [finishNext!, endTurn!] };
};

/** Returns the taps of `NEXT_ITEM_ID`, one per delta. */
const buildTaps = (...deltas: readonly string[]): TapItem[] =>
  deltas.map((delta) => ({
    turnId: "turn-1",
    itemId: NEXT_ITEM_ID,
    streamKind: "assistant_text",
    delta,
  }));

/** Returns the paragraph the agent is writing. Fails when the transcript shows none. */
const findOpenParagraph = (): Element => {
  const paragraph = findTranscript().querySelector(".streaming");
  if (paragraph === null) throw new Error("the transcript shows no paragraph being written");
  return paragraph;
};

/**
 * Waits until the paragraph being written shows `text`, running the animation
 * frames it is painted in. The live connection hands a delivery on a little
 * after the push, so the frame that paints it is not requested at once.
 */
const expectOpenParagraphToShow = (text: string): Promise<void> =>
  waitFor(() => {
    frames.run();
    expect(findOpenParagraph().textContent).toBe(text);
  });

describe("the thread screen", () => {
  it("draws the thread's blocks in order, with their markdown, times and meta lines", async () => {
    await openThread(THREAD_FIXTURES.finished);
    expect(readBlocks()).toEqual([
      "Bump the Bun pin to 1.3.2 and make sure CI still passes.11:00",
      "Worked for 9s ›ran 2 commands",
      "Claude Code · Claude Sonnet 5 · 11:00The pin lives in .bun-version and in two workflows. I'll update all three.",
      "Worked for 1m 57s ›edited 3 filesran 2 commands",
      "Claude Code · Claude Sonnet 5 · 11:02Done. The pin is now 1.3.2 in:\n\n.bun-version\n.github/workflows/ci.yml\n.github/workflows/release.yml\n\nbun install and bun test pass.",
    ]);

    const transcript = findTranscript();
    // The agent's text streams in, so a live region would read every word.
    expect(transcript.getAttribute("aria-live")).toBeNull();
    expect(within(transcript).getByText("1.3.2").tagName).toBe("STRONG");
    expect(
      within(transcript)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([".bun-version", ".github/workflows/ci.yml", ".github/workflows/release.yml"]);
    // The meta line names the agent, so the faces beside it are decorative;
    // a finished thread's faces rest.
    const faces = [...transcript.querySelectorAll(".cr")];
    expect(faces).toHaveLength(2);
    for (const face of faces) {
      expect(face.getAttribute("aria-hidden")).toBe("true");
      expect(face.classList).toContain("cr--idle");
    }
  });

  it("expands a work divider into its items, and collapses it again", async () => {
    await openThread(THREAD_FIXTURES.finished);
    const divider = within(findTranscript()).getByRole("button", {
      name: "Worked for 1m 57s, edited 3 files, ran 2 commands",
    });
    expect(divider.getAttribute("aria-expanded")).toBe("false");
    expect(divider.nextElementSibling).toBeNull();

    await userEvent.click(divider);
    expect(divider.getAttribute("aria-expanded")).toBe("true");
    const list = divider.nextElementSibling as HTMLElement;
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "edit · .bun-version · completed",
      "edit · .github/workflows/ci.yml · completed",
      "edit · .github/workflows/release.yml · completed",
      "command · bun install · completed",
      "command · bun test · completed",
    ]);
    expect(list.querySelector("code")?.textContent).toBe(".bun-version");

    await userEvent.click(divider);
    expect(divider.getAttribute("aria-expanded")).toBe("false");
    expect(divider.nextElementSibling).toBeNull();
  });

  it("animates the face of the message the agent is writing, and only that one", async () => {
    await openThread(THREAD_FIXTURES.running);
    const transcript = findTranscript();
    const animated = [...transcript.querySelectorAll(".cr--animated")];
    expect(animated).toHaveLength(1);
    // The message is still open, so the paragraph being written shows as
    // stored, with the space the next word follows.
    expect(animated[0]!.closest(".tx-item")?.textContent).toBe(
      "Claude Code · Claude Sonnet 5 · 11:03The three failures share one cause: ",
    );
  });

  it("rests the face while the thread waits on the user, and says since when", async () => {
    await openThread(THREAD_FIXTURES.waiting);
    const transcript = findTranscript();
    expect(transcript.querySelector(".cr--animated")).toBeNull();
    expect(readBlocks().at(-1)).toBe("Waiting on you since 10:55 · 29m");
  });

  it("paints the taps, draws each finished paragraph as markdown, and closes the message when the turn ends", async () => {
    const thread = THREAD_FIXTURES.running;
    const sessionId = thread.session.id;
    const rows = buildNextMessageRows(
      thread,
      "It is a race in the **retry** queue.\n\nThe fix is to lock it.",
    );
    const { live } = await openThread(thread);
    act(() => {
      live.pushStreamRows(sessionId, rows.start);
    });
    // The face moves on to the new message, whose paragraph being written is
    // empty until the agent writes.
    await waitFor(() => {
      expect(readBlocks().at(-1)).toBe("Claude Code · Claude Sonnet 5 · 11:03");
    });
    const animated = [...findTranscript().querySelectorAll(".cr--animated")];
    expect(animated.map((face) => face.closest(".tx-item"))).toEqual([
      findOpenParagraph().closest(".tx-item"),
    ]);

    act(() => {
      live.pushTaps(sessionId, buildTaps("It is a race ", "in the **retry** queue.\n\nThe fix "));
    });
    await expectOpenParagraphToShow("The fix ");
    // The first paragraph has finished, so it is drawn as markdown while the
    // message is still open.
    expect(within(findTranscript()).getByText("retry").tagName).toBe("STRONG");

    act(() => {
      live.pushTaps(sessionId, buildTaps("is to lock it."));
    });
    await expectOpenParagraphToShow("The fix is to lock it.");

    // The stored row takes its text from the front of the tail, so the
    // message shows its text once.
    act(() => {
      live.pushStreamRows(sessionId, [rows.text]);
    });
    await expectOpenParagraphToShow("The fix is to lock it.");
    expect(readBlocks().at(-1)).toBe(
      "Claude Code · Claude Sonnet 5 · 11:03It is a race in the retry queue.The fix is to lock it.",
    );

    act(() => {
      live.pushStreamRows(sessionId, rows.end);
    });
    await waitFor(() => {
      expect(findTranscript().querySelector(".streaming")).toBeNull();
    });
    // The message has ended, so all of its text is drawn as markdown.
    expect(within(findTranscript()).getByText("retry").tagName).toBe("STRONG");
    expect(readBlocks().at(-1)).toBe(
      "Claude Code · Claude Sonnet 5 · 11:03It is a race in the retry queue.\nThe fix is to lock it.",
    );
    expect(findTranscript().querySelector(".cr--animated")).toBeNull();
  });

  it("reads the transcript again when the stream is reset, and stops painting the taps of the message it was writing", async () => {
    const thread = THREAD_FIXTURES.running;
    const sessionId = thread.session.id;
    // The controller's log, which the reset replaces with one that holds the
    // text the taps had shown.
    let held = thread.transcript;
    const transcriptPath = `/api/v1/sessions/${sessionId}/transcript`;
    const { live, calls } = await openThread(thread, {
      [`GET ${transcriptPath}`]: () => ({ body: { items: held } }),
    });
    const rows = buildNextMessageRows(thread, "It is a race ");
    act(() => {
      live.pushStreamRows(sessionId, rows.start);
    });
    act(() => {
      live.pushTaps(sessionId, buildTaps("It is a race "));
    });
    await expectOpenParagraphToShow("It is a race ");

    held = [...thread.transcript, ...rows.start, rows.text];
    act(() => {
      live.resetStream(sessionId);
    });
    await waitFor(() => {
      expect(readBlocks().at(-1)).toBe("Claude Code · Claude Sonnet 5 · 11:03It is a race ");
    });
    expect(calls.filter((call) => call.path === transcriptPath)).toHaveLength(2);
    // Taps may have been missed while the stream was lost, so the message's
    // later taps can no longer be placed: its text shows only as its rows land.
    frames.run();
    act(() => {
      live.pushTaps(sessionId, buildTaps("in the retry queue."));
    });
    // The tap has reached the thread once it asks for a frame to paint in.
    await waitFor(() => {
      expect(frames.countWaiting()).toBe(1);
    });
    frames.run();
    expect(findOpenParagraph().textContent).toBe("It is a race ");
  });

  it("shrinks the composer while the transcript is away from its bottom and the composer has no focus", async () => {
    const user = userEvent.setup();
    // jsdom reports no focus in the document while an element loses it,
    // where a browser reports whether the window has it.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await openThread(THREAD_FIXTURES.finished);
    // jsdom lays nothing out, so the transcript is given a size: 2000px of
    // content in 800px, whose bottom is at 1200.
    const transcript = findTranscript();
    let scrollTop = 1200;
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, get: () => 2000 },
      clientHeight: { configurable: true, get: () => 800 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.min(value, 1200);
        },
      },
    });
    const composer = document.querySelector(".composer")!;
    const field = screen.getByRole("textbox", { name: "Message" });
    /** Scrolls the transcript to `top`, as the user would. */
    const scrollTo = (top: number): void => {
      scrollTop = top;
      fireEvent.scroll(transcript);
    };

    scrollTo(1190);
    expect(composer.className).toBe("composer");
    scrollTo(1100);
    expect(composer.className).toBe("composer is-scrolled");
    act(() => {
      field.focus();
    });
    expect(composer.className).toBe("composer");
    act(() => {
      field.blur();
    });
    expect(composer.className).toBe("composer is-scrolled");

    // A click on the shrunk composer brings the reader back to the bottom.
    await user.click(field);
    expect(scrollTop).toBe(1200);
    act(() => {
      field.blur();
    });
    expect(composer.className).toBe("composer");
  });
});
