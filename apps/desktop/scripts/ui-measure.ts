/**
 * Measures one ready specimen page for `pnpm ui:metrics`
 * (scripts/ui-metrics.ts): the page is loaded once, and every metric is read
 * from it in place, each change to the page undone before the next. The
 * browser side is the UI probe (src/renderer/specimens/ui-probe.ts); this
 * file takes the screenshots, does the pixel checks (scripts/ui-pixels.ts)
 * and turns the facts into numbers (scripts/ui-summary.ts).
 *
 * Runs on plain Node by stripping types, so it uses only syntax that
 * stripping can erase: no enums, namespaces or parameter properties.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { Page } from "playwright";
import type {
  ClippingFacts,
  DisciplineFacts,
  FocusOutcome,
  GlyphPair,
  Perturbation,
  ProbeRect,
  ProbeTarget,
  ProseFacts,
  TextFragment,
  ThemeTokens,
} from "../src/renderer/specimens/ui-probe-types.ts";
import { screenshotVariant } from "./ui-capture.ts";
import {
  GLASS_PERCENTS,
  isDarkTheme,
  UI_SCREENS,
  WINDOW_SIZE,
  type UiVariant,
} from "./ui-screens.ts";
import { ALL_THEMES } from "../src/renderer/specimens/sheet-themes.ts";
import {
  checkFocusRing,
  checkNonTextPart,
  measureFragmentContrast,
  type DecodedImage,
} from "./ui-pixels.ts";
import {
  summarizeContrast,
  summarizeDiscipline,
  summarizeGlyphs,
  summarizeProse,
  summarizeResilience,
  summarizeTargets,
  summarizeText,
  summarizeTokens,
  type MeasuredFragment,
  type MetricValues,
} from "./ui-summary.ts";

/** The scale the metrics are measured at. 2x would only repeat 1x with finer pixels. */
export const METRICS_SCALE = 1;

/** The glass level the page loads with, and the level the contrast is also measured at. */
const [DEFAULT_GLASS_PERCENT, SOLID_GLASS_PERCENT] = GLASS_PERCENTS;

/** The size of the window the reflow check shrinks to, in CSS px: the window of 1440 px at 150% zoom is 960 px wide. */
const REFLOW_WINDOW = { width: 960, height: 600 } as const;

/** How far around a target the focus check looks for a ring, in CSS px. A ring with an offset reaches beyond the target's box. */
const FOCUS_CLIP_MARGIN_PX = 12;

/** The address the probe module is served at, from the origin of every specimen page. */
const PROBE_URL = "/specimens/ui-probe.ts";

/** The probe's functions as the page defines them (src/renderer/specimens/ui-probe.ts). */
interface ProbeFunctions {
  resolveThemeTokens(): ThemeTokens;
  collectText(): TextFragment[];
  hideText(): void;
  showText(): void;
  hideOpacityGroups(ids: ReadonlyArray<number>): void;
  showOpacityGroups(): void;
  setGlass(percent: number): void;
  collectDiscipline(): DisciplineFacts;
  collectTargets(): ProbeTarget[];
  focusTarget(id: number): FocusOutcome;
  blurTarget(): void;
  measureParts(selectors: ReadonlyArray<string>): ProbeRect[][];
  applyPerturbation(perturbation: Perturbation): void;
  removePerturbation(): void;
  measureClipping(): ClippingFacts;
  measureProse(): ProseFacts;
  measureGlyphPairs(): GlyphPair[];
}

/** The probe as this program calls it: each function runs in the page and returns a promise. */
type PageProbe = {
  [Name in keyof ProbeFunctions]: (
    ...args: Parameters<ProbeFunctions[Name]>
  ) => Promise<ReturnType<ProbeFunctions[Name]>>;
};

/**
 * Returns the probe of `page`: an object whose methods run the probe's
 * functions of the same name inside the page. The page imports the module on
 * the first call; later calls reuse that instance, so the state the probe
 * keeps (hidden text, the focused target, a perturbation) survives between
 * calls.
 */
