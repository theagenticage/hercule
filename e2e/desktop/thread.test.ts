/**
 * Tests the thread view in the packaged app, signed in to a real controller
 * whose threads scripted runners fill with turns, streamed text and Requests
 * (spec 17 §Slices, slice 5):
 *
 * - a thread opens from the sidebar, and its transcript shows its rows;
 * - a message streams into the tail before its row lands, then shows as
 *   markdown, below a divider that sums up the work before it;
 * - a Request shows the dock and the waiting note, and Allow resolves it;
 * - a queued input shows above the composer, and Cancel removes it;
 * - a window hidden and shown again while a message streams ends with the
 *   whole message, no word doubled or skipped;
 * - the app opens the last open thread again at launch.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { ElectronApplication, Page } from "playwright";
import { describe, expect, it, onTestFinished } from "vitest";
import { createClient, type HerculeClient } from "../../packages/client-core/src/index";
import type { Session } from "../../packages/contract/src/index";
import {
  evaluateInMain,
  launchPlainApp,
  signInOnce,
  stopApp,
  writeSettings,
} from "../../apps/desktop/scripts/packaged-app";
import type { ScriptedRunner } from "../../scripts/scripted-runner";
import { connectFleet, type Fleet } from "./fleet";
import {
  createUserDataDirForTest,
  launchForTest,
  launchWithSavedController,
  signInAndReadToken,
  startControllerForTest,
  type LaunchedApp,
} from "./harness";

/** A scratch controller, a fleet with one runner on it, and a client for reading it back. */
interface Arranged {
  readonly url: string;
  readonly fleet: Fleet;
  readonly runner: ScriptedRunner;
  readonly client: HerculeClient;
  /** Waits until the thread's status is `status`, read through the API. */
  readonly waitForStatus: (sessionId: string, status: Session["status"]) => Promise<void>;
}

/**
 * Starts a scratch controller that is set up, and enlists one scripted runner
 * on it. The controller is stopped and the runner disconnected when the test
 * ends.
 */
async function arrangeFleet(): Promise<Arranged> {
  const controller = await startControllerForTest({ setUp: true });
  const fleet = await connectFleet(controller.url);
  onTestFinished(fleet.disconnectRunners);
  const runner = await fleet.enlistRunner("studio");
  const client = createClient({ baseUrl: controller.url, token: fleet.token });
  return {
    url: controller.url,
    fleet,
    runner,
    client,
    waitForStatus: async (sessionId, status) => {
      await expect
        .poll(async () => (await client.session.read({ params: { id: sessionId } })).status)
        .toBe(status);
    },
  };
}

/**
 * Starts the app with the controller at `url` saved, signs in, and returns
 * the app once the sidebar's thread list is on screen.
 */
async function openSignedIn(url: string): Promise<LaunchedApp> {
  const launched = await launchWithSavedController(url);
  await signInAndReadToken(launched.page, url);
  await launched.page.getByRole("navigation", { name: "Threads" }).waitFor();
  return launched;
}

/**
 * Keeps the app's window above the windows of the tests that run in other
 * files at the same time. macOS draws no frames for a window that another
 * window covers, and the page writes the tail only when a frame is drawn, so
 * a covered window would stop streaming.
 */
async function keepWindowOnTop(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setAlwaysOnTop(true);
  });
}

/** Clicks the sidebar row of the thread titled `title`, and waits for its transcript. */
async function openThread(page: Page, title: string): Promise<void> {
  await page
    .getByRole("navigation", { name: "Threads" })
    .locator("a.side-row", { hasText: title })
    .first()
    .click();
  await page.locator('section[aria-label="Transcript"]').waitFor();
}

/** Returns the title of the thread the header shows as open. */
function readOpenTab(page: Page): Promise<string | null> {
  return page
    .locator('nav[aria-label="Threads in this workspace"] a[aria-current="page"] .ptab-title')
    .textContent();
}

