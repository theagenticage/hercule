/**
 * Tests what a thread view shows as things happen while it is open, in the
 * packaged app, signed in to a real controller whose threads scripted
 * runners fill with turns and Requests (spec 17, §Design system, **The
 * thread**):
 *
 * - a Request shows the dock and the waiting note, and Allow resolves it;
 * - a queued input shows above the composer, and Cancel removes it;
 * - a window hidden and shown again while a message streams ends with the
 *   whole message, no word doubled or skipped.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  arrangeFleet,
  buildCountedMessage,
  buildLiveCheck,
  countStoredTextRows,
  joinShownText,
  launchPlainAppForTest,
  openSignedIn,
  openThread,
  READ_AGENT_TEXTS,
  READ_LAST_AGENT_TEXT,
  readWordNumbers,
  recordFrames,
  recordLastAgentText,
  WINDOW_VISIBILITY_TIMEOUT_MS,
  type AgentTextSnapshot,
} from "./harness";
import { TRANSCRIPT_SELECTOR } from "./thread-helpers";

describe("the thread view, while the thread is live", () => {
  it("shows the dock and the waiting note while a Request is open, and Allow resolves it", async () => {
    const { url, fleet, client, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const [thread] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(thread!.id, "busy");
    const { page } = await openSignedIn(url);
    await openThread(page, "Thread 1");

    const played = runner.playScript(thread!.id, [
      { kind: "command", command: "pnpm test", ask: true },
      { kind: "end", state: "completed" },
    ]);
    const dock = page.getByRole("group", { name: "Run this command?" });
    await dock.waitFor();
    expect(await dock.locator("code").textContent()).toBe("pnpm test");
    const waitingNote = page.locator('section[aria-label="Transcript"] .waiting-note');
    expect(await waitingNote.textContent()).toMatch(/^Waiting on you since \d\d:\d\d · /);

    await dock.getByRole("button", { name: "Allow", exact: true }).click();
    await dock.waitFor({ state: "detached" });
    await waitingNote.waitFor({ state: "detached" });
    await played;
    await fleet.waitForTurn(thread!.id, 1, "completed");
    expect((await client.session.read({ params: { id: thread!.id } })).openRequests).toEqual([]);
  });

  it("shows a queued input above the composer, and Cancel removes it", async () => {
    const { url, fleet, client, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const [thread] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(thread!.id, "busy");
    const { page } = await openSignedIn(url);
    await openThread(page, "Thread 1");

    const text = "Also check the refund flow";
    const { inputId, result } = await client.session.input({
      params: { id: thread!.id },
      payload: { text },
    });
    expect(result).toBe("queued");
    const row = page.locator(".queued", { hasText: text });
    await row.waitFor();
    expect(await row.locator(".faint").textContent()).toBe("queued · runs next");

    await row.getByRole("button", { name: "Cancel" }).click();
    await row.waitFor({ state: "detached" });
    const inputs = await client.input.query({ params: { id: thread!.id }, query: {} });
    expect(inputs.items.find((input) => input.id === inputId)?.status).toBe("cancelled");
  });

  it("ends with the whole message, no word doubled or skipped, when the window is hidden and shown while it streams", async () => {
    const { url, fleet, client } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    // The message pauses until the window is hidden and until it is shown
    // again; see buildCountedMessage.
    const message = buildCountedMessage();
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "Count to three thousand" },
      [
        { kind: "command", command: "pnpm test", ask: true },
        message.step,
        { kind: "end", state: "completed" },
      ],
    );
    await fleet.waitForTurn(thread.id, 1, "waiting");

    // Playwright's focus emulation keeps a hidden page "visible", and the tap
    // is unsubscribed and the rows are kept aside only on a real hide. This
    // test starts the app as a plain process instead.
    const { evaluateInPage, callWindowMethod } = await launchPlainAppForTest(url, "top-right");
    const readVisibility = () => evaluateInPage("document.visibilityState");
    const readLastSnapshot = () =>
      evaluateInPage(READ_LAST_AGENT_TEXT) as Promise<AgentTextSnapshot | undefined>;

    // The thread waits on a Request, so it has a row in Waiting on you as
    // well as its own.
    const threadRow = `document.querySelector("a.side-row:not(.side-row--wait)")`;
    await expect
      .poll(() => evaluateInPage(`${threadRow} !== null`), { timeout: 10_000 })
      .toBe(true);
    // A window that another window covers also reads as hidden; see
    // keepWindowOnTop.
    await callWindowMethod("setAlwaysOnTop", true);
    await expect.poll(readVisibility, { timeout: 10_000 }).toBe("visible");
    await evaluateInPage(`(${recordFrames.toString()})()`);
    await evaluateInPage(`${threadRow}.click()`);
    await expect
      .poll(() => evaluateInPage(buildLiveCheck(thread.id)), { timeout: 10_000 })
      .toBe(true);
    await evaluateInPage(
      `(${recordLastAgentText.toString()})(${JSON.stringify(TRANSCRIPT_SELECTOR)})`,
    );

    const [openRequest] = (await client.session.read({ params: { id: thread.id } })).openRequests;
    await client.session.respondToApprovalRequest({
      params: { id: thread.id },
      payload: { requestId: openRequest!.requestId, decision: "allow" },
    });
    await expect.poll(async () => (await readLastSnapshot())?.openParagraph ?? "").not.toBe("");

    await callWindowMethod("hide");
    await expect.poll(readVisibility, { timeout: WINDOW_VISIBILITY_TIMEOUT_MS }).toBe("hidden");
    const shownWhenHidden = joinShownText((await readLastSnapshot())!);
    const rowsWhenHidden = await countStoredTextRows(client, thread.id);
    message.resumeAfterHide();
    await expect
      .poll(() => countStoredTextRows(client, thread.id), { timeout: 10_000 })
      .toBeGreaterThan(rowsWhenHidden);
    // The page still receives the stored rows while it is hidden, but keeps
    // them aside instead of drawing them. A hidden page runs its timers at
    // most once a second, so a page that drew them anyway would show them
    // within that time. Wait a little longer before checking that it shows
    // nothing new.
    await sleep(2_000);
    expect(joinShownText((await readLastSnapshot())!)).toBe(shownWhenHidden);

    await callWindowMethod("show");
    await expect.poll(readVisibility, { timeout: WINDOW_VISIBILITY_TIMEOUT_MS }).toBe("visible");
    // The rows kept aside while the window was hidden are drawn together.
    await expect
      .poll(async () => joinShownText((await readLastSnapshot())!).length, { timeout: 10_000 })
      .toBeGreaterThan(shownWhenHidden.length);
    // The message is paused, so it is still being written.
    expect((await readLastSnapshot())!.openParagraph).not.toBeNull();
    message.resumeAfterShow();

    await played;
    await fleet.waitForTurn(thread.id, 1, "completed");
    await expect.poll(async () => (await readLastSnapshot())!.openParagraph).toBeNull();
    const snapshots = (await evaluateInPage(READ_AGENT_TEXTS)) as AgentTextSnapshot[];
    const broken = snapshots
      .map(readWordNumbers)
      .find((numbers) => numbers.some((number, index) => number !== index + 1));
    expect(broken, "a snapshot doubled or skipped a word").toBeUndefined();
    expect(readWordNumbers(snapshots.at(-1)!).length).toBe(message.wordCount);
  });
});
