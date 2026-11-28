/**
 * Tests the thread's composer, its shape and its field, in the packaged app,
 * signed in to a real controller whose threads run on a scripted runner
 * (spec 17, §Design system, **The thread**):
 *
 * - the composer shrinks while the transcript is scrolled up, `dock-mini`
 *   answers a Request without expanding it, and a click on the field
 *   expands it again;
 * - with the transcript scrolled up, none of it shows below the full
 *   composer's card, where the lip is, and it shows below the shrunk one;
 * - the field grows with its text up to eight lines, then scrolls, and an
 *   empty field grows to hold a placeholder that wraps;
 * - text pasted during an IME composition goes in as plain text, with its
 *   blank lines.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Locator, Page } from "playwright";
import { describe, expect, it } from "vitest";
import { pollUntil } from "../../apps/desktop/scripts/poll";
import {
  arrangeFleet,
  fillFieldLines,
  keepWindowOnTop,
  openSignedIn,
  openThread,
  readFieldText,
} from "./harness";
import { locateComposer, readBox } from "./composer-helpers";

/**
 * The height of the composer's field, and of the text in it, in CSS pixels.
 * Both are layout sizes, which the composer's 4px drop, a transform, does not
 * change.
 */
interface FieldSize {
  /** The field's height, padding included. */
  readonly clientHeight: number;
  /** The height of the field's text and padding, which is more than `clientHeight` once the field scrolls. */
  readonly scrollHeight: number;
}

/** Returns the size of the composer's field. */
function readFieldSize(field: Locator): Promise<FieldSize> {
  return field.evaluate(({ clientHeight, scrollHeight }) => ({ clientHeight, scrollHeight }));
}

/** Returns how far the transcript is scrolled away from its bottom, in CSS pixels. */
function readDistanceFromBottom(page: Page): Promise<number> {
  return page
    .locator('section[aria-label="Transcript"]')
    .evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
}

/**
 * Scrolls the transcript so that the paragraph starting with `start` begins
 * 4px above the bottom of the composer's card. Its first line then runs into
 * the strip below the card.
 */
async function scrollParagraphToCardBottom(page: Page, start: string): Promise<void> {
  // The transcript draws its rows some time after the thread opens.
  await page.locator(".msg-body p").filter({ hasText: start }).first().waitFor();
  await page.evaluate((start) => {
    const transcript = document.querySelector('section[aria-label="Transcript"]')!;
    const paragraph = [...transcript.querySelectorAll(".msg-body p")].find((each) =>
      each.textContent?.startsWith(start),
    )!;
    const card = document.querySelector(".composer-card")!;
    transcript.scrollTop +=
      paragraph.getBoundingClientRect().top - (card.getBoundingClientRect().bottom - 4);
  }, start);
}

/** Waits until the composer's transitions, such as its 4px drop, have finished. */
async function waitForComposerTransitions(page: Page): Promise<void> {
  await page
    .locator(".composer")
    .evaluate((composer) =>
      Promise.all(composer.getAnimations({ subtree: true }).map((each) => each.finished)),
    );
}

/**
 * Captures the part of the window that `clip` covers once it has stopped
 * changing, and returns the capture: it captures again until two captures
 * in a row are the same. Fails when the part keeps changing for 5 s.
 *
 * Right after the page changes, Chromium now and then hands over a frame it
 * has not finished drawing, in which a few hundred pixels below the
 * composer's card are one shade off. The next capture is right again. So one
 * capture alone can differ from another capture of the same page.
 */
async function captureSettled(
  page: Page,
  clip: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): Promise<Buffer> {
  let previous = await page.screenshot({ clip });
  return pollUntil(
    async () => {
      const next = await page.screenshot({ clip });
      const settled = next.equals(previous);
      previous = next;
      return settled ? next : undefined;
    },
    { timeoutMs: 5_000, intervalMs: 0, timeoutMessage: "the captured part kept changing for 5 s" },
  );
}

