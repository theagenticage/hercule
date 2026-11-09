/**
 * Tests the thread's composer in the packaged app, signed in to a real
 * controller whose threads run on a scripted runner (spec 17, §Design
 * system, **The thread**). `composer-field.test.ts` tests the rest of it:
 *
 * - a message sent to an idle thread opens a turn, and the field empties;
 * - while a turn runs, Stop stands where Send stands, ⏎ queues a message,
 *   and Stop ends the turn;
 * - the options and model menus open above their triggers, one at a time,
 *   and Esc closes them without touching the typed text;
 * - a picked model and option show at once and go with the next message;
 * - a thread keeps its unsent text and picks while the user looks at
 *   another thread;
 * - a picked PNG is sent with the message, and the sent bubble draws it,
 *   decoded by Chromium itself.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { describe, expect, it } from "vitest";
import {
  arrangeFleet,
  keepWindowOnTop,
  openSignedIn,
  openThread,
  readFieldPlaceholder,
  readFieldText,
} from "./harness";
import { locateComposer, readBox } from "./composer-helpers";

/**
 * A real PNG, 4 × 3 pixels of one colour, that Chromium decodes. The unit
 * tests run in jsdom, which decodes no image, so only this suite proves that
 * a sent image's thumbnail is built and drawn.
 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGOwybsERww4OQBUhhHRUMjhlgAAAABJRU5ErkJggg==",
  "base64",
);

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
    expect(await readFieldText(composer.field)).toBe("");
    await fleet.waitForTurn(thread.id, 2, "running");
  });

  it("sends a picked PNG with the message, and the sent bubble draws it", async () => {
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

    const uploaded = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/attachments" &&
        response.request().method() === "POST",
    );
    await page
      .locator('.composer input[type="file"]')
      .setInputFiles({ name: "screen.png", mimeType: "image/png", buffer: PNG });
    expect((await uploaded).status()).toBe(201);
    await page.locator(".shelf-strip").waitFor({ state: "detached" });
    await composer.field.fill("What is on this screen?");
    await composer.field.press("Enter");

    const sent = page.locator(".msg--me", { hasText: "What is on this screen?" });
    await sent.getByRole("button", { name: "Preview screen.png" }).waitFor();
    await expect
      .poll(() =>
        sent.locator(".image-tile img").evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
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
    expect(await readFieldPlaceholder(composer.field)).toBe("Queued until the turn finishes…");

    const queuedText = "Also check the refund flow";
    await composer.field.fill(queuedText);
    await composer.field.press("Enter");
    const queued = page.locator(".queued", { hasText: queuedText });
    await queued.waitFor();
    expect(await queued.locator(".faint").textContent()).toBe("queued · runs next");
    expect(await readFieldText(composer.field)).toBe("");

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

    expect(await readFieldText(composer.field)).toBe("Half a thought");
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
    await expect.poll(() => readFieldText(composer.field)).toBe("");
    expect(await composer.modelPill.textContent()).toBe("Scripted");
    expect(await composer.note.textContent()).toBe("");

    await openThread(page, "Thread 1");
    await expect.poll(() => readFieldText(composer.field)).toBe("Half a thought");
    expect(await composer.modelPill.textContent()).toBe("Scripted Large");
    expect(await composer.note.textContent()).toBe("model change applies on send");
  });
});
