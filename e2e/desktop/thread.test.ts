/**
 * Tests the thread view in the packaged app, signed in to a real controller
 * whose threads scripted runners fill with turns, streamed text and Requests
 * (spec 17, §Design system, **The thread**):
 *
 * - a thread opens from the sidebar, and its transcript shows its rows;
 * - a message the agent has started, with no word yet, shows a "Writing…"
 *   line and no agent row, and the row shows once the first word arrives,
 *   while the message is still open; a message the user stops before its
 *   first word shows no agent row at all;
 * - a message streams into the tail before its row lands, then shows as
 *   markdown, below a divider that sums up the work before it;
 * - a Request shows the dock and the waiting note, and Allow resolves it;
 * - a queued input shows above the composer, and Cancel removes it;
 * - a window hidden and shown again while a message streams ends with the
 *   whole message, no word doubled or skipped;
 * - long messages of the user's are collapsed as they mount, without
 *   setting off a resize loop;
 * - the view of the transcript keeps still where the reader leaves it and
 *   follows the bottom where the reader stays: a scroll down through long
 *   collapsed messages never moves back, a reader at the bottom follows a
 *   streaming message, leaves it by scrolling up and rejoins it by
 *   scrolling down, and scrolling a step's output box does not rejoin it;
 * - the app opens the last open thread again at launch;
 * - a step whose tool returned images opens to their thumbnails, a line for
 *   an image that could not be kept, and a lightbox.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { writeSettings } from "../../apps/desktop/scripts/packaged-app";
import type { ScriptStep } from "../../apps/desktop/scripts/scripted-runner";
import {
  arrangeFleet,
  buildCountedMessage,
  buildLiveCheck,
  countStoredTextRows,
  createMessagePause,
  createUserDataDirForTest,
  joinShownText,
  keepWindowOnTop,
  launchForTest,
  launchPlainAppForTest,
  openSignedIn,
  measureGapAboveBottom,
  openThread,
  READ_AGENT_TEXTS,
  READ_LAST_AGENT_TEXT,
  readLastScrollFrame,
  readScrollFrames,
  readWordNumbers,
  recordFrames,
  recordLastAgentText,
  recordScrollFrames,
  signInAndReadToken,
  waitForFrames,
  type AgentTextSnapshot,
  type ScrollFrame,
} from "./harness";

/** Finds the thread's transcript, whose last agent message `recordLastAgentText` records. */
const TRANSCRIPT_SELECTOR = 'section[aria-label="Transcript"]';

/** Returns the title of the thread the header shows as open. */
function readOpenTab(page: Page): Promise<string | null> {
  return page
    .locator('nav[aria-label="Sessions in this workspace"] a[aria-current="page"] .ptab-title')
    .textContent();
}

/**
 * Returns every block the transcript has mounted, top to bottom, each as one
 * line of text. A block shows only what the stylesheet leaves visible, so a
 * message the agent has started and not yet written a word of reads as its
 * "Writing…" line, and a message with text as the message:
 *
 * - a message the user sent: "you: Why does the test fail?";
 * - a message the agent wrote, without its meta line: "agent: Let me look.";
 * - a status line, while the turn has drawn nothing: "pending: Working for 3s";
 * - a work stretch's divider, by its accessible name: "divider: Worked for
 *   2s, ran 2 commands";
 * - the end of a turn that did not complete: "ending: Stopped after 4s";
 * - the note that the thread waits: "waiting: Waiting on you since 09:31 · now".
 */
function readTranscript(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('section[aria-label="Transcript"] .tx-item')].map((item) => {
      const block = [...item.children].find((part) => getComputedStyle(part).display !== "none")!;
      if (block.matches(".msg--me")) return `you: ${block.querySelector(".bubble")!.textContent}`;
      if (block.matches(".msg")) {
        const parts = [...block.querySelector(".msg-body")!.children].filter(
          (part) => !part.matches(".msg-meta"),
        );
        return `agent: ${parts.map((part) => part.textContent).join("")}`;
      }
      if (block.matches("button.worked")) return `divider: ${block.getAttribute("aria-label")}`;
      if (block.matches('.worked[role="status"]'))
        return `pending: ${block.querySelector("b")!.textContent}`;
      if (block.matches(".worked")) return `ending: ${block.textContent}`;
      if (block.matches(".waiting-note")) return `waiting: ${block.textContent}`;
      return `unknown: ${block.outerHTML}`;
    }),
  );
}

