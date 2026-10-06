/**
 * Tests an assistant's Conversation in the packaged app, signed in to a real
 * controller whose assistant runs on a scripted runner (spec 17, §Design
 * system, **The assistant**):
 *
 * - an assistant opens from the sidebar, a message sent from the composer
 *   shows in the Conversation, the reply streams in, a Request is answered
 *   on the dock, and Stop ends the turn with the controller's notice;
 * - a window hidden while a reply streams drops the tap, subscribes to it
 *   again when it is shown, and ends with the whole reply, no word doubled
 *   or skipped.
 *
 * The harness retires the controller's own runner, so the assistant's
 * session lands on the scripted runner each test enlists.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import type { HerculeClient } from "../../packages/client-core/src/index";
import type { Session } from "../../packages/contract/src/index";
import type { ScriptedRunner } from "../../apps/desktop/scripts/scripted-runner";
import {
  arrangeFleet,
  buildLiveCheck,
  buildTapCheck,
  keepWindowOnTop,
  launchPlainAppForTest,
  openSignedIn,
  readAssistant,
  readNewestSession,
  recordFrames,
  type TapSubscriptions,
} from "./harness";

/**
 * Waits until the newest session of the conversation `conversationId` is
 * busy on `runner`, as it is once a sent message has started its turn, and
 * returns it. Fails when that does not happen within the poll timeout.
 */
async function waitForBusySession(
  client: HerculeClient,
  conversationId: string,
  runner: ScriptedRunner,
): Promise<Session> {
  await expect
    .poll(async () => {
      const session = await readNewestSession(client, conversationId);
      return session === null ? null : { runnerId: session.runnerId, status: session.status };
    })
    .toEqual({ runnerId: runner.runnerId, status: "busy" });
  return (await readNewestSession(client, conversationId))!;
}

/**
 * Returns every block the Conversation has mounted, top to bottom, each as
 * one line of text:
 *
 * - a day stamp: "stamp: Today";
 * - a message the owner sent: "you: Run the tests, please";
 * - a reply, stored or being written, without its name line: "reply: On it.";
 * - a notice, without its time: "notice: Hercule was interrupted: …".
 */
function readConversation(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('section[aria-label="Conversation"] .atx-item')].map((item) => {
      const block = item.firstElementChild!;
      if (block.matches(".stamp")) return `stamp: ${block.textContent}`;
      if (block.matches(".msg--me")) return `you: ${block.querySelector(".bubble")!.textContent}`;
      if (block.matches(".msg")) {
        const parts = [...block.querySelector(".msg-body")!.children].filter(
          (part) => !part.matches(".msg-name"),
        );
        return `reply: ${parts.map((part) => part.textContent).join("")}`;
      }
      if (block.matches(".notice")) {
        const text = block.querySelector(":scope > span")!.firstChild!.textContent;
        return `notice: ${text}`;
      }
      return `unknown: ${block.outerHTML}`;
    }),
  );
}

/** Returns the paragraph the open reply is writing, or null while no reply is being written. */
function readOpenParagraph(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document.querySelector('section[aria-label="Conversation"] .msg-body .streaming')
        ?.textContent ?? null,
  );
}

/** What the last reply in the Conversation showed at one moment. */
interface ReplySnapshot {
  /** The reply's text drawn as markdown: everything but its name line and the paragraph being written. */
  readonly text: string;
  /** The paragraph being written, as plain text, or `null` once the reply is stored. */
  readonly openParagraph: string | null;
}

/** The page's global object, with what `recordLastReply` keeps on it. */
type RecordingGlobal = typeof globalThis & { replySnapshots?: ReplySnapshot[] };

/**
 * Starts recording what the last reply in the Conversation shows, each time
 * the page changes it, in `replySnapshots` on the page's global object, as
 * the thread test's `recordLastMessage` does for a thread's last message.
 *
 * It runs in the page, handed over as source text, so it closes over nothing
 * in this file.
 */
