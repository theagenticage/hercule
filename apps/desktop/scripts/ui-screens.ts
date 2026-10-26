/**
 * The fixed list of desktop screens `pnpm capture:ui` captures, and the
 * variants of each: theme, scale and glass. Each screen is a specimen page
 * (src/renderer/specimens) that draws the app's own components from fixtures.
 *
 * Runs on plain Node by stripping types, so it uses only syntax that
 * stripping can erase: no enums, namespaces or parameter properties.
 */
import { NIGHT_THEMES } from "../src/ipc/appearance.ts";
import { ALL_THEMES } from "../src/renderer/specimens/sheet-themes.ts";

/** One screen of the app, as a specimen page draws it. */
export interface UiScreen {
  /** The name the screen's captures carry, such as `thread-long`. */
  readonly name: string;
  /** The specimen page, relative to the specimens' address, with the screen's own query. */
  readonly path: string;
  /**
   * A CSS selector of content that is visible once the screen has rendered.
   * Meaningful content, not `#root`, which exists before React draws anything.
   */
  readonly contentSelector: string;
  /**
   * The parts of the screen that WCAG 1.4.11 asks to stand out, as CSS
   * selectors of the elements themselves: a `boundary` is the edge of a
   * control (an input, a select, the composer, a segmented control), and a
   * `mark` is a symbol that carries meaning (a state dot, a check mark, an icon).
   * A mark's selector points at the mark, not at a row that holds a label,
   * because the whole box of the element is measured. Every selector must
   * match something visible on the screen.
   */
  readonly nonTextParts: ReadonlyArray<NonTextPart>;
}

/** One part of a screen whose contrast with its surroundings is measured. See `UiScreen.nonTextParts`. */
export interface NonTextPart {
  readonly selector: string;
  readonly kind: "boundary" | "mark";
}

/** The glass levels captured: the default of 40 %, and 0 % (Reduce transparency). */
export const GLASS_PERCENTS = [40, 0] as const;

/** The device pixel ratios captured: 1x is the main capture, 2x is a Retina display. */
export const SCALES = [1, 2] as const;

/** The size of the window in CSS pixels, as in the Electron captures. */
export const WINDOW_SIZE = { width: 1440, height: 900 } as const;

/** One capture to take: a screen in a theme, at a scale, with a glass level. */
export interface UiVariant {
  readonly screen: UiScreen;
  readonly theme: string;
  readonly scale: (typeof SCALES)[number];
  readonly glassPercent: (typeof GLASS_PERCENTS)[number];
}

