/**
 * Tests that a colleague's hue can be set the way React sets it, under the
 * release Content-Security-Policy (spec 17, §Content-Security-Policy). React
 * writes a custom property in the `style` prop with `style.setProperty`, which
 * goes through the CSSOM; `style-src 'self'` governs style attributes written
 * in markup, not the CSSOM. tokens.css derives `--who` from `--hue` only for
 * an element whose `style` attribute contains `--hue`, and every face and mark
 * draws with `--who`.
 *
 * The test starts the packaged test package, which runs under the release
 * policy. Run `pnpm build:desktop` first.
 */
import { expect, it } from "vitest";
import { launchForTest } from "./harness";

it("sets a colleague's hue with style.setProperty, and the hue's colours follow, with no policy violation", async () => {
  const { page } = await launchForTest();

  const result = await page.evaluate(async () => {
    const styled = document.createElement("div");
    const control = document.createElement("div");
    const violations: { directive: string; element: string }[] = [];
    // Resolves at the violation of the control element, set up below.
    const controlRefused = new Promise<void>((resolve) => {
      document.addEventListener("securitypolicyviolation", (event) => {
        violations.push({
          directive: event.effectiveDirective,
          element:
            event.target === styled ? "styled" : event.target === control ? "control" : "other",
        });
        if (event.target === control) resolve();
      });
    });

    styled.style.setProperty("--hue", "var(--hue-lime)");
    document.body.append(styled);
    const matches = styled.matches('[style*="--hue"]');
    const who = getComputedStyle(styled).getPropertyValue("--who");

    // The control writes the same hue as a style attribute, which the policy
    // refuses, so the test sees that a refused style does get reported.
    // Chromium reports violations in the order they happen, each in a task of
    // its own, so once the control's violation arrives, any violation for the
    // styled element has arrived before it.
    document.body.append(control);
    control.setAttribute("style", "--hue: var(--hue-lime)");
    await controlRefused;
    styled.remove();
    control.remove();
    return { matches, who, violations };
  });

  expect(result.matches).toBe(true);
  // `--hue-lime` is 132, and `--who` is an oklch() colour with the hue last.
  expect(result.who).toMatch(/^oklch\(.+ 132\)$/);
  expect(result.violations).toEqual([{ directive: "style-src-attr", element: "control" }]);
});
