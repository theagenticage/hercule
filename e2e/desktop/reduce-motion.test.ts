/**
 * Tests that Reduce motion stops every transition (spec 17, §Performance,
 * rule 2). Every transition lasts one of the three duration tokens, and
 * base.css sets the tokens to 0s under Reduce motion, so Chromium starts no
 * transition at all.
 *
 * The test starts the packaged test package on the first run's welcome, whose
 * Open the office button fades its background on hover. Run
 * `pnpm build:desktop` first.
 */
import { expect, it } from "vitest";
import { keepWindowOnTop, launchForTest } from "./harness";

/** The page's global, with the list of the properties whose transition has started. */
type TransitionLog = typeof globalThis & { transitionsRun?: string[] };

it("starts no transition when a control is hovered with Reduce motion on, and one with it off", async () => {
  const { app, page } = await launchForTest();
  // The hover below comes from the pointer, which another app of the suite
  // can take away by covering or unfocusing this window.
  await keepWindowOnTop(app);
  // The button is off while the welcome looks for Hercule on this Mac, and a
  // button that is off does not change on hover.
  const button = page.getByRole("button", { name: "Open the office", disabled: false });
  await button.waitFor();
  const readBackground = () => button.evaluate((element) => getComputedStyle(element).background);

  // `transitionrun` fires for every transition Chromium starts, before its
  // first frame. The event bubbles, so one listener on the document hears
  // every element.
  await page.evaluate(() => {
    const log: string[] = [];
    (globalThis as TransitionLog).transitionsRun = log;
    document.addEventListener("transitionrun", (event) => log.push(event.propertyName));
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  // One duration per property the button transitions: background and box-shadow.
  expect(await button.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
    "0s, 0s",
  );
  const restingBackground = await readBackground();
  // The page handles the hover some time after it is sent, so the test waits
  // until the button has changed. Without that wait, a page that has not
  // handled the hover yet has no transition either, and the check below would
  // mean nothing. Reading the style also applies the change. A hover can also
  // be lost: a window event from another app of the suite clears it before
  // the page has used it. So the hover and the check are one step that is
  // retried: each try moves the pointer onto the button again.
  await expect
    .poll(async () => {
      await button.hover();
      return readBackground();
    })
    .not.toBe(restingBackground);
  // `getAnimations` recalculates the page's style first, so a transition the
  // hover started would be in the list.
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  // Reading the style applies the change while Reduce motion is still on, so
  // the button's return to rest cannot start a transition below.
  await page.mouse.move(0, 0);
  await expect.poll(readBackground).toBe(restingBackground);

  // With Reduce motion off, the same hover starts the button's transition.
  // That proves the hover changes a property that transitions, so the empty
  // list above means something.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await button.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
    "0.12s, 0.12s",
  );
  await expect
    .poll(async () => {
      await button.hover();
      return page.evaluate(() => (globalThis as TransitionLog).transitionsRun);
    })
    .toContain("background-color");
  // Events arrive in the order their transitions started, so a transition
  // started under Reduce motion would be in the list before this one.
  expect(await page.evaluate(() => (globalThis as TransitionLog).transitionsRun)).toEqual([
    "background-color",
  ]);
});