/** Every screen `capture:ui` captures, in the order of the contact sheets' rows. */
export const UI_SCREENS: ReadonlyArray<UiScreen> = [
  {
    name: "sidebar",
    path: "sidebar.html",
    contentSelector: "aside.side a.side-row",
    nonTextParts: [
      { selector: "aside.side .seg--side", kind: "boundary" },
      { selector: "aside.side .icon-btn svg", kind: "mark" },
      { selector: "aside.side .side-detail--ask .side-glyph", kind: "mark" },
    ],
  },
  {
    name: "thread",
    path: "thread.html",
    contentSelector: 'section.transcript[aria-label="Transcript"] .tx > *',
    nonTextParts: [
      { selector: ".composer-card", kind: "boundary" },
      { selector: "header.top .icon-btn svg", kind: "mark" },
      { selector: ".composer-row .icon-btn svg", kind: "mark" },
      { selector: ".thread-tabs .mark", kind: "mark" },
      { selector: ".waiting-note .mark", kind: "mark" },
      { selector: "aside.side .side-dot", kind: "mark" },
    ],
  },
  {
    name: "thread-long",
    path: "thread.html?state=long",
    contentSelector: 'section.transcript[aria-label="Transcript"] .tx > *',
    nonTextParts: [
      { selector: ".composer-card", kind: "boundary" },
      { selector: "header.top .icon-btn svg", kind: "mark" },
      { selector: ".composer-row .icon-btn svg", kind: "mark" },
      { selector: ".thread-tabs .mark", kind: "mark" },
    ],
  },
  {
    name: "draft",
    path: "draft.html",
    contentSelector: ".hello .column > *",
    nonTextParts: [
      { selector: ".composer-card", kind: "boundary" },
      { selector: "header.top .icon-btn svg", kind: "mark" },
      { selector: ".composer-row .icon-btn svg", kind: "mark" },
    ],
  },
  {
    name: "conversation",
    path: "conversation.html",
    contentSelector: 'section.transcript[aria-label="Conversation"] .atx > *',
    nonTextParts: [
      { selector: ".composer-card", kind: "boundary" },
      { selector: ".composer-row .icon-btn svg", kind: "mark" },
    ],
  },
  {
    name: "intake",
    path: "intake.html",
    contentSelector: 'section.asks-detail[aria-label="The open signal"] > *',
    nonTextParts: [
      { selector: ".asks-modes", kind: "boundary" },
      { selector: ".ask-box", kind: "boundary" },
      { selector: ".asks-sec .dot", kind: "mark" },
      { selector: ".ask-mark:not(.ask-mark--face) svg", kind: "mark" },
      { selector: ".ask-act svg", kind: "mark" },
      { selector: ".asks-pane-btn svg", kind: "mark" },
      { selector: ".b-change-checks .mark", kind: "mark" },
    ],
  },
  {
    name: "tracking-pane",
    path: "intake.html?scene=tracking-pane-needs-you",
    contentSelector: 'section.asks-detail[aria-label="The open Tracking row"] > *',
    nonTextParts: [
      { selector: ".asks-modes", kind: "boundary" },
      { selector: ".ask-act svg", kind: "mark" },
      { selector: ".tr-sec .mark", kind: "mark" },
      { selector: ".tr-wait .mark", kind: "mark" },
      { selector: ".tr-steps .mark", kind: "mark" },
      { selector: ".tr-ask-q .mark", kind: "mark" },
    ],
  },
  {
    name: "workflows",
    path: "workflows.html",
    contentSelector: 'nav[aria-label="Workflows"] .virtual-list-items > *',
    nonTextParts: [
      { selector: "label.find", kind: "boundary" },
      { selector: ".table-mark .mark", kind: "mark" },
    ],
  },
  {
    name: "run",
    path: "run.html",
    contentSelector: "section.run-page h1.run-state",
    nonTextParts: [
      { selector: ".tab-tools .seg", kind: "boundary" },
      { selector: "button.node", kind: "boundary" },
      { selector: ".run-state .mark", kind: "mark" },
      { selector: ".node-mark .mark", kind: "mark" },
      { selector: ".zoom .icon-btn svg", kind: "mark" },
    ],
  },
  {
    name: "discussions",
    path: "discussions.html",
    contentSelector: 'nav[aria-label="Discussion list"] .virtual-list-items > *',
    nonTextParts: [{ selector: ".overlap-mark svg", kind: "mark" }],
  },
  {
    name: "wiki",
    path: "wiki.html",
    contentSelector: 'nav[aria-label="Wiki page list"] .virtual-list-items > *',
    nonTextParts: [],
  },
  {
    name: "settings-appearance",
    path: "settings-appearance.html",
    contentSelector: ".set-body .set-sec",
    nonTextParts: [
      { selector: ".tp-art", kind: "boundary" },
      { selector: ".field--select", kind: "boundary" },
      { selector: ".toggle", kind: "boundary" },
      { selector: ".gd-pill .mark", kind: "mark" },
      { selector: ".side-sec .dot", kind: "mark" },
    ],
  },
];

/**
 * Returns every variant of `screens`: each screen in all five themes, at
 * every scale, with every glass level. Ordered by theme, then screen, then
 * scale, then glass, so the order is the same on every run.
 */
export function listUiVariants(screens: ReadonlyArray<UiScreen> = UI_SCREENS): UiVariant[] {
  return ALL_THEMES.flatMap((theme) =>
    screens.flatMap((screen) =>
      SCALES.flatMap((scale) =>
        GLASS_PERCENTS.map((glassPercent) => ({ screen, theme, scale, glassPercent })),
      ),
    ),
  );
}

/** Returns whether `theme` is a dark theme, which a Mac in dark appearance shows. */
export function isDarkTheme(theme: string): boolean {
  return (NIGHT_THEMES as ReadonlyArray<string>).includes(theme);
}

/**
 * Returns the address of the variant's page: the screen's specimen page
 * under `specimensUrl`, with `theme` and `glass` merged into the screen's own
 * query.
 */
export function buildVariantUrl(specimensUrl: string, variant: UiVariant): string {
  const url = new URL(variant.screen.path, specimensUrl);
  url.searchParams.set("theme", variant.theme);
  url.searchParams.set("glass", String(variant.glassPercent));
  return url.href;
}

/** Returns the variant's name for messages, such as `thread-long, orient-express, 2x, glass 0`. */
export function describeVariant(variant: UiVariant): string {
  return `${variant.screen.name}, ${variant.theme}, ${String(variant.scale)}x, glass ${String(variant.glassPercent)}`;
}