function bindProbe(page: Page): PageProbe {
  return new Proxy({} as PageProbe, {
    get: (_target, name) => {
      // An `await` on the probe itself would otherwise look for a `then`.
      if (name === "then") return undefined;
      return (...args: unknown[]) =>
        page.evaluate(
          // Runs in the page, where the annotation is already stripped.
          ([url, functionName, functionArguments]) =>
            import(url).then((probe: Record<string, (...input: unknown[]) => unknown>) =>
              probe[functionName]!(...functionArguments),
            ),
          [PROBE_URL, String(name), args] as const,
        );
    },
  });
}

/** How many times the page is waited for or measured, at most, while it settles. */
const MAXIMUM_SETTLE_ATTEMPTS = 20;

/** What every screenshot of the measurement uses: finished animations and no caret, as the golden has. */
const SCREENSHOT_OPTIONS = { animations: "disabled", caret: "hide" } as const;

/** Takes a screenshot of the whole window and returns it decoded. */
async function captureWindow(page: Page): Promise<DecodedImage> {
  return PNG.sync.read(await page.screenshot(SCREENSHOT_OPTIONS));
}

/**
 * Waits until the page has drawn what a change of its size or style makes it
 * draw: every animation and transition that ends has ended, and two frames
 * have passed. Animations that never end, such as a working face, are not
 * waited for. A window that shrinks starts transitions, some of them after a
 * delay, so a measure taken before they end differs from run to run.
 */
async function waitForPageToSettle(page: Page): Promise<void> {
  // A string, because this program has no DOM types.
  await page.evaluate(`(async () => {
    const nextFrames = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (let round = 0; round < ${String(MAXIMUM_SETTLE_ATTEMPTS)}; round += 1) {
      await nextFrames();
      const ending = document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime ?? 0));
      if (ending.every((animation) => animation.playState === "finished")) return;
      await Promise.all(ending.map((animation) => animation.finished.catch(() => undefined)));
    }
  })()`);
}

/**
 * Measures how much text is clipped or overlapping, once the page has stopped
 * moving. A change of the text or of the window can set off a second layout
 * in the page (a virtual list that renders other rows, a field that grows),
 * and a measure taken in between differs from run to run. So it waits two
 * frames, measures, and repeats until two measures in a row are the same.
 * Fails when the page does not settle within 20 measures, which means the
 * numbers could not be repeated.
 */
async function measureSettledClipping(page: Page, probe: PageProbe): Promise<ClippingFacts> {
  let previous: ClippingFacts | undefined;
  for (let attempt = 0; attempt < MAXIMUM_SETTLE_ATTEMPTS; attempt += 1) {
    await waitForPageToSettle(page);
    const facts = await probe.measureClipping();
    if (
      previous?.clippedCharacters === facts.clippedCharacters &&
      previous.overlappingPairs === facts.overlappingPairs
    ) {
      return facts;
    }
    previous = facts;
  }
  throw new Error(
    `The text of the page kept changing: ${String(MAXIMUM_SETTLE_ATTEMPTS)} measures in a row differed.`,
  );
}

/**
 * Reads the contrast of every line of text on the page as it is drawn now.
 * Takes one screenshot with the text hidden, and a second with the outermost
 * opacity groups hidden as well, only when some text sits in one. Returns the
 * lines that have pixels to measure on; the others are scrolled away or
 * clipped. Leaves the page as it found it.
 */
async function measureTextContrast(page: Page, probe: PageProbe): Promise<MeasuredFragment[]> {
  const fragments = await probe.collectText();
  await probe.hideText();
  const textHidden = await captureWindow(page);
  const groupIds = [
    ...new Set(
      fragments.flatMap(({ opacityGroups }) => opacityGroups.slice(0, 1).map((g) => g.id)),
    ),
  ];
  let behind: DecodedImage | null = null;
  if (groupIds.length > 0) {
    await probe.hideOpacityGroups(groupIds);
    behind = await captureWindow(page);
    await probe.showOpacityGroups();
  }
  await probe.showText();

  const measured: MeasuredFragment[] = [];
  for (const fragment of fragments) {
    const contrast = measureFragmentContrast(fragment, textHidden, behind, METRICS_SCALE);
    if (contrast !== null) measured.push({ fragment, contrast });
  }
  return measured;
}