/**
 * Returns every block the transcript has mounted, top to bottom, each as one
 * line of text:
 *
 * - a message the user sent: "you: Why does the test fail?";
 * - a message the agent wrote, without its meta line: "agent: Let me look.";
 * - a work stretch's divider, by its accessible name: "divider: Worked for
 *   2s, ran 2 commands";
 * - the end of a turn that did not complete: "ending: Stopped after 4s";
 * - the note that the thread waits: "waiting: Waiting on you since 09:31 · now".
 */
function readTranscript(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('section[aria-label="Transcript"] .tx-item')].map((item) => {
      const block = item.firstElementChild!;
      if (block.matches(".msg--me")) return `you: ${block.querySelector(".bubble")!.textContent}`;
      if (block.matches(".msg")) {
        const parts = [...block.querySelector(".msg-body")!.children].filter(
          (part) => !part.matches(".msg-meta"),
        );
        return `agent: ${parts.map((part) => part.textContent).join("")}`;
      }
      if (block.matches("button.worked")) return `divider: ${block.getAttribute("aria-label")}`;
      if (block.matches(".worked")) return `ending: ${block.textContent}`;
      if (block.matches(".waiting-note")) return `waiting: ${block.textContent}`;
      return `unknown: ${block.outerHTML}`;
    }),
  );
}

/** What the last agent message in the transcript showed at one moment. */
interface MessageSnapshot {
  /**
   * The text the message draws as markdown, as rendered: everything but its
   * meta line and the paragraph being written. While the message streams,
   * that is its finished paragraphs; once it is complete, all of its text.
   */
  readonly text: string;
  /** The paragraph being written, as plain text, or `null` once the message is complete. */
  readonly openParagraph: string | null;
}

/** Returns the text a snapshot shows: its markdown's text, then the paragraph being written. */
const readShownText = ({ text, openParagraph }: MessageSnapshot): string =>
  `${text}${openParagraph ?? ""}`;

/** The page's global object, with what the recorders below keep on it. */
type RecordingGlobal = typeof globalThis & {
  messageSnapshots?: MessageSnapshot[];
  sentFrames?: string[];
};

/**
 * Starts recording what the last agent message in the transcript shows, each
 * time the page changes it. The snapshots collect, oldest first, in
 * `messageSnapshots` on the page's global object; a change that leaves the
 * text and the paragraph being written as they were adds none.
 *
 * It runs in the page, handed over as source text, so it closes over nothing
 * in this file. A `MutationObserver` calls it after each change, once the
 * change's task is done, so it sees the page as a frame would draw it.
 */
function recordLastMessage(): void {
  const snapshots: MessageSnapshot[] = [];
  (globalThis as RecordingGlobal).messageSnapshots = snapshots;
  const transcript = document.querySelector('section[aria-label="Transcript"]')!;
  const takeSnapshot = () => {
    const body = [...transcript.querySelectorAll(".msg > .msg-body")].at(-1);
    if (body === undefined) return;
    const openParagraph = body.querySelector(".streaming")?.textContent ?? null;
    const text = [...body.children]
      .filter((part) => !part.matches(".msg-meta, .streaming"))
      .map((part) => part.textContent)
      .join("");
    const last = snapshots.at(-1);
    if (last?.text === text && last.openParagraph === openParagraph) return;
    snapshots.push({ text, openParagraph });
  };
  new MutationObserver(takeSnapshot).observe(transcript, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  takeSnapshot();
}

/**
 * Starts recording every frame the page sends on a WebSocket, as text, in
 * `sentFrames` on the page's global object. The live connection's socket
 * already exists; it sends through the prototype's `send`, so it is recorded
 * too. It runs in the page, like `recordLastMessage`.
 */
function recordSentFrames(): void {
  const frames: string[] = [];
  (globalThis as RecordingGlobal).sentFrames = frames;
  // The original `send` is kept apart from any socket, and called below with
  // each socket as `this`.
  const send = Reflect.get(WebSocket.prototype, "send");
  WebSocket.prototype.send = function (this: WebSocket, data) {
    frames.push(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer));
    send.call(this, data);
  };
}

