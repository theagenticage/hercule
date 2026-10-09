/**
 * Tests the thread view in the packaged app, signed in to a real controller
 * whose threads scripted runners fill with turns, streamed text and Requests
 * (spec 17, §Design system, **The thread**):
 *
 * - a thread opens from the sidebar, and its transcript shows its rows;
 * - a message the agent has started, with no word yet, shows a "Writing…"
 *   line and no agent row, and the row shows once the first word arrives;
 * - a message streams into the tail before its row lands, then shows as
 *   markdown, below a divider that sums up the work before it;
 * - a Request shows the dock and the waiting note, and Allow resolves it;
 * - a queued input shows above the composer, and Cancel removes it;
 * - a window hidden and shown again while a message streams ends with the
 *   whole message, no word doubled or skipped;
 * - the app opens the last open thread again at launch.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { writeSettings } from "../../apps/desktop/scripts/packaged-app";
import {
  arrangeFleet,
  buildCountedMessage,
  buildLiveCheck,
  createMessagePause,
  createUserDataDirForTest,
  joinShownText,
  keepWindowOnTop,
  launchForTest,
  launchPlainAppForTest,
  openSignedIn,
  openThread,
  READ_AGENT_TEXTS,
  READ_LAST_AGENT_TEXT,
  readWordNumbers,
  recordFrames,
  recordLastAgentText,
  signInAndReadToken,
  type AgentTextSnapshot,
} from "./harness";

/** Finds the thread's transcript, whose last agent message `recordLastAgentText` records. */
const TRANSCRIPT_SELECTOR = 'section[aria-label="Transcript"]';

/** Returns the title of the thread the header shows as open. */
function readOpenTab(page: Page): Promise<string | null> {
  return page
    .locator('nav[aria-label="Threads in this workspace"] a[aria-current="page"] .ptab-title')
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
    const { url, fleet } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    // The message starts, and its first word waits for the test, so the page
    // holds an open message with no text for as long as the test looks.
    const firstWord = createMessagePause(0);
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "Why does the checkout test fail?" },
      [
        { kind: "message", text: "Found it.", pauses: [firstWord.pause] },
        { kind: "end", state: "completed" },
      ],
    );
    const { page } = await openSignedIn(url);
    await openThread(page, "Why does the checkout test fail?");

    await expect
      .poll(() => readTranscript(page))
      .toEqual(["you: Why does the checkout test fail?", "pending: Writing…"]);
    expect(await page.locator(`${TRANSCRIPT_SELECTOR} .msg:visible`).count()).toBe(0);

    firstWord.resume();
    await played;
    await fleet.waitForTurn(thread.id, 1, "completed");
    await expect
      .poll(() => readTranscript(page))
      .toEqual(["you: Why does the checkout test fail?", "agent: Found it."]);
    expect(await page.locator(`${TRANSCRIPT_SELECTOR} .msg-pending:visible`).count()).toBe(0);
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
    // is unsubscribed only on a real hide. This test starts the app as a
    // plain process instead.
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
    // The stream topic stays subscribed while the window is hidden, so the
    // rows keep landing. A hidden page runs its timers at most once a second.
    message.resumeAfterHide();
    await expect
      .poll(async () => joinShownText((await readLastSnapshot())!).length, { timeout: 10_000 })
      .toBeGreaterThan(shownWhenHidden.length);
    await callWindowMethod("show");
    await expect.poll(readVisibility).toBe("visible");
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
});