/**
 * Checks whether any of the transcript shows below the composer's card,
 * across the card's width: the strip the lip sits in. The strip is captured
 * twice, as drawn and with the transcript hidden, each once it has stopped
 * changing (see `captureSettled`), and the transcript shows there when the
 * two captures differ.
 *
 * The lip is hidden in both captures, because Chromium draws its text a
 * shade differently once the transcript behind it is hidden.
 */
async function showsTranscriptBelowCard(page: Page): Promise<boolean> {
  const transcript = page.locator('section[aria-label="Transcript"]');
  const setVisibility = (selector: string, visibility: string): Promise<void> =>
    page.evaluate(
      ([selector, visibility]) => {
        for (const element of document.querySelectorAll<HTMLElement>(selector)) {
          element.style.visibility = visibility;
        }
      },
      [selector, visibility] as const,
    );
  const card = await readBox(page.locator(".composer-card"));
  const pane = await readBox(transcript);
  const clip = {
    x: card.left,
    y: card.bottom,
    width: card.width,
    height: pane.bottom - card.bottom,
  };
  await setVisibility(".lip", "hidden");
  const drawn = await captureSettled(page, clip);
  await setVisibility('section[aria-label="Transcript"]', "hidden");
  const hidden = await captureSettled(page, clip);
  await setVisibility('section[aria-label="Transcript"], .lip', "");
  return !drawn.equals(hidden);
}

/** Returns `count` lines of text, numbered from 1, joined by newlines. */
const buildLines = (count: number): string =>
  Array.from({ length: count }, (_, index) => `Line ${index + 1}`).join("\n");

/**
 * An answer long enough that its thread's transcript scrolls in the window:
 * thirty paragraphs of one sentence each.
 */
const LONG_ANSWER = Array.from(
  { length: 30 },
  (_, index) =>
    `Paragraph ${index + 1} of the answer, written only to make the transcript taller than the window.`,
).join("\n\n");