/** Returns `box` grown by the focus margin, cut to the window and rounded outwards to whole pixels. */
function buildFocusClip(box: ProbeRect): ProbeRect {
  return {
    left: Math.max(0, Math.floor(box.left - FOCUS_CLIP_MARGIN_PX)),
    top: Math.max(0, Math.floor(box.top - FOCUS_CLIP_MARGIN_PX)),
    right: Math.min(WINDOW_SIZE.width, Math.ceil(box.right + FOCUS_CLIP_MARGIN_PX)),
    bottom: Math.min(WINDOW_SIZE.height, Math.ceil(box.bottom + FOCUS_CLIP_MARGIN_PX)),
  };
}

/**
 * Focuses each target that lies wholly in the window, as a keyboard user
 * does, and returns how many show no focus ring: the focus did not land, or
 * the pixels around the target did not change enough from `golden`. One small
 * screenshot per target. Leaves the page as it found it.
 */
async function countTargetsWithoutFocusRing(
  page: Page,
  probe: PageProbe,
  golden: DecodedImage,
  targets: ReadonlyArray<ProbeTarget>,
): Promise<number> {
  let missing = 0;
  for (const target of targets) {
    if (!target.inWindow) continue;
    const { focused } = await probe.focusTarget(target.id);
    let hasRing = false;
    if (focused) {
      const clip = buildFocusClip(target.box);
      const clipped = PNG.sync.read(
        await page.screenshot({
          ...SCREENSHOT_OPTIONS,
          clip: {
            x: clip.left,
            y: clip.top,
            width: clip.right - clip.left,
            height: clip.bottom - clip.top,
          },
        }),
      );
      hasRing = checkFocusRing(golden, clipped, clip, target.box, METRICS_SCALE).visible;
    }
    await probe.blurTarget();
    if (!hasRing) missing += 1;
  }
  return missing;
}

/**
 * Checks the borders and marks that `variant`'s screen names in
 * `nonTextParts` against the golden, and returns how many fail. Fails when a
 * selector matches nothing visible: the screen changed and its list did not.
 */
async function countFailingNonTextParts(
  probe: PageProbe,
  golden: DecodedImage,
  variant: UiVariant,
): Promise<number> {
  const parts = variant.screen.nonTextParts;
  const boxesPerPart = await probe.measureParts(parts.map(({ selector }) => selector));
  let failing = 0;
  parts.forEach(({ selector, kind }, index) => {
    const boxes = boxesPerPart[index]!;
    if (boxes.length === 0) {
      throw new Error(
        `The non-text selector "${selector}" of the screen ${variant.screen.name} matches nothing visible. Fix nonTextParts in scripts/ui-screens.ts.`,
      );
    }
    for (const box of boxes) {
      if (!checkNonTextPart(golden, box, kind, METRICS_SCALE).passes) failing += 1;
    }
  });
  return failing;
}

/** How long each kind of work took on one page, in seconds. */
export interface PageTimings {
  readonly contrast: number;
  readonly focus: number;
  readonly other: number;
}

/** What `measurePage` returns. */
export interface PageMeasurement {
  /** Metric keys (`<theme>/<screen>/<metric>`, and the theme's tokens and the run's own keys on the pages that measure them) to numbers. */
  readonly values: MetricValues;
  readonly timings: PageTimings;
}

/** The theme whose first screen also measures what does not depend on the theme: the glyphs. */
const FIRST_THEME = ALL_THEMES[0];

/** Returns whether `variant` is the first screen of its theme, which also measures the theme's tokens. */
function isFirstScreen(variant: UiVariant): boolean {
  return variant.screen === UI_SCREENS[0];
}

