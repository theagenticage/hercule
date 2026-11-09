/**
 * Tests the thread view in the packaged app, signed in to a real controller
 * whose threads scripted runners fill with turns, streamed text and Requests
 * (spec 17, §Design system, **The thread**). The files `thread-live.test.ts`,
 * `thread-scroll.test.ts` and `thread-follow.test.ts` test the rest of it:
 *
 * - a thread opens from the sidebar, and its transcript shows its rows;
 * - a message the agent has started, with no word yet, shows a "Writing…"
 *   line and no agent row, and the row shows once the first word arrives,
 *   while the message is still open; a message the user stops before its
 *   first word shows no agent row at all;
 * - a message streams into the tail before its row lands, then shows as
 *   markdown, below a divider that sums up the work before it;
 * - the app opens the last open thread again at launch;
 * - a step whose tool returned images opens to their thumbnails, a line for
 *   an image that could not be kept, and a lightbox.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { writeSettings } from "../../apps/desktop/scripts/packaged-app";
import {
  arrangeFleet,
  buildLiveCheck,
  createMessagePause,
  createUserDataDirForTest,
  keepWindowOnTop,
  launchForTest,
  openSignedIn,
  openThread,
  READ_AGENT_TEXTS,
  READ_LAST_AGENT_TEXT,
  recordFrames,
  recordLastAgentText,
  signInAndReadToken,
  type AgentTextSnapshot,
} from "./harness";
import { TRANSCRIPT_SELECTOR } from "./thread-helpers";

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
    // message streams while the page listens. The message stops in the middle
    // of its second paragraph until the test has seen that paragraph being
    // written next to the first one, drawn as markdown: on a slow machine the
    // page can otherwise take the whole message in one frame, and there would
    // be no such state to see.
    const insideSecondParagraph = createMessagePause(
      FIRST_PARAGRAPH.markdown.split(" ").length + 2,
    );
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "Why does the checkout test fail?" },
      [
        { kind: "command", command: "pnpm test", ask: true },
        { kind: "message", text: ANSWER, deltaMs: 40, pauses: [insideSecondParagraph.pause] },
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
    await expect
      .poll(async () => {
        const last = (await page.evaluate(READ_LAST_AGENT_TEXT)) as AgentTextSnapshot | undefined;
        return last?.text === FIRST_PARAGRAPH.rendered && (last.openParagraph ?? "") !== "";
      })
      .toBe(true);
    insideSecondParagraph.resume();
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