/**
 * Returns a page expression that checks whether the page has sent the frame
 * that subscribes to the thread's tap. The controller does not acknowledge a
 * subscription, so the frame being sent is the closest a test can get to
 * knowing the tap is live. A test waits for it before a message streams: a
 * delta sent before the controller has the subscription reaches no one.
 */
function buildTapSubscribedCheck(sessionId: string): string {
  const topic = JSON.stringify(`session:${sessionId}:tap`);
  return `(globalThis.sentFrames ?? []).some((frame) => frame.includes(${topic}))`;
}

/** The first paragraph of `ANSWER`, as markdown and as the page renders it. */
const FIRST_PARAGRAPH = {
  markdown: "The checkout test fails because `fetchOrders` resolves after the timeout.",
  rendered: "The checkout test fails because fetchOrders resolves after the timeout.",
};

/** The second and last paragraph of `ANSWER`, as markdown and as the page renders it. */
const SECOND_PARAGRAPH = {
  markdown: "Adding a **retry** fixes it.",
  rendered: "Adding a retry fixes it.",
};

/** The answer the streaming test's agent writes, as markdown. */
const ANSWER = `${FIRST_PARAGRAPH.markdown}\n\n${SECOND_PARAGRAPH.markdown}`;

/**
 * `ANSWER` as the page renders it: the markdown's text, without its marks.
 * The transcript is read one element at a time, so nothing joins the two
 * paragraphs.
 */
const RENDERED_ANSWER = `${FIRST_PARAGRAPH.rendered}${SECOND_PARAGRAPH.rendered}`;