/**
 * Measures the ready page of `variant` and returns all its metrics, with the
 * keys `<theme>/<screen>/<metric>`. The page is measured in this order, and
 * each change is undone before the next:
 *
 * 1. the golden screenshot, written to `<outputDir>/<theme>/<screen>.png`;
 * 2. the contrast of the text at glass 40 and at glass 0;
 * 3. the type, shape and spacing values;
 * 4. the click targets and their focus rings;
 * 5. the borders and marks of the controls;
 * 6. the prose measure (only on the long thread);
 * 7. how the text survives a narrow window, the spacing of WCAG 1.4.12 and
 *    the largest Text size.
 *
 * The prose is read before the window shrinks, because a narrow window can
 * leave the scroll positions of a long transcript changed. The narrow window
 * comes before the other two changes of the text, because the thread screens
 * do not always return to their first layout once the text size or spacing is
 * removed, and the narrow window then measured one of two layouts at random.
 *
 * On the first screen of a theme it adds the theme's token metrics
 * (`<theme>/tokens/...`), and on the first screen of the first theme the
 * glyph metrics (`run/...`). Fails when the screenshot is blank or the wrong
 * size, or when a probe call fails.
 */
export async function measurePage(
  page: Page,
  variant: UiVariant,
  outputDir: string,
): Promise<PageMeasurement> {
  const probe = bindProbe(page);
  const prefix = `${variant.theme}/${variant.screen.name}/`;
  const dark = isDarkTheme(variant.theme);
  const values: MetricValues = {};
  const add = (metrics: MetricValues, suffix = ""): void => {
    for (const [name, value] of Object.entries(metrics)) {
      values[`${prefix}${name}${suffix}`] = value;
    }
  };
  const timings = { contrast: 0, focus: 0, other: 0 };
  const startedAt = performance.now();
  let mark = startedAt;
  const lap = (kind: keyof PageTimings): void => {
    const now = performance.now();
    timings[kind] += (now - mark) / 1000;
    mark = now;
  };

  const { png } = await screenshotVariant(page, variant);
  await writeFile(join(outputDir, variant.theme, `${variant.screen.name}.png`), png);
  const golden: DecodedImage = PNG.sync.read(png);
  lap("other");

  const measured = await measureTextContrast(page, probe);
  add(summarizeContrast(measured, dark));
  add(summarizeText(measured));
  await probe.setGlass(SOLID_GLASS_PERCENT);
  await waitForPageToSettle(page);
  add(summarizeContrast(await measureTextContrast(page, probe), dark), "@glass0");
  await probe.setGlass(DEFAULT_GLASS_PERCENT);
  await waitForPageToSettle(page);
  lap("contrast");

  add(summarizeDiscipline(await probe.collectDiscipline()));
  lap("other");

  const targets = await probe.collectTargets();
  add(summarizeTargets(targets));
  lap("other");
  add({ "focus.missing": await countTargetsWithoutFocusRing(page, probe, golden, targets) });
  lap("focus");

  add({ "nonText.failing": await countFailingNonTextParts(probe, golden, variant) });

  if (variant.screen.name === "thread-long") {
    add(summarizeProse(await probe.measureProse()));
  }

  add(summarizeResilience("rest", await measureSettledClipping(page, probe)));
  await page.setViewportSize(REFLOW_WINDOW);
  add(summarizeResilience("reflow", await measureSettledClipping(page, probe)));
  await page.setViewportSize(WINDOW_SIZE);
  await waitForPageToSettle(page);
  for (const [perturbation, prefixName] of [
    ["text-spacing", "textSpacing"],
    ["largest-text-size", "textSize"],
  ] as const) {
    await probe.applyPerturbation(perturbation);
    add(summarizeResilience(prefixName, await measureSettledClipping(page, probe)));
    await probe.removePerturbation();
  }

  if (isFirstScreen(variant)) {
    for (const [name, value] of Object.entries(summarizeTokens(await probe.resolveThemeTokens()))) {
      values[`${variant.theme}/tokens/${name}`] = value;
    }
    if (variant.theme === FIRST_THEME) {
      const glyphs = summarizeGlyphs(await probe.measureGlyphPairs());
      for (const [name, value] of Object.entries(glyphs)) values[`run/${name}`] = value;
    }
  }
  lap("other");
  return { values, timings };
}
