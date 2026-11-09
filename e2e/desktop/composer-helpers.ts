/**
 * What the composer's end-to-end files share (`composer.test.ts` and
 * `composer-field.test.ts`): arranging a thread with a composer and reading it.
 */
import type { Locator, Page } from "playwright";

/** The parts of the open thread's composer that a test reads or clicks. */
export interface Composer {
  /** The composer itself, whose class says whether it is shrunk. */
  readonly root: Locator;
  readonly field: Locator;
  readonly send: Locator;
  readonly stop: Locator;
  /** The button that opens the model options menu. Its text is the effort, such as "Medium". */
  readonly optionsTrigger: Locator;
  /** The model pill, the button that opens the model menu. */
  readonly modelPill: Locator;
  readonly optionsMenu: Locator;
  readonly modelMenu: Locator;
  /** The note that a picked model applies on send. It is empty while no model is picked. */
  readonly note: Locator;
}

/**
 * Returns the parts of the open thread's composer. The two triggers are found
 * by their place in the row, because their names are what they show, and
 * that changes with a pick.
 */
export function locateComposer(page: Page): Composer {
  return {
    root: page.locator(".composer"),
    field: page.getByRole("textbox", { name: "Message" }),
    send: page.getByRole("button", { name: "Send", exact: true }),
    stop: page.getByRole("button", { name: "Stop", exact: true }),
    optionsTrigger: page.locator(".composer-row button.pick:not(.pick--pill)"),
    modelPill: page.locator(".composer-row button.pick--pill"),
    optionsMenu: page.getByRole("dialog", { name: "Model options", exact: true }),
    modelMenu: page.getByRole("dialog", { name: "Model", exact: true }),
    note: page.locator(".composer-note"),
  };
}

/** Where an element is drawn, in CSS pixels from the window's top left corner. */
export interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
}

/** Returns where the element `locator` finds is drawn. */
export function readBox(locator: Locator): Promise<Box> {
  return locator.evaluate((element) => {
    const { top, bottom, left, right, width, height } = element.getBoundingClientRect();
    return { top, bottom, left, right, width, height };
  });
}
