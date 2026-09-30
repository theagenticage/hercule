/**
 * Tests the thread's composer in the packaged app, signed in to a real
 * controller whose threads run on a scripted runner (spec 17 §Slices,
 * slice 6):
 *
 * - a message sent to an idle thread opens a turn, and the field empties;
 * - while a turn runs, Stop stands where Send stands, ⏎ queues a message,
 *   and Stop ends the turn;
 * - the options and model menus open above their triggers, one at a time,
 *   and Esc closes them without touching the typed text;
 * - a picked model and option show at once and go with the next message;
 * - a thread keeps its unsent text and picks while the user looks at
 *   another thread;
 * - the composer shrinks while the transcript is scrolled up, `dock-mini`
 *   answers a Request without expanding it, and a click on the field
 *   expands it again;
 * - the field grows with its text up to eight lines, then scrolls.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Locator, Page } from "playwright";
import { describe, expect, it } from "vitest";
import { arrangeFleet, keepWindowOnTop, openSignedIn, openThread } from "./harness";

/** The parts of the open thread's composer that a test reads or clicks. */
interface Composer {
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
function locateComposer(page: Page): Composer {
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
interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
}

/** Returns where the element `locator` finds is drawn. */
function readBox(locator: Locator): Promise<Box> {
  return locator.evaluate((element) => {
    const { top, bottom, left, right, width, height } = element.getBoundingClientRect();
    return { top, bottom, left, right, width, height };
  });
}

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

describe("the composer", () => {
  it("sends a message to an idle thread, which opens a turn, and empties the field", async () => {
    const { url, fleet, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "Why does the checkout test fail?" },
      [
        { kind: "message", text: "The fetch resolves after the timeout." },
        { kind: "end", state: "completed" },
      ],
    );
    await played;
    await waitForStatus(thread.id, "idle");
    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await openThread(page, "Why does the checkout test fail?");
    const composer = locateComposer(page);

    await composer.field.fill("Add a retry");
    await composer.field.press("Enter");

    await page.locator(".msg--me .bubble", { hasText: "Add a retry" }).waitFor();
    expect(await composer.field.inputValue()).toBe("");
    await fleet.waitForTurn(thread.id, 2, "running");
  });

  it("draws Stop in Send's place while a turn runs, queues a message sent with ⏎, and stops the turn", async () => {
    const { url, fleet, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "Why does the checkout test fail?" },
      [{ kind: "end", state: "completed" }],
    );
    await played;
    await waitForStatus(thread.id, "idle");
    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await openThread(page, "Why does the checkout test fail?");
    const composer = locateComposer(page);
    const sendBox = await readBox(composer.send);

    await composer.field.fill("Add a retry");
    await composer.field.press("Enter");
    await composer.stop.waitFor();
    expect(await composer.send.count()).toBe(0);
    expect(await readBox(composer.stop)).toEqual(sendBox);
    expect(await composer.field.getAttribute("placeholder")).toBe(
      "Queued until the turn finishes…",
    );

    const queuedText = "Also check the refund flow";
    await composer.field.fill(queuedText);
    await composer.field.press("Enter");
    const queued = page.locator(".queued", { hasText: queuedText });
    await queued.waitFor();
    expect(await queued.locator(".faint").textContent()).toBe("queued · runs next");
    expect(await composer.field.inputValue()).toBe("");

    await composer.stop.click();
    await fleet.waitForTurn(thread.id, 2, "interrupted");
    const transcript = page.locator('section[aria-label="Transcript"]');
    await transcript.locator(".worked", { hasText: /^Stopped after \d+s$/ }).waitFor();
    // The queued message runs next, as the next turn.
    await transcript.locator(".msg--me .bubble", { hasText: queuedText }).waitFor();
    await queued.waitFor({ state: "detached" });
    await fleet.waitForTurn(thread.id, 3, "running");
  });

  it("opens the options and model menus above their triggers, one at a time, closes them on Esc, and keeps the typed text", async () => {
    const { url, fleet } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    await fleet.spawnThreads(1, { runner });
    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await openThread(page, "Thread 1");
    const composer = locateComposer(page);
    await composer.field.fill("Half a thought");

    expect(await composer.optionsTrigger.textContent()).toBe("Medium");
    await composer.optionsTrigger.click();
    // The trigger follows the menu's toggle event, which the browser sends
    // just after it shows or hides the menu.
    await expect.poll(() => composer.optionsTrigger.getAttribute("aria-expanded")).toBe("true");
    // The options menu grows to the right: its left edge is its trigger's.
    const optionsTrigger = await readBox(composer.optionsTrigger);
    const optionsMenu = await readBox(composer.optionsMenu);
    expect(optionsMenu.bottom).toBeCloseTo(optionsTrigger.top - 6, 1);
    expect(optionsMenu.left).toBeCloseTo(optionsTrigger.left, 1);
    expect(optionsMenu.width).toBe(320);
    await page.keyboard.press("Escape");
    await composer.optionsMenu.waitFor({ state: "hidden" });
    await expect.poll(() => composer.optionsTrigger.getAttribute("aria-expanded")).toBe("false");

    expect(await composer.modelPill.textContent()).toBe("Scripted");
    await composer.modelPill.click();
    await expect.poll(() => composer.modelPill.getAttribute("aria-expanded")).toBe("true");
    // The model menu grows to the left: its right edge is the pill's.
    const pill = await readBox(composer.modelPill);
    const modelMenu = await readBox(composer.modelMenu);
    expect(modelMenu.bottom).toBeCloseTo(pill.top - 6, 1);
    expect(modelMenu.right).toBeCloseTo(pill.right, 1);
    expect(modelMenu.width).toBe(360);

    // Opening one menu closes the other.
    await composer.optionsTrigger.click();
    await composer.optionsMenu.waitFor();
    await composer.modelMenu.waitFor({ state: "hidden" });
    await expect.poll(() => composer.modelPill.getAttribute("aria-expanded")).toBe("false");
    await page.keyboard.press("Escape");
    await composer.optionsMenu.waitFor({ state: "hidden" });

    expect(await composer.field.inputValue()).toBe("Half a thought");
  });