describe("the composer's shape and field", () => {
  it("shrinks while the transcript is scrolled up, answers a Request from dock-mini without expanding, and expands on a click on the field", async () => {
    const { url, fleet, client } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "Why does the checkout test fail?" },
      [
        { kind: "message", text: LONG_ANSWER, deltaMs: 1 },
        { kind: "command", command: "pnpm test", ask: true },
        { kind: "end", state: "completed" },
      ],
    );
    await fleet.waitForTurn(thread.id, 1, "waiting");
    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await openThread(page, "Why does the checkout test fail?");
    const composer = locateComposer(page);
    await page.getByRole("group", { name: "Run this command?" }).waitFor();
    expect(await composer.root.getAttribute("class")).toBe("composer");

    await page.locator('section[aria-label="Transcript"] .msg-body').first().hover();
    await page.mouse.wheel(0, -600);
    await expect.poll(() => composer.root.getAttribute("class")).toBe("composer is-scrolled");
    expect((await readFieldSize(composer.field)).clientHeight).toBe(32);
    const mini = page.locator(".dock-mini");
    expect(await mini.locator(".dock-mini-q").textContent()).toBe("Run pnpm test?");
    expect(await mini.getByRole("button").allTextContents()).toEqual(["Allow", "Deny"]);

    await mini.getByRole("button", { name: "Allow" }).click();
    await expect
      .poll(async () => (await client.session.read({ params: { id: thread.id } })).openRequests)
      .toEqual([]);
    await mini.waitFor({ state: "detached" });
    expect(await composer.root.getAttribute("class")).toBe("composer is-scrolled");
    await played;

    await composer.field.click();
    await expect.poll(() => composer.root.getAttribute("class")).toBe("composer");
    expect(await composer.field.evaluate((field) => field === document.activeElement)).toBe(true);
    await expect.poll(() => readDistanceFromBottom(page)).toBeLessThan(1);
  });

  it("hides the transcript below the full composer's card, where the lip is, and shows it below the shrunk one", async () => {
    const { url, fleet } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const { played } = await fleet.spawnScriptedThread(
      { runner, prompt: "Why does the checkout test fail?" },
      [
        { kind: "message", text: LONG_ANSWER, deltaMs: 1 },
        { kind: "end", state: "completed" },
      ],
    );
    await played;
    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await openThread(page, "Why does the checkout test fail?");
    const composer = locateComposer(page);

    // Scrolled up with the focus elsewhere, the composer shrinks. The
    // paragraph is placed again once the card has its shrunk size. The
    // transcript is still being measured when the thread has just opened, and
    // while it follows the bottom, a resize puts the view back at the bottom
    // before the page has noted the scroll up. So the scroll and the check are
    // one step that is retried: each try scrolls again.
    await expect
      .poll(async () => {
        await scrollParagraphToCardBottom(page, "Paragraph 20 ");
        return composer.root.getAttribute("class");
      })
      .toBe("composer is-scrolled");
    await waitForComposerTransitions(page);
    await scrollParagraphToCardBottom(page, "Paragraph 20 ");
    expect(await showsTranscriptBelowCard(page)).toBe(true);

    // With the focus in the field, the composer stays full size while the
    // transcript is scrolled up.
    await composer.field.click();
    await expect.poll(() => composer.root.getAttribute("class")).toBe("composer");
    await waitForComposerTransitions(page);
    await scrollParagraphToCardBottom(page, "Paragraph 20 ");
    await expect.poll(() => readDistanceFromBottom(page)).toBeGreaterThan(200);
    expect(await composer.root.getAttribute("class")).toBe("composer");
    expect(await showsTranscriptBelowCard(page)).toBe(false);
  });

  it("grows the field with its text up to eight lines, then scrolls it", async () => {
    const { url, fleet } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    await fleet.spawnThreads(1, { runner });
    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await openThread(page, "Thread 1");
    const { field } = locateComposer(page);

    // 6px of padding above the text, 21px a line, and 4px below.
    const heights: Record<number, number> = {};
    for (const lines of [1, 2, 3, 8, 9, 12]) {
      await fillFieldLines(field, buildLines(lines));
      heights[lines] = (await readFieldSize(field)).clientHeight;
    }
    expect(heights).toEqual({ 1: 44, 2: 52, 3: 73, 8: 178, 9: 178, 12: 178 });
    await fillFieldLines(field, buildLines(8));
    const eight = await readFieldSize(field);
    expect(eight.scrollHeight).toBe(eight.clientHeight);
    await fillFieldLines(field, buildLines(9));
    const nine = await readFieldSize(field);
    expect(nine.scrollHeight).toBeGreaterThan(nine.clientHeight);

    // The field's scroll bar, drawn at its right edge from its top, stays
    // inside the card's rounded corner.
    const card = await readBox(page.locator(".composer-card"));
    const box = await readBox(field);
    expect({ top: box.top - card.top, right: card.right - box.right }).toEqual({
      top: 8,
      right: 8,
    });
  });

  it("grows the empty field to hold a placeholder that wraps", async () => {
    const { url, fleet } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    await fleet.spawnThreads(1, { runner });
    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await openThread(page, "Thread 1");
    const { field } = locateComposer(page);
    expect((await readFieldSize(field)).clientHeight).toBe(44);

    // The placeholder's text is set through the style sheet, because the page
    // draws it from the editor's state and puts back any attribute changed.
    const wrapping = "Message the thread, and write enough here that the text wraps. ".repeat(8);
    await page.evaluate((text) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(
        `.composer-input p.is-editor-empty::before { content: ${JSON.stringify(text)}; }`,
      );
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }, wrapping);

    const size = await readFieldSize(field);
    expect(size.clientHeight).toBeGreaterThan(44);
    expect(size.scrollHeight).toBe(size.clientHeight);
  });

  it("pastes the plain text of the clipboard, blank lines kept, during an IME composition", async () => {
    const { url, fleet } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    await fleet.spawnThreads(1, { runner });
    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await openThread(page, "Thread 1");
    const { field } = locateComposer(page);
    await field.click();

    // A synthetic paste has no default action, so whatever lands in the field
    // was inserted by the app's handler. The clipboard's HTML would put the
    // two lines in as `one  two` (a `<br>` parses to a space).
    await field.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/html", "one<br><br>two");
      clipboardData.setData("text/plain", "one\n\ntwo");
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
      element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });

    expect(await readFieldText(field)).toBe("one\n\ntwo");
  });
});
