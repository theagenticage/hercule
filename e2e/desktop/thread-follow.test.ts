/**
 * Tests which part of a streaming transcript the thread view follows, in the
 * packaged app, signed in to a real controller whose threads scripted
 * runners stream long messages (spec 17, §Design system, **The thread**):
 *
 * - a reader at the bottom follows a streaming message, leaves it by
 *   scrolling up and rejoins it by scrolling down past the end;
 * - a reader who is not following stays where they are when they scroll a
 *   step's output box, and scrolling the box does not rejoin the stream.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import type { ScriptStep } from "../../apps/desktop/scripts/scripted-runner";
import {
  arrangeFleet,
  buildLiveCheck,
  keepWindowOnTop,
  openSignedIn,
  measureGapAboveBottom,
  openThread,
  readLastScrollFrame,
  readScrollFrames,
  recordFrames,
  recordScrollFrames,
  waitForFrames,
  type ScrollFrame,
} from "./harness";
import {
  TRANSCRIPT_SELECTOR,
  SHORT_REPLY,
  moveMouseOverTranscript,
  scrollWithWheel,
} from "./thread-helpers";

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

describe("the thread view, following a stream", () => {
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
});