  it("shows a picked model and option at once, and sends them with the next message", async () => {
    const { url, fleet, client, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "Why does the checkout test fail?" },
      [{ kind: "end", state: "completed" }],
    );
    await played;
    await waitForStatus(thread.id, "idle");
    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await openThread(page, "Why does the checkout test fail?");
    const composer = locateComposer(page);
    expect(await composer.note.textContent()).toBe("");

    await composer.modelPill.click();
    await composer.modelMenu.getByRole("button", { name: "Scripted Large", exact: true }).click();
    await composer.modelMenu.waitFor({ state: "hidden" });
    expect(await composer.modelPill.textContent()).toBe("Scripted Large");
    expect(await composer.note.textContent()).toBe("model change applies on send");

    await composer.optionsTrigger.click();
    const effort = composer.optionsMenu.getByRole("group", { name: "Reasoning effort" });
    await effort.getByRole("button", { name: "High" }).click();
    // A pick keeps the options menu open.
    expect(await effort.getByRole("button", { name: "High" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(await composer.optionsTrigger.textContent()).toBe("High");
    await page.keyboard.press("Escape");
    await composer.optionsMenu.waitFor({ state: "hidden" });

    const sent = page.waitForRequest(
      (request) =>
        request.url().endsWith(`/api/v1/sessions/${thread.id}/input`) &&
        request.method() === "POST",
    );
    await composer.field.fill("Think harder");
    await composer.field.press("Enter");
    expect((await sent).postDataJSON()).toEqual({
      text: "Think harder",
      model: "scripted-large",
      options: { effort: "high" },
    });
    await expect
      .poll(async () => (await client.session.read({ params: { id: thread.id } })).modelSelection)
      .toEqual({ model: "scripted-large", options: { effort: "high" } });
    await expect.poll(() => composer.note.textContent()).toBe("");
    expect(await composer.modelPill.textContent()).toBe("Scripted Large");
    expect(await composer.optionsTrigger.textContent()).toBe("High");
  });

  it("keeps a thread's unsent text and picks while another thread is open", async () => {
    const { url, fleet } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    await fleet.spawnThreads(2, { runner });
    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await openThread(page, "Thread 1");
    const composer = locateComposer(page);
    await composer.field.fill("Half a thought");
    await composer.modelPill.click();
    await composer.modelMenu.getByRole("button", { name: "Scripted Large", exact: true }).click();
    await composer.modelMenu.waitFor({ state: "hidden" });

    await openThread(page, "Thread 2");
    await expect.poll(() => composer.field.inputValue()).toBe("");
    expect(await composer.modelPill.textContent()).toBe("Scripted");
    expect(await composer.note.textContent()).toBe("");

    await openThread(page, "Thread 1");
    await expect.poll(() => composer.field.inputValue()).toBe("Half a thought");
    expect(await composer.modelPill.textContent()).toBe("Scripted Large");
    expect(await composer.note.textContent()).toBe("model change applies on send");
  });

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
      .poll(async () => (await client.session.read({ params: { id: thread.id } })).openRequest)
      .toBeNull();
    await mini.waitFor({ state: "detached" });
    expect(await composer.root.getAttribute("class")).toBe("composer is-scrolled");
    await played;

    await composer.field.click();
    await expect.poll(() => composer.root.getAttribute("class")).toBe("composer");
    expect(await composer.field.evaluate((field) => field === document.activeElement)).toBe(true);
    await expect.poll(() => readDistanceFromBottom(page)).toBeLessThan(1);
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
      await field.fill(buildLines(lines));
      heights[lines] = (await readFieldSize(field)).clientHeight;
    }
    expect(heights).toEqual({ 1: 44, 2: 52, 3: 73, 8: 178, 9: 178, 12: 178 });
    await field.fill(buildLines(8));
    const eight = await readFieldSize(field);
    expect(eight.scrollHeight).toBe(eight.clientHeight);
    await field.fill(buildLines(9));
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
});
