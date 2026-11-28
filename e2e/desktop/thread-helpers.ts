/**
 * What the thread view's end-to-end files share (`thread.test.ts`,
 * `thread-live.test.ts`, `thread-scroll.test.ts`, `thread-follow.test.ts`):
 * reading the open transcript, the scripted answers the threads play, and the
 * wheel and frame measurements of the scroll tests.
 */
import type { Page } from "playwright";
import { waitForFrames } from "./harness";

/** Finds the thread's transcript, whose last agent message `recordLastAgentText` records. */
export const TRANSCRIPT_SELECTOR = 'section[aria-label="Transcript"]';

/** A reply of 33 words, three or four lines in the transcript. */
export const SHORT_REPLY =
  "I read the test and the payment form. The form waits for the bank's reply, and on a slow " +
  "runner the reply comes after the timeout, so the first assertion runs too early.";

/** Moves the mouse to the middle of the transcript, where a wheel step scrolls it. */
export async function moveMouseOverTranscript(page: Page): Promise<void> {
  const box = (await page.locator(TRANSCRIPT_SELECTOR).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Scrolls the transcript with one wheel step of `deltaY` pixels, as a mouse
 * wheel does, and waits until the page has painted the result.
 */
export async function scrollWithWheel(page: Page, deltaY: number): Promise<void> {
  await page.mouse.wheel(0, deltaY);
  await waitForFrames(page, 2);
}
