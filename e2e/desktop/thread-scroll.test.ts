/**
 * Tests how the thread view's transcript holds still while the reader moves
 * through long messages, in the packaged app, signed in to a real controller
 * whose threads scripted runners fill with messages (spec 17, §Design system,
 * **The thread**):
 *
 * - long messages of the user's are collapsed as they mount, without
 *   setting off a resize loop;
 * - a scroll down through long collapsed messages never moves the view back.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { describe, expect, it } from "vitest";
import {
  arrangeFleet,
  keepWindowOnTop,
  openSignedIn,
  measureGapAboveBottom,
  openThread,
  readLastScrollFrame,
  readScrollFrames,
  recordScrollFrames,
  waitForFrames,
} from "./harness";
import {
  TRANSCRIPT_SELECTOR,
  SHORT_REPLY,
  moveMouseOverTranscript,
  scrollWithWheel,
} from "./thread-helpers";

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

describe("the thread view, scrolling", () => {
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
});