/** The first paragraph of `ANSWER`, as markdown and as the page renders it. */
const FIRST_PARAGRAPH = {
  markdown: "The checkout test fails because `fetchOrders` resolves after the timeout.",
  rendered: "The checkout test fails because fetchOrders resolves after the timeout.",
};

/** The second and last paragraph of `ANSWER`, as markdown and as the page renders it. */
const SECOND_PARAGRAPH = {
  markdown: "Adding a **retry** fixes it.",
  rendered: "Adding a retry fixes it.",
};

/** The answer the streaming test's agent writes, as markdown. */
const ANSWER = `${FIRST_PARAGRAPH.markdown}\n\n${SECOND_PARAGRAPH.markdown}`;

/**
 * `ANSWER` as the page renders it: the markdown's text, without its marks.
 * The transcript is read one element at a time, so nothing joins the two
 * paragraphs.
 */
const RENDERED_ANSWER = `${FIRST_PARAGRAPH.rendered}${SECOND_PARAGRAPH.rendered}`;

/**
 * A real PNG, 4 × 3 pixels of one colour, that Chromium decodes. The unit
 * tests run in jsdom, which decodes no image, so only this suite proves that
 * a tool's image is stored, read back and drawn.
 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGOwybsERww4OQBUhhHRUMjhlgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A message of about 15 lines in the bubble, past the 10 lines above which a
 * bubble is collapsed to 162px.
 */
const LONG_USER_MESSAGE = Array.from({ length: 4 }, () =>
  (
    "The checkout test fails because the payment form waits for the bank's reply, " +
    "and the reply arrives after the test's timeout on a slow runner. "
  ).repeat(3),
).join("\n\n");

/** A reply of 33 words, three or four lines in the transcript. */
const SHORT_REPLY =
  "I read the test and the payment form. The form waits for the bank's reply, and on a slow " +
  "runner the reply comes after the timeout, so the first assertion runs too early.";

/**
 * Builds `count` agent messages of about 100 words each that play at once,
 * to give a thread a transcript taller than the window.
 */
function buildFillerMessages(count: number): ScriptStep[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "message",
    text: `Part ${index + 1}. ${SHORT_REPLY} ${SHORT_REPLY} ${SHORT_REPLY}`,
    deltaMs: 0,
  }));
}

