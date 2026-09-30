/**
 * Tests that Reduce transparency removes the glass blur completely (spec 17,
 * §Performance, rule 5). Every glass surface reads its `backdrop-filter`
 * from one token, so the test reads what that token computes to on a probe
 * element.
 *
 * A filter that changes no pixel, such as `blur(0px)`, is not enough: Chromium
 * still draws a backdrop filter for it, and holds about 400 MB more GPU memory
 * while a caret blinks. So the test expects `none`.
 *
 * The test starts the packaged test package on the connect screen. Run
 * `pnpm build:desktop` first.
 */
import { expect, it } from "vitest";
import { launchForTest } from "./harness";

it("computes the glass filter to none with Reduce transparency on, and to a blur with it off", async () => {
  const { page } = await launchForTest();
  // Playwright's `emulateMedia` has no switch for this media feature, so the
  // test asks Chromium directly.
  const session = await page.context().newCDPSession(page);
  const emulateReducedTransparency = (value: "reduce" | "no-preference") =>
    session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value }],
    });
  const readGlassFilter = () =>
    page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.backdropFilter = "var(--glass-filter)";
      document.body.append(probe);
      const filter = getComputedStyle(probe).backdropFilter;
      probe.remove();
      return filter;
    });

  await emulateReducedTransparency("reduce");
  expect(await readGlassFilter()).toBe("none");

  // With Reduce transparency off, the same probe blurs. That proves the probe
  // reads the token, so `none` above means something.
  await emulateReducedTransparency("no-preference");
  expect(await readGlassFilter()).toMatch(/^blur\(/);
});