function recordLastReply(): void {
  const snapshots: ReplySnapshot[] = [];
  (globalThis as RecordingGlobal).replySnapshots = snapshots;
  const conversation = document.querySelector('section[aria-label="Conversation"]')!;
  const takeSnapshot = () => {
    const body = [...conversation.querySelectorAll(".msg > .msg-body")].at(-1);
    if (body === undefined) return;
    const openParagraph = body.querySelector(".streaming")?.textContent ?? null;
    const text = [...body.children]
      .filter((part) => !part.matches(".msg-name, .streaming"))
      .map((part) => part.textContent)
      .join("");
    const last = snapshots.at(-1);
    if (last?.text === text && last.openParagraph === openParagraph) return;
    snapshots.push({ text, openParagraph });
  };
  new MutationObserver(takeSnapshot).observe(conversation, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  takeSnapshot();
}

/** Returns the text a snapshot shows: its markdown's text, then the paragraph being written. */
const readShownText = ({ text, openParagraph }: ReplySnapshot): string =>
  `${text}${openParagraph ?? ""}`;

/** The text the assistant writes before it asks to run the tests. */
const FIRST_TEXT = "Let me run the tests first, then I will look at the failure.";

/** The text the assistant writes once it may run the tests, when it is stopped. */
const SECOND_TEXT = "The tests ran, and the checkout test fails because the fetch is slow.";

describe("the Conversation", () => {
  it("sends a message from the composer, streams the reply, answers a Request on the dock, and stops the turn", async () => {
    const { url, fleet, client } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const hercule = await readAssistant(client, "Hercule");
    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);

    await page
      .getByRole("navigation", { name: "Assistants", exact: true })
      .getByRole("link", { name: "Hercule, idle" })
      .click();
    const main = page.getByRole("main");
    await main.getByRole("heading", { level: 2, name: "Hercule" }).waitFor();
    const field = page.getByRole("textbox", { name: "Message" });
    const send = page.getByRole("button", { name: "Send", exact: true });
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    expect(await field.getAttribute("placeholder")).toBe("Message Hercule…");

    await field.fill("Run the tests, please");
    await field.press("Enter");

    // The message shows once the controller has stored it, and the field
    // empties in the same frame.
    await page.locator(".msg--me .bubble", { hasText: "Run the tests, please" }).waitFor();
    expect(await field.inputValue()).toBe("");
    const session = await waitForBusySession(client, hercule.mainConversationId, runner);
    await stop.waitFor();
    expect(await send.count()).toBe(0);

    const played = runner.playScript(session.id, [
      { kind: "message", text: FIRST_TEXT, deltaMs: 40 },
      { kind: "command", command: "pnpm test", ask: true },
      { kind: "message", text: SECOND_TEXT, deltaMs: 40 },
    ]);

    // The reply streams in: the open paragraph shows part of the first text
    // before the whole text is written.
    await expect
      .poll(async () => {
        const paragraph = (await readOpenParagraph(page)) ?? "";
        return paragraph !== "" && paragraph !== FIRST_TEXT && FIRST_TEXT.startsWith(paragraph);
      })
      .toBe(true);

    const dock = page.getByRole("group", { name: "Run this command?" });
    await dock.waitFor();
    expect(await dock.locator("code").textContent()).toBe("pnpm test");
    await dock.getByRole("button", { name: "Allow", exact: true }).click();
    await dock.waitFor({ state: "detached" });

    // In the `turn-end` reply mode, the open reply shows only the turn's
    // newest text, so the second text takes the first one's place. The turn
    // goes on running once the script is played.
    await played;
    await expect
      .poll(() => readConversation(page))
      .toEqual(["stamp: Today", "you: Run the tests, please", `reply: ${SECOND_TEXT}`]);
    await stop.click();
    await fleet.waitForTurn(session.id, 1, "interrupted");

    // A stopped turn stores every text it wrote as one reply, and then the
    // notice that it was stopped.
    await expect
      .poll(() => readConversation(page))
      .toEqual([
        "stamp: Today",
        "you: Run the tests, please",
        `reply: ${FIRST_TEXT}${SECOND_TEXT}`,
        "notice: Hercule was interrupted: its turn was stopped",
      ]);
    await send.waitFor();
    expect(await stop.count()).toBe(0);
    expect((await client.session.read({ params: { id: session.id } })).openRequests).toEqual([]);
  });

  it("drops the tap while the window is hidden, and shows the whole reply once it is shown again", async () => {
    const { url, fleet, client } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const hercule = await readAssistant(client, "Hercule");
    await client.conversation.send({
      params: { id: hercule.mainConversationId },
      payload: { text: "Count to three thousand" },
    });
    const session = await waitForBusySession(client, hercule.mainConversationId, runner);
    // As in the thread's test: 3,000 numbered words stream for about 7 s, at
    // 2 ms a word, which leaves time to hide the window, see rows land while
    // it is hidden, and show it again before the reply ends. The script
    // waits on a Request until the Conversation is open.
    const wordCount = 3_000;
    const counted = Array.from({ length: wordCount }, (_, index) => `w${index + 1}`).join(" ");
    const played = runner.playScript(session.id, [
      { kind: "command", command: "pnpm test", ask: true },
      { kind: "message", text: counted, deltaMs: 2 },
      { kind: "end", state: "completed" },
    ]);
    await fleet.waitForTurn(session.id, 1, "waiting");

    // Playwright's focus emulation keeps a hidden page "visible", and the tap
    // is unsubscribed only on a real hide, so the app runs as a plain process.
    const { evaluateInPage, callWindowMethod } = await launchPlainAppForTest(url);
    const readVisibility = () => evaluateInPage("document.visibilityState");
    const readTaps = () => evaluateInPage(buildTapCheck(session.id)) as Promise<TapSubscriptions>;
    const readLastSnapshot = () =>
      evaluateInPage("globalThis.replySnapshots.at(-1)") as Promise<ReplySnapshot | undefined>;

    const assistantRow = `document.querySelector('nav[aria-label="Assistants"] a')`;
    await expect
      .poll(() => evaluateInPage(`${assistantRow} !== null`), { timeout: 10_000 })
      .toBe(true);
    // A window that another window covers also reads as hidden; see
    // keepWindowOnTop.
    await callWindowMethod("setAlwaysOnTop", true);
    await expect.poll(readVisibility, { timeout: 10_000 }).toBe("visible");
    await evaluateInPage(`(${recordFrames.toString()})()`);
    await evaluateInPage(`${assistantRow}.click()`);
    await expect
      .poll(() => evaluateInPage(buildLiveCheck(session.id)), { timeout: 10_000 })
      .toBe(true);
    await evaluateInPage(`(${recordLastReply.toString()})()`);

    const [openRequest] = (await client.session.read({ params: { id: session.id } })).openRequests;
    await client.session.respondToApprovalRequest({
      params: { id: session.id },
      payload: { requestId: openRequest!.requestId, decision: "allow" },
    });
    await expect.poll(async () => (await readLastSnapshot())?.openParagraph ?? "").not.toBe("");

    await callWindowMethod("hide");
    await expect.poll(readVisibility).toBe("hidden");
    // Every tap subscription the page made is ended, and none is made while
    // the window stays hidden.
    await expect.poll(async () => (await readTaps()).ended).toBeGreaterThan(0);
    const tapsWhenHidden = await readTaps();
    expect(tapsWhenHidden.made).toBe(tapsWhenHidden.ended);
    const shownWhenHidden = readShownText((await readLastSnapshot())!);
    // The stream stays subscribed while the window is hidden, so the rows
    // keep landing. A hidden page runs its timers at most once a second.
    await expect
      .poll(async () => readShownText((await readLastSnapshot())!).length, { timeout: 10_000 })
      .toBeGreaterThan(shownWhenHidden.length);
    expect(await readTaps()).toEqual(tapsWhenHidden);

    await callWindowMethod("show");
    await expect.poll(readVisibility).toBe("visible");
    // The reply must still be streaming, or the window was shown too late
    // for this test to check anything.
    expect((await readLastSnapshot())!.openParagraph).not.toBeNull();
    await expect.poll(readTaps).toEqual({
      made: tapsWhenHidden.made + 1,
      ended: tapsWhenHidden.ended,
    });

    await played;
    await fleet.waitForTurn(session.id, 1, "completed");
    await expect.poll(async () => (await readLastSnapshot())!.openParagraph).toBeNull();
    const snapshots = (await evaluateInPage("globalThis.replySnapshots")) as ReplySnapshot[];
    const readWordNumbers = (snapshot: ReplySnapshot): number[] =>
      [...readShownText(snapshot).matchAll(/w(\d+)/g)].map((match) => Number(match[1]));
    const broken = snapshots
      .map(readWordNumbers)
      .find((numbers) => numbers.some((number, index) => number !== index + 1));
    expect(broken, "a snapshot doubled or skipped a word").toBeUndefined();
    expect(readWordNumbers(snapshots.at(-1)!).length).toBe(wordCount);
  });
});