/** Moves the mouse to the middle of the transcript, where a wheel step scrolls it. */
async function moveMouseOverTranscript(page: Page): Promise<void> {
  const box = (await page.locator(TRANSCRIPT_SELECTOR).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Scrolls the transcript with one wheel step of `deltaY` pixels, as a mouse
 * wheel does, and waits until the page has painted the result.
 */
async function scrollWithWheel(page: Page, deltaY: number): Promise<void> {
  await page.mouse.wheel(0, deltaY);
  await waitForFrames(page, 2);
}

/**
 * Waits until the transcript is `pixels` taller than `height`, as a message
 * streaming at its end makes it, and returns once it is. Fails when the
 * transcript does not grow that far in time, for instance because the stream
 * ended.
 */
async function waitForGrowth(page: Page, height: number, pixels: number): Promise<void> {
  await expect
    .poll(async () => ((await readLastScrollFrame(page))?.height ?? 0) - height, {
      timeout: 8_000,
    })
    .toBeGreaterThanOrEqual(pixels);
}

/**
 * How much taller the transcript is after four more wrapped lines of 22.4px
 * (89.6px), rounded down so that four lines are enough.
 */
const FOUR_LINES_HEIGHT = 89;

/** Returns the frames recorded after the first `recorded` of them. */
async function readFramesSince(page: Page, recorded: number): Promise<ScrollFrame[]> {
  return (await readScrollFrames(page)).slice(recorded);
}

/**
 * Returns how far, in pixels, the frames' scroll position strays from `top`,
 * at most.
 */
function measureLargestStray(frames: ReadonlyArray<ScrollFrame>, top: number): number {
  return Math.max(...frames.map((frame) => Math.abs(frame.top - top)));
}

/**
 * Opens a thread whose transcript is taller than the window and whose last
 * message, a single paragraph of about 660 words (20 short replies), streams at the usual pace of
 * 20ms a word once the test allows the command before it. Returns once the
 * page shows the stream's first word, with the view at the end of the
 * transcript and the scroll positions of the frames being recorded.
 */
async function openThreadWithStreamingMessage(): Promise<Page> {
  const { url, fleet, client } = await arrangeFleet();
  const runner = await fleet.enlistRunner("studio");
  const streamed = Array.from({ length: 20 }, () => SHORT_REPLY).join(" ");
  const { thread } = await fleet.spawnScriptedThread(
    { runner, prompt: "Why does the checkout test fail?" },
    [
      ...buildFillerMessages(8),
      { kind: "command", command: "pnpm test", ask: true },
      { kind: "message", text: streamed },
      { kind: "end", state: "completed" },
    ],
  );
  await fleet.waitForTurn(thread.id, 1, "waiting");
  const { app, page } = await openSignedIn(url);
  await keepWindowOnTop(app);
  await page.evaluate(recordFrames);
  await openThread(page, "Why does the checkout test fail?");
  await expect.poll(() => page.evaluate(buildLiveCheck(thread.id))).toBe(true);
  await page.evaluate(recordScrollFrames, TRANSCRIPT_SELECTOR);
  await expect
    .poll(async () => {
      const frame = await readLastScrollFrame(page);
      return frame !== undefined && measureGapAboveBottom(frame) < 12;
    })
    .toBe(true);

  const [openRequest] = (await client.session.read({ params: { id: thread.id } })).openRequests;
  await client.session.respondToApprovalRequest({
    params: { id: thread.id },
    payload: { requestId: openRequest!.requestId, decision: "allow" },
  });
  await page.locator(`${TRANSCRIPT_SELECTOR} .streaming`).waitFor();
  await waitForFrames(page, 3);
  return page;
}

describe("the thread view", () => {
  it("opens a thread from the sidebar and shows its transcript", async () => {
    const { url, fleet } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "Why does the checkout test fail?" },
      [
        { kind: "message", text: "Let me look at the test first." },
        { kind: "command", command: "pnpm test" },
        { kind: "command", command: "git log -1" },
        { kind: "message", text: ANSWER },
        { kind: "end", state: "completed" },
      ],
    );
    await played;
    await fleet.waitForTurn(thread.id, 1, "completed");
    await fleet.spawnThreads(1, { runner });

    const { page } = await openSignedIn(url);
    await openThread(page, "Why does the checkout test fail?");

    await expect
      .poll(() => readTranscript(page))
      .toEqual([
        "you: Why does the checkout test fail?",
        "agent: Let me look at the test first.",
        expect.stringMatching(/^divider: Worked for \d+s, ran 2 commands$/),
        `agent: ${RENDERED_ANSWER}`,
      ]);
    const answer = page.locator('section[aria-label="Transcript"] .msg-body').last();
    expect(await answer.locator("code").textContent()).toBe("fetchOrders");
    expect(await answer.locator("strong").textContent()).toBe("retry");
    expect(await readOpenTab(page)).toBe("Why does the checkout test fail?");
  });

  it("streams a message, drawing each paragraph as markdown once it is finished", async () => {
    const { url, fleet, client } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    // The script waits on a Request until the thread is open, so the whole
    // message streams while the page listens.
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "Why does the checkout test fail?" },
      [
        { kind: "command", command: "pnpm test", ask: true },
        { kind: "message", text: ANSWER, deltaMs: 40 },
        { kind: "end", state: "completed" },
      ],
    );
    await fleet.waitForTurn(thread.id, 1, "waiting");
    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await page.evaluate(recordFrames);
    await openThread(page, "Why does the checkout test fail?");
    await expect.poll(() => page.evaluate(buildLiveCheck(thread.id))).toBe(true);
    await page.evaluate(recordLastAgentText, TRANSCRIPT_SELECTOR);

    const [openRequest] = (await client.session.read({ params: { id: thread.id } })).openRequests;
    await client.session.respondToApprovalRequest({
      params: { id: thread.id },
      payload: { requestId: openRequest!.requestId, decision: "allow" },
    });
    await played;
    await fleet.waitForTurn(thread.id, 1, "completed");

    await expect
      .poll(() => readTranscript(page))
      .toEqual([
        "you: Why does the checkout test fail?",
        expect.stringMatching(/^divider: Worked for \d+s, ran 1 command$/),
        `agent: ${RENDERED_ANSWER}`,
      ]);
    const snapshots: AgentTextSnapshot[] = await page.evaluate(READ_AGENT_TEXTS);
    // While the message streams, the paragraph being written is the raw
    // markdown written so far, and each finished paragraph shows as
    // markdown. Once the message ends, the whole answer shows as markdown.
    const isExpected = ({ text, openParagraph }: AgentTextSnapshot): boolean => {
      if (openParagraph === null) return text === RENDERED_ANSWER;
      if (text === "") return ANSWER.startsWith(openParagraph);
      return (
        text === FIRST_PARAGRAPH.rendered && SECOND_PARAGRAPH.markdown.startsWith(openParagraph)
      );
    };
    expect(snapshots.filter((snapshot) => !isExpected(snapshot))).toEqual([]);
    // The page paints at most once a frame, so which snapshots there are
    // depends on when frames fall. Their order does not: the first paragraph
    // being written (0), then the second being written below the first drawn
    // as markdown (1), then the whole answer (2). Some streamed text shows
    // before the message is complete.
    const stages = snapshots.map(({ text, openParagraph }) =>
      openParagraph === null ? 2 : text === "" ? 0 : 1,
    );
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    expect(snapshots.some(({ openParagraph }) => (openParagraph ?? "") !== "")).toBe(true);
    expect(snapshots.at(-1)).toEqual({ text: RENDERED_ANSWER, openParagraph: null });
    const answer = page.locator('section[aria-label="Transcript"] .msg-body').last();
    expect(await answer.locator("code").textContent()).toBe("fetchOrders");
    expect(await answer.locator("strong").textContent()).toBe("retry");
  });

  it("shows a Writing… line, never an agent row with no text, until the message's first word arrives", async () => {
    const { url, fleet, client } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    // The first step waits on a Request, so the message starts only after the
    // page has subscribed. The message then pauses before its first word and
    // again after it, so the test looks at each state while the message is
    // still open, not after the turn has ended and the page has redrawn.
    const beforeFirstWord = createMessagePause(0);
    const afterFirstWord = createMessagePause(1);
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "Why does the checkout test fail?" },
      [
        { kind: "command", command: "pnpm test", ask: true },
        {
          kind: "message",
          text: "Found it.",
          pauses: [beforeFirstWord.pause, afterFirstWord.pause],
        },
        { kind: "end", state: "completed" },
      ],
    );
    await fleet.waitForTurn(thread.id, 1, "waiting");
    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await page.evaluate(recordFrames);
    await openThread(page, "Why does the checkout test fail?");
    await expect.poll(() => page.evaluate(buildLiveCheck(thread.id))).toBe(true);

    const [openRequest] = (await client.session.read({ params: { id: thread.id } })).openRequests;
    await client.session.respondToApprovalRequest({
      params: { id: thread.id },
      payload: { requestId: openRequest!.requestId, decision: "allow" },
    });

    // The message has started and has no word: its line shows, its row does not.
    await expect
      .poll(() => readTranscript(page))
      .toEqual([
        "you: Why does the checkout test fail?",
        expect.stringMatching(/^divider: Worked for \d+s, ran 1 command$/),
        "pending: Writing…",
      ]);
    expect(await page.locator(`${TRANSCRIPT_SELECTOR} .msg:visible`).count()).toBe(0);

    // The first word has landed and the message is still open: the row shows
    // and the line is gone.
    beforeFirstWord.resume();
    await expect
      .poll(() => readTranscript(page))
      .toEqual([
        "you: Why does the checkout test fail?",
        expect.stringMatching(/^divider: Worked for \d+s, ran 1 command$/),
        expect.stringMatching(/^agent: Found/),
      ]);
    expect(await page.locator(`${TRANSCRIPT_SELECTOR} .msg-pending:visible`).count()).toBe(0);
    expect(await page.locator(`${TRANSCRIPT_SELECTOR} .msg:visible`).count()).toBe(1);

    afterFirstWord.resume();
    await played;
    await fleet.waitForTurn(thread.id, 1, "completed");
  });

  it("shows no agent row when the user stops the agent before a message's first word", async () => {
    const { url, fleet, client } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const beforeFirstWord = createMessagePause(0);
    const { thread } = await fleet.spawnScriptedThread(
      { runner, prompt: "Why does the checkout test fail?" },
      [
        { kind: "command", command: "pnpm test", ask: true },
        { kind: "message", text: "Found it.", pauses: [beforeFirstWord.pause] },
        { kind: "end", state: "completed" },
      ],
    );
    await fleet.waitForTurn(thread.id, 1, "waiting");
    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await page.evaluate(recordFrames);
    await openThread(page, "Why does the checkout test fail?");
    await expect.poll(() => page.evaluate(buildLiveCheck(thread.id))).toBe(true);

    const [openRequest] = (await client.session.read({ params: { id: thread.id } })).openRequests;
    await client.session.respondToApprovalRequest({
      params: { id: thread.id },
      payload: { requestId: openRequest!.requestId, decision: "allow" },
    });
    await expect.poll(() => readTranscript(page)).toContainEqual("pending: Writing…");

    await client.session.interrupt({ params: { id: thread.id }, payload: {} });

    await expect
      .poll(() => readTranscript(page))
      .toEqual([
        "you: Why does the checkout test fail?",
        expect.stringMatching(/^divider: Worked for \d+s, ran 1 command$/),
        expect.stringMatching(/^ending: Stopped after /),
      ]);
    expect(await page.locator(`${TRANSCRIPT_SELECTOR} .msg:visible`).count()).toBe(0);
  });

  it("shows the dock and the waiting note while a Request is open, and Allow resolves it", async () => {
    const { url, fleet, client, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const [thread] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(thread!.id, "busy");
    const { page } = await openSignedIn(url);
    await openThread(page, "Thread 1");

    const played = runner.playScript(thread!.id, [
      { kind: "command", command: "pnpm test", ask: true },
      { kind: "end", state: "completed" },
    ]);
    const dock = page.getByRole("group", { name: "Run this command?" });
    await dock.waitFor();
    expect(await dock.locator("code").textContent()).toBe("pnpm test");
    const waitingNote = page.locator('section[aria-label="Transcript"] .waiting-note');
    expect(await waitingNote.textContent()).toMatch(/^Waiting on you since \d\d:\d\d · /);

    await dock.getByRole("button", { name: "Allow", exact: true }).click();
    await dock.waitFor({ state: "detached" });
    await waitingNote.waitFor({ state: "detached" });
    await played;
    await fleet.waitForTurn(thread!.id, 1, "completed");
    expect((await client.session.read({ params: { id: thread!.id } })).openRequests).toEqual([]);
  });

  it("shows a queued input above the composer, and Cancel removes it", async () => {
    const { url, fleet, client, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const [thread] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(thread!.id, "busy");
    const { page } = await openSignedIn(url);
    await openThread(page, "Thread 1");

    const text = "Also check the refund flow";
    const { inputId, result } = await client.session.input({
      params: { id: thread!.id },
      payload: { text },
    });
    expect(result).toBe("queued");
    const row = page.locator(".queued", { hasText: text });
    await row.waitFor();
    expect(await row.locator(".faint").textContent()).toBe("queued · runs next");

    await row.getByRole("button", { name: "Cancel" }).click();
    await row.waitFor({ state: "detached" });
    const inputs = await client.input.query({ params: { id: thread!.id }, query: {} });
    expect(inputs.items.find((input) => input.id === inputId)?.status).toBe("cancelled");
  });

  it("ends with the whole message, no word doubled or skipped, when the window is hidden and shown while it streams", async () => {
    const { url, fleet, client } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    // The message pauses until the window is hidden and until it is shown
    // again; see buildCountedMessage.
    const message = buildCountedMessage();
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "Count to three thousand" },
      [
        { kind: "command", command: "pnpm test", ask: true },
        message.step,
        { kind: "end", state: "completed" },
      ],
    );
    await fleet.waitForTurn(thread.id, 1, "waiting");

    // Playwright's focus emulation keeps a hidden page "visible", and the tap
    // is unsubscribed and the rows are kept aside only on a real hide. This
    // test starts the app as a plain process instead.
    const { evaluateInPage, callWindowMethod } = await launchPlainAppForTest(url);
    const readVisibility = () => evaluateInPage("document.visibilityState");
    const readLastSnapshot = () =>
      evaluateInPage(READ_LAST_AGENT_TEXT) as Promise<AgentTextSnapshot | undefined>;

    // The thread waits on a Request, so it has a row in Waiting on you as
    // well as its own.
    const threadRow = `document.querySelector("a.side-row:not(.side-row--wait)")`;
    await expect
      .poll(() => evaluateInPage(`${threadRow} !== null`), { timeout: 10_000 })
      .toBe(true);
    // A window that another window covers also reads as hidden; see
    // keepWindowOnTop.
    await callWindowMethod("setAlwaysOnTop", true);
    await expect.poll(readVisibility, { timeout: 10_000 }).toBe("visible");
    await evaluateInPage(`(${recordFrames.toString()})()`);
    await evaluateInPage(`${threadRow}.click()`);
    await expect
      .poll(() => evaluateInPage(buildLiveCheck(thread.id)), { timeout: 10_000 })
      .toBe(true);
    await evaluateInPage(
      `(${recordLastAgentText.toString()})(${JSON.stringify(TRANSCRIPT_SELECTOR)})`,
    );

    const [openRequest] = (await client.session.read({ params: { id: thread.id } })).openRequests;
    await client.session.respondToApprovalRequest({
      params: { id: thread.id },
      payload: { requestId: openRequest!.requestId, decision: "allow" },
    });
    await expect.poll(async () => (await readLastSnapshot())?.openParagraph ?? "").not.toBe("");

    await callWindowMethod("hide");
    await expect.poll(readVisibility).toBe("hidden");
    const shownWhenHidden = joinShownText((await readLastSnapshot())!);
    const rowsWhenHidden = await countStoredTextRows(client, thread.id);
    message.resumeAfterHide();
    await expect
      .poll(() => countStoredTextRows(client, thread.id), { timeout: 10_000 })
      .toBeGreaterThan(rowsWhenHidden);
    // The page still receives the stored rows while it is hidden, but keeps
    // them aside instead of drawing them. A hidden page runs its timers at
    // most once a second, so a page that drew them anyway would show them
    // within that time. Wait a little longer before checking that it shows
    // nothing new.
    await sleep(2_000);
    expect(joinShownText((await readLastSnapshot())!)).toBe(shownWhenHidden);

    await callWindowMethod("show");
    await expect.poll(readVisibility).toBe("visible");
    // The rows kept aside while the window was hidden are drawn together.
    await expect
      .poll(async () => joinShownText((await readLastSnapshot())!).length, { timeout: 10_000 })
      .toBeGreaterThan(shownWhenHidden.length);
    // The message is paused, so it is still being written.
    expect((await readLastSnapshot())!.openParagraph).not.toBeNull();
    message.resumeAfterShow();

    await played;
    await fleet.waitForTurn(thread.id, 1, "completed");
    await expect.poll(async () => (await readLastSnapshot())!.openParagraph).toBeNull();
    const snapshots = (await evaluateInPage(READ_AGENT_TEXTS)) as AgentTextSnapshot[];
    const broken = snapshots
      .map(readWordNumbers)
      .find((numbers) => numbers.some((number, index) => number !== index + 1));
    expect(broken, "a snapshot doubled or skipped a word").toBeUndefined();
    expect(readWordNumbers(snapshots.at(-1)!).length).toBe(message.wordCount);
  });

  it("collapses a thread's long messages as they mount, with no resize loop", async () => {
    const { url, fleet, client, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const [thread] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(thread!.id, "busy");
    // There are enough long messages to fill the window several times over.
    const count = 30;
    for (let index = 0; index < count; index += 1) {
      const { inputId } = await client.session.input({
        params: { id: thread!.id },
        payload: { text: LONG_USER_MESSAGE },
      });
      await client.input.steer({ params: { id: thread!.id, inputId } });
    }
    await expect
      .poll(async () => {
        const rows = await fleet.readTranscript(thread!.id);
        return rows.filter(
          ({ event }) => event._tag === "item.completed" && event.kind === "user_message",
        ).length;
      })
      .toBe(count + 1);

    const { page } = await openSignedIn(url);
    // Chromium reports a resize loop as an error event on the window, which
    // nothing else in the app listens for.
    await page.evaluate(() => {
      const errors: string[] = [];
      Object.assign(globalThis, { resizeLoopErrors: errors });
      window.addEventListener("error", (event) => {
        if (event.message.includes("ResizeObserver")) errors.push(event.message);
      });
    });
    await openThread(page, "Thread 1");
    await expect.poll(() => page.locator(".bubble-toggle").count()).toBeGreaterThan(1);
    const errors = await page.evaluate(async () => {
      for (let frame = 0; frame < 20; frame += 1) {
        await new Promise(requestAnimationFrame);
      }
      return (globalThis as typeof globalThis & { resizeLoopErrors: string[] }).resizeLoopErrors;
    });
    expect(errors).toEqual([]);
    expect(await page.locator(".bubble-toggle").first().textContent()).toBe("Show full message");
  });

  it("scrolls down through long collapsed messages without the view ever moving back", async () => {
    const { url, fleet, client, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const [thread] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(thread!.id, "busy");
    // Each turn has a long message, a reply and a command, so the transcript
    // is many windows tall, and each long message mounts below the view and
    // collapses while the reader scrolls toward it.
    for (let turn = 0; turn < 30; turn += 1) {
      const { inputId } = await client.session.input({
        params: { id: thread!.id },
        payload: { text: LONG_USER_MESSAGE },
      });
      await client.input.steer({ params: { id: thread!.id, inputId } });
      await runner.playScript(thread!.id, [
        { kind: "message", text: SHORT_REPLY, deltaMs: 0 },
        { kind: "command", command: "pnpm test" },
      ]);
    }
    await runner.playScript(thread!.id, [{ kind: "end", state: "completed" }]);
    await fleet.waitForTurn(thread!.id, 1, "completed");

    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await openThread(page, "Thread 1");
    await expect.poll(() => page.locator(".bubble-toggle").count()).toBeGreaterThan(1);
    await page.evaluate(recordScrollFrames, TRANSCRIPT_SELECTOR);
    const transcript = page.locator(TRANSCRIPT_SELECTOR);
    await transcript.evaluate((area) => area.scrollTo(0, 0));
    await expect.poll(() => transcript.evaluate((area) => area.scrollTop)).toBe(0);
    await waitForFrames(page, 5);
    const atTop = (await readLastScrollFrame(page))!;
    expect(atTop.height / atTop.viewport).toBeGreaterThan(10);

    const recorded = (await readScrollFrames(page)).length;
    await moveMouseOverTranscript(page);
    const wheelStep = 120;
    for (let step = 0; step < (atTop.height / wheelStep) * 2; step += 1) {
      await scrollWithWheel(page, wheelStep);
      if (measureGapAboveBottom((await readLastScrollFrame(page))!) < 1) break;
    }

    const frames = (await readScrollFrames(page)).slice(recorded);
    // A view at the bottom is also moved up when the transcript gets
    // shorter. That is the browser keeping the view inside the transcript,
    // not a jump.
    const jumpsBack = frames.flatMap((frame, index) =>
      index > 0 && frame.top < frames[index - 1]!.top - 1 && measureGapAboveBottom(frame) > 1
        ? [{ frame: index, from: frames[index - 1]!.top, to: frame.top }]
        : [],
    );
    // A view that is thrown back as far as it was scrolled shows no jump
    // between two frames, but it never reaches the bottom.
    const furthest = Math.max(...frames.map(({ top }) => top));
    expect(
      {
        jumps: jumpsBack.length,
        firstJumps: jumpsBack.slice(0, 3),
        reachedBottom: measureGapAboveBottom(frames.at(-1)!) < 1,
      },
      `the view got no further than ${furthest}px of a ${atTop.height}px transcript`,
    ).toEqual({ jumps: 0, firstJumps: [], reachedBottom: true });
  });

  it("follows a streaming message at the end, lets go on a wheel up, and follows again on a wheel down past the end", async () => {
    const page = await openThreadWithStreamingMessage();
    await moveMouseOverTranscript(page);

    // At the end, the view stays at the end as lines wrap. The 12px bound
    // is under one wrapped line (22.4px), so a view that falls behind fails
    // it. A sample can rarely show a gap no painted frame had (see
    // `recordScrollFrames`); that can only fail this test, never pass it.
    let recorded = (await readScrollFrames(page)).length;
    await waitForGrowth(page, (await readLastScrollFrame(page))!.height, FOUR_LINES_HEIGHT);
    const following = await readFramesSince(page, recorded);
    expect(Math.max(...following.map(measureGapAboveBottom))).toBeLessThan(12);

    // A wheel up lets go: the view stays where the reader left it.
    await scrollWithWheel(page, -200);
    const left = (await readLastScrollFrame(page))!;
    expect(measureGapAboveBottom(left)).toBeGreaterThan(12);
    recorded = (await readScrollFrames(page)).length;
    await waitForGrowth(page, left.height, FOUR_LINES_HEIGHT);
    expect(measureLargestStray(await readFramesSince(page, recorded), left.top)).toBeLessThan(1);

    // A wheel down past the end follows again, though the transcript grows
    // while the wheel's scroll is applied.
    await scrollWithWheel(page, 5_000);
    recorded = (await readScrollFrames(page)).length;
    await waitForGrowth(page, (await readLastScrollFrame(page))!.height, FOUR_LINES_HEIGHT);
    const rejoined = await readFramesSince(page, recorded);
    expect(Math.max(...rejoined.map(measureGapAboveBottom))).toBeLessThan(12);
  });

  it("keeps a reader who is not following where they are when they scroll a step's output box", async () => {
    const { url, fleet } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const output = Array.from({ length: 30 }, (_, index) => `line ${index + 1} of the output`);
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "How does the checkout page look?" },
      [
        ...buildFillerMessages(8),
        { kind: "tool_images", tool: "Screenshot", text: output.join("\n"), images: [] },
        { kind: "message", text: "The page looks right.", deltaMs: 0 },
        { kind: "end", state: "completed" },
      ],
    );
    await played;
    await fleet.waitForTurn(thread.id, 1, "completed");

    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await openThread(page, "How does the checkout page look?");
    await page.locator("button.worked").click();
    await page.getByRole("button", { name: "Screenshot", exact: true }).click();
    const outputBox = page.locator(".work-output-text");
    await outputBox.waitFor();
    await page.evaluate(recordScrollFrames, TRANSCRIPT_SELECTOR);

    // Playwright scrolls each button into view before it clicks it. That is
    // an upward scroll, so the transcript has stopped following the end by
    // now. Bring the view back to the end with a wheel step far past it,
    // beside the output box, which rejoins the end.
    const transcriptBox = (await page.locator(TRANSCRIPT_SELECTOR).boundingBox())!;
    await page.mouse.move(transcriptBox.x + 10, transcriptBox.y + transcriptBox.height / 2);
    await scrollWithWheel(page, 5_000);
    await expect
      .poll(async () => {
        const frame = await readLastScrollFrame(page);
        return frame !== undefined && measureGapAboveBottom(frame) < 12;
      })
      .toBe(true);

    // Let go of the end, 30px above it. A wheel step of 100px down would
    // reach the end if it scrolled the transcript, but the box takes it all.
    await scrollWithWheel(page, -30);
    const left = (await readLastScrollFrame(page))!;
    expect(measureGapAboveBottom(left)).toBeGreaterThan(12);
    expect(measureGapAboveBottom(left)).toBeLessThan(100);
    const outputRect = (await outputBox.boundingBox())!;
    expect(outputRect.y).toBeGreaterThan(transcriptBox.y);
    expect(outputRect.y + outputRect.height).toBeLessThan(transcriptBox.y + transcriptBox.height);

    const recorded = (await readScrollFrames(page)).length;
    await page.mouse.move(
      outputRect.x + outputRect.width / 2,
      outputRect.y + outputRect.height / 2,
    );
    await scrollWithWheel(page, 100);
    await waitForFrames(page, 5);

    expect(await outputBox.evaluate((box) => box.scrollTop)).toBeGreaterThan(0);
    expect(measureLargestStray(await readFramesSince(page, recorded), left.top)).toBeLessThan(1);
  });

  it("opens the last open thread again at launch", async () => {
    const { url, fleet } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "Why does the checkout test fail?" },
      [
        { kind: "message", text: ANSWER },
        { kind: "end", state: "completed" },
      ],
    );
    await played;
    await fleet.waitForTurn(thread.id, 1, "completed");
    await fleet.spawnThreads(1, { runner });
    const transcript = ["you: Why does the checkout test fail?", `agent: ${RENDERED_ANSWER}`];

    const userDataDir = createUserDataDirForTest();
    writeSettings(userDataDir, { controllerUrl: url });
    const first = await launchForTest(userDataDir);
    await signInAndReadToken(first.page, url);
    await first.page.getByRole("navigation", { name: "Threads", exact: true }).waitFor();
    await openThread(first.page, "Why does the checkout test fail?");
    await expect.poll(() => readTranscript(first.page)).toEqual(transcript);
    await first.close();

    const { page } = await launchForTest(userDataDir);
    await page.locator('section[aria-label="Transcript"]').waitFor();
    expect(await readTranscript(page)).toEqual(transcript);
    expect(await readOpenTab(page)).toBe("Why does the checkout test fail?");
  });

  it("opens a step whose tool returned images to their thumbnails, and one to the lightbox", async () => {
    const tooLarge = "The image is larger than 10 MB, so it was not kept.";
    const { url, fleet } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "How does the checkout page look?" },
      [
        {
          kind: "tool_images",
          tool: "Screenshot",
          text: "Took 3 screenshots.",
          images: [{ bytes: PNG }, { unavailable: tooLarge }, { bytes: PNG }],
        },
        { kind: "message", text: "The page looks right." },
        { kind: "end", state: "completed" },
      ],
    );
    await played;
    await fleet.waitForTurn(thread.id, 1, "completed");

    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await openThread(page, "How does the checkout page look?");
    await page.locator("button.worked").click();
    await page.getByRole("button", { name: "Screenshot", exact: true }).click();

    const output = page.locator(".work-output");
    expect(await output.locator(".work-output-text").textContent()).toBe("Took 3 screenshots.");
    expect(await output.locator(".tool-result-image-unavailable").allTextContents()).toEqual([
      tooLarge,
    ]);
    const tiles = output.locator(".image-tile img");
    await expect.poll(() => tiles.count()).toBe(2);
    for (const tile of await tiles.all()) {
      await expect
        .poll(() => tile.evaluate((image: HTMLImageElement) => image.naturalWidth))
        .toBeGreaterThan(0);
    }

    await output.getByRole("button", { name: "Preview Image 2" }).click();
    expect(await page.locator(".lightbox-caption").textContent()).toBe("Image 2 (2/2)");
    await expect
      .poll(() =>
        page.locator(".lightbox-image").evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(4);
  });
});