describe("the thread view", () => {
  it("opens a thread from the sidebar and shows its transcript", async () => {
    const { url, fleet, runner } = await arrangeFleet();
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "Why does the checkout test fail?" },
      [
        { kind: "message", text: "Let me look at the test first." },
        { kind: "command", command: "pnpm test" },
        { kind: "command", command: "git log -1" },
        { kind: "message", text: ANSWER },
        { kind: "end", state: "completed" },
      ],
    );
    await played;
    await fleet.waitForTurn(thread.id, 1, "completed");
    await fleet.spawnThreads(1, { runner });

    const { page } = await openSignedIn(url);
    await openThread(page, "Why does the checkout test fail?");

    await expect
      .poll(() => readTranscript(page))
      .toEqual([
        "you: Why does the checkout test fail?",
        "agent: Let me look at the test first.",
        expect.stringMatching(/^divider: Worked for \d+s, ran 2 commands$/),
        `agent: ${RENDERED_ANSWER}`,
      ]);
    const answer = page.locator('section[aria-label="Transcript"] .msg-body').last();
    expect(await answer.locator("code").textContent()).toBe("fetchOrders");
    expect(await answer.locator("strong").textContent()).toBe("retry");
    expect(await readOpenTab(page)).toBe("Why does the checkout test fail?");
  });

  it("streams a message, drawing each paragraph as markdown once it is finished", async () => {
    const { url, fleet, runner, client } = await arrangeFleet();
    // The script waits on a Request until the thread is open, so the whole
    // message streams while the page listens.
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "Why does the checkout test fail?" },
      [
        { kind: "command", command: "pnpm test", ask: true },
        { kind: "message", text: ANSWER, deltaMs: 40 },
        { kind: "end", state: "completed" },
      ],
    );
    await fleet.waitForTurn(thread.id, 1, "waiting");
    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await page.evaluate(recordSentFrames);
    await openThread(page, "Why does the checkout test fail?");
    await expect.poll(() => page.evaluate(buildTapSubscribedCheck(thread.id))).toBe(true);
    await page.evaluate(recordLastMessage);

    const { openRequest } = await client.session.read({ params: { id: thread.id } });
    await client.session.respond({
      params: { id: thread.id },
      payload: { requestId: openRequest!.requestId, decision: "allow" },
    });
    await played;
    await fleet.waitForTurn(thread.id, 1, "completed");

    await expect
      .poll(() => readTranscript(page))
      .toEqual([
        "you: Why does the checkout test fail?",
        expect.stringMatching(/^divider: Worked for \d+s, ran 1 command$/),
        `agent: ${RENDERED_ANSWER}`,
      ]);
    const snapshots = await page.evaluate(() => (globalThis as RecordingGlobal).messageSnapshots!);
    // While the message streams, the paragraph being written is the raw
    // markdown written so far, and each finished paragraph shows as
    // markdown. Once the message ends, the whole answer shows as markdown.
    const isExpected = ({ text, openParagraph }: MessageSnapshot): boolean => {
      if (openParagraph === null) return text === RENDERED_ANSWER;
      if (text === "") return ANSWER.startsWith(openParagraph);
      return (
        text === FIRST_PARAGRAPH.rendered && SECOND_PARAGRAPH.markdown.startsWith(openParagraph)
      );
    };
    expect(snapshots.filter((snapshot) => !isExpected(snapshot))).toEqual([]);
    expect(snapshots).toContainEqual({
      text: "",
      openParagraph: expect.stringContaining("`fetchOrders`") as string,
    });
    expect(snapshots).toContainEqual({
      text: FIRST_PARAGRAPH.rendered,
      openParagraph: expect.stringContaining("**retry**") as string,
    });
    expect(snapshots.at(-1)).toEqual({ text: RENDERED_ANSWER, openParagraph: null });
    const answer = page.locator('section[aria-label="Transcript"] .msg-body').last();
    expect(await answer.locator("code").textContent()).toBe("fetchOrders");
    expect(await answer.locator("strong").textContent()).toBe("retry");
  });

  it("shows the dock and the waiting note while a Request is open, and Allow resolves it", async () => {
    const { url, fleet, runner, client, waitForStatus } = await arrangeFleet();
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
    expect((await client.session.read({ params: { id: thread!.id } })).openRequest).toBeNull();
  });

  it("shows a queued input above the composer, and Cancel removes it", async () => {
    const { url, fleet, runner, client, waitForStatus } = await arrangeFleet();
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
    const { url, fleet, runner, client } = await arrangeFleet();
    // 3,000 numbered words make about 17 KiB, which the controller writes as
    // four rows of 4 KiB and a last one. At 2 ms a word the message streams
    // for about 7 s, long enough to hide the window, see a row land while it
    // is hidden, and show it again before the message ends.
    const wordCount = 3_000;
    const counted = Array.from({ length: wordCount }, (_, index) => `w${index + 1}`).join(" ");
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "Count to three thousand" },
      [
        { kind: "command", command: "pnpm test", ask: true },
        { kind: "message", text: counted, deltaMs: 2 },
        { kind: "end", state: "completed" },
      ],
    );
    await fleet.waitForTurn(thread.id, 1, "waiting");

    // Playwright's focus emulation keeps a hidden page "visible", and the tap
    // is unsubscribed only on a real hide. This test starts the app as a
    // plain process instead, and reads the page through main, which attaches
    // nothing to the page.
    const userDataDir = createUserDataDirForTest();
    writeSettings(userDataDir, { controllerUrl: url });
    await signInOnce(userDataDir);
    const { process: child, inspectorUrl } = await launchPlainApp(userDataDir);
    onTestFinished(async () => {
      // The PID of a process that has already exited may belong to another
      // process by now, so only a running app is stopped.
      if (child.exitCode === null && child.signalCode === null) await stopApp(child.pid!);
    });
    const window = `require("electron").BrowserWindow.getAllWindows()[0]`;
    const evaluateInPage = (expression: string) =>
      evaluateInMain(
        inspectorUrl,
        `${window}.webContents.executeJavaScript(${JSON.stringify(expression)})`,
      );
    const readVisibility = () => evaluateInPage("document.visibilityState");
    const readLastSnapshot = () =>
      evaluateInPage("globalThis.messageSnapshots.at(-1)") as Promise<MessageSnapshot | undefined>;

    // The thread waits on a Request, so it has a row in Waiting on you as
    // well as its own.
    const threadRow = `document.querySelector("a.side-row:not(.side-row--wait)")`;
    await expect
      .poll(() => evaluateInPage(`${threadRow} !== null`), { timeout: 10_000 })
      .toBe(true);
    // A window that another window covers also reads as hidden; see
    // keepWindowOnTop.
    await evaluateInMain(inspectorUrl, `${window}.setAlwaysOnTop(true)`);
    await expect.poll(readVisibility, { timeout: 10_000 }).toBe("visible");
    await evaluateInPage(`(${recordSentFrames.toString()})()`);
    await evaluateInPage(`${threadRow}.click()`);
    await expect
      .poll(() => evaluateInPage(buildTapSubscribedCheck(thread.id)), { timeout: 10_000 })
      .toBe(true);
    await evaluateInPage(`(${recordLastMessage.toString()})()`);

    const { openRequest } = await client.session.read({ params: { id: thread.id } });
    await client.session.respond({
      params: { id: thread.id },
      payload: { requestId: openRequest!.requestId, decision: "allow" },
    });
    await expect.poll(async () => (await readLastSnapshot())?.openParagraph ?? "").not.toBe("");

    await evaluateInMain(inspectorUrl, `${window}.hide()`);
    await expect.poll(readVisibility).toBe("hidden");
    const shownWhenHidden = readShownText((await readLastSnapshot())!);
    // The stream topic stays subscribed while the window is hidden, so the
    // rows keep landing. A hidden page runs its timers at most once a second.
    await expect
      .poll(async () => readShownText((await readLastSnapshot())!).length, { timeout: 10_000 })
      .toBeGreaterThan(shownWhenHidden.length);
    await evaluateInMain(inspectorUrl, `${window}.show()`);
    await expect.poll(readVisibility).toBe("visible");
    // The message must still be streaming, or the window was shown too late
    // for this test to check anything.
    expect((await readLastSnapshot())!.openParagraph).not.toBeNull();

    await played;
    await fleet.waitForTurn(thread.id, 1, "completed");
    await expect.poll(async () => (await readLastSnapshot())!.openParagraph).toBeNull();
    const snapshots = (await evaluateInPage("globalThis.messageSnapshots")) as MessageSnapshot[];
    // A row can end inside a word, and the tail then holds the word's end,
    // so a snapshot's text is read as it shows, not word by word per part.
    const readWordNumbers = (snapshot: MessageSnapshot): number[] =>
      [...readShownText(snapshot).matchAll(/w(\d+)/g)].map((match) => Number(match[1]));
    const broken = snapshots
      .map(readWordNumbers)
      .find((numbers) => numbers.some((number, index) => number !== index + 1));
    expect(broken, "a snapshot doubled or skipped a word").toBeUndefined();
    const whole = readWordNumbers(snapshots.at(-1)!);
    expect(whole.length).toBe(wordCount);
  });

  it("opens the last open thread again at launch", async () => {
    const { url, fleet, runner } = await arrangeFleet();
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "Why does the checkout test fail?" },
      [
        { kind: "message", text: ANSWER },
        { kind: "end", state: "completed" },
      ],
    );
    await played;
    await fleet.waitForTurn(thread.id, 1, "completed");
    await fleet.spawnThreads(1, { runner });
    const transcript = ["you: Why does the checkout test fail?", `agent: ${RENDERED_ANSWER}`];

    const userDataDir = createUserDataDirForTest();
    writeSettings(userDataDir, { controllerUrl: url });
    const first = await launchForTest(userDataDir);
    await signInAndReadToken(first.page, url);
    await first.page.getByRole("navigation", { name: "Threads" }).waitFor();
    await openThread(first.page, "Why does the checkout test fail?");
    await expect.poll(() => readTranscript(first.page)).toEqual(transcript);
    await first.close();

    const { page } = await launchForTest(userDataDir);
    await page.locator('section[aria-label="Transcript"]').waitFor();
    expect(await readTranscript(page)).toEqual(transcript);
    expect(await readOpenTab(page)).toBe("Why does the checkout test fail?");
  });
});
